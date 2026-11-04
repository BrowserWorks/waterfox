/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import {
  ApplePasswordCrypto,
  ApplePasswordError,
  encodeApplePasswordHandshake,
  decodeApplePasswordHandshake,
} from "resource:///modules/ApplePasswordCrypto.sys.mjs";

export { ApplePasswordError };

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  WindowsRegistry: "resource://gre/modules/WindowsRegistry.sys.mjs",
});

const HOST = "com.apple.passwordmanager";
const MAX_MANIFEST = 64 * 1024;
const MAX_FRAME = 1024 * 1024;
const MAX_ENTRIES = 2048;
const MAX_STRING = 32 * 1024;
const NO_SAVED_PASSWORDS = "Passwords\u00a0not\u00a0saved";
const FATAL_ERRORS = new Set([
  "protocol-error",
  "unsupported-protocol",
  "connection-closed",
  "timeout",
  "invalid-session",
  "native-auth-required",
  "pairing-failed",
  "invalid-pin",
  "not-available",
]);
const LOCK_ERRORS = new Set([
  "invalid-session",
  "native-auth-required",
  "pairing-failed",
  "invalid-pin",
]);
const encoder = new TextEncoder();

function object(value) {
  if (typeof value === "string") {
    if (value.length > MAX_FRAME) {
      throw new ApplePasswordError();
    }
    try {
      value = JSON.parse(value);
    } catch {
      throw new ApplePasswordError();
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplePasswordError();
  }
  return value;
}

function string(value, maximum = MAX_STRING) {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}

function originInfo(origin) {
  let url;
  try {
    if (
      !string(origin, 8192) ||
      Array.from(origin).some(char => {
        let code = char.charCodeAt(0);
        return code <= 0x20 || code === 0x7f;
      })
    ) {
      throw new Error();
    }
    url = new URL(origin);
  } catch {
    throw new ApplePasswordError("invalid-origin");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw new ApplePasswordError("invalid-origin");
  }
  return { origin: url.origin, host: url.host };
}

/**
 * Copies and freezes the parent's frame scope before native requests.
 *
 * @param {string} origin Expected HTTPS origin.
 * @param {object} [options] Full frame URLs and routing IDs supplied by the parent.
 * @returns {object} Frozen scope, including its URL array.
 */
export function validateApplePasswordOTPContext(origin, options = {}) {
  let context = originInfo(origin);
  if (!context.origin.startsWith("https://")) {
    throw new ApplePasswordError("invalid-origin");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new ApplePasswordError("invalid-argument");
  }
  let { frameURLs = [`${context.origin}/`], tabId = 0, frameId = 0 } = options;
  let count = Array.isArray(frameURLs) ? frameURLs.length : 0;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 32 ||
    !Number.isSafeInteger(tabId) ||
    tabId < 0 ||
    !Number.isSafeInteger(frameId) ||
    frameId < 0
  ) {
    throw new ApplePasswordError("invalid-argument");
  }
  let urls = [];
  for (let i = 0; i < count; i++) {
    let value = frameURLs[i];
    if (
      !string(value, 8192) ||
      !/^https:\/\/[^/?#@]+(?:[/?#]|$)/i.test(value) ||
      /[\p{Cc}\s\\]/u.test(value)
    ) {
      throw new ApplePasswordError("invalid-origin");
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new ApplePasswordError("invalid-origin");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.origin !== context.origin
    ) {
      throw new ApplePasswordError("invalid-origin");
    }
    urls.push(value);
  }
  return Object.freeze({ frameURLs: Object.freeze(urls), tabId, frameId });
}

export function validateApplePasswordSetupURI(value) {
  try {
    if (
      !string(value, 4096) ||
      value.includes("#") ||
      /[\p{Cc}\s\\]/u.test(value)
    ) {
      throw new Error();
    }
    let url = new URL(value);
    let label = decodeURIComponent(url.pathname.slice(1));
    if (
      !["otpauth:", "apple-otpauth:"].includes(url.protocol) ||
      url.hostname !== "totp" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !label.trim() ||
      label.length > 1024 ||
      /\p{Cc}/u.test(label)
    ) {
      throw new Error();
    }
    let allowed = new Set([
      "secret",
      "issuer",
      "algorithm",
      "digits",
      "period",
    ]);
    let seen = new Set();
    for (let [name, parameter] of url.searchParams) {
      if (
        !allowed.has(name) ||
        seen.has(name) ||
        !parameter ||
        parameter.length > 1024 ||
        /\p{Cc}/u.test(parameter)
      ) {
        throw new Error();
      }
      seen.add(name);
    }
    let secret = url.searchParams.get("secret") ?? "";
    if (!/^[A-Z2-7]{16,128}={0,6}$/i.test(secret)) {
      throw new Error();
    }
    let key = secret.replace(/=+$/, "").toUpperCase();
    let remainder = key.length % 8;
    let unused = [0, null, 2, null, 4, 1, null, 3][remainder];
    let last = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(key.at(-1));
    let padding = secret.length - key.length;
    if (
      unused === null ||
      last & ((1 << unused) - 1) ||
      (padding && padding !== (8 - remainder) % 8) ||
      (seen.has("algorithm") &&
        !["SHA1", "SHA256", "SHA512"].includes(
          url.searchParams.get("algorithm").toUpperCase()
        )) ||
      (seen.has("digits") &&
        !["6", "8"].includes(url.searchParams.get("digits"))) ||
      (seen.has("period") &&
        (!/^[1-9]\d{0,3}$/.test(url.searchParams.get("period")) ||
          Number(url.searchParams.get("period")) > 3600))
    ) {
      throw new Error();
    }
    return value;
  } catch {
    throw new ApplePasswordError("invalid-argument");
  }
}

function passwordLookupSite(context, selectedAccount) {
  if (selectedAccount.sites === undefined) {
    return context.host;
  }
  if (
    !Array.isArray(selectedAccount.sites) ||
    selectedAccount.sites.length > 256
  ) {
    throw new ApplePasswordError("invalid-argument");
  }
  let origin = new URL(context.origin);
  let host = origin.hostname.replace(/\.$/, "");
  for (let site of selectedAccount.sites) {
    if (
      !string(site, 8192) ||
      !site ||
      /^[/?#]/.test(site) ||
      /[\p{Cc}\s\\]/u.test(site)
    ) {
      continue;
    }
    try {
      let url = new URL(site.includes("://") ? site : `https://${site}`);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.port !== origin.port
      ) {
        continue;
      }
      let siteHost = url.hostname.replace(/\.$/, "");
      if (
        host === siteHost ||
        (host.endsWith(`.${siteHost}`) &&
          Services.eTLD.getBaseDomainFromHost(host) ===
            Services.eTLD.getBaseDomainFromHost(siteHost))
      ) {
        return site;
      }
    } catch {}
  }
  throw new ApplePasswordError("invalid-argument");
}

function windowsPath(path, base) {
  if (
    !string(path) ||
    !path ||
    /["<>|?*]/.test(path) ||
    Array.from(path).some(char => char.charCodeAt(0) <= 0x1f)
  ) {
    return null;
  }
  path = path.replaceAll("/", "\\");
  if (!/^[a-z]:\\/i.test(path)) {
    if (!base || path.startsWith("\\") || path.includes(":")) {
      return null;
    }
    path = `${base}\\${path}`;
  }
  let parts = [];
  for (let part of path.slice(3).split("\\")) {
    if (part === "..") {
      if (!parts.length) {
        return null;
      }
      parts.pop();
    } else if (part && part !== ".") {
      if (part.includes(":") || /[. ]$/.test(part)) {
        return null;
      }
      parts.push(part);
    }
  }
  return `${path.slice(0, 3)}${parts.join("\\")}`;
}

async function readManifest(path) {
  let bytes = await IOUtils.read(path, { maxBytes: MAX_MANIFEST + 1 });
  if (bytes.length > MAX_MANIFEST) {
    throw new ApplePasswordError();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function readRegistry(hive, path, view) {
  let registry = Ci.nsIWindowsRegKey;
  return lazy.WindowsRegistry.readRegKey(
    hive === "current-user"
      ? registry.ROOT_KEY_CURRENT_USER
      : registry.ROOT_KEY_LOCAL_MACHINE,
    path,
    "",
    view === 64 ? registry.WOW64_64 : registry.WOW64_32
  );
}

function macManifestPaths() {
  let directories = [];
  for (let property of ["XREUserNativeManifests", "XRESysNativeManifests"]) {
    directories.push(Services.dirsvc.get(property, Ci.nsIFile).path);
  }
  let home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  for (let browser of [
    "Waterfox",
    "Mozilla",
    "Google/Chrome",
    "Chromium",
    "Microsoft Edge",
  ]) {
    directories.push(`${home}/Library/Application Support/${browser}`);
  }
  directories.push(
    "/Library/Application Support/Waterfox",
    "/Library/Application Support/Mozilla",
    "/Library/Google/Chrome",
    "/Library/Application Support/Chromium",
    "/Library/Microsoft/Edge"
  );
  return [...new Set(directories)].map(
    directory => `${directory}/NativeMessagingHosts/${HOST}.json`
  );
}

/**
 * Locates the registered Apple native messaging host.
 *
 * @param {object} [options] Discovery inputs.
 * @param {string} [options.platform] Gecko platform name.
 * @param {string[]} [options.manifestPaths] Paths to use instead of platform defaults.
 * @param {Function} [options.readManifest] Manifest loader.
 * @param {Function} [options.readRegistry] Registry lookup.
 * @returns {Promise<object|null>} Executable and manifest paths, or null if absent.
 */
export async function discoverApplePasswordHost({
  platform = AppConstants.platform,
  manifestPaths,
  readManifest: load = readManifest,
  readRegistry: registry = readRegistry,
} = {}) {
  if (Services.appinfo.processType !== Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT) {
    throw new ApplePasswordError("unsupported");
  }
  if (!["macosx", "win"].includes(platform)) {
    return null;
  }
  let paths = manifestPaths ? [...manifestPaths] : [];
  if (!manifestPaths && platform === "macosx") {
    paths = macManifestPaths();
  } else if (!manifestPaths && platform === "win") {
    for (let hive of ["current-user", "local-machine"]) {
      for (let vendor of [
        "Waterfox",
        "Mozilla",
        "Google\\Chrome",
        "Microsoft\\Edge",
        "Chromium",
      ]) {
        for (let view of [64, 32]) {
          let path = registry(
            hive,
            `Software\\${vendor}\\NativeMessagingHosts\\${HOST}`,
            view
          );
          if (typeof path === "string") {
            paths.push(path);
          }
        }
      }
    }
  }
  for (let path of new Set(paths)) {
    try {
      if (platform === "win") {
        path = windowsPath(path);
      }
      if (
        !string(path) ||
        !path ||
        (platform === "macosx" && !path.startsWith("/"))
      ) {
        continue;
      }
      let manifest = object(await load(path));
      if (
        manifest.name !== HOST ||
        manifest.type !== "stdio" ||
        !string(manifest.path) ||
        !manifest.path
      ) {
        continue;
      }
      let command;
      if (platform === "win") {
        command = windowsPath(
          manifest.path,
          path.slice(0, path.lastIndexOf("\\"))
        );
        if (!command || !command.toLowerCase().endsWith(".exe")) {
          continue;
        }
      } else {
        command = manifest.path;
        if (!command.startsWith("/") || command.startsWith("//")) {
          continue;
        }
      }
      return { command, manifestPath: path };
    } catch {
      // An invalid or missing registration must not hide a subsequent valid one.
    }
  }
  return null;
}

function disposeProcess(process) {
  if (!process) {
    return;
  }
  for (let pipe of [process.stdin, process.stdout, process.stderr]) {
    try {
      Promise.resolve(pipe?.close(true)).catch(() => {});
    } catch {}
  }
  try {
    Promise.resolve(process.kill(0)).catch(() => {});
  } catch {}
}

function validateFillPolicy(value) {
  if (
    Object.hasOwn(value, "RequiresUserAuthenticationToFill") &&
    typeof value.RequiresUserAuthenticationToFill !== "boolean" &&
    value.RequiresUserAuthenticationToFill !== 0
  ) {
    throw new ApplePasswordError();
  }
}

function entries(value) {
  let result;
  if (Object.hasOwn(value, "Entries")) {
    result = value.Entries;
  } else {
    let keys = Object.keys(value).filter(key => /^Entry_[0-9]{1,7}$/.test(key));
    keys.sort((left, right) => Number(left.slice(6)) - Number(right.slice(6)));
    result = keys.map(key => value[key]);
  }
  if (!Array.isArray(result) || result.length > MAX_ENTRIES) {
    throw new ApplePasswordError();
  }
  return result.map(entry => {
    entry = object(entry);
    validateFillPolicy(entry);
    return entry;
  });
}

function account(entry, withPassword = false) {
  if (
    !string(entry.USR) ||
    !Array.isArray(entry.sites) ||
    entry.sites.length > 256 ||
    entry.sites.some(site => !string(site, 8192) || !site.length) ||
    (withPassword && !string(entry.PWD))
  ) {
    throw new ApplePasswordError();
  }
  let result = { username: entry.USR, sites: [...entry.sites] };
  if (withPassword) {
    result.password = entry.PWD;
  }
  return result;
}

function oneTimeCode(entry, withCode) {
  if (
    !string(entry.username, 4096) ||
    /\p{Cc}/u.test(entry.username) ||
    !string(entry.domain, 8192) ||
    !entry.domain ||
    /\p{Cc}/u.test(entry.domain) ||
    (withCode &&
      (typeof entry.code !== "string" ||
        !/^[0-9]{4,10}$/.test(entry.code) ||
        (entry.expiresAt !== undefined && !Number.isFinite(entry.expiresAt))))
  ) {
    throw new ApplePasswordError();
  }
  let result = {
    username: entry.username,
    domain: entry.domain,
    source: "totp",
  };
  if (withCode) {
    result.code = entry.code;
    if (entry.expiresAt !== undefined) {
      result.expiresAt = entry.expiresAt;
    }
  }
  return result;
}

/**
 * Native bridge for the parent process. connect() checks availability without
 * pairing; getStatus() returns a synchronous snapshot.
 * onStateChange receives (state, status); onNotification receives {type},
 * without native payloads.
 */
export class ApplePasswordManager {
  #platform;
  #discoverHost;
  #transportFactory;
  #cryptoFactory;
  #cryptoOptions;
  #requestTimeout;
  #authenticationTimeout;
  #pairingTimeout;
  #maxQueue;
  #state = "disconnected";
  #available = false;
  #error;
  #generation = 0;
  #process;
  #session;
  #useBase64 = false;
  #canFillOneTimeCodes = false;
  #canSetUpOneTimeCodes = false;
  #pairingTimer;
  #pending;
  #active;
  #queue = [];

  constructor(options = {}) {
    if (
      Services.appinfo.processType !== Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT
    ) {
      throw new ApplePasswordError("unsupported");
    }
    this.#platform = options.platform ?? AppConstants.platform;
    this.#discoverHost =
      options.discoverHost ??
      (() => discoverApplePasswordHost({ platform: this.#platform }));
    this.#transportFactory =
      options.transportFactory ??
      (host =>
        lazy.Subprocess.call({
          command: host.command,
          arguments: [],
          workdir: PathUtils.parent(host.command),
          stderr: "pipe",
          disclaim: true,
        }));
    this.#cryptoFactory =
      options.cryptoFactory ??
      (settings => ApplePasswordCrypto.create(settings));
    this.#cryptoOptions = options.cryptoOptions ?? {};
    this.#requestTimeout = options.requestTimeoutMS ?? 15000;
    this.#authenticationTimeout = options.authenticationTimeoutMS ?? 120000;
    this.#pairingTimeout = options.pairingTimeoutMS ?? 120000;
    this.#maxQueue = options.maxQueue ?? 32;
    for (let value of [
      this.#requestTimeout,
      this.#authenticationTimeout,
      this.#pairingTimeout,
    ]) {
      if (!Number.isInteger(value) || value <= 0 || value > 300000) {
        throw new ApplePasswordError("invalid-argument");
      }
    }
    if (
      !Number.isInteger(this.#maxQueue) ||
      this.#maxQueue < 1 ||
      this.#maxQueue > 128
    ) {
      throw new ApplePasswordError("invalid-argument");
    }
    this.onStateChange = options.onStateChange;
    this.onNotification = options.onNotification;
  }

  get state() {
    return this.#state;
  }

  get isReady() {
    return (
      this.#state === "ready" && !!this.#session?.isVerified && !!this.#process
    );
  }

  get supported() {
    return ["macosx", "win"].includes(this.#platform);
  }

  get canFillOneTimeCodes() {
    return this.#canFillOneTimeCodes;
  }

  get canSetUpOneTimeCodes() {
    return this.#canSetUpOneTimeCodes;
  }

  getStatus() {
    let status = {
      supported: this.supported,
      available: this.#available,
      state: this.state,
    };
    if (this.#error) {
      status.error = this.#error;
    }
    return status;
  }

  #setState(state, error) {
    let changed = state !== this.#state || error !== this.#error;
    this.#state = state;
    this.#error = error;
    if (changed) {
      try {
        this.onStateChange?.(state, this.getStatus());
      } catch {}
    }
  }

  #guard(generation) {
    if (generation !== this.#generation) {
      throw new ApplePasswordError("locked");
    }
  }

  #shutdown(state, code) {
    this.#generation++;
    clearTimeout(this.#pairingTimer);
    this.#pairingTimer = null;
    this.#session?.destroy();
    this.#session = null;
    this.#useBase64 = false;
    this.#canFillOneTimeCodes = false;
    this.#canSetUpOneTimeCodes = false;
    let process = this.#process;
    this.#process = null;
    let error = new ApplePasswordError(code ?? "locked");
    this.#pending?.reject(error);
    this.#pending = null;
    let jobs = this.#queue.splice(0);
    if (this.#active) {
      jobs.unshift(this.#active);
      this.#active = null;
    }
    for (let job of jobs) {
      clearTimeout(job.timer);
      job.run = null;
      job.reject(error);
    }
    disposeProcess(process);
    this.#setState(state, code);
  }

  #enqueue(run, timeout = this.#requestTimeout) {
    if (!this.supported) {
      return Promise.reject(new ApplePasswordError("unsupported"));
    }
    if (this.#queue.length + Number(!!this.#active) >= this.#maxQueue) {
      return Promise.reject(new ApplePasswordError("queue-full"));
    }
    return new Promise((resolve, reject) => {
      let job = { run, resolve, reject, generation: this.#generation };
      job.timer = setTimeout(() => {
        if (this.#active === job) {
          // No wire request IDs: close the pipe on timeout so a late reply cannot
          // satisfy a later request of the same kind.
          this.#shutdown("disconnected", "timeout");
        } else {
          let index = this.#queue.indexOf(job);
          if (index !== -1) {
            this.#queue.splice(index, 1);
            job.run = null;
            reject(new ApplePasswordError("timeout"));
          }
        }
      }, timeout);
      this.#queue.push(job);
      this.#pump();
    });
  }

  #pump() {
    if (this.#active || !this.#queue.length) {
      return;
    }
    let job = this.#queue.shift();
    this.#active = job;
    Promise.resolve()
      .then(() => {
        this.#guard(job.generation);
        let run = job.run;
        job.run = null;
        return run(job.generation);
      })
      .then(
        value => this.#finish(job, null, value),
        error => this.#finish(job, error)
      );
  }

  #finish(job, error, value) {
    if (this.#active !== job) {
      return;
    }
    if (error) {
      error =
        error instanceof ApplePasswordError ? error : new ApplePasswordError();
      if (FATAL_ERRORS.has(error.code)) {
        this.#shutdown(
          LOCK_ERRORS.has(error.code) ? "locked" : "disconnected",
          error.code
        );
        return;
      }
    }
    clearTimeout(job.timer);
    this.#active = null;
    if (error) {
      job.reject(error);
    } else {
      job.resolve(value);
    }
    this.#pump();
  }

  async #connect(generation) {
    if (this.#process) {
      return this.getStatus();
    }
    this.#setState("connecting");
    this.#guard(generation);
    let host;
    try {
      host = await this.#discoverHost();
    } catch {
      throw new ApplePasswordError("not-available");
    }
    this.#guard(generation);
    this.#available = !!host;
    if (!host) {
      throw new ApplePasswordError("not-available");
    }
    let process;
    try {
      process = await this.#transportFactory(host);
    } catch {
      throw new ApplePasswordError("not-available");
    }
    if (generation !== this.#generation) {
      disposeProcess(process);
      throw new ApplePasswordError("locked");
    }
    if (
      !process?.stdout ||
      !process.stdin ||
      typeof process.kill !== "function" ||
      typeof process.wait !== "function"
    ) {
      disposeProcess(process);
      throw new ApplePasswordError();
    }
    this.#process = process;
    this.#read(process, generation);
    this.#discardStderr(process, generation);
    let onExit = () => {
      if (this.#process === process && generation === this.#generation) {
        this.#shutdown("disconnected", "connection-closed");
      }
    };
    Promise.resolve(process.wait()).then(onExit, onExit);
    let reply = await this.#request({ cmd: 14 }, [14], generation);
    validateFillPolicy(reply);
    let capabilities = object(reply.capabilities);
    if (
      (capabilities.secretSessionVersion !== undefined &&
        capabilities.secretSessionVersion !== 1) ||
      (capabilities.shouldUseBase64 !== undefined &&
        typeof capabilities.shouldUseBase64 !== "boolean") ||
      (capabilities.canFillOneTimeCodes !== undefined &&
        typeof capabilities.canFillOneTimeCodes !== "boolean") ||
      (capabilities.scanForOTPURI !== undefined &&
        typeof capabilities.scanForOTPURI !== "boolean")
    ) {
      throw new ApplePasswordError("unsupported-protocol");
    }
    this.#useBase64 = capabilities.shouldUseBase64 ?? false;
    this.#canFillOneTimeCodes = capabilities.canFillOneTimeCodes ?? false;
    this.#canSetUpOneTimeCodes = capabilities.scanForOTPURI ?? false;
    this.#guard(generation);
    this.#setState("locked");
    return this.getStatus();
  }

  async #read(process, generation) {
    try {
      while (this.#process === process && generation === this.#generation) {
        let size = await process.stdout.readUint32();
        if (!Number.isInteger(size) || size <= 0 || size > MAX_FRAME) {
          throw new ApplePasswordError();
        }
        let message = await process.stdout.readJSON(size);
        this.#guard(generation);
        this.#receive(message);
      }
    } catch (error) {
      if (this.#process === process && generation === this.#generation) {
        let code = "connection-closed";
        if (error instanceof ApplePasswordError) {
          code = error.code;
        } else if (error?.errorCode === lazy.Subprocess.ERROR_INVALID_JSON) {
          code = "protocol-error";
        }
        this.#shutdown("disconnected", code);
      }
    }
  }

  async #discardStderr(process, generation) {
    if (!process.stderr) {
      return;
    }
    try {
      while (this.#process === process && generation === this.#generation) {
        let bytes = await process.stderr.read();
        if (!bytes.byteLength) {
          break;
        }
      }
    } catch {}
  }

  #receive(message) {
    message = object(message);
    if (!Number.isInteger(message.cmd)) {
      throw new ApplePasswordError();
    }
    let type;
    switch (message.cmd) {
      case 0:
        this.#shutdown("disconnected", "connection-closed");
        return;
      case 9:
      case 10:
        this.#shutdown("locked", "native-auth-required");
        type = "authentication-required";
        break;
      case 12:
        // Treat an unhandled native state change as a local lock.
        this.#shutdown("locked", "invalid-session");
        type = "state-changed";
        break;
      case 15:
        type = "one-time-code-available";
        break;
      case 3:
        if (message.payload === "NoValueSet" && this.isReady) {
          this.#shutdown("locked", "invalid-session");
          type = "state-changed";
        } else {
          type = "presentation-changed";
        }
        break;
      default:
        if (this.#pending?.commands.includes(message.cmd)) {
          let pending = this.#pending;
          this.#pending = null;
          pending.resolve(message);
        }
        return;
    }
    try {
      this.onNotification?.({ type });
    } catch {}
  }

  #request(message, commands, generation) {
    this.#guard(generation);
    if (!this.#process || this.#pending) {
      throw new ApplePasswordError("invalid-state");
    }
    let bytes = encoder.encode(JSON.stringify(message));
    if (!bytes.length || bytes.length > MAX_FRAME) {
      throw new ApplePasswordError("invalid-argument");
    }
    let frame = new Uint8Array(4 + bytes.length);
    frame.set(new Uint8Array(Uint32Array.of(bytes.length).buffer));
    frame.set(bytes, 4);
    return new Promise((resolve, reject) => {
      this.#pending = { commands, resolve, reject };
      try {
        Promise.resolve(this.#process.stdin.write(frame.buffer)).catch(() => {
          if (generation === this.#generation) {
            this.#shutdown("disconnected", "connection-closed");
          }
        });
      } catch {
        this.#shutdown("disconnected", "connection-closed");
      }
    });
  }

  async connect() {
    return this.#enqueue(generation => this.#connect(generation));
  }

  async beginPairing() {
    return this.#enqueue(async generation => {
      if (this.isReady || (this.#state === "pairing" && this.#session)) {
        return this.getStatus();
      }
      await this.#connect(generation);
      this.#guard(generation);
      let session = await this.#cryptoFactory({
        ...this.#cryptoOptions,
        useBase64: this.#useBase64,
      });
      if (generation !== this.#generation) {
        session.destroy();
        throw new ApplePasswordError("locked");
      }
      this.#session = session;
      this.#setState("pairing");
      this.#guard(generation);
      let reply = await this.#request(
        {
          cmd: 2,
          msg: {
            QID: "m0",
            HSTBRSR: "Waterfox",
            PAKE: encodeApplePasswordHandshake(session.clientHello()),
          },
        },
        [2],
        generation
      );
      validateFillPolicy(reply);
      let payload = object(reply.payload);
      session.acceptServerHello(decodeApplePasswordHandshake(payload.PAKE));
      this.#guard(generation);
      this.#pairingTimer = setTimeout(() => {
        if (generation === this.#generation && this.#state === "pairing") {
          this.#shutdown("locked", "timeout");
        }
      }, this.#pairingTimeout);
      return this.getStatus();
    });
  }

  async completePairing(pin) {
    if (typeof pin !== "string" || !/^[0-9]{6}$/.test(pin)) {
      throw new ApplePasswordError("invalid-pin");
    }
    return this.#enqueue(async generation => {
      if (this.#state !== "pairing" || !this.#session) {
        throw new ApplePasswordError("invalid-state");
      }
      let session = this.#session;
      let proof = await session.clientProof(pin);
      pin = null;
      this.#guard(generation);
      let reply = await this.#request(
        {
          cmd: 2,
          msg: { QID: "m2", PAKE: encodeApplePasswordHandshake(proof) },
        },
        [2],
        generation
      );
      validateFillPolicy(reply);
      session.verifyServerProof(
        decodeApplePasswordHandshake(object(reply.payload).PAKE)
      );
      this.#guard(generation);
      if (!session.isVerified) {
        throw new ApplePasswordError("pairing-failed");
      }
      clearTimeout(this.#pairingTimer);
      this.#pairingTimer = null;
      this.#setState("ready");
      return this.getStatus();
    }, this.#authenticationTimeout);
  }

  async lock() {
    this.#shutdown(this.supported ? "locked" : "disconnected");
  }

  #operation(cmd, qid, context, body, convert, authentication = false) {
    if (!this.isReady) {
      return Promise.reject(
        new ApplePasswordError(this.supported ? "locked" : "unsupported")
      );
    }
    return this.#enqueue(
      async generation => {
        if (!this.isReady) {
          throw new ApplePasswordError("locked");
        }
        let session = this.#session;
        let sdata = await session.encryptJSON(body);
        body = null;
        this.#guard(generation);
        let reply = await this.#request(
          {
            cmd,
            tabId: context.tabId ?? 0,
            frameId: context.frameId ?? 0,
            ...([6, 16, 17].includes(cmd)
              ? {}
              : { url: context.lookupSite ?? context.host }),
            payload: JSON.stringify({
              QID: qid,
              SMSG: JSON.stringify({ TID: session.tid, SDATA: sdata }),
            }),
          },
          cmd === 6 ? [6, 4] : [cmd],
          generation
        );
        if (cmd === 16 || cmd === 17) {
          for (let key of ["tabId", "frameId"]) {
            if (Object.hasOwn(reply, key) && reply[key] !== context[key]) {
              throw new ApplePasswordError();
            }
          }
        }
        validateFillPolicy(reply);
        let payload = object(reply.payload);
        validateFillPolicy(payload);
        if (
          payload.QID !== undefined &&
          payload.QID !== qid &&
          !(
            cmd === 6 &&
            reply.cmd === 4 &&
            payload.QID === "CmdGetLoginNames4URL"
          )
        ) {
          throw new ApplePasswordError();
        }
        let envelope = object(payload.SMSG);
        validateFillPolicy(envelope);
        if (envelope.TID !== session.tid) {
          throw new ApplePasswordError();
        }
        let response = await session.decryptJSON(envelope.SDATA);
        this.#guard(generation);
        if (response.STATUS === 3) {
          if (cmd === 4) {
            return [];
          }
          if (cmd === 5) {
            throw new ApplePasswordError("no-results");
          }
        }
        validateFillPolicy(response);
        if (!Number.isInteger(response.STATUS)) {
          throw new ApplePasswordError();
        }
        if (response.STATUS !== 0) {
          if (response.STATUS === 3 && cmd !== 5 && cmd !== 6) {
            return [];
          }
          let code =
            new Map([
              [2, "invalid-argument"],
              [3, cmd === 6 ? "save-failed" : "no-results"],
              [5, "save-failed"],
              [7, "duplicate-item"],
              [9, "invalid-session"],
            ]).get(response.STATUS) ?? "native-error";
          throw new ApplePasswordError(code);
        }
        return convert(response);
      },
      authentication ? this.#authenticationTimeout : this.#requestTimeout
    );
  }

  #launchApp(fields, setup, isCurrent, beforeDispatch) {
    if (
      typeof isCurrent !== "function" ||
      typeof beforeDispatch !== "function"
    ) {
      return Promise.reject(new ApplePasswordError("invalid-argument"));
    }
    return this.#enqueue(async generation => {
      if (!isCurrent()) {
        throw new ApplePasswordError("invalid-session");
      }
      await this.#connect(generation);
      this.#guard(generation);
      if (!isCurrent()) {
        throw new ApplePasswordError("invalid-session");
      }
      if (setup && !this.#canSetUpOneTimeCodes) {
        throw new ApplePasswordError("setup-unavailable");
      }
      if (setup && !this.isReady) {
        throw new ApplePasswordError("locked");
      }
      const targetIsCurrent = await beforeDispatch();
      this.#guard(generation);
      if (targetIsCurrent !== true || isCurrent() !== true) {
        throw new ApplePasswordError("invalid-session");
      }
      if (setup && (!this.isReady || !this.#canSetUpOneTimeCodes)) {
        throw new ApplePasswordError("locked");
      }
      let bytes = encoder.encode(JSON.stringify({ cmd: 13, ...fields }));
      let frame = new Uint8Array(4 + bytes.length);
      frame.set(new Uint8Array(Uint32Array.of(bytes.length).buffer));
      frame.set(bytes, 4);
      try {
        await this.#process.stdin.write(frame.buffer);
      } catch {
        throw new ApplePasswordError("connection-closed");
      } finally {
        // Subprocess transfers the frame buffer to its IO worker.
        if (frame.byteLength) {
          frame.fill(0);
        }
        bytes.fill(0);
      }
      this.#guard(generation);
      return { dispatched: true };
    });
  }

  async openPasswordsApp(
    origin,
    { isCurrent = () => true, beforeDispatch = () => true } = {}
  ) {
    let context = originInfo(origin);
    if (!context.origin.startsWith("https://")) {
      throw new ApplePasswordError("invalid-origin");
    }
    return this.#launchApp(
      { searchQueryURL: context.origin },
      false,
      isCurrent,
      beforeDispatch
    );
  }

  async setUpOneTimeCode(
    origin,
    uri,
    { isCurrent = () => true, beforeDispatch = () => true } = {}
  ) {
    let context = originInfo(origin);
    if (!context.origin.startsWith("https://")) {
      throw new ApplePasswordError("invalid-origin");
    }
    validateApplePasswordSetupURI(uri);
    if (!this.isReady) {
      throw new ApplePasswordError("locked");
    }
    return this.#launchApp(
      {
        setUpTOTPPageURL: new URL(context.origin).hostname,
        setUpTOTPURI: uri,
      },
      true,
      isCurrent,
      beforeDispatch
    );
  }

  async listAccounts(origin) {
    let context = originInfo(origin);
    return this.#operation(
      4,
      "CmdGetLoginNames4URL",
      context,
      { ACT: 5, URL: context.host },
      response =>
        entries(response)
          .filter(entry => entry.USR !== NO_SAVED_PASSWORDS)
          .map(entry => account(entry))
    );
  }

  async getPassword(origin, selectedAccount) {
    let context = originInfo(origin);
    if (!selectedAccount || !string(selectedAccount.username)) {
      throw new ApplePasswordError("invalid-argument");
    }
    let username = selectedAccount.username;
    let lookupSite = passwordLookupSite(context, selectedAccount);
    return this.#operation(
      5,
      "CmdGetPassword4LoginName",
      { ...context, lookupSite },
      { ACT: 2, URL: lookupSite, USR: username },
      response => {
        let matches = entries(response).filter(
          entry => entry.USR === username && entry.USR !== NO_SAVED_PASSWORDS
        );
        if (matches.length !== 1) {
          throw new ApplePasswordError(
            matches.length ? "protocol-error" : "no-results"
          );
        }
        return account(matches[0], true);
      },
      true
    );
  }

  async savePassword(login) {
    if (
      !login ||
      !string(login.username) ||
      !string(login.password) ||
      (login.oldUsername !== undefined && !string(login.oldUsername)) ||
      (login.oldPassword !== undefined && !string(login.oldPassword))
    ) {
      throw new ApplePasswordError("invalid-argument");
    }
    let context = originInfo(login.origin);
    // A cmd4 reply does not confirm that the password was stored.
    return this.#operation(
      6,
      "CmdSetPassword4LoginName_URL",
      context,
      {
        ACT: 4,
        URL: "",
        USR: "",
        PWD: "",
        NURL: context.host,
        NUSR: login.username,
        NPWD: login.password,
      },
      () => ({ accepted: true, verified: false }),
      true
    );
  }

  #oneTimeCodes(origin, withCodes, options, username) {
    let context = validateApplePasswordOTPContext(origin, options);
    if (withCodes && (!string(username, 4096) || /\p{Cc}/u.test(username))) {
      throw new ApplePasswordError("invalid-argument");
    }
    return this.#operation(
      withCodes ? 17 : 16,
      withCodes ? "CmdDidFillOneTimeCode" : "CmdGetOneTimeCodes",
      context,
      {
        ACT: withCodes ? 2 : 5,
        TYPE: "oneTimeCodes",
        frameURLs: context.frameURLs,
        ...(withCodes ? { username } : {}),
      },
      response =>
        entries(response)
          .filter(entry => entry.source === "totp")
          .map(entry => oneTimeCode(entry, withCodes)),
      withCodes
    );
  }

  async listOneTimeCodes(origin, options = {}) {
    return this.#oneTimeCodes(origin, false, options);
  }

  async getOneTimeCodes(origin, options = {}) {
    return this.#oneTimeCodes(origin, true, options, options?.username);
  }
}
