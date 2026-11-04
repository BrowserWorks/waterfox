/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ICloudPasswords: "resource:///modules/ICloudPasswords.sys.mjs",
  validateApplePasswordSetupURI:
    "resource:///modules/ApplePasswordManager.sys.mjs",
});

const WORKER =
  "chrome://browser/content/waterfox/icloudpasswords/ICloudPasswordsQRWorker.js";
const MAX_SIDE = 1024;
const MAX_PIXELS = MAX_SIDE * MAX_SIDE;
const MAX_URI = 4096;

function bounded(promise, signal, milliseconds, dispose = () => {}) {
  return new Promise(resolve => {
    let finished = false;
    const finish = value => {
      if (finished) {
        dispose(value);
        return;
      }
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(onAbort, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(finish, () => finish(null));
    if (signal.aborted) {
      onAbort();
    }
  });
}

export function decodeICloudSetupQR(
  { width, height, data },
  { signal, workerFactory, timeout = 1000 } = {}
) {
  if (
    signal?.aborted ||
    typeof workerFactory !== "function" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    width * height > MAX_PIXELS ||
    !data ||
    typeof data !== "object" ||
    ChromeUtils.getClassName(data) !== "Uint8ClampedArray" ||
    data.length !== width * height * 4 ||
    data.byteOffset !== 0 ||
    data.buffer.byteLength !== data.byteLength
  ) {
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    let worker;
    let timer;
    let finished = false;
    const finish = uri => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (worker) {
        worker.onmessage = worker.onerror = null;
        worker.terminate();
      }
      if (data.byteLength) {
        data.fill(0);
      }
      resolve(uri);
    };
    const onAbort = () => finish(null);
    try {
      worker = workerFactory(WORKER);
      worker.onmessage = event => {
        const uri = event.data?.uri;
        finish(typeof uri === "string" && uri.length <= MAX_URI ? uri : null);
      };
      worker.onerror = event => {
        event.preventDefault();
        finish(null);
      };
      timer = setTimeout(onAbort, Math.min(Math.max(timeout, 1), 1000));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        finish(null);
      } else {
        worker.postMessage({ width, height, rgba: data }, [data.buffer]);
      }
    } catch {
      finish(null);
    }
  });
}

function validatedURI(value) {
  if (typeof value !== "string" || value.length > MAX_URI) {
    return null;
  }
  try {
    lazy.validateApplePasswordSetupURI(value);
    return value;
  } catch {
    return null;
  }
}

function sameDescriptor(a, b) {
  return (
    !!a &&
    !!b &&
    a.kind === b.kind &&
    a.value === b.value &&
    (a.kind !== "qr" || a.rect.every((value, index) => value === b.rect[index]))
  );
}

function descriptor(value) {
  switch (value?.kind) {
    case "none":
      return { kind: "none" };
    case "uri":
      if (typeof value.value !== "string" || value.value.length > MAX_URI) {
        return null;
      }
      return { kind: "uri", value: value.value };
    case "key":
      if (
        typeof value.value !== "string" ||
        !/^[A-Z2-7]{16,128}$/.test(value.value)
      ) {
        return null;
      }
      return { kind: "key", value: value.value };
    case "qr": {
      const rect = value.rect;
      if (
        !Array.isArray(rect) ||
        rect.length !== 4 ||
        !rect.every(Number.isFinite) ||
        rect[0] < 0 ||
        rect[1] < 0 ||
        rect[2] < 16 ||
        rect[3] < 16 ||
        rect[2] > 4096 ||
        rect[3] > 4096
      ) {
        return null;
      }
      return { kind: "qr", rect: [...rect] };
    }
  }
  return null;
}

/** Stores enrollment data in the parent; each handle can be used once. */
export class ICloudPasswordsSetupParent extends JSWindowActorParent {
  #pending = null;
  #inFlight = new Set();
  #destroyed = false;

  // Do not expose native operations through receiveMessage.
  async inspect({ targetIdentifier, timeStamp, browser, signal, isCurrent }) {
    this.clear();
    if (!this.#enabled() || signal.aborted) {
      return null;
    }
    const scope = this.#scope(browser);
    if (
      !scope ||
      targetIdentifier?.browsingContextId !== this.browsingContext.id
    ) {
      return null;
    }
    const record = {
      scope,
      targetIdentifier: { ...targetIdentifier },
      timeStamp,
      allowSetup: this.#enabled(true),
      isCurrent,
      controller: new AbortController(),
      externalSignal: signal,
      handle: Services.uuid.generateUUID().toString(),
      descriptor: null,
      uri: null,
    };
    record.onAbort = () => {
      if (this.#pending === record) {
        this.#pending = null;
      }
      this.#discard(record);
    };
    signal.addEventListener("abort", record.onAbort, { once: true });
    this.#pending = record;
    let accepted = false;
    try {
      record.descriptor = await this.#inspectTarget(record);
      if (!record.descriptor || !this.#current(record)) {
        return null;
      }
      if (record.allowSetup) {
        record.uri = await this.#uri(record, record.descriptor);
      }
      const current = await this.#inspectTarget(record);
      if (
        !sameDescriptor(record.descriptor, current) ||
        !this.#current(record)
      ) {
        return null;
      }
      accepted = true;
      return {
        handle: record.handle,
        canSetUp: !!record.uri || record.descriptor.kind === "key",
      };
    } catch {
      return null;
    } finally {
      if (!accepted && this.#pending === record) {
        this.clear();
      }
    }
  }

  async activate(handle, action, parentWindow, confirmKey) {
    const record = this.#pending;
    if (
      !record ||
      record.handle !== handle ||
      !["setup", "manager"].includes(action)
    ) {
      return { status: "stale" };
    }
    this.#pending = null;
    this.#inFlight.add(record);
    try {
      if (
        !this.#current(record) ||
        parentWindow !== record.scope.browser.documentGlobal
      ) {
        return { status: "stale" };
      }
      const current = await this.#inspectTarget(record);
      if (
        !sameDescriptor(record.descriptor, current) ||
        !this.#current(record)
      ) {
        return { status: "stale" };
      }
      const isCurrent = () =>
        this.#current(record) && this.#enabled(action === "setup");
      const selectedURI = record.uri;
      const beforeDispatch = () =>
        this.#beforeDispatch(record, current, selectedURI, isCurrent);
      if (action === "manager") {
        await lazy.ICloudPasswords.openManager(record.scope.origin, {
          isCurrent,
          beforeDispatch,
        });
        return { status: isCurrent() ? "dispatched" : "stale" };
      }
      if (!this.#enabled(true)) {
        return { status: "stale" };
      }
      let uri = record.uri;
      if (current.kind === "key") {
        const accepted = await confirmKey(record.scope.browser, { isCurrent });
        if (!isCurrent()) {
          return { status: "stale" };
        }
        if (!accepted) {
          return { status: "cancelled" };
        }
        if (!sameDescriptor(current, await this.#inspectTarget(record))) {
          return { status: "stale" };
        }
        const label = encodeURIComponent(new URL(record.scope.origin).hostname);
        uri = validatedURI(
          `otpauth://totp/${label}?secret=${current.value}&algorithm=SHA1&digits=6&period=30`
        );
      } else if (current.kind === "qr") {
        // A canvas, image, or SVG can change while its menu is open.
        const freshURI = await this.#uri(record, current);
        if (!uri || freshURI !== uri) {
          return { status: "stale" };
        }
      }
      const finalTarget = await this.#inspectTarget(record);
      if (!uri || !sameDescriptor(current, finalTarget) || !isCurrent()) {
        return { status: "stale" };
      }
      const result = await lazy.ICloudPasswords.setUpOneTimeCode(
        record.scope.origin,
        uri,
        parentWindow,
        { isCurrent, beforeDispatch }
      );
      if (!isCurrent()) {
        return { status: "stale" };
      }
      return { status: result?.dispatched === true ? "dispatched" : "failed" };
    } catch (error) {
      if (!this.#current(record)) {
        return { status: "stale" };
      }
      return { status: error?.code === "cancelled" ? "cancelled" : "failed" };
    } finally {
      this.#inFlight.delete(record);
      this.#discard(record);
    }
  }

  async #beforeDispatch(record, expected, selectedURI, isCurrent) {
    let valid = false;
    try {
      if (!isCurrent()) {
        return false;
      }
      const target = await this.#inspectTarget(record);
      if (!sameDescriptor(expected, target) || !isCurrent()) {
        return false;
      }
      // Canvas pixels can change during native waits without DOM mutations.
      if (
        target.kind === "qr" &&
        (await this.#uri(record, target)) !== selectedURI
      ) {
        return false;
      }
      const finalTarget = await this.#inspectTarget(record);
      valid = sameDescriptor(expected, finalTarget) && isCurrent();
      return valid;
    } catch {
      return false;
    } finally {
      if (!valid) {
        this.#discard(record);
      }
    }
  }

  receiveMessage({ name, data }) {
    if (name !== "ICloudPasswordsSetup:Invalidated") {
      return;
    }
    if (this.#pending?.handle === data?.token) {
      this.clear();
    }
    for (const record of this.#inFlight) {
      if (record.handle === data?.token) {
        this.#discard(record);
      }
    }
  }

  clear(signal) {
    if (this.#pending && (!signal || this.#pending.externalSignal === signal)) {
      this.#discard(this.#pending);
      this.#pending = null;
    }
  }

  didDestroy() {
    this.#destroyed = true;
    this.clear();
    for (const record of this.#inFlight) {
      this.#discard(record);
    }
    this.#inFlight.clear();
  }

  #discard(record) {
    if (record.discarded) {
      return;
    }
    record.discarded = true;
    record.controller.abort();
    if (!this.#destroyed) {
      try {
        this.sendAsyncMessage("ICloudPasswordsSetup:Clear", {
          token: record.handle,
        });
      } catch {}
    }
    record.externalSignal.removeEventListener("abort", record.onAbort);
    record.handle = record.uri = record.descriptor = null;
  }

  #enabled(otp = false) {
    return (
      !this.#destroyed &&
      Services.prefs.getBoolPref("waterfox.passwords.icloud.enabled", false) &&
      lazy.ICloudPasswords.enabled &&
      lazy.ICloudPasswords.supported &&
      (!otp ||
        (Services.prefs.getBoolPref(
          "waterfox.passwords.icloud.otp.enabled",
          false
        ) &&
          lazy.ICloudPasswords.otpEnabled))
    );
  }

  #scope(browser) {
    try {
      const win = browser.documentGlobal;
      if (
        !browser.isConnected ||
        win.gBrowser.selectedBrowser !== browser ||
        this.browsingContext.top.embedderElement !== browser
      ) {
        return null;
      }
      const ancestors = [];
      for (let bc = this.browsingContext; bc; bc = bc.parent) {
        const global = bc.currentWindowGlobal;
        const url = new URL(global.documentURI.spec);
        if (
          ancestors.length >= 32 ||
          !global.documentPrincipal.schemeIs("https") ||
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.origin !== global.documentPrincipal.originNoSuffix
        ) {
          return null;
        }
        ancestors.push({ bc, global, spec: global.documentURI.spec });
      }
      if (ancestors[0]?.global !== this.manager) {
        return null;
      }
      return {
        browser,
        ancestors,
        origin: this.manager.documentPrincipal.originNoSuffix,
      };
    } catch {
      return null;
    }
  }

  #current(record) {
    try {
      if (
        !this.#enabled() ||
        record.controller.signal.aborted ||
        !record.isCurrent() ||
        !record.scope.browser.isConnected ||
        record.scope.browser.documentGlobal.gBrowser.selectedBrowser !==
          record.scope.browser
      ) {
        return false;
      }
      const fresh = this.#scope(record.scope.browser);
      return (
        fresh?.origin === record.scope.origin &&
        fresh.ancestors.length === record.scope.ancestors.length &&
        fresh.ancestors.every((entry, index) => {
          const saved = record.scope.ancestors[index];
          return (
            entry.bc === saved.bc &&
            entry.global === saved.global &&
            entry.spec === saved.spec
          );
        })
      );
    } catch {
      return false;
    }
  }

  async #inspectTarget(record) {
    if (!this.#current(record)) {
      return null;
    }
    const result = await bounded(
      this.sendQuery("ICloudPasswordsSetup:Inspect", {
        targetIdentifier: record.targetIdentifier,
        timeStamp: record.timeStamp,
        token: record.handle,
        allowSetup: record.allowSetup,
      }),
      record.controller.signal,
      1000
    );
    return this.#current(record) ? descriptor(result) : null;
  }

  async #uri(record, candidate) {
    if (candidate.kind === "uri") {
      return validatedURI(candidate.value);
    }
    if (candidate.kind !== "qr" || !this.#current(record)) {
      return null;
    }
    const win = record.scope.browser.documentGlobal;
    const [x, y, width, height] = candidate.rect;
    const scale = Math.min(1, MAX_SIDE / width, MAX_SIDE / height);
    let bitmap;
    let canvas;
    try {
      bitmap = await bounded(
        this.manager.drawSnapshot(
          new win.DOMRect(x, y, width, height),
          scale,
          "rgb(255,255,255)"
        ),
        record.controller.signal,
        1000,
        value => value?.close()
      );
      if (
        !bitmap ||
        !this.#current(record) ||
        bitmap.width > MAX_SIDE ||
        bitmap.height > MAX_SIDE ||
        bitmap.width * bitmap.height > MAX_PIXELS
      ) {
        return null;
      }
      canvas = win.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas"
      );
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const uri = await decodeICloudSetupQR(pixels, {
        signal: record.controller.signal,
        workerFactory: url => new win.ChromeWorker(url),
      });
      return this.#current(record) ? validatedURI(uri) : null;
    } catch {
      return null;
    } finally {
      bitmap?.close();
      if (canvas) {
        canvas.width = canvas.height = 0;
      }
    }
  }
}
