/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LoginManagerParent as NativeLoginManagerParent } from "resource://gre/modules/LoginManagerParent.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ICloudPasswords: "resource:///modules/ICloudPasswords.sys.mjs",
  ICloudPasswordsPrompter:
    "resource:///modules/ICloudPasswordsPrompter.sys.mjs",
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
});
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["browser/waterfox/icloud-provider.ftl"], true)
);
const LoginInfo = Components.Constructor(
  "@mozilla.org/login-manager/loginInfo;1",
  "nsILoginInfo",
  "init"
);
const STATE_TOPIC = "icloud-passwords-state-changed";

function icloudOTPLabel(account) {
  if (!account) {
    return lazy.l10n.formatValueSync("icloud-passwords-code-label");
  }
  return lazy.l10n.formatValueSync("icloud-passwords-code-issuer-label", {
    issuer: account.domain,
  });
}

async function recipesForOrigin(origin) {
  const hostname = URL.parse(origin)?.hostname;
  if (!hostname) {
    return [];
  }
  const manager = await NativeLoginManagerParent.recipeParentPromise;
  return manager.getRecipesForHost(hostname) ?? [];
}

async function passwordFingerprint(password) {
  const bytes = new TextEncoder().encode(password);
  try {
    return Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      byte => byte.toString(16).padStart(2, "0")
    ).join("");
  } finally {
    bytes.fill(0);
  }
}

/** Routes fills and captured logins between local storage and iCloud. */
export class LoginManagerParent extends NativeLoginManagerParent {
  #icloudChoices = new Map();
  #icloudInput = null;
  #icloudFilled = new Map();
  #icloudSearch = 0;
  #icloudGeneration = 0;
  #captureVersion = 0;
  #icloudBusy = false;
  #icloudObserver = null;
  #destroyed = false;

  didDestroy() {
    this.#destroyed = true;
    this.#icloudChoices.clear();
    this.#icloudInput = null;
    this.#icloudFilled.clear();
    this.#icloudSearch++;
    // An admitted submission may finish after its document navigates away.
    if (this.#icloudObserver) {
      Services.obs.removeObserver(this.#icloudObserver, STATE_TOPIC);
      this.#icloudObserver = null;
    }
    super.didDestroy?.();
  }

  get #icloudEnabled() {
    if (
      this.#destroyed ||
      !Services.prefs.getBoolPref("waterfox.passwords.icloud.enabled", false)
    ) {
      return false;
    }
    try {
      return (
        lazy.ICloudPasswords.enabled &&
        lazy.ICloudPasswords.supported &&
        this.origin?.startsWith("https://")
      );
    } catch {
      return false;
    }
  }

  get #icloudSaveByDefault() {
    return this.#icloudEnabled && lazy.ICloudPasswords.saveByDefault;
  }

  #watchICloudState() {
    if (this.#icloudObserver) {
      return;
    }
    this.#icloudObserver = {
      observe: () => {
        if (!lazy.ICloudPasswords.isReady) {
          this.#icloudChoices.clear();
          this.#icloudSearch++;
          this.#icloudGeneration++;
          this.sendAsyncMessage("PasswordManager:InvalidateICloudAutocomplete");
        }
        // Fingerprints retain capture provenance through idle lock, not disable.
        if (!lazy.ICloudPasswords.enabled) {
          this.#icloudFilled.clear();
          this.#icloudInput = null;
          this.#captureVersion++;
        }
      },
    };
    Services.obs.addObserver(this.#icloudObserver, STATE_TOPIC);
  }

  #icloudContext() {
    try {
      return {
        manager: this.manager,
        principal: this.manager.documentPrincipal.origin,
        origin: this.origin,
        browser: this.getRootBrowser(),
      };
    } catch {
      return null;
    }
  }

  #isCurrentICloudDocument(context) {
    try {
      return (
        !this.#destroyed &&
        !!context?.browser?.isConnected &&
        this.manager === context.manager &&
        this.browsingContext.currentWindowGlobal === context.manager &&
        this.manager.documentPrincipal.origin === context.principal &&
        this.origin === context.origin &&
        this.getRootBrowser() === context.browser
      );
    } catch {
      return false;
    }
  }

  #icloudOTPOptions() {
    try {
      const principal = this.manager.documentPrincipal;
      if (
        this.browsingContext.currentWindowGlobal !== this.manager ||
        !principal.schemeIs("https") ||
        principal.originNoSuffix !== this.origin
      ) {
        return null;
      }
      const frameURLs = [];
      for (
        let context = this.browsingContext;
        context;
        context = context.parent
      ) {
        const global = context.currentWindowGlobal;
        const spec = global?.documentURI?.spec;
        const url = spec && URL.parse(spec);
        if (
          !global?.documentPrincipal.equals(principal) ||
          !url ||
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.origin !== this.origin
        ) {
          break;
        }
        frameURLs.push(spec);
      }
      if (!frameURLs.length) {
        return null;
      }
      return Object.freeze({
        frameURLs: Object.freeze(frameURLs),
        tabId: this.browsingContext.top.id,
        frameId: this.browsingContext.parent ? this.browsingContext.id : 0,
      });
    } catch {
      return null;
    }
  }

  #isCurrentICloudContext(context) {
    if (!this.#isCurrentICloudDocument(context)) {
      return false;
    }
    if (!context.otpOptions) {
      return true;
    }
    const current = this.#icloudOTPOptions();
    const saved = context.otpOptions;
    return (
      !!current &&
      current.tabId === saved.tabId &&
      current.frameId === saved.frameId &&
      current.frameURLs.length === saved.frameURLs.length &&
      current.frameURLs.every((url, index) => url === saved.frameURLs[index])
    );
  }

  #isCurrentICloudTarget(context, input, generation = this.#icloudGeneration) {
    return (
      generation === this.#icloudGeneration &&
      this.#isCurrentICloudContext(context) &&
      this.#icloudInput === input &&
      input?.browsingContextId === this.browsingContext.id &&
      context.browser.documentGlobal?.wrappedJSObject?.gBrowser
        ?.selectedBrowser === context.browser
    );
  }

  async #icloudItems(
    formOrigin,
    {
      actionOrigin,
      searchString = "",
      isOneTimeCode,
      isProbablyANewPasswordField,
      hasBeenTypePassword,
    }
  ) {
    const search = ++this.#icloudSearch;
    this.#icloudChoices.clear();
    if (
      !this.#icloudEnabled ||
      formOrigin !== this.origin ||
      (isOneTimeCode && !lazy.ICloudPasswords.otpEnabled) ||
      (!isOneTimeCode && isProbablyANewPasswordField)
    ) {
      return [];
    }
    this.#watchICloudState();
    const context = this.#icloudContext();
    if (isOneTimeCode) {
      const otpOptions = this.#icloudOTPOptions();
      if (!context || !otpOptions) {
        return [];
      }
      context.otpOptions = otpOptions;
    }
    let accounts = [];
    if (lazy.ICloudPasswords.isReady) {
      try {
        accounts = isOneTimeCode
          ? await lazy.ICloudPasswords.listOneTimeCodes(
              formOrigin,
              context.otpOptions
            )
          : await lazy.ICloudPasswords.listAccounts(formOrigin);
      } catch {
        // The provider's connection UI owns sanitized operation errors.
      }
    }
    if (
      search !== this.#icloudSearch ||
      !this.#icloudEnabled ||
      !this.#isCurrentICloudContext(context)
    ) {
      return [];
    }
    const provider = lazy.l10n.formatValueSync(
      "icloud-passwords-provider-name"
    );
    const records = lazy.ICloudPasswords.isReady ? accounts : [null];
    const prefix = hasBeenTypePassword ? "" : searchString.toLowerCase();
    return records
      .filter(
        account =>
          !account ||
          isOneTimeCode ||
          account.username.toLowerCase().startsWith(prefix)
      )
      .map(account => {
        const id = Services.uuid.generateUUID().toString();
        this.#icloudChoices.set(id, {
          account,
          context,
          kind: isOneTimeCode ? "code" : "password",
          actionOrigin: actionOrigin || formOrigin,
          input: this.#icloudInput,
        });
        return {
          image: "chrome://browser/skin/login.svg",
          label: account
            ? account.username ||
              lazy.l10n.formatValueSync("icloud-passwords-empty-username")
            : lazy.l10n.formatValueSync("icloud-passwords-unlock"),
          secondary: isOneTimeCode ? icloudOTPLabel(account) : provider,
          fillMessageName: "PasswordManager:SelectICloudCredential",
          fillMessageData: { id },
          provider: "icloud",
        };
      });
  }

  async doAutocompleteSearch(formOrigin, options) {
    if (!this.#icloudEnabled && !options.isOneTimeCode) {
      return super.doAutocompleteSearch(formOrigin, options);
    }
    const items = await this.#icloudItems(formOrigin, options);
    let result;
    if (options.isOneTimeCode || !Services.logins.isLoggedIn) {
      result = {
        logins: [],
        generatedPassword: null,
        willAutoSaveGeneratedPassword: false,
      };
      if (
        !options.isOneTimeCode &&
        this.#icloudSaveByDefault &&
        (options.forcePasswordGeneration ||
          (options.isProbablyANewPasswordField &&
            Services.logins.getLoginSavingEnabled(formOrigin)))
      ) {
        result.generatedPassword = await super.getGeneratedPassword({
          inputMaxLength: options.inputMaxLength,
        });
      }
    } else {
      result = await super.doAutocompleteSearch(formOrigin, options);
    }
    if (this.#icloudSaveByDefault) {
      result = { ...result, willAutoSaveGeneratedPassword: false };
    }
    return {
      ...result,
      autocompleteItems: [
        ...items.filter(item => {
          const choice = this.#icloudChoices.get(item.fillMessageData.id);
          return choice && this.#isCurrentICloudContext(choice.context);
        }),
        ...(result.autocompleteItems ?? []),
      ],
    };
  }

  async sendLoginDataToChild(formOrigin, actionOrigin, options) {
    if (this.#icloudEnabled && !Services.logins.isLoggedIn) {
      return {
        logins: [],
        recipes: await recipesForOrigin(formOrigin),
        externalProviderAvailable: true,
      };
    }
    return super.sendLoginDataToChild(formOrigin, actionOrigin, options);
  }

  onAutoCompletePopupOpened(elementId) {
    super.onAutoCompletePopupOpened?.(elementId);
    try {
      const identifier =
        typeof elementId == "string" ? JSON.parse(elementId) : elementId;
      if (
        identifier?.browsingContextId !== this.browsingContext.id ||
        !["number", "string"].includes(typeof identifier.id)
      ) {
        return;
      }
      this.#icloudInput = Object.freeze({ ...identifier });
      for (const choice of this.#icloudChoices.values()) {
        choice.input = this.#icloudInput;
      }
    } catch {}
  }

  async onAutoCompleteEntrySelected(message, data) {
    if (message == "PasswordManager:SelectICloudCredential") {
      return this.#selectICloudCredential(data?.id);
    }
    return super.onAutoCompleteEntrySelected(message, data);
  }

  async #selectICloudCredential(id) {
    const choice = this.#icloudChoices.get(id);
    const inputElementIdentifier = this.#icloudInput;

    if (
      !choice ||
      choice.input !== inputElementIdentifier ||
      !inputElementIdentifier ||
      this.#icloudBusy ||
      !this.#icloudEnabled ||
      (choice.kind == "code" && !lazy.ICloudPasswords.otpEnabled) ||
      !this.#isCurrentICloudTarget(choice.context, inputElementIdentifier)
    ) {
      return;
    }
    const { context } = choice;
    const generation = this.#icloudGeneration;
    this.#icloudBusy = true;
    this.#icloudChoices.clear();
    try {
      if (!choice.account) {
        if (
          (await lazy.ICloudPasswords.unlock(context.browser)) &&
          this.#icloudEnabled &&
          this.#isCurrentICloudTarget(context, inputElementIdentifier)
        ) {
          this.sendAsyncMessage("PasswordManager:RefreshICloudAutocomplete", {
            inputElementIdentifier,
          });
        }
        return;
      }
      if (choice.kind == "code") {
        const result = await lazy.ICloudPasswords.getOneTimeCode(
          context.origin,
          choice.account,
          context.browser,
          context.otpOptions
        );
        if (
          result &&
          this.#icloudEnabled &&
          lazy.ICloudPasswords.otpEnabled &&
          this.#isCurrentICloudTarget(
            context,
            inputElementIdentifier,
            generation
          )
        ) {
          this.sendAsyncMessage("PasswordManager:FillICloudCode", {
            inputElementIdentifier,
            code: result.code,
            actionOrigin: choice.actionOrigin,
          });
        }
        return;
      }
      const result = await lazy.ICloudPasswords.getPassword(
        context.origin,
        choice.account,
        context.browser
      );

      if (
        !result ||
        !this.#icloudEnabled ||
        !this.#isCurrentICloudTarget(
          context,
          inputElementIdentifier,
          generation
        )
      ) {
        return;
      }
      const recipes = await recipesForOrigin(context.origin);

      if (
        !this.#icloudEnabled ||
        !lazy.ICloudPasswords.isReady ||
        !this.#isCurrentICloudTarget(
          context,
          inputElementIdentifier,
          generation
        )
      ) {
        return;
      }
      const fingerprint = await passwordFingerprint(result.password);

      if (
        !this.#icloudEnabled ||
        !lazy.ICloudPasswords.isReady ||
        !this.#isCurrentICloudTarget(
          context,
          inputElementIdentifier,
          generation
        )
      ) {
        return;
      }
      const handle = Services.uuid.generateUUID().toString();
      this.#icloudFilled.set(handle, {
        username: result.username,
        fingerprint,
        context,
        input: inputElementIdentifier,
        actionOrigin: choice.actionOrigin,
      });
      const login = new LoginInfo(
        context.origin,
        choice.actionOrigin,
        null,
        result.username,
        result.password,
        "",
        ""
      );
      this.sendAsyncMessage("PasswordManager:FillICloudPassword", {
        inputElementIdentifier,
        loginFormOrigin: context.origin,
        logins: [lazy.LoginHelper.loginToVanillaObject(login)],
        recipes,
        providerHandle: handle,
        actionOrigin: choice.actionOrigin,
      });
    } catch {
      if (
        !this.#icloudEnabled ||
        !this.#isCurrentICloudTarget(
          context,
          inputElementIdentifier,
          generation
        )
      ) {
        return;
      }
      const status = await lazy.ICloudPasswords.getStatus();
      if (
        status.error &&
        this.#icloudEnabled &&
        this.#isCurrentICloudTarget(context, inputElementIdentifier, generation)
      ) {
        context.browser.documentGlobal.wrappedJSObject.PopupNotifications.show(
          context.browser,
          "icloud-passwords-error",
          status.error,
          "password-notification-icon",
          null,
          [],
          { dismissed: false, removeOnDismissal: true }
        );
      }
    } finally {
      this.#icloudBusy = false;
      this.#invalidateConsumedICloudChoice(choice);
    }
  }

  #invalidateConsumedICloudChoice(choice) {
    if (
      (choice.account || !lazy.ICloudPasswords.isReady) &&
      this.#isCurrentICloudDocument(choice.context)
    ) {
      // Consumed handles must not survive in Gecko's autocomplete cache.
      this.sendAsyncMessage("PasswordManager:InvalidateICloudAutocomplete");
    }
  }

  #isAuthorizedICloudCapture(context, browser, formOrigin, data) {
    return (
      !this.#destroyed &&
      !!context?.browser?.isConnected &&
      browser === context.browser &&
      formOrigin === context.origin &&
      (data.browsingContextId === undefined ||
        data.browsingContextId === this.browsingContext.id)
    );
  }

  #isICloudCaptureSource(filled, context, actionOrigin) {
    return (
      !!filled &&
      filled.context.manager === context.manager &&
      filled.context.principal === context.principal &&
      filled.context.browser === context.browser &&
      filled.context.origin === context.origin &&
      filled.input.browsingContextId === this.browsingContext.id &&
      actionOrigin === filled.actionOrigin
    );
  }

  async _capture(browser, formOrigin, data, dismissed) {
    const version = ++this.#captureVersion;
    const context = this.#icloudContext();
    const authorized = this.#isAuthorizedICloudCapture(
      context,
      browser,
      formOrigin,
      data
    );
    const filled = this.#icloudFilled.get(data.providerHandle);
    const actionOrigin = data.formActionOrigin || formOrigin;
    const usedICloud =
      authorized && this.#isICloudCaptureSource(filled, context, actionOrigin);
    if (data.providerHandle != null && !usedICloud) {
      return true;
    }
    // A local fill must not become an upload just because the default changed.
    if (
      !usedICloud &&
      (data.filledLoginProvider == "local" || data.autoFilledLoginGuid)
    ) {
      return false;
    }
    if (!usedICloud && !this.#icloudSaveByDefault) {
      return false;
    }
    if (
      !this.#icloudEnabled ||
      !authorized ||
      typeof data.newPasswordField?.value != "string" ||
      !data.newPasswordField.value ||
      !Services.logins.getLoginSavingEnabled(formOrigin)
    ) {
      return true;
    }
    this.#watchICloudState();
    // Snapshot the original site's authorization and values; ignore new documents.
    const capture = Object.freeze({
      browser,
      origin: formOrigin,
      username: usedICloud ? filled.username : undefined,
      fingerprint: usedICloud ? filled.fingerprint : undefined,
    });
    const login = new LoginInfo(
      capture.origin,
      actionOrigin,
      null,
      data.usernameField?.value ?? (usedICloud ? capture.username : ""),
      data.newPasswordField.value,
      data.usernameField?.name ?? "",
      data.newPasswordField.name ?? ""
    );
    const possibleValues = this.possibleValues;
    let unchanged = false;
    if (usedICloud) {
      try {
        unchanged =
          (await passwordFingerprint(login.password)) === capture.fingerprint &&
          login.username === capture.username;
      } catch {
        return true;
      }
    }
    if (
      version !== this.#captureVersion ||
      !capture.browser.isConnected ||
      !Services.prefs.getBoolPref("waterfox.passwords.icloud.enabled", false) ||
      !lazy.ICloudPasswords.enabled ||
      !lazy.ICloudPasswords.supported ||
      !Services.logins.getLoginSavingEnabled(capture.origin) ||
      unchanged
    ) {
      return true;
    }
    lazy.ICloudPasswordsPrompter.prompt(capture.browser, login, {
      isUpdate: usedICloud,
      dismissed,
      oldUsername: capture.username,
      possibleValues,
    });
    return true;
  }

  async showDoorhanger(browser, formOrigin, data) {
    if (data.providerHandle == null && !this.#icloudEnabled) {
      return super.showDoorhanger(browser, formOrigin, data);
    }
    if (await this._capture(browser, formOrigin, data, data.dismissedPrompt)) {
      return undefined;
    }
    return super.showDoorhanger(browser, formOrigin, data);
  }

  async _onPasswordEditedOrGenerated(browser, formOrigin, data) {
    if (data.providerHandle == null && !this.#icloudEnabled) {
      return super._onPasswordEditedOrGenerated(browser, formOrigin, data);
    }
    if (await this._capture(browser, formOrigin, data, true)) {
      return undefined;
    }
    return super._onPasswordEditedOrGenerated(browser, formOrigin, data);
  }
}
