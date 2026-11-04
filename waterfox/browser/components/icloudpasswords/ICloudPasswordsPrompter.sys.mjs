/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ICloudPasswords: "resource:///modules/ICloudPasswords.sys.mjs",
});
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () =>
    new Localization(
      ["branding/brand.ftl", "browser/waterfox/icloud-provider.ftl"],
      true
    )
);
const PREFIX = "icloud-passwords-capture-";

function text(id, args) {
  return lazy.l10n.formatValueSync(PREFIX + id, args);
}

function button(id) {
  const message = lazy.l10n.formatMessagesSync([PREFIX + id])[0];
  return {
    label: message.value,
    accessKey: message.attributes.find(attr => attr.name == "accesskey").value,
  };
}

/** Shows iCloud save and update prompts. */
export class ICloudPasswordsPrompter {
  static prompt(
    browser,
    login,
    { isUpdate = false, dismissed = false, oldUsername, possibleValues } = {}
  ) {
    const { PopupNotifications } = browser.documentGlobal.wrappedJSObject;
    const doc = browser.ownerDocument;
    const win = doc.defaultView;
    const tabContainer = PopupNotifications.tabbrowser?.tabContainer;
    const data = {
      origin: login.origin,
      username: login.username,
      password: login.password,
    };
    const host = new URL(data.origin).hostname;
    const originalUsername = oldUsername ?? login.username;
    let notification, element, username, password, previousSearch, localPrompt;
    let expectedLogin, saveGlobal, actionDismissed;
    let sessionReady = lazy.ICloudPasswords.isReady;
    let pending = false,
      visible = false,
      cancelled = false,
      retry = false,
      accepted = false,
      queuedCheck = false,
      status;
    const updating = () => isUpdate && data.username === originalUsername;
    const foreground = () =>
      !PopupNotifications.tabbrowser ||
      PopupNotifications.tabbrowser.selectedBrowser === browser;
    const current = () =>
      !cancelled &&
      browser.isConnected &&
      PopupNotifications.getNotification("password", browser) === notification;
    const valid = global =>
      current() && browser.browsingContext?.currentWindowGlobal === global;
    const message = () => {
      let prompt = "save-site-prompt";
      if (isUpdate) {
        prompt = updating() ? "update-site-prompt" : "new-account-prompt";
      }
      return text(status ?? prompt, { host });
    };
    const read = () => {
      data.username = username.value;
      data.password = password.value;
    };
    const refresh = () => {
      notification.message = message();
      notification.options.passwordNotificationType = updating()
        ? "password-change"
        : "password-save";
      let action = updating() ? "update-button" : "save-button";
      if (accepted) {
        action = "check-again-button";
      } else if (retry) {
        action = "retry-button";
      }
      Object.assign(mainAction, button(action));
      mainAction.disabled = pending || (!accepted && !data.password);
      if (!visible || element.notification !== notification) {
        return;
      }
      element.setAttribute("label", notification.message);
      element.setAttribute("buttonlabel", mainAction.label);
      element.setAttribute("buttonaccesskey", mainAction.accessKey);
      element.button.disabled = mainAction.disabled;
      element.setAttribute(
        "secondarybuttonhidden",
        pending || accepted ? "true" : "false"
      );
      username.disabled = password.disabled = pending || accepted;
    };
    const onInput = () => {
      if (pending || accepted) {
        return;
      }
      read();
      status = undefined;
      retry = false;
      refresh();
    };
    const onKeyUp = event => {
      if (event.key == "Enter") {
        element.button.click();
      }
    };
    const dismiss = () => {
      cancelled = true;
      stopWatching();
      localPrompt?.dismiss();
      if (
        PopupNotifications.getNotification("password", browser) === notification
      ) {
        notification.remove();
      }
    };
    const stateObserver = () => {
      const ready = lazy.ICloudPasswords.isReady;
      if (!lazy.ICloudPasswords.enabled || (sessionReady && !ready)) {
        dismiss();
      }
      sessionReady ||= ready;
    };
    const cleanup = () => {
      visible = false;
      for (const field of [username, password]) {
        field?.removeEventListener("input", onInput);
        field?.removeEventListener("keyup", onKeyUp);
      }
      if (username && element.notification === notification) {
        username.autocompleteSearch = previousSearch;
        username.inputEl?.removeAttribute("disableautocomplete");
        username.inputEl?.detachController();
        username.disabled = password.disabled = false;
      }
    };
    const canCheck = () =>
      accepted &&
      valid(saveGlobal) &&
      lazy.ICloudPasswords.enabled &&
      lazy.ICloudPasswords.isReady;
    const active = () => foreground() && Services.focus.activeWindow === win;
    const check = async (passive = true) => {
      if (!canCheck() || (passive && !active())) {
        return;
      }
      if (pending) {
        queuedCheck = true;
        return;
      }
      do {
        queuedCheck = false;
        pending = true;
        status = "verification-pending";
        refresh();
        let verified;
        try {
          verified = await lazy.ICloudPasswords.verifySavedLogin(
            browser,
            expectedLogin
          );
        } catch {
          // Never surface native exception text or payloads.
          status = "verification-error";
        }
        pending = false;
        if (!canCheck() || verified === true) {
          dismiss();
          return;
        }
        refresh();
        // Only events received during a read can request one more check.
      } while (queuedCheck && active());
      queuedCheck = false;
    };
    const onActivate = event => {
      if (event.isTrusted && event.target === win) {
        return check();
      }
      return undefined;
    };
    const onTabSelect = event => {
      if (event.isTrusted && event.target.linkedBrowser === browser) {
        return check();
      }
      return undefined;
    };
    const stopWatching = () => {
      queuedCheck = false;
      win.removeEventListener("activate", onActivate);
      tabContainer?.removeEventListener("TabSelect", onTabSelect);
      win.removeEventListener("unload", dismiss);
    };
    const mainAction = {
      ...button(updating() ? "update-button" : "save-button"),
      dismiss: true,
      callback: async ({ event } = {}) => {
        if (pending || !visible || !current()) {
          return;
        }
        if (accepted && !valid(saveGlobal)) {
          dismiss();
          return;
        }
        if (!accepted) {
          read();
          expectedLogin = Object.freeze({ ...data });
          saveGlobal = browser.browsingContext?.currentWindowGlobal;
        }
        // PopupNotifications dismisses the panel after invoking this action.
        const hidden = event
          ? new Promise(resolve => {
              actionDismissed = resolve;
            })
          : Promise.resolve();
        pending = true;
        notification.options.persistWhileVisible = false;
        notification.options.timeout = 0;
        status = accepted ? "verification-pending" : "saving";
        refresh();
        if (!accepted) {
          browser.focus();
          let result;
          try {
            result = await lazy.ICloudPasswords.saveLogin(
              browser,
              expectedLogin
            );
          } catch {
            // Never surface native exception text or payloads.
          }
          await hidden;
          if (!valid(saveGlobal)) {
            dismiss();
            return;
          }
          if (result?.accepted !== true || result.verified !== false) {
            pending = false;
            retry = true;
            status = result === false ? "cancelled" : "save-error";
            refresh();
            if (foreground()) {
              notification.reshow();
            }
            return;
          }
          accepted = true;
          win.addEventListener("activate", onActivate);
          tabContainer?.addEventListener("TabSelect", onTabSelect);
          win.addEventListener("unload", dismiss, { once: true });
        } else {
          await hidden;
        }
        pending = false;
        await check(false);
      },
    };
    const switchToLocal = {
      ...button("switch-to-local"),
      dismiss: true,
      callback: () => {
        if (pending || accepted || !visible || !current()) {
          return;
        }
        read();
        const global = browser.browsingContext?.currentWindowGlobal;
        Services.tm.dispatchToMainThread(() => {
          if (!valid(global)) {
            dismiss();
            return;
          }
          const LoginInfo = Components.Constructor(
            "@mozilla.org/login-manager/loginInfo;1",
            "nsILoginInfo",
            "init"
          );
          const localLogin = new LoginInfo(
            data.origin,
            login.formActionOrigin,
            login.httpRealm,
            data.username,
            data.password,
            login.usernameField,
            login.passwordField
          );
          notification.remove();
          if (
            cancelled ||
            !browser.isConnected ||
            browser.browsingContext?.currentWindowGlobal !== global ||
            PopupNotifications.getNotification("password", browser)
          ) {
            return;
          }
          const prompter = Cc[
            "@mozilla.org/login-manager/prompter;1"
          ].getService(Ci.nsILoginManagerPrompter);
          localPrompt = prompter.promptToSavePassword(
            browser,
            localLogin,
            false,
            false,
            "",
            possibleValues
          );
        });
      },
    };
    notification = PopupNotifications.show(
      browser,
      "password",
      message(),
      "password-notification-icon",
      mainAction,
      [
        {
          ...button("not-now-button"),
          callback: () => {
            cancelled = true;
          },
        },
        switchToLocal,
      ],
      {
        dismissed: dismissed || PrivateBrowsingUtils.isBrowserPrivate(browser),
        persistWhileVisible: true,
        timeout: Date.now() + 10000,
        hideClose: true,
        passwordNotificationType: updating()
          ? "password-change"
          : "password-save",
        eventCallback(topic) {
          if (topic == "showing") {
            notification = this;
            element = doc.getElementById("password-notification");
            username = doc.getElementById("password-notification-username");
            password = doc.getElementById("password-notification-password");
            if (!visible) {
              previousSearch = username.autocompleteSearch;
            }
            username.autocompleteSearch = "";
            username.showDropmarker = false;
            username.inputEl?.setAttribute("disableautocomplete", "true");
          } else if (topic == "shown") {
            const opening = !visible;
            visible = true;
            username.value = data.username;
            password.value = data.password;
            password.inputEl.revealPassword = false;
            for (const field of [username, password]) {
              field.addEventListener("input", onInput);
              field.addEventListener("keyup", onKeyUp);
            }
            if (opening && accepted) {
              status = "verification-pending";
              refresh();
              void check();
            } else {
              refresh();
            }
          } else if (topic == "dismissed" || topic == "removed") {
            if (topic == "dismissed" && foreground()) {
              browser.focus();
            }
            cleanup();
            if (actionDismissed) {
              actionDismissed();
              actionDismissed = null;
            } else if (topic == "dismissed" && (pending || accepted)) {
              dismiss();
            }
            if (topic == "removed") {
              stopWatching();
              Services.obs.removeObserver(
                stateObserver,
                "icloud-passwords-state-changed"
              );
            }
          }
          return false;
        },
      }
    );
    Services.obs.addObserver(stateObserver, "icloud-passwords-state-changed");
    return { dismiss };
  }
}
