/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ApplePasswordManager: "resource:///modules/ApplePasswordManager.sys.mjs",
  discoverApplePasswordHost: "resource:///modules/ApplePasswordManager.sys.mjs",
  validateApplePasswordOTPContext:
    "resource:///modules/ApplePasswordManager.sys.mjs",
  validateApplePasswordSetupURI:
    "resource:///modules/ApplePasswordManager.sys.mjs",
});

const PREF_BRANCH = "waterfox.passwords.icloud.";
const MACOS_SONOMA_DARWIN_VERSION = "23";
const STATE_TOPIC = "icloud-passwords-state-changed";
const SESSION_TOPICS = [
  "last-pb-context-exited",
  "sleep_notification",
  "quit-application-granted",
  "profile-before-change",
];
const STATES = new Set([
  "disconnected",
  "connecting",
  "locked",
  "pairing",
  "ready",
]);
const ERROR_IDS = Object.freeze({
  disabled: "icloud-passwords-error-disabled",
  unsupported: "icloud-passwords-error-unsupported",
  unavailable: "icloud-passwords-error-unavailable",
  locked: "icloud-passwords-error-locked",
  cancelled: "icloud-passwords-error-cancelled",
  "invalid-pin": "icloud-passwords-error-invalid-pin",
  "authentication-failed": "icloud-passwords-error-authentication",
  timeout: "icloud-passwords-error-timeout",
  "invalid-origin": "icloud-passwords-error-origin",
  "account-mismatch": "icloud-passwords-error-account",
  "ambiguous-account": "icloud-passwords-error-ambiguous",
  "no-code": "icloud-passwords-error-no-code",
  "otp-disabled": "icloud-passwords-error-otp-disabled",
  "save-failed": "icloud-passwords-error-save",
  "manager-unavailable": "icloud-passwords-error-manager",
  "setup-invalid": "icloud-passwords-error-setup-invalid",
  "setup-unavailable": "icloud-passwords-error-setup-unavailable",
  "session-changed": "icloud-passwords-error-session",
  "native-error": "icloud-passwords-error-native",
});
const ERROR_ALIASES = Object.freeze({
  "not-supported": "unsupported",
  "host-not-found": "unavailable",
  "host-unavailable": "unavailable",
  "not-installed": "unavailable",
  "not-available": "unavailable",
  "unsupported-protocol": "unavailable",
  "connection-closed": "unavailable",
  "not-ready": "locked",
  "invalid-session": "locked",
  "native-auth-required": "authentication-failed",
  "no-results": "account-mismatch",
  "duplicate-item": "ambiguous-account",
  canceled: "cancelled",
  "invalid-code": "invalid-pin",
  "pin-invalid": "invalid-pin",
  "auth-failed": "authentication-failed",
  "pairing-failed": "authentication-failed",
  "request-timeout": "timeout",
});

/** Exposes only a safe error code and a Fluent message ID. */
export class ICloudPasswordsError extends Error {
  constructor(code) {
    code = Object.hasOwn(ERROR_IDS, code) ? code : "native-error";
    super(ERROR_IDS[code]);
    this.name = "ICloudPasswordsError";
    this.code = code;
    this.l10nId = ERROR_IDS[code];
  }
}

function errorCode(error) {
  let code = typeof error == "string" ? error : error?.code;
  if (typeof code != "string" || code.length > 100) {
    return "native-error";
  }
  code = code.toLowerCase().replaceAll("_", "-");
  if (Object.hasOwn(ERROR_IDS, code)) {
    return code;
  }
  return Object.hasOwn(ERROR_ALIASES, code)
    ? ERROR_ALIASES[code]
    : "native-error";
}

function validString(value, maxLength = 4096) {
  return typeof value == "string" && value.length <= maxLength;
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 1000) {
    throw new ICloudPasswordsError("native-error");
  }
}

function parseOrigin(origin) {
  try {
    if (!validString(origin) || /[\p{Cc}\s\\]/u.test(origin)) {
      throw new Error();
    }
    let url = new URL(origin);
    if (
      url.protocol != "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname != "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url;
  } catch {
    throw new ICloudPasswordsError("invalid-origin");
  }
}

function parseSite(site) {
  if (
    !validString(site) ||
    !site ||
    /^[/?#]/.test(site) ||
    /[\p{Cc}\s\\]/u.test(site)
  ) {
    return null;
  }
  try {
    let url = new URL(site.includes("://") ? site : `https://${site}`);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function siteMatches(origin, site) {
  if (!site || origin.port != site.port) {
    return false;
  }
  let host = origin.hostname.replace(/\.$/, "");
  let siteHost = site.hostname.replace(/\.$/, "");
  if (host == siteHost) {
    return true;
  }
  if (!host.endsWith(`.${siteHost}`)) {
    return false;
  }
  try {
    return (
      Services.eTLD.getBaseDomainFromHost(host) ==
      Services.eTLD.getBaseDomainFromHost(siteHost)
    );
  } catch {
    // IPs, public suffixes and hosts with one label must match exactly.
    return false;
  }
}

function accountsForOrigin(accounts, origin) {
  validateEntries(accounts);
  let result = [];
  for (let account of accounts) {
    if (
      !validString(account?.username) ||
      !Array.isArray(account.sites) ||
      account.sites.length > 100
    ) {
      continue;
    }
    let sites = account.sites
      .map(parseSite)
      .filter(site => siteMatches(origin, site))
      .map(site => site.origin);
    sites = [...new Set(sites)].sort();
    if (sites.length) {
      result.push({ username: account.username, sites });
    }
  }
  return result;
}

function sameAccount(a, b) {
  return (
    a.username === b.username &&
    a.sites.length == b.sites.length &&
    a.sites.every((site, index) => site === b.sites[index])
  );
}

// The helper scopes by frameURLs; domain is an opaque issuer label, not an origin.
function otpIdentity(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  let { username, domain, source } = entry;
  if (
    !validString(username) ||
    /\p{Cc}/u.test(username) ||
    !validString(domain, 8192) ||
    !domain ||
    /\p{Cc}/u.test(domain) ||
    source !== "totp"
  ) {
    return null;
  }
  return Object.freeze({ username, domain, source });
}

function sameOTPIdentity(left, right) {
  return (
    left?.source === right.source &&
    left.username === right.username &&
    left.domain === right.domain
  );
}

function createTimer(callback, delay) {
  let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback(callback, delay, Ci.nsITimer.TYPE_ONE_SHOT);
  return timer;
}

async function promptForPIN(parent, { title, text, signal }) {
  signal.throwIfAborted();
  let ownerWindow =
    parent?.documentGlobal ??
    parent?.ownerGlobal ??
    parent ??
    Services.wm.getMostRecentWindow("navigator:browser");
  ownerWindow = ownerWindow?.wrappedJSObject ?? ownerWindow;
  if (ownerWindow?.closed || !ownerWindow?.gDialogBox) {
    return null;
  }
  let args = Cc["@mozilla.org/hash-property-bag;1"].createInstance(
    Ci.nsIWritablePropertyBag
  );
  args.setProperty("async", true);
  args.setProperty("title", title);
  args.setProperty("text", text);
  args.setProperty("pin", null);
  let dialogBox = ownerWindow.gDialogBox;
  let host = ownerWindow.document.getElementById("window-modal-dialog");
  let dialog, onAbort, onClosed;
  try {
    await new Promise((resolve, reject) => {
      onAbort = () => {
        args.setProperty("pin", null);
        let input = dialog?.frameContentWindow?.document.getElementById("pin");
        if (input) {
          input.value = "";
        }
        dialog?.abort();
        reject(signal.reason);
      };
      let open = () => {
        if (signal.aborted) {
          onAbort();
          return;
        }
        // Wait outside gDialogBox's queue so an expired prompt never opens later.
        if (dialogBox.isOpen || dialogBox._queued.length) {
          return;
        }
        host.removeEventListener("close", onClosed);
        let closed = dialogBox.open(
          "chrome://browser/content/waterfox/icloudpasswords/pinDialog.xhtml",
          args
        );
        dialog = dialogBox.dialog;
        if (signal.aborted) {
          onAbort();
        }
        closed.then(resolve, reject);
      };
      onClosed = () => Services.tm.dispatchToMainThread(open);
      signal.addEventListener("abort", onAbort, { once: true });
      host.addEventListener("close", onClosed);
      open();
    });
    signal.throwIfAborted();
    return args.getProperty("pin");
  } finally {
    signal.removeEventListener("abort", onAbort);
    host.removeEventListener("close", onClosed);
    args.setProperty("pin", null);
  }
}

function localFile(path) {
  let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

function launchManager(platform) {
  if (platform == "macosx") {
    let file = localFile("/System/Applications/Passwords.app");
    if (file.exists()) {
      file.launch();
      return;
    }
    Cc["@mozilla.org/uriloader/external-protocol-service;1"]
      .getService(Ci.nsIExternalProtocolService)
      .loadURI(
        Services.io.newURI("x-apple.systempreferences:com.apple.Passwords")
      );
    return;
  } else if (platform == "win") {
    let registry = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
      Ci.nsIWindowsRegKey
    );
    for (let root of [
      registry.ROOT_KEY_CURRENT_USER,
      registry.ROOT_KEY_LOCAL_MACHINE,
    ]) {
      for (let view of [registry.WOW64_64, registry.WOW64_32]) {
        let path;
        try {
          registry.open(
            root,
            "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\iCloudPasswords.exe",
            registry.ACCESS_READ | view
          );
          path = registry.readStringValue("");
        } catch {
          continue;
        } finally {
          registry.close();
        }
        let file = localFile(path);
        if (
          file.leafName.toLowerCase() == "icloudpasswords.exe" &&
          file.exists() &&
          file.isFile()
        ) {
          let process = Cc["@mozilla.org/process/util;1"].createInstance(
            Ci.nsIProcess
          );
          process.init(file);
          process.runw(false, [], 0);
          return;
        }
      }
    }
  }
  throw new ICloudPasswordsError("manager-unavailable");
}

/** Credential access requires an explicit unlock and lasts for that session. */
export class ICloudPasswordsService {
  #prefs;
  #observers;
  #platform;
  #platformVersion;
  #discoverHost;
  #clientFactory;
  #client = null;
  #promptPIN;
  #localization;
  #timerFactory;
  #timer = null;
  #now;
  #wallNow;
  #launchManager;
  #state = "disconnected";
  #lastErrorCode = null;
  #generation = 0;
  #lastActivity = 0;
  #unlockPromise = null;
  #pinPrompt = null;
  #closing = Promise.resolve();
  #destroyed = false;

  constructor({
    client,
    clientFactory = options => client ?? new lazy.ApplePasswordManager(options),
    platform = AppConstants.platform,
    platformVersion = Services.sysinfo.getProperty("version"),
    discoverHost = options => lazy.discoverApplePasswordHost(options),
    prefs = Services.prefs,
    observers = Services.obs,
    promptPIN = promptForPIN,
    localization = null,
    timerFactory = createTimer,
    now = () => ChromeUtils.now(),
    wallNow = () => Date.now(),
    openManager = launchManager,
  } = {}) {
    if (Services.appinfo.processType != Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT) {
      throw new Error("ICloudPasswords is parent-process only");
    }
    this.#prefs = prefs;
    this.#observers = observers;
    this.#platform = platform;
    this.#platformVersion = platformVersion;
    this.#discoverHost = discoverHost;
    this.#clientFactory = clientFactory;
    // promptPIN(parent, { title, text, signal }) accepts an optional AbortSignal.
    // Injected UI callbacks should clear/close only their own prompt on abort.
    this.#promptPIN = promptPIN;
    this.#localization = localization;
    this.#timerFactory = timerFactory;
    this.#now = now;
    this.#wallNow = wallNow;
    this.#launchManager = openManager;
    prefs.addObserver(PREF_BRANCH, this);
    for (let topic of SESSION_TOPICS) {
      observers.addObserver(this, topic);
    }
  }

  get enabled() {
    return (
      !this.#destroyed &&
      this.#prefs.getBoolPref(`${PREF_BRANCH}enabled`, false)
    );
  }

  get supported() {
    let platformSupported = this.#platform === "win";
    if (this.#platform === "macosx") {
      platformSupported =
        Services.vc.compare(
          this.#platformVersion,
          MACOS_SONOMA_DARWIN_VERSION
        ) >= 0;
    }
    return platformSupported && this.#client?.supported !== false;
  }

  get state() {
    this.#expireIdleSession();
    return this.enabled && this.supported ? this.#state : "disconnected";
  }

  get isReady() {
    return this.state == "ready" && this.#client?.isReady === true;
  }

  get saveByDefault() {
    return this.#prefs.getBoolPref(`${PREF_BRANCH}saveByDefault`, false);
  }

  get otpEnabled() {
    return this.#prefs.getBoolPref(`${PREF_BRANCH}otp.enabled`, false);
  }

  get lastErrorCode() {
    return this.#lastErrorCode;
  }

  async isAvailable() {
    if (!this.supported) {
      return false;
    }
    if (this.#platform !== "win") {
      return true;
    }
    try {
      const host = await this.#discoverHost({ platform: this.#platform });
      return !!host && (await IOUtils.stat(host.command)).type === "regular";
    } catch {
      return false;
    }
  }

  setEnabled(value) {
    if (typeof value != "boolean") {
      throw new TypeError("enabled must be a boolean");
    }
    this.#prefs.setBoolPref(`${PREF_BRANCH}enabled`, value);
    if (!value) {
      return;
    }
    for (const pref of ["saveByDefault", "otp.enabled"]) {
      const name = `${PREF_BRANCH}${pref}`;
      if (!this.#prefs.prefIsLocked(name)) {
        this.#prefs.setBoolPref(name, true);
      }
    }
  }

  async getStatus() {
    let available = false;
    if (this.enabled && this.supported) {
      try {
        let client = this.#ensureClient();
        let generation = this.#generation;
        let status = await client.getStatus();
        this.#assertSession(client, generation);
        available = status.supported !== false && status.available === true;
        this.#nativeStateChanged(client.state);
        if (status.error) {
          this.#setError(errorCode(status.error));
        }
      } catch (error) {
        if (this.enabled) {
          this.#setError(errorCode(error));
        }
      }
    }
    let status = { supported: this.supported, available, state: this.state };
    if (this.#lastErrorCode) {
      status.errorCode = this.#lastErrorCode;
      status.error = await this.#errorMessage(this.#lastErrorCode);
    }
    return status;
  }

  async unlock(parent) {
    return this.#withErrors(async () => {
      this.#requireEnabled();
      if (this.isReady) {
        this.#touch();
        return true;
      }
      if (this.#unlockPromise) {
        return this.#unlockPromise;
      }
      let pending = this.#unlock(parent);
      this.#unlockPromise = pending;
      try {
        return await pending;
      } finally {
        this.#unlockPromise = null;
      }
    });
  }

  async lock() {
    await this.#closeSession();
  }

  async listAccounts(origin) {
    return this.#withErrors(async () => {
      let url = parseOrigin(origin);
      if (!this.isReady) {
        return [];
      }
      let client = this.#client;
      let generation = this.#generation;
      let accounts = accountsForOrigin(
        await client.listAccounts(url.origin),
        url
      );
      this.#assertSession(client, generation, true);
      this.#touch();
      return [
        ...new Map(
          accounts.map(account => [JSON.stringify(account), account])
        ).values(),
      ];
    });
  }

  async getPassword(origin, account, parent) {
    return this.#withErrors(async () => {
      let url = parseOrigin(origin);
      let selection = accountsForOrigin([account], url)[0];
      if (!selection) {
        throw new ICloudPasswordsError("account-mismatch");
      }
      if (!(await this.unlock(parent))) {
        return null;
      }
      let client = this.#client;
      let generation = this.#generation;
      let result = await this.#readPassword(
        url,
        selection.username,
        client,
        generation,
        selection
      );
      this.#assertSession(client, generation, true);
      return result;
    });
  }

  async listOneTimeCodes(origin, options = {}) {
    return this.#withErrors(async () => {
      let url = parseOrigin(origin);
      let context = lazy.validateApplePasswordOTPContext(url.origin, options);
      if (!this.otpEnabled || !this.isReady) {
        return [];
      }
      let client = this.#client;
      if (client.canFillOneTimeCodes !== true) {
        return [];
      }
      let generation = this.#generation;
      let entries;
      try {
        entries = await client.listOneTimeCodes(url.origin, context);
      } catch (error) {
        this.#assertSession(client, generation, true);
        throw error;
      }
      this.#assertSession(client, generation, true);
      if (!this.otpEnabled || client.canFillOneTimeCodes !== true) {
        return [];
      }
      validateEntries(entries);
      let identities = entries.map(otpIdentity).filter(Boolean);
      this.#touch();
      return [
        ...new Map(
          identities.map(entry => [JSON.stringify(entry), entry])
        ).values(),
      ];
    });
  }

  async getOneTimeCode(origin, account, parent, options = {}) {
    return this.#withErrors(async () => {
      let url = parseOrigin(origin);
      let context = lazy.validateApplePasswordOTPContext(url.origin, options);
      if (!this.otpEnabled) {
        throw new ICloudPasswordsError("otp-disabled");
      }
      let selection = otpIdentity(account);
      if (!selection) {
        throw new ICloudPasswordsError("account-mismatch");
      }
      let unlocking = this.unlock(parent);
      let generation = this.#generation;
      if (!(await unlocking)) {
        return null;
      }
      let client = this.#client;
      try {
        this.#assertOTPSession(client, generation);
        let metadata = await client.listOneTimeCodes(url.origin, context);
        this.#assertOTPSession(client, generation);
        validateEntries(metadata);
        let candidates = metadata
          .map(otpIdentity)
          .filter(identity => sameOTPIdentity(identity, selection));
        if (candidates.length > 1) {
          throw new ICloudPasswordsError("ambiguous-account");
        }
        if (candidates.length !== 1) {
          throw new ICloudPasswordsError("account-mismatch");
        }
        let entries = await client.getOneTimeCodes(
          url.origin,
          Object.freeze({ ...context, username: selection.username })
        );
        this.#assertOTPSession(client, generation);
        validateEntries(entries);
        let matches = entries.filter(entry =>
          sameOTPIdentity(otpIdentity(entry), selection)
        );
        if (matches.length > 1) {
          throw new ICloudPasswordsError("ambiguous-account");
        }
        let entry = matches[0];
        if (
          !entry ||
          typeof entry.code != "string" ||
          entry.code.length < 4 ||
          entry.code.length > 10 ||
          /[^0-9]/.test(entry.code) ||
          (entry.expiresAt !== undefined &&
            (!Number.isFinite(entry.expiresAt) ||
              entry.expiresAt <= this.#wallNow()))
        ) {
          throw new ICloudPasswordsError("no-code");
        }
        this.#succeeded();
        this.#assertOTPSession(client, generation);
        return { ...otpIdentity(entry), code: entry.code };
      } catch (error) {
        this.#assertSession(client, generation, true);
        throw error;
      }
    });
  }

  async saveLogin(parent, login) {
    return this.#withErrors(async () => {
      let url = parseOrigin(login?.origin);
      if (
        !validString(login.username) ||
        !validString(login.password, 1048576) ||
        (login.oldUsername !== undefined && !validString(login.oldUsername)) ||
        (login.oldPassword !== undefined &&
          !validString(login.oldPassword, 1048576))
      ) {
        throw new ICloudPasswordsError("save-failed");
      }
      let request = {
        origin: url.origin,
        username: login.username,
        password: login.password,
      };
      for (let key of ["oldUsername", "oldPassword"]) {
        if (login[key] !== undefined) {
          request[key] = login[key];
        }
      }
      if (!(await this.unlock(parent))) {
        return false;
      }
      let client = this.#client;
      let generation = this.#generation;
      let result = await client.savePassword(request);
      this.#assertSession(client, generation, true);
      if (result?.accepted !== true || result.verified !== false) {
        throw new ICloudPasswordsError("save-failed");
      }
      this.#succeeded();
      this.#assertSession(client, generation, true);
      return { accepted: true, verified: false };
    });
  }

  /**
   * Verifies without writing; false does not prove the credential is absent.
   * Ambiguity, native read errors and invalidated sessions reject.
   *
   * @param {Window|Element|null} parent - Authentication prompt owner.
   * @param {object} login - Expected origin, username and password.
   * @returns {Promise<boolean>} Whether the stored credential matches login.
   */
  async verifySavedLogin(parent, login) {
    return this.#withErrors(async () => {
      let url = parseOrigin(login?.origin);
      let { username, password } = login;
      if (
        !validString(username) ||
        username.includes("\0") ||
        !validString(password, 1048576) ||
        password.includes("\0")
      ) {
        throw new ICloudPasswordsError("account-mismatch");
      }
      let unlocking = this.unlock(parent);
      let generation = this.#generation;
      if (!(await unlocking)) {
        return false;
      }
      let client = this.#client;
      try {
        let result = await this.#readPassword(
          url,
          username,
          client,
          generation
        );
        this.#assertSession(client, generation, true);
        return result.password === password;
      } catch (error) {
        this.#assertSession(client, generation, true);
        if (errorCode(error) === "account-mismatch") {
          return false;
        }
        throw error;
      }
    });
  }

  async setUpOneTimeCode(
    origin,
    uri,
    parent,
    { isCurrent = () => true, beforeDispatch = () => true } = {}
  ) {
    return this.#withErrors(async () => {
      let url = parseOrigin(origin);
      this.#requireEnabled();
      if (!this.otpEnabled) {
        throw new ICloudPasswordsError("otp-disabled");
      }
      try {
        lazy.validateApplePasswordSetupURI(uri);
      } catch {
        throw new ICloudPasswordsError("setup-invalid");
      }
      if (
        typeof isCurrent !== "function" ||
        typeof beforeDispatch !== "function" ||
        isCurrent() !== true
      ) {
        throw new ICloudPasswordsError("session-changed");
      }
      let client = this.#ensureClient();
      let generation = this.#generation;
      await client.connect();
      this.#assertSession(client, generation);
      if (!this.otpEnabled || !isCurrent()) {
        throw new ICloudPasswordsError("session-changed");
      }
      if (client.canSetUpOneTimeCodes !== true) {
        throw new ICloudPasswordsError("setup-unavailable");
      }
      if (!(await this.unlock(parent))) {
        return null;
      }
      this.#assertSession(client, generation, true);
      const current = () =>
        isCurrent() &&
        this.enabled &&
        this.otpEnabled &&
        this.#client === client &&
        this.#generation === generation &&
        this.isReady &&
        client.canSetUpOneTimeCodes === true;
      if (!current()) {
        throw new ICloudPasswordsError("session-changed");
      }
      let result;
      try {
        result = await client.setUpOneTimeCode(url.origin, uri, {
          isCurrent: current,
          beforeDispatch: async () =>
            current() && (await beforeDispatch()) === true && current(),
        });
      } catch (error) {
        if (error?.code === "invalid-argument") {
          throw new ICloudPasswordsError("setup-invalid");
        }
        throw error;
      }
      this.#assertSession(client, generation, true);
      if (!current()) {
        throw new ICloudPasswordsError("session-changed");
      }
      if (result?.dispatched !== true) {
        throw new ICloudPasswordsError("native-error");
      }
      this.#succeeded();
      return { dispatched: true };
    });
  }

  async openManager(
    origin,
    { isCurrent = () => true, beforeDispatch = () => true } = {}
  ) {
    return this.#withErrors(async () => {
      if (!this.supported) {
        throw new ICloudPasswordsError("unsupported");
      }
      if (origin !== undefined) {
        let url = parseOrigin(origin);
        this.#requireEnabled();
        if (
          typeof isCurrent !== "function" ||
          typeof beforeDispatch !== "function" ||
          isCurrent() !== true
        ) {
          throw new ICloudPasswordsError("session-changed");
        }
        let client = this.#ensureClient();
        let generation = this.#generation;
        const current = () =>
          isCurrent() &&
          this.enabled &&
          this.#client === client &&
          this.#generation === generation;
        let result = await client.openPasswordsApp(url.origin, {
          isCurrent: current,
          beforeDispatch: async () =>
            current() && (await beforeDispatch()) === true && current(),
        });
        this.#assertSession(client, generation);
        if (!current()) {
          throw new ICloudPasswordsError("session-changed");
        }
        return result;
      }
      try {
        await this.#launchManager(this.#platform);
      } catch {
        throw new ICloudPasswordsError("manager-unavailable");
      }
      return undefined;
    });
  }

  observe(subject, topic, pref) {
    if (topic == "nsPref:changed") {
      if (pref == `${PREF_BRANCH}enabled` && !this.enabled) {
        void this.#closeSession();
      } else if (pref == `${PREF_BRANCH}idleTimeout`) {
        this.#expireIdleSession();
        if (this.isReady) {
          this.#scheduleIdleTimer();
        }
      }
      this.#notify();
    } else if (topic == "profile-before-change") {
      void this.destroy();
    } else {
      let completion;
      if (topic == "last-pb-context-exited") {
        try {
          completion = subject
            ?.QueryInterface(Ci.nsIPBMCleanupCollector)
            .addPendingCleanup();
        } catch {}
      }
      this.#closeSession().then(() => completion?.complete(Cr.NS_OK));
    }
  }

  async destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      this.#prefs.removeObserver(PREF_BRANCH, this);
      for (let topic of SESSION_TOPICS) {
        this.#observers.removeObserver(this, topic);
      }
      await this.#closeSession();
    }
  }

  async #readPassword(url, username, client, generation, selection = null) {
    this.#assertSession(client, generation, true);
    let nativeAccounts = await client.listAccounts(url.origin);
    this.#assertSession(client, generation, true);
    let accounts = accountsForOrigin(nativeAccounts, url).filter(
      candidate => candidate.username === username
    );
    if (accounts.length > 1) {
      throw new ICloudPasswordsError("ambiguous-account");
    }
    if (
      accounts.length != 1 ||
      (selection && !sameAccount(selection, accounts[0]))
    ) {
      throw new ICloudPasswordsError("account-mismatch");
    }
    let nativeAccount = nativeAccounts.find(
      candidate =>
        candidate?.username === username &&
        accountsForOrigin([candidate], url).length
    );
    let result = await client.getPassword(url.origin, {
      username,
      sites: nativeAccount.sites.filter(site =>
        siteMatches(url, parseSite(site))
      ),
    });
    this.#assertSession(client, generation, true);
    let identity = accountsForOrigin([result], url)[0];
    if (
      !identity ||
      !sameAccount(identity, accounts[0]) ||
      !validString(result.password, 1048576)
    ) {
      throw new ICloudPasswordsError("account-mismatch");
    }
    this.#succeeded();
    this.#assertSession(client, generation, true);
    return { ...identity, password: result.password };
  }

  #ensureClient() {
    this.#requireEnabled();
    if (!this.#client) {
      let client;
      client = this.#clientFactory({
        onStateChange: (_state, status) => {
          if (this.#client === client) {
            this.#nativeStateChanged(client.state, status?.error);
            if (status?.error) {
              this.#setError(errorCode(status.error));
            }
          }
        },
      });
      this.#client = client;
      this.#nativeStateChanged(client.state);
    }
    return this.#client;
  }

  #nativeStateChanged(state, error) {
    let next = STATES.has(state) ? state : "disconnected";
    if (next !== "pairing") {
      this.#pinPrompt?.abort(
        new ICloudPasswordsError(error ? errorCode(error) : "locked")
      );
    }
    if (next === this.#state) {
      return;
    }
    if (this.#state == "ready") {
      this.#generation++;
    }
    this.#state = next;
    this.#timer?.cancel();
    this.#timer = null;
    if (next == "ready") {
      this.#touch();
    }
    this.#notify();
  }

  #requireEnabled() {
    if (!this.enabled) {
      throw new ICloudPasswordsError("disabled");
    }
    if (!this.supported) {
      throw new ICloudPasswordsError("unsupported");
    }
  }

  #assertSession(client, generation, requireReady = false) {
    if (
      !this.enabled ||
      client !== this.#client ||
      generation != this.#generation
    ) {
      throw new ICloudPasswordsError("session-changed");
    }
    if (requireReady && !this.isReady) {
      throw new ICloudPasswordsError("locked");
    }
  }

  #assertOTPSession(client, generation) {
    this.#assertSession(client, generation, true);
    if (!this.otpEnabled) {
      throw new ICloudPasswordsError("otp-disabled");
    }
    if (client.canFillOneTimeCodes !== true) {
      throw new ICloudPasswordsError("no-code");
    }
  }

  async #unlock(parent) {
    let generation = this.#generation;
    await this.#closing;
    this.#requireEnabled();
    if (generation != this.#generation) {
      throw new ICloudPasswordsError("session-changed");
    }
    let client = this.#ensureClient();
    try {
      await client.connect();
      this.#assertSession(client, generation);
      this.#nativeStateChanged(client.state);
      let needsChallenge = true;
      let messageID = "icloud-passwords-pin-text";
      for (let attempt = 0; attempt < 3 && !client.isReady; attempt++) {
        if (needsChallenge) {
          await client.beginPairing();
          this.#assertSession(client, generation);
          this.#nativeStateChanged(client.state);
        }
        if (client.state !== "pairing") {
          throw new ICloudPasswordsError(this.#lastErrorCode ?? "locked");
        }
        let controller = new AbortController();
        this.#pinPrompt = controller;
        let { signal } = controller;
        let onAbort;
        let aborted = new Promise((resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        let pin = null;
        try {
          let [title, text] = await Promise.race([
            this.#l10n.formatValues([
              { id: "icloud-passwords-pin-title" },
              { id: messageID },
            ]),
            aborted,
          ]);
          signal.throwIfAborted();
          this.#assertSession(client, generation);
          pin = await Promise.race([
            this.#promptPIN(parent, { title, text, signal }),
            aborted,
          ]);
          signal.throwIfAborted();
          this.#assertSession(client, generation);
          if (pin === null) {
            this.#setError("cancelled");
            await this.#closeSession();
            return false;
          }
          if (typeof pin != "string" || pin.length != 6 || /[^0-9]/.test(pin)) {
            needsChallenge = false;
            messageID = "icloud-passwords-pin-invalid";
            if (attempt == 2) {
              throw new ICloudPasswordsError("invalid-pin");
            }
            continue;
          }
          this.#pinPrompt = null;
          try {
            await client.completePairing(pin);
          } catch (error) {
            this.#assertSession(client, generation);
            if (
              !["invalid-pin", "authentication-failed"].includes(
                errorCode(error)
              ) ||
              attempt == 2
            ) {
              throw error;
            }
            needsChallenge = true;
            messageID = "icloud-passwords-pin-retry";
          }
        } finally {
          pin = null;
          signal.removeEventListener("abort", onAbort);
          if (this.#pinPrompt === controller) {
            this.#pinPrompt = null;
          }
        }
        this.#assertSession(client, generation);
        this.#nativeStateChanged(client.state);
      }
      if (!client.isReady) {
        throw new ICloudPasswordsError("locked");
      }
      this.#nativeStateChanged(client.state);
      this.#assertSession(client, generation, true);
      this.#succeeded();
      this.#assertSession(client, generation, true);
      return true;
    } catch (error) {
      if (this.#client === client) {
        await this.#closeSession();
      }
      throw error;
    }
  }

  #closeSession() {
    this.#pinPrompt?.abort(new ICloudPasswordsError("session-changed"));
    let client = this.#client;
    this.#client = null;
    this.#generation++;
    this.#timer?.cancel();
    this.#timer = null;
    this.#state = this.enabled && this.supported ? "locked" : "disconnected";
    let cleanup;
    try {
      cleanup = Promise.resolve(client?.lock());
    } catch (error) {
      cleanup = Promise.reject(error);
    }
    cleanup = cleanup.catch(error => this.#setError(errorCode(error)));
    this.#closing = Promise.all([this.#closing, cleanup]).then(() => {});
    this.#notify();
    return this.#closing;
  }

  get #idleMilliseconds() {
    let seconds = this.#prefs.getIntPref(`${PREF_BRANCH}idleTimeout`, 900);
    return (seconds > 0 ? Math.min(seconds, 86400) : 900) * 1000;
  }

  #touch() {
    this.#lastActivity = this.#now();
    this.#scheduleIdleTimer();
  }

  #scheduleIdleTimer() {
    this.#timer?.cancel();
    let remaining = this.#idleMilliseconds - (this.#now() - this.#lastActivity);
    this.#timer = this.#timerFactory(
      () => {
        this.#timer = null;
        this.#expireIdleSession();
        if (this.isReady) {
          this.#scheduleIdleTimer();
        }
      },
      Math.max(1, Math.ceil(remaining))
    );
  }

  #expireIdleSession() {
    if (
      this.#state == "ready" &&
      this.#now() - this.#lastActivity >= this.#idleMilliseconds
    ) {
      void this.#closeSession();
    }
  }

  get #l10n() {
    return (this.#localization ??= new Localization([
      "browser/waterfox/icloud-provider.ftl",
    ]));
  }

  async #errorMessage(code) {
    try {
      return (await this.#l10n.formatValue(ERROR_IDS[code])) || ERROR_IDS[code];
    } catch {
      return ERROR_IDS[code];
    }
  }

  async #withErrors(callback) {
    try {
      return await callback();
    } catch (error) {
      let code = errorCode(error);
      this.#setError(code);
      let sanitized = new ICloudPasswordsError(code);
      sanitized.message = await this.#errorMessage(code);
      throw sanitized;
    }
  }

  #setError(code) {
    if (this.#lastErrorCode !== code) {
      this.#lastErrorCode = code;
      this.#notify();
    }
  }

  #succeeded() {
    let hadError = this.#lastErrorCode !== null;
    this.#lastErrorCode = null;
    this.#touch();
    if (hadError) {
      this.#notify();
    }
  }

  #notify() {
    this.#observers.notifyObservers(null, STATE_TOPIC);
  }
}

export const ICloudPasswords = new ICloudPasswordsService();
