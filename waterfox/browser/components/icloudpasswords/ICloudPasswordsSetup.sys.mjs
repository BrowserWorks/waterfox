/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ICloudPasswords: "resource:///modules/ICloudPasswords.sys.mjs",
});
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["browser/waterfox/icloud-provider.ftl"])
);

const PREF = "waterfox.passwords.icloud.";

async function confirmKey(browser, { isCurrent }, prompt) {
  const [title, message, accept] = await lazy.l10n.formatValues([
    { id: "icloud-passwords-setup-key-title" },
    { id: "icloud-passwords-setup-key-message" },
    { id: "icloud-passwords-setup-key-accept" },
  ]);
  if (!isCurrent()) {
    return false;
  }
  const flags =
    (Ci.nsIPromptService.BUTTON_TITLE_IS_STRING *
      Ci.nsIPromptService.BUTTON_POS_0) |
    (Ci.nsIPromptService.BUTTON_TITLE_CANCEL *
      Ci.nsIPromptService.BUTTON_POS_1) |
    Ci.nsIPromptService.BUTTON_POS_1_DEFAULT;
  const result = await prompt.asyncConfirmEx(
    browser.browsingContext,
    Ci.nsIPrompt.MODAL_TYPE_CONTENT,
    title,
    message,
    flags,
    accept,
    null,
    null,
    null,
    false
  );
  return result.get("buttonNumClicked") === 0;
}

/** Adds Apple Passwords commands to the content context menu. */
export class ICloudPasswordsSetupController {
  #initialized = false;
  #sessions = new Map();
  #prompt;
  #localize;

  constructor({
    prompt = Services.prompt,
    localize = (document, items) => document.l10n.translateElements(items),
  } = {}) {
    this.#prompt = prompt;
    this.#localize = localize;
  }

  init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    Services.obs.addObserver(this, "on-build-contextmenu");
    Services.prefs.addObserver(PREF, this);
  }

  destroy() {
    if (!this.#initialized) {
      return;
    }
    Services.obs.removeObserver(this, "on-build-contextmenu");
    Services.prefs.removeObserver(PREF, this);
    this.#initialized = false;
    for (const session of this.#sessions.values()) {
      session.cancel();
    }
  }

  whenReady(menu) {
    return this.#sessions.get(menu)?.ready ?? Promise.resolve();
  }

  observe(subject, topic) {
    if (topic === "nsPref:changed") {
      for (const session of this.#sessions.values()) {
        session.cancel();
      }
      return;
    }
    if (topic !== "on-build-contextmenu" || !this.#enabled()) {
      return;
    }
    const menu = subject?.wrappedJSObject?.menu;
    const win = menu?.documentGlobal;
    if (
      menu?.id !== "contentAreaContextMenu" ||
      !menu.nodePrincipal.isSystemPrincipal ||
      !win?.gBrowser
    ) {
      return;
    }
    this.#sessions.get(menu)?.cancel();
    const tabbrowser = win.gBrowser;
    let resolveReady;
    const ready = new Promise(resolve => {
      resolveReady = resolve;
    });
    const session = {
      actor: null,
      browser: null,
      manager: null,
      abort: new AbortController(),
      closed: false,
      admitted: false,
      items: [],
      ready,
    };
    const removeItems = () => {
      for (const item of session.items) {
        item.remove();
      }
      session.items = [];
    };
    const cleanup = () => {
      menu.removeEventListener("popupshown", onShown);
      menu.removeEventListener("popuphidden", onHidden);
      win.removeEventListener("unload", session.cancel);
      tabbrowser.tabContainer.removeEventListener("TabSelect", session.cancel);
      tabbrowser.tabContainer.removeEventListener("TabClose", onTabClose);
      tabbrowser.removeTabsProgressListener(progress);
      removeItems();
      if (this.#sessions.get(menu) === session) {
        this.#sessions.delete(menu);
      }
    };
    session.cancel = () => {
      session.closed = true;
      session.abort.abort();
      session.actor?.clear(session.abort.signal);
      cleanup();
      resolveReady();
    };
    const onTabClose = event => {
      if (event.target.linkedBrowser === session.browser) {
        session.cancel();
      }
    };
    const progress = {
      onLocationChange: browser => {
        if (browser === session.browser) {
          session.cancel();
        }
      },
      onStateChange: (browser, webProgress, request, flags) => {
        if (
          browser === session.browser &&
          flags & Ci.nsIWebProgressListener.STATE_START &&
          flags & Ci.nsIWebProgressListener.STATE_IS_DOCUMENT
        ) {
          session.cancel();
        }
      },
    };
    const onShown = event => {
      if (event.target !== menu || !event.isTrusted) {
        return;
      }
      menu.removeEventListener("popupshown", onShown);
      this.#populate(menu, session)
        .catch(() => session.cancel())
        .finally(resolveReady);
    };
    const onHidden = event => {
      if (event.target !== menu) {
        return;
      }
      session.closed = true;
      session.actor?.clear(session.abort.signal);
      removeItems();
      if (!session.admitted) {
        session.cancel();
      }
    };
    this.#sessions.set(menu, session);
    menu.addEventListener("popupshown", onShown);
    menu.addEventListener("popuphidden", onHidden);
    win.addEventListener("unload", session.cancel, { once: true });
    tabbrowser.tabContainer.addEventListener("TabSelect", session.cancel);
    tabbrowser.tabContainer.addEventListener("TabClose", onTabClose);
    tabbrowser.addTabsProgressListener(progress);
  }

  #enabled() {
    return (
      Services.prefs.getBoolPref(`${PREF}enabled`, false) &&
      lazy.ICloudPasswords.enabled &&
      lazy.ICloudPasswords.supported
    );
  }

  #current(session) {
    try {
      const { browser, manager } = session;
      return (
        !session.abort.signal.aborted &&
        this.#enabled() &&
        (!session.closed || session.admitted) &&
        browser?.isConnected &&
        browser.documentGlobal.gBrowser.selectedBrowser === browser &&
        manager === session.actor.manager &&
        manager.browsingContext.currentWindowGlobal === manager
      );
    } catch {
      return false;
    }
  }

  async #populate(menu, session) {
    const win = menu.documentGlobal;
    const context = win.gContextMenu;
    if (
      !context?.actor ||
      !context.targetIdentifier ||
      context.browser !== win.gBrowser.selectedBrowser ||
      session.closed
    ) {
      session.cancel();
      return;
    }
    session.manager = context.actor.manager;
    session.browser = context.browser;
    session.actor = context.actor.manager.getActor("ICloudPasswordsSetup");
    const candidate = await session.actor.inspect({
      targetIdentifier: context.targetIdentifier,
      timeStamp: context.timeStamp,
      browser: session.browser,
      signal: session.abort.signal,
      isCurrent: () => this.#current(session),
    });
    if (
      !candidate ||
      !this.#current(session) ||
      win.gContextMenu !== context ||
      menu.state !== "open"
    ) {
      session.cancel();
      return;
    }
    const document = menu.ownerDocument;
    document.l10n.addResourceIds(["browser/waterfox/icloud-provider.ftl"]);
    session.items.push(document.createXULElement("menuseparator"));
    if (candidate.canSetUp) {
      this.#item(
        menu,
        session,
        candidate.handle,
        "setup",
        "context-icloud-setup-code",
        "icloud-passwords-context-setup-code"
      );
    }
    this.#item(
      menu,
      session,
      candidate.handle,
      "manager",
      "context-icloud-open-site",
      "icloud-passwords-context-open-site"
    );
    const items = session.items.filter(item => item.localName === "menuitem");
    await this.#localize(document, items);
    if (
      !this.#current(session) ||
      session.closed ||
      win.gContextMenu !== context ||
      menu.state !== "open" ||
      items.some(item => !item.getAttribute("label")?.trim())
    ) {
      session.cancel();
      return;
    }
    // Native menus require individual insertions to avoid duplicate reconstruction.
    for (const item of session.items) {
      menu.appendChild(item);
    }
  }

  #item(menu, session, handle, action, id, message) {
    const item = menu.ownerDocument.createXULElement("menuitem");
    item.id = id;
    // Admit the command before explicitly hiding, so popuphidden can revoke all
    // unused handles without racing XUL's asynchronous command dispatch.
    item.setAttribute("closemenu", "none");
    menu.ownerDocument.l10n.setAttributes(item, message);
    item.addEventListener("command", event => {
      if (
        !event.isTrusted ||
        event.target !== item ||
        item.parentNode !== menu ||
        session.admitted ||
        session.closed ||
        !this.#current(session)
      ) {
        return;
      }
      session.admitted = true;
      const pending = session.actor.activate(
        handle,
        action,
        menu.documentGlobal,
        (browser, options) => confirmKey(browser, options, this.#prompt)
      );
      menu.hidePopup();
      pending
        .then(async result => {
          if (result.status !== "failed" || !this.#current(session)) {
            return;
          }
          const [title, text] = await lazy.l10n.formatValues([
            { id: "icloud-passwords-setup-error-title" },
            { id: "icloud-passwords-setup-error-message" },
          ]);
          if (this.#current(session)) {
            this.#prompt.alert(menu.documentGlobal, title, text);
          }
        })
        .catch(() => {})
        .finally(session.cancel);
    });
    session.items.push(item);
  }
}

export const ICloudPasswordsSetup = new ICloudPasswordsSetupController();
