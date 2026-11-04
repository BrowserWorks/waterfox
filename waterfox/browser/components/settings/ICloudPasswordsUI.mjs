/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ICloudPasswords: "resource:///modules/ICloudPasswords.sys.mjs",
});

export const ICLOUD_PASSWORDS_PREFS = Object.freeze({
  enabled: "waterfox.passwords.icloud.enabled",
  destination: "waterfox.passwords.icloud.saveByDefault",
  otp: "waterfox.passwords.icloud.otp.enabled",
  idleTimeout: "waterfox.passwords.icloud.idleTimeout",
});

const STATE_TOPIC = "icloud-passwords-state-changed";
const PREF_BRANCH = "waterfox.passwords.icloud.";
const MAX_IDLE_SECONDS = 86400;
const STATES = new Set([
  "disconnected",
  "connecting",
  "locked",
  "pairing",
  "ready",
]);

/** Tracks provider status and explicit UI actions for one browser window. */
export class ICloudPasswordsUI {
  constructor(
    ownerWindow,
    onChange,
    provider = lazy.ICloudPasswords,
    browser = null
  ) {
    this.window = ownerWindow;
    this.browser = browser;
    this.onChange = onChange;
    this.provider = provider;
    this.status = {
      supported: provider.supported,
      available: false,
      state: provider.state,
    };
    this.busy = false;
    this.checking = true;
    this.available = false;
    this.actionError = null;
    this.statusError = false;
    this.destroyed = false;
    this._generation = 0;
    this._started = false;
    this._onUnload = () => this.destroy();
  }

  start() {
    if (this._started || this.destroyed) {
      return undefined;
    }
    if (this.window.closed) {
      this.destroy();
      return undefined;
    }
    this._started = true;
    this.window.addEventListener("unload", this._onUnload, { once: true });
    Services.obs.addObserver(this, STATE_TOPIC);
    Services.prefs.addObserver(PREF_BRANCH, this);
    return this.refresh();
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this._generation++;
    if (this._started) {
      Services.obs.removeObserver(this, STATE_TOPIC);
      Services.prefs.removeObserver(PREF_BRANCH, this);
      this.window.removeEventListener("unload", this._onUnload);
    }
    this.onChange = null;
    this.browser = null;
    this.window = null;
  }

  observe(_subject, topic, pref) {
    if (topic === STATE_TOPIC || pref === ICLOUD_PASSWORDS_PREFS.enabled) {
      if (!this.busy) {
        this.actionError = null;
      }
      this.refresh();
    } else {
      this._changed();
    }
  }

  _changed() {
    if (!this.destroyed) {
      this.onChange();
    }
  }

  get enabled() {
    return this.provider.enabled;
  }

  get supported() {
    return !!this.status.supported;
  }

  get idleTimeout() {
    const seconds = Services.prefs.getIntPref(
      ICLOUD_PASSWORDS_PREFS.idleTimeout,
      900
    );
    return seconds > 0 ? Math.min(seconds, MAX_IDLE_SECONDS) : 900;
  }

  get ready() {
    return this.enabled && this.status.state === "ready";
  }

  get statusL10nId() {
    let state;
    if (!this.supported) {
      state = "unsupported";
    } else if (this.checking) {
      state = "checking";
    } else if (!this.enabled) {
      state = "disabled";
    } else {
      state = STATES.has(this.status.state)
        ? this.status.state
        : "disconnected";
    }
    return `waterfox-icloud-status-${state}`;
  }

  get errorL10nId() {
    if (this.actionError) {
      return this.actionError;
    }
    if (this.statusError || (this.enabled && this.status.error)) {
      return "waterfox-icloud-error-status";
    }
    return null;
  }

  canConfigure(settingName) {
    return (
      !this.destroyed &&
      !this.busy &&
      !this.checking &&
      this.supported &&
      this.available &&
      (settingName === "enabled" || this.enabled) &&
      !Services.prefs.prefIsLocked(ICLOUD_PASSWORDS_PREFS[settingName])
    );
  }

  canRun(action) {
    if (action === "enabled") {
      return this.canConfigure("enabled");
    }
    if (
      this.destroyed ||
      this.busy ||
      this.checking ||
      !this.supported ||
      !this.available
    ) {
      return false;
    }
    switch (action) {
      case "unlock":
        return (
          this.enabled &&
          !this.ready &&
          !["connecting", "pairing"].includes(this.status.state)
        );
      case "lock":
        return this.enabled && this.ready;
      case "manager":
        return true;
      default:
        return false;
    }
  }

  async refresh() {
    if (this.destroyed) {
      return;
    }
    const generation = ++this._generation;
    try {
      const [providerStatus, available] = await Promise.all([
        this.provider.getStatus(),
        this.provider.isAvailable(),
      ]);
      if (this.destroyed || generation !== this._generation) {
        return;
      }
      this.status = providerStatus;
      this.available = !!available;
      this.statusError = false;
    } catch {
      if (this.destroyed || generation !== this._generation) {
        return;
      }
      this.statusError = true;
    }
    this.checking = false;
    this._changed();
  }

  async run(action, value) {
    if (!this.canRun(action)) {
      return;
    }
    this.busy = true;
    this.actionError = null;
    this._changed();
    try {
      switch (action) {
        case "enabled":
          await this.provider.setEnabled(value);
          break;
        case "unlock":
          await this.provider.unlock(
            this.browser ||
              this.window.browsingContext?.embedderElement ||
              this.window
          );
          break;
        case "lock":
          await this.provider.lock();
          break;
        case "manager":
          await this.provider.openManager();
          break;
      }
    } catch {
      this.actionError = `waterfox-icloud-error-${action}`;
    } finally {
      if (!this.destroyed) {
        this.busy = false;
        await this.refresh();
      }
    }
  }

  setPreference(settingName, value) {
    if (!this.canConfigure(settingName) || settingName === "enabled") {
      return;
    }
    this.actionError = null;
    try {
      const pref = ICLOUD_PASSWORDS_PREFS[settingName];
      if (settingName === "idleTimeout") {
        const seconds = Number(value);
        if (
          !Number.isInteger(seconds) ||
          seconds <= 0 ||
          seconds > MAX_IDLE_SECONDS
        ) {
          throw new Error("Invalid idle timeout");
        }
        Services.prefs.setIntPref(pref, seconds);
      } else {
        Services.prefs.setBoolPref(pref, !!value);
      }
    } catch {
      this.actionError = "waterfox-icloud-error-preference";
    }
    this._changed();
  }
}
