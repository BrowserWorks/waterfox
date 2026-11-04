/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ICloudPasswordsUI } from "chrome://browser/content/waterfox/settings/ICloudPasswordsUI.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ICloudPasswords: "resource:///modules/ICloudPasswords.sys.mjs",
});
const PREFIX = "WaterfoxICloudAboutLogins:";
const ACTIONS = new Map([
  ["unlock", "unlock"],
  ["lock", "lock"],
  ["openManager", "manager"],
]);

/** Handles iCloud connection actions from about:logins. */
export class WaterfoxICloudAboutLoginsParent extends JSWindowActorParent {
  #ui = null;
  #busy = false;
  #error = null;
  #closed = false;

  #browser(active = false) {
    try {
      const context = this.browsingContext;
      const browser = context.embedderElement;
      if (
        this.#closed ||
        context.parent ||
        !browser?.isConnected ||
        context.currentWindowGlobal !== this.manager ||
        this.manager.remoteType !== "privilegedabout" ||
        this.manager.documentURI?.spec.split(/[?#]/, 1)[0] !== "about:logins" ||
        (active &&
          (!context.isActive ||
            browser.documentGlobal.gBrowser?.selectedBrowser !== browser))
      ) {
        return null;
      }
      return browser;
    } catch {
      return null;
    }
  }

  async #ensureUI(browser) {
    if (this.#ui?.browser !== browser) {
      this.#ui?.destroy();
      this.#ui = new ICloudPasswordsUI(
        browser.documentGlobal,
        () => this.#sendStatus(),
        lazy.ICloudPasswords,
        browser
      );
      await this.#ui.start();
    } else {
      await this.#ui.refresh();
    }
  }

  #status() {
    return {
      enabled:
        !!this.#ui?.enabled && !!this.#ui?.supported && !!this.#ui?.available,
      statusL10nId:
        this.#ui?.statusL10nId || "waterfox-icloud-status-unavailable",
      errorL10nId: this.#error || this.#ui?.errorL10nId || null,
      busy: this.#busy,
      canUnlock: !this.#busy && !!this.#ui?.canRun("unlock"),
      canLock: !this.#busy && !!this.#ui?.canRun("lock"),
      canManage: !this.#busy && !!this.#ui?.canRun("manager"),
    };
  }

  #sendStatus() {
    if (this.#browser()) {
      try {
        this.sendAsyncMessage(PREFIX + "Status", this.#status());
      } catch {}
    }
  }

  async receiveMessage({ name, data }) {
    const browser = this.#browser(name === PREFIX + "Action");
    if (!browser) {
      return null;
    }
    if (name === PREFIX + "GetStatus") {
      try {
        await this.#ensureUI(browser);
      } catch {
        this.#error = "waterfox-icloud-error-status";
      }
      return this.#browser() ? this.#status() : null;
    }
    if (
      name !== PREFIX + "Action" ||
      data?.userActivation !== true ||
      (!ACTIONS.has(data.action) && data.action !== "openSettings")
    ) {
      return null;
    }
    if (this.#busy) {
      return this.#status();
    }
    this.#busy = true;
    this.#error = null;
    this.#sendStatus();
    try {
      if (data.action === "openSettings") {
        await browser.documentGlobal.openPreferences("passwordsAutofill");
      } else {
        await this.#ensureUI(browser);
        if (this.#browser(true) === browser) {
          await this.#ui.run(ACTIONS.get(data.action));
        }
      }
    } catch {
      this.#error =
        data.action === "openSettings"
          ? "waterfox-icloud-error-settings"
          : "waterfox-icloud-error-status";
    } finally {
      this.#busy = false;
      this.#sendStatus();
    }
    return this.#browser() ? this.#status() : null;
  }

  didDestroy() {
    this.#closed = true;
    this.#ui?.destroy();
    this.#ui = null;
  }
}
