/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PREFIX = "WaterfoxICloudAboutLogins:";

/** Shows the iCloud landing view alongside Mozilla's local password manager. */
export class WaterfoxICloudAboutLoginsChild extends JSWindowActorChild {
  #main = null;
  #back = null;
  #status = null;
  #error = null;
  #buttons = new Map();
  #settings = null;
  #listeners = null;
  #tabIndexObserver = null;
  #state = null;
  #closed = false;

  actorCreated() {
    if (this.document.readyState !== "loading") {
      this.#init();
    }
  }

  handleEvent(event) {
    if (
      event.type === "DOMContentLoaded" &&
      event.isTrusted &&
      event.target === this.document
    ) {
      this.#init();
    }
  }

  #element(tag, id, l10nId) {
    const element = this.document.createElement(tag);
    element.id = id;
    if (l10nId) {
      this.document.l10n.setAttributes(element, l10nId);
    }
    return element;
  }

  #init() {
    const doc = this.document;
    if (
      this.#closed ||
      this.#main ||
      this.browsingContext.parent ||
      doc.documentURI.split(/[?#]/, 1)[0] !== "about:logins"
    ) {
      return;
    }
    const header = doc.querySelector("body > header");
    if (!header) {
      return;
    }
    for (const [rel, href] of [
      ["localization", "browser/waterfox/icloud-passwords.ftl"],
      [
        "stylesheet",
        "chrome://browser/content/waterfox/icloudpasswords/aboutLogins.css",
      ],
    ]) {
      const link = doc.createElement("link");
      link.rel = rel;
      link.href = href;
      doc.head.append(link);
    }
    for (const component of ["moz-card", "moz-button"]) {
      const script = doc.createElement("script");
      script.type = "module";
      script.src = `chrome://global/content/elements/${component}.mjs`;
      doc.head.append(script);
    }

    this.#main = this.#element("main", "waterfox-icloud-passwords");
    this.#main.hidden = true;
    const heading = this.#element(
      "h1",
      "waterfox-icloud-page-title",
      "about-logins-page-title-name"
    );
    heading.tabIndex = -1;
    this.#main.setAttribute("aria-labelledby", heading.id);
    const card = this.#element("moz-card", "waterfox-icloud-notice");
    const content = this.#element("div", "waterfox-icloud-notice-content");
    const icon = this.#element("img", "waterfox-icloud-icon");
    icon.src = "chrome://browser/skin/login.svg";
    icon.alt = "";
    const details = this.#element("div", "waterfox-icloud-details");
    const title = this.#element(
      "h2",
      "waterfox-icloud-title",
      "waterfox-icloud-landing-title"
    );
    const notice = this.#element(
      "p",
      "waterfox-icloud-vault-notice",
      "waterfox-icloud-vault-notice"
    );
    this.#status = this.#element("p", "waterfox-icloud-status");
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("aria-atomic", "true");
    this.#error = this.#element("p", "waterfox-icloud-error");
    this.#error.setAttribute("role", "alert");
    this.#error.setAttribute("aria-atomic", "true");
    this.#error.hidden = true;
    const actions = this.#element(
      "moz-button-group",
      "waterfox-icloud-actions"
    );
    for (const [action, id, l10nId] of [
      ["openManager", "manager", "waterfox-icloud-manager-button"],
      ["unlock", "unlock", "waterfox-icloud-unlock-button"],
    ]) {
      const button = this.#element(
        "moz-button",
        `waterfox-icloud-${id}`,
        l10nId
      );
      button.setAttribute(
        "type",
        action === "openManager" ? "primary" : "default"
      );
      button.dataset.action = action;
      button.setAttribute("disabled", "");
      button.tabIndex = 0;
      this.#buttons.set(action, button);
      actions.append(button);
    }
    details.append(title, notice, this.#status, this.#error, actions);
    content.append(icon, details);
    card.append(content);

    const links = this.#element("div", "waterfox-icloud-links");
    const local = this.#element(
      "a",
      "waterfox-icloud-local",
      "waterfox-icloud-local-link"
    );
    local.href = "#local";
    local.tabIndex = 0;
    this.#settings = this.#element(
      "a",
      "waterfox-icloud-settings",
      "waterfox-icloud-settings-link"
    );
    this.#settings.href = "about:preferences#passwordsAutofill";
    this.#settings.dataset.action = "openSettings";
    this.#settings.tabIndex = 0;
    links.append(local, this.#settings);
    this.#main.append(heading, card, links);
    doc.body.append(this.#main);

    this.#back = this.#element(
      "a",
      "waterfox-icloud-back",
      "waterfox-icloud-back-link"
    );
    this.#back.href = "#icloud";
    this.#back.hidden = true;
    this.#back.tabIndex = 0;
    header.prepend(this.#back);

    this.#listeners = new this.contentWindow.AbortController();
    const { signal } = this.#listeners;
    this.#main.addEventListener(
      "click",
      event => {
        const target = event.target.closest?.("[data-action]");
        if (!target || !this.#main.contains(target)) {
          return;
        }
        event.preventDefault();
        if (
          event.isTrusted &&
          event.button === 0 &&
          !target.hasAttribute("disabled") &&
          target.getAttribute("aria-disabled") !== "true" &&
          doc.hasValidTransientUserGestureActivation
        ) {
          this.#request("Action", {
            action: target.dataset.action,
            userActivation: true,
          });
        }
      },
      { signal }
    );
    this.contentWindow.addEventListener(
      "hashchange",
      () => this.#updateView(true),
      { signal }
    );
    this.contentWindow.addEventListener(
      "pageshow",
      event => {
        if (event.persisted) {
          this.#request("GetStatus");
        }
      },
      { signal }
    );
    // Apply about:logins' native modal keyboard restrictions to these controls.
    this.#tabIndexObserver = new this.contentWindow.MutationObserver(
      records => {
        for (const { target } of records) {
          if (target === doc.documentElement) {
            this.#updateView();
          } else if (!target.hasAttribute("tabindex")) {
            target.tabIndex = 0;
          }
        }
      }
    );
    this.#tabIndexObserver.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    for (const control of [
      ...this.#buttons.values(),
      local,
      this.#settings,
      this.#back,
    ]) {
      this.#tabIndexObserver.observe(control, {
        attributes: true,
        attributeFilter: ["tabindex"],
      });
    }
    this.#request("GetStatus");
  }

  #updateView(focus = false) {
    const doc = this.document;
    const enabled = !!this.#state?.enabled;
    const authRequired = doc.documentElement.classList.contains(
      "primary-password-auth-required"
    );
    const landing =
      enabled && !authRequired && this.contentWindow.location.hash !== "#local";
    doc.documentElement.classList.toggle("waterfox-icloud-landing", landing);
    this.#main.hidden = !landing;
    this.#back.hidden = !enabled || landing;
    this.#back.inert = authRequired;
    if (!focus || authRequired) {
      return;
    }
    const focusTarget = landing
      ? doc.getElementById("waterfox-icloud-page-title")
      : doc.querySelector("login-list");
    focusTarget.focus();
  }

  async #request(name, data) {
    try {
      const status = await this.sendQuery(PREFIX + name, data);
      if (!this.#closed && status) {
        this.#render(status);
      }
    } catch {
      if (!this.#closed) {
        this.#render({
          ...this.#state,
          statusL10nId: "waterfox-icloud-status-unavailable",
          errorL10nId: "waterfox-icloud-error-status",
        });
      }
    }
  }

  receiveMessage({ name, data }) {
    if (name === PREFIX + "Status" && this.#main && !this.#closed) {
      this.#render(data);
    }
  }

  #render(status) {
    const ready = status.statusL10nId === "waterfox-icloud-status-ready";
    this.#state = status;
    this.document.l10n.setAttributes(this.#status, status.statusL10nId);
    this.#status.hidden = ready;
    this.#error.hidden = !status.errorL10nId;
    if (status.errorL10nId) {
      this.document.l10n.setAttributes(this.#error, status.errorL10nId);
    }
    for (const [action, button] of this.#buttons) {
      const capability = action === "unlock" ? "canUnlock" : "canManage";
      button.toggleAttribute("disabled", !status[capability]);
      if (action === "unlock") {
        const hadFocus = this.document.activeElement === button;
        button.hidden = ready;
        if (hadFocus && button.hidden) {
          this.#buttons.get("openManager").focus();
        }
      }
    }
    this.#settings.setAttribute(
      "aria-disabled",
      status.busy ? "true" : "false"
    );
    this.#main.setAttribute("aria-busy", status.busy ? "true" : "false");
    this.#updateView();
  }

  didDestroy() {
    this.#closed = true;
    try {
      this.#listeners?.abort();
      this.#tabIndexObserver?.disconnect();
      this.document.documentElement.classList.remove("waterfox-icloud-landing");
      this.#main?.remove();
      this.#back?.remove();
    } catch {}
    this.#main = this.#back = null;
    this.#status = this.#error = this.#settings = null;
    this.#listeners = this.#tabIndexObserver = this.#state = null;
    this.#buttons.clear();
  }
}
