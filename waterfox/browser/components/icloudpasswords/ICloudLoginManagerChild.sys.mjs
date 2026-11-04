/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  LoginManagerChild as NativeLoginManagerChild,
  LoginFormState,
} from "resource://gre/modules/LoginManagerChild.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { ContentDOMReference } from "resource://gre/modules/ContentDOMReference.sys.mjs";
import { GenericAutocompleteItem } from "resource://gre/modules/FillHelpers.sys.mjs";
import { FormLikeFactory } from "resource://gre/modules/FormLikeFactory.sys.mjs";
import { InsecurePasswordUtils } from "resource://gre/modules/InsecurePasswordUtils.sys.mjs";
import { LoginHelper } from "resource://gre/modules/LoginHelper.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "formFill", () =>
  Cc["@mozilla.org/satchel/form-fill-controller;1"].getService(
    Ci.nsIFormFillController
  )
);

/** Inserts provider rows without changing Gecko's native autocomplete result. */
class ICloudAutoCompleteResult {
  #base;
  #rows;
  #searchString;
  constructor(base, items, codesOnly, searchString = "") {
    this.#base = base;
    this.#searchString = searchString;
    this.#rows = codesOnly
      ? []
      : Array.from({ length: base.matchCount }, (_, index) => index);
    let footer = this.#rows.findIndex(
      index => base.getStyleAt(index) === "loginsFooter"
    );
    this.#rows.splice(
      footer < 0 ? this.#rows.length : footer,
      0,
      ...items.map(
        item =>
          new GenericAutocompleteItem(
            item.image,
            item.label,
            item.secondary,
            item.fillMessageName,
            item.fillMessageData
          )
      )
    );
  }
  QueryInterface = ChromeUtils.generateQI([
    "nsIAutoCompleteResult",
    "nsISupportsWeakReference",
  ]);
  get wrappedJSObject() {
    return this;
  }
  get logins() {
    return this.#base?.wrappedJSObject.logins ?? [];
  }
  get searchString() {
    return this.#base?.searchString ?? this.#searchString;
  }
  get searchResult() {
    return this.matchCount
      ? Ci.nsIAutoCompleteResult.RESULT_SUCCESS
      : (this.#base?.searchResult ?? Ci.nsIAutoCompleteResult.RESULT_NOMATCH);
  }
  get matchCount() {
    return this.#rows.length;
  }
  get defaultIndex() {
    return this.matchCount ? Math.max(0, this.#base?.defaultIndex ?? 0) : -1;
  }
  get errorDescription() {
    return this.#base?.errorDescription ?? "";
  }
  #value(index, method, property) {
    if (!Number.isInteger(index) || index < 0 || index >= this.matchCount) {
      throw new RangeError("Autocomplete index out of range");
    }
    const row = this.#rows[index];
    return typeof row === "number" ? this.#base[method](row) : row[property];
  }
  getValueAt(index) {
    return this.#value(index, "getValueAt", "value");
  }
  getLabelAt(index) {
    return this.#value(index, "getLabelAt", "label");
  }
  getCommentAt(index) {
    return this.#value(index, "getCommentAt", "comment");
  }
  getStyleAt(index) {
    return this.#value(index, "getStyleAt", "style");
  }
  getImageAt(index) {
    return this.#value(index, "getImageAt", "image");
  }
  getFinalCompleteValueAt(index) {
    return this.#value(index, "getFinalCompleteValueAt", "value");
  }
  isRemovableAt(index) {
    return (
      typeof this.#rows[index] === "number" &&
      this.#base.isRemovableAt(this.#rows[index])
    );
  }
  removeValueAt(index, removeFromDB) {
    if (typeof this.#rows[index] === "number") {
      this.#base.removeValueAt(this.#rows[index], removeFromDB);
    }
  }
}

function codeIdentifiers(element) {
  return [element.id, element.getAttribute("name") ?? ""].map(identifier =>
    identifier
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
  );
}

function hasConflictingCodeName(element) {
  return codeIdentifiers(element).some(identifier =>
    /\b(?:coupon|cc|csc|email|username|user|password)\b/.test(identifier)
  );
}

function hasCodeName(element) {
  return (
    codeIdentifiers(element).some(identifier =>
      /\b(?:totp|otp|mfa)+\b/.test(identifier)
    ) && !hasConflictingCodeName(element)
  );
}

function isOneTimeCodeField(input) {
  if (!HTMLInputElement.isInstance(input)) {
    return false;
  }
  const info = input.getAutocompleteInfo();
  if (info?.fieldName === "one-time-code") {
    return true;
  }
  if (
    (info?.fieldName && !["on", "off"].includes(info.fieldName)) ||
    info?.credentialType ||
    !["text", "tel", "number"].includes(input.type) ||
    input.hasBeenTypePassword
  ) {
    return false;
  }
  return hasCodeName(input);
}

const ICLOUD_PREFS = [
  "waterfox.passwords.icloud.enabled",
  "waterfox.passwords.icloud.otp.enabled",
  "signon.rememberSignons",
];
const CODE_EVENTS = [
  "focusin",
  "focusout",
  "beforeinput",
  "input",
  "change",
  "pagehide",
  "visibilitychange",
];
const CODE_BOUNDARY = "form, fieldset, [role=group]";
const CODE_CONTROLS =
  "input, select, textarea, [contenteditable], iframe, object, embed";
const CODE_ATTRIBUTES = [
  "id",
  "name",
  "type",
  "autocomplete",
  "maxlength",
  "minlength",
  "min",
  "max",
  "step",
  "inputmode",
  "pattern",
  "form",
  "action",
  "method",
  "disabled",
  "readonly",
  "hidden",
  "inert",
  "contenteditable",
  "role",
];

function splitOneTimeCodeGroup(input) {
  if (!input.isConnected || !input.documentGlobal) {
    return null;
  }
  for (
    let root = input.parentElement, depth = 0;
    root && !root.matches("body, html") && depth < 6;
    root = root.parentElement, depth++
  ) {
    const fields = [];
    const walker = input.ownerDocument.createTreeWalker(
      root,
      input.documentGlobal.NodeFilter.SHOW_ELEMENT
    );
    let count = 0;
    for (
      let element = walker.nextNode();
      element;
      element = walker.nextNode()
    ) {
      if (++count > 80 || element.matches(CODE_BOUNDARY)) {
        return null;
      }
      if (HTMLInputElement.isInstance(element)) {
        fields.push(element);
        if (fields.length > 10) {
          return null;
        }
      } else if (element.matches(CODE_CONTROLS)) {
        return null;
      }
    }
    if (fields.length < 4) {
      if (
        root.matches(CODE_BOUNDARY) ||
        (fields.length > 1 && hasCodeName(root))
      ) {
        return null;
      }
      continue;
    }
    const sections = new Set(
      fields.map(field => field.getAutocompleteInfo()?.section).filter(Boolean)
    );
    if (
      !fields.includes(input) ||
      sections.size > 1 ||
      !fields.every(field => {
        const info = field.getAutocompleteInfo();
        return (
          field.maxLength === 1 &&
          field.form === input.form &&
          field.ownerDocument === input.ownerDocument &&
          field.isConnected &&
          !field.matches(":disabled") &&
          !field.readOnly &&
          !field.closest("[inert]") &&
          !field.hasBeenTypePassword &&
          ["text", "tel", "number"].includes(field.type) &&
          !info?.credentialType &&
          (!info?.fieldName ||
            ["on", "off", "one-time-code"].includes(info.fieldName)) &&
          !hasConflictingCodeName(field) &&
          (field.inputMode === "numeric" ||
            ["tel", "number"].includes(field.type) ||
            /^(?:\\d|\[0-9\])(?:\{1\}|[+*])?$/.test(field.pattern)) &&
          field.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          })
        );
      }) ||
      (!fields.some(isOneTimeCodeField) && !hasCodeName(root))
    ) {
      return null;
    }
    return { root, fields };
  }
  return null;
}

function oneTimeCodeFields(input) {
  if (!HTMLInputElement.isInstance(input)) {
    return null;
  }
  if (input.maxLength !== 1) {
    return isOneTimeCodeField(input) ? [input] : null;
  }
  return splitOneTimeCodeGroup(input)?.fields ?? null;
}

function splitOTPMutated(session, records) {
  return records.some(record => {
    if (record.type === "attributes") {
      return session.targets.has(record.target);
    }
    return (
      Array.from(record.removedNodes).some(
        node =>
          (session.form && node.contains(session.form)) ||
          session.fields.some(field => node.contains(field))
      ) ||
      (session.root.contains(record.target) &&
        Array.from(record.addedNodes).some(node => {
          if (node.nodeType !== 1) {
            return false;
          }
          const walker = session.document.createTreeWalker(
            node,
            session.window.NodeFilter.SHOW_ELEMENT
          );
          let count = 0;
          for (let element = node; element; element = walker.nextNode()) {
            if (
              ++count > 80 ||
              element.matches(CODE_CONTROLS + ", " + CODE_BOUNDARY)
            ) {
              return true;
            }
          }
          return false;
        }))
    );
  });
}

/** Tracks which credentials came from iCloud during native form handling. */
export class LoginManagerChild extends NativeLoginManagerChild {
  #sources = new WeakMap();
  #capturing = null;
  #filling = null;
  #providerEpoch = 0;
  #observer = null;
  #splitOTP = null;

  #invalidateSplitOTP() {
    const session = this.#splitOTP;
    if (!session?.valid) {
      return;
    }
    session.valid = false;
    session.selected = false;
    session.values = [];
    session.choices.clear();
    session.observer.disconnect();
    session.progress.removeProgressListener(session.navigation);
    for (const type of CODE_EVENTS) {
      session.document.removeEventListener(type, session.onEvent, true);
    }
    session.window.removeEventListener(
      "beforeunload",
      session.onNavigation,
      true
    );
  }

  #rememberSplitOTP(input, items) {
    const group = splitOneTimeCodeGroup(input);
    if (!group) {
      return;
    }
    const { root, fields } = group;
    const document = input.ownerDocument;
    const session = {
      input,
      root,
      fields,
      document,
      window: document.defaultView,
      form: input.form,
      action: input.form?.action,
      uri: document.documentURI,
      epoch: this.#providerEpoch,
      values: fields.map(field => field.value),
      choices: new Set(items.map(item => item.fillMessageData?.id)),
      targets: new Set(),
      selected: false,
      filling: false,
      valid: true,
      onEvent: event => {
        if (event.type === "focusout") {
          if (
            fields.includes(event.target) &&
            (!session.filling || !fields.includes(event.relatedTarget))
          ) {
            this.#invalidateSplitOTP();
          }
        } else if (event.type === "focusin") {
          if (!fields.includes(event.target)) {
            this.#invalidateSplitOTP();
          }
        } else if (
          ["pagehide", "visibilitychange"].includes(event.type) ||
          (!session.filling && fields.includes(event.target))
        ) {
          this.#invalidateSplitOTP();
        }
      },
    };
    session.observer = new document.defaultView.MutationObserver(records => {
      if (splitOTPMutated(session, records)) {
        this.#invalidateSplitOTP();
      }
    });
    session.observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: CODE_ATTRIBUTES,
    });
    for (const element of [...fields, input.form]) {
      for (let node = element; node; node = node.parentElement) {
        session.targets.add(node);
      }
    }
    for (const node of session.targets) {
      if (!root.contains(node)) {
        session.observer.observe(node, {
          childList: true,
          attributes: true,
          attributeFilter:
            node === input.form
              ? [
                  "id",
                  "action",
                  "method",
                  "autocomplete",
                  "disabled",
                  "hidden",
                  "inert",
                ]
              : ["disabled", "hidden", "inert"],
        });
      }
    }
    session.progress = this.docShell
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIWebProgress);
    session.navigation = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onStateChange: (progress, request, flags) => {
        if (
          progress.DOMWindow === session.window &&
          flags & Ci.nsIWebProgressListener.STATE_START
        ) {
          this.#invalidateSplitOTP();
        }
      },
      onLocationChange: progress => {
        if (progress.DOMWindow === session.window) {
          this.#invalidateSplitOTP();
        }
      },
    };
    session.progress.addProgressListener(
      session.navigation,
      Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT |
        Ci.nsIWebProgress.NOTIFY_LOCATION
    );
    for (const type of CODE_EVENTS) {
      document.addEventListener(type, session.onEvent, true);
    }
    session.onNavigation = () => this.#invalidateSplitOTP();
    this.#splitOTP = session;
  }

  #validSplitOTP(session) {
    if (
      !session.valid ||
      !session.selected ||
      this.#splitOTP !== session ||
      this.document !== session.document ||
      session.uri !== this.document.documentURI ||
      session.epoch !== this.#providerEpoch ||
      this.docShell.busyFlags ||
      this.docShell.isInUnload ||
      !this.#enabled ||
      !Services.prefs.getBoolPref(
        "waterfox.passwords.icloud.otp.enabled",
        false
      ) ||
      session.form !== session.input.form ||
      session.action !== session.input.form?.action ||
      splitOTPMutated(session, session.observer.takeRecords())
    ) {
      return false;
    }
    const active = this.document.activeElement;
    const focusMatches = session.filling
      ? session.fields.includes(active)
      : active === session.input;
    if (
      !focusMatches ||
      !this.#target(ContentDOMReference.get(active)) ||
      !InsecurePasswordUtils.isFormSecure(
        FormLikeFactory.createFromField(session.input)
      )
    ) {
      return false;
    }
    const group = splitOneTimeCodeGroup(session.input);
    return (
      group?.root === session.root &&
      group.fields.length === session.fields.length &&
      group.fields.every(
        (field, index) =>
          field === session.fields[index] &&
          field.value === session.values[index]
      )
    );
  }

  #fillSplitOTP(input, code) {
    const session = this.#splitOTP;
    if (
      session?.input !== input ||
      session.filling ||
      typeof code !== "string" ||
      /\D/.test(code) ||
      code.length !== session.fields.length
    ) {
      return;
    }
    try {
      if (!this.#validSplitOTP(session)) {
        return;
      }
      session.filling = true;
      session.window.addEventListener(
        "beforeunload",
        session.onNavigation,
        true
      );
      for (const [index, field] of session.fields.entries()) {
        if (!this.#validSplitOTP(session)) {
          return;
        }
        session.values[index] = code[index];
        field.setUserInput(code[index]);
        if (!this.#validSplitOTP(session)) {
          return;
        }
        LoginFormState._highlightFilledField(field);
      }
      if (
        this.document.activeElement !== input &&
        this.#validSplitOTP(session)
      ) {
        input.focus({ preventScroll: true });
      }
    } finally {
      session.filling = false;
      this.#invalidateSplitOTP();
    }
  }

  actorCreated() {
    super.actorCreated?.();
    this.#observer = {
      observe: (subject, topic, data) => {
        if (topic === "nsPref:changed") {
          if (data === "waterfox.passwords.icloud.enabled") {
            this.#providerEpoch++;
          }
          this.#invalidateSplitOTP();
          return;
        }
        try {
          const input = subject.QueryInterface(
            Ci.nsIFormFillController
          ).controlledElement;
          const selection = JSON.parse(data);
          if (
            this.#splitOTP?.input === input &&
            selection.fillMessageName ===
              "PasswordManager:SelectICloudCredential" &&
            typeof selection.fillMessageData?.id === "string" &&
            this.#splitOTP.choices.has(selection.fillMessageData?.id)
          ) {
            this.#splitOTP.selected = true;
          }
          if (
            input?.ownerDocument === this.document &&
            input.isConnected &&
            selection.fillMessageName ===
              "PasswordManager:OnFieldAutoComplete" &&
            selection.guid
          ) {
            // Stamp provenance before the controller's setUserInput emits input.
            this.#sources.set(FormLikeFactory.findRootForField(input), {
              filledLoginProvider: "local",
            });
          }
        } catch {}
      },
    };
    Services.obs.addObserver(this.#observer, "autocomplete-will-enter-text");
    for (const pref of ICLOUD_PREFS) {
      Services.prefs.addObserver(pref, this.#observer);
    }
  }

  didDestroy() {
    this.#invalidateSplitOTP();
    this.#splitOTP = null;
    if (this.#observer) {
      Services.obs.removeObserver(
        this.#observer,
        "autocomplete-will-enter-text"
      );
      for (const pref of ICLOUD_PREFS) {
        Services.prefs.removeObserver(pref, this.#observer);
      }
      this.#observer = null;
    }
    super.didDestroy?.();
  }

  get #enabled() {
    return (
      ["macosx", "win"].includes(AppConstants.platform) &&
      LoginHelper.enabled &&
      Services.prefs.getBoolPref("waterfox.passwords.icloud.enabled", false)
    );
  }

  #target(identifier) {
    const input = ContentDOMReference.resolve(identifier);
    if (
      !this.#enabled ||
      !HTMLInputElement.isInstance(input) ||
      !input.isConnected ||
      input.ownerDocument !== this.document ||
      input.ownerDocument.activeElement !== input ||
      input.ownerDocument.visibilityState !== "visible" ||
      input.disabled ||
      input.readOnly ||
      input.nodePrincipal.isNullPrincipal ||
      !input.nodePrincipal.schemeIs("https")
    ) {
      return null;
    }
    return input;
  }

  receiveMessage(message) {
    const { name, data } = message;
    if (name === "PasswordManager:InvalidateICloudAutocomplete") {
      this.#invalidateSplitOTP();
      if (lazy.formFill.controlledElement?.ownerDocument === this.document) {
        lazy.formFill
          .QueryInterface(Ci.nsIAutoCompleteInput)
          .controller.resetInternalState();
      }
      return undefined;
    }
    if (name === "PasswordManager:RefreshICloudAutocomplete") {
      const input = this.#target(data.inputElementIdentifier);
      if (input) {
        this.markAsAutoCompletableField(input);
        lazy.formFill.controlledElement = input;
        this.repopulateAutocompletePopup();
      }
      return undefined;
    }
    if (
      name === "PasswordManager:FillICloudCode" ||
      name === "PasswordManager:FillICloudPassword"
    ) {
      const input = this.#target(data.inputElementIdentifier);
      if (!input) {
        return undefined;
      }
      const form = FormLikeFactory.createFromField(input);

      if (
        !InsecurePasswordUtils.isFormSecure(form) ||
        (data.actionOrigin &&
          LoginHelper.getFormActionOrigin(form) !== data.actionOrigin)
      ) {
        return undefined;
      }
      if (name === "PasswordManager:FillICloudCode") {
        if (
          Services.prefs.getBoolPref(
            "waterfox.passwords.icloud.otp.enabled",
            false
          ) &&
          /^\d{4,10}$/.test(data.code)
        ) {
          if (input.maxLength === 1 || this.#splitOTP?.input === input) {
            this.#fillSplitOTP(input, data.code);
          } else if (isOneTimeCodeField(input)) {
            input.setUserInput(data.code);
            LoginFormState._highlightFilledField(input);
          }
        }
      } else if (!isOneTimeCodeField(input) && !oneTimeCodeFields(input)) {
        this.#filling = {
          providerHandle: data.providerHandle,
          epoch: this.#providerEpoch,
        };
        try {
          super.fillForm({
            loginFormOrigin: data.loginFormOrigin,
            loginsFound: LoginHelper.vanillaObjectsToLogins(data.logins),
            recipes: data.recipes,
            inputElementIdentifier: data.inputElementIdentifier,
            originMatches: false,
            style: "icloudPassword",
          });
        } finally {
          this.#filling = null;
        }
      }
      return undefined;
    }
    return super.receiveMessage(message);
  }

  handleEvent(event) {
    if (event.type !== "focusin") {
      super.handleEvent(event);
      return;
    }
    if (this.#splitOTP?.filling) {
      return;
    }
    const input = event.composedTarget;
    if (
      event.isTrusted &&
      this.#enabled &&
      HTMLInputElement.isInstance(input) &&
      !this.shouldIgnoreLoginManagerEvent(event) &&
      oneTimeCodeFields(input) &&
      this.shouldSearchForAutoComplete(input, "")
    ) {
      this.markAsAutoCompletableField(input);
      lazy.formFill.controlledElement = input;
      this.repopulateAutocompletePopup();
    }
  }

  loginsFound(result) {
    if (
      this.#enabled &&
      result.form.ownerDocument.nodePrincipal.schemeIs("https")
    ) {
      const fields = this.stateForDocument(
        result.form.ownerDocument
      )._getFormFields(result.form, false, result.recipes);
      if (
        fields.usernameField &&
        !this.isLoginManagerField(fields.usernameField)
      ) {
        this.markAsAutoCompletableField(fields.usernameField);
      }
    }
    return super.loginsFound(result);
  }

  _fillForm(form, logins, recipes, options = {}) {
    const previous = this.#sources.get(form.rootElement);
    if (this.#filling) {
      this.#sources.set(form.rootElement, this.#filling);
    }
    const result = super._fillForm(form, logins, recipes, options);
    const filled = this.stateForDocument(
      form.ownerDocument
    ).fillsByRootElement.get(form.rootElement)?.login;
    if (this.#filling) {
      if (
        !filled ||
        filled.username !== logins[0]?.username ||
        filled.password !== logins[0]?.password
      ) {
        if (previous) {
          this.#sources.set(form.rootElement, previous);
        } else {
          this.#sources.delete(form.rootElement);
        }
      }
    } else if (filled?.guid) {
      this.#sources.set(form.rootElement, { filledLoginProvider: "local" });
    }
    return result;
  }

  _maybeSendFormInteractionMessageContinue(form, name, options) {
    const previous = this.#capturing;
    const source = this.#sources.get(form.rootElement);
    this.#capturing = source;
    if (source?.providerHandle) {
      this.#capturing =
        source.epoch === this.#providerEpoch && this.#enabled
          ? { providerHandle: source.providerHandle }
          : { filledLoginProvider: "local" };
    }
    try {
      return super._maybeSendFormInteractionMessageContinue(
        form,
        name,
        options
      );
    } finally {
      this.#capturing = previous;
    }
  }

  sendAsyncMessage(name, data, ...rest) {
    if (
      this.#capturing &&
      (name === "PasswordManager:ShowDoorhanger" ||
        name === "PasswordManager:onPasswordEditedOrGenerated")
    ) {
      data = { ...data, ...this.#capturing };
    }
    return super.sendAsyncMessage(name, data, ...rest);
  }

  getAutoCompleteSearchOption(input, searchString) {
    if (oneTimeCodeFields(input)) {
      return {
        actionOrigin: LoginHelper.getFormActionOrigin(
          FormLikeFactory.createFromField(input)
        ),
        searchString,
        isOneTimeCode: true,
      };
    }
    return super.getAutoCompleteSearchOption(input, searchString);
  }

  shouldSearchForAutoComplete(input, searchString) {
    const fields = oneTimeCodeFields(input);
    if (fields || isOneTimeCodeField(input)) {
      return (
        !!fields &&
        !!this.#target(ContentDOMReference.get(input)) &&
        Services.prefs.getBoolPref(
          "waterfox.passwords.icloud.otp.enabled",
          false
        ) &&
        InsecurePasswordUtils.isFormSecure(
          FormLikeFactory.createFromField(input)
        )
      );
    }
    return super.shouldSearchForAutoComplete(input, searchString);
  }

  searchResultToAutoCompleteResult(searchString, input, records) {
    if (this.#splitOTP?.filling) {
      return null;
    }
    const items =
      records?.autocompleteItems?.filter(item => item.provider === "icloud") ??
      [];
    const fields = oneTimeCodeFields(input);
    const codesOnly = !!fields || isOneTimeCodeField(input);
    this.#invalidateSplitOTP();
    if (this.#splitOTP?.input !== input) {
      this.#splitOTP = null;
    }
    if (codesOnly) {
      if (!fields) {
        return null;
      }
      if (fields.length > 1 && items.length) {
        this.#rememberSplitOTP(input, items);
      }
      return items.length
        ? new ICloudAutoCompleteResult(null, items, true, searchString)
        : null;
    }
    const nativeRecords = records && {
      ...records,
      autocompleteItems: records.autocompleteItems?.filter(
        item => item.provider !== "icloud"
      ),
    };
    const base = super.searchResultToAutoCompleteResult(
      searchString,
      input,
      nativeRecords
    );
    return items.length && base
      ? new ICloudAutoCompleteResult(base, items, codesOnly)
      : base;
  }
}
