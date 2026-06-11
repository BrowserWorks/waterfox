/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WaterfoxBrowserStyle: "resource:///modules/WaterfoxBrowserStyle.sys.mjs",
  WaterfoxThemeColors: "resource:///modules/WaterfoxThemeColors.sys.mjs",
});

const NOVA_PREF = "browser.nova.enabled";
const BROWSER_STYLE_PREF = "browser.theme.waterfox.browserStyle";
const CHROME_SHEET_PREF = "browser.theme.waterfox.chromeSheet";
const DENSITY_PREF = "browser.uidensity";
const WATERFOX_THEME_MODE_PREF = "browser.theme.waterfox.mode";
const WATERFOX_THEME_COLOR_PREF = "browser.theme.waterfox.color";
const STATUS_BAR_PREF = "browser.statusbar.enabled";
const STATUS_BAR_TEXT_PREF = "browser.statusbar.appendStatusText";

const CHROME_SHEET_ON = 0;
const CHROME_SHEET_OFF = 2;
const DENSITY_VALUES = { compact: 1, normal: 0, touch: 2 };

const DENSITY_OPTIONS = [
  {
    value: "compact",
    l10nId: "waterfox-density-compact",
    imageSrc: "chrome://browser/skin/customizableui/density-compact.svg",
  },
  {
    value: "normal",
    l10nId: "waterfox-density-normal",
    imageSrc: "chrome://browser/skin/customizableui/density-normal.svg",
  },
  {
    value: "touch",
    l10nId: "waterfox-density-touch",
    imageSrc: "chrome://browser/skin/customizableui/density-touch.svg",
  },
];

const THEME_MODES = [
  {
    value: "system",
    l10nId: "waterfox-appearance-theme-mode-option-system",
    imageSrc: "chrome://browser/skin/device-desktop.svg",
  },
  {
    value: "light",
    l10nId: "waterfox-appearance-theme-mode-option-light",
    imageSrc: "chrome://browser/skin/weather/sunny.svg",
  },
  {
    value: "dark",
    l10nId: "waterfox-appearance-theme-mode-option-dark",
    imageSrc: "chrome://browser/skin/weather/night-hazy-moonlight.svg",
  },
];

/** Theme mode segmented control for about:preferences. */
class WaterfoxModeSegmented extends HTMLElement {
  static get observedAttributes() {
    return ["disabled", "data-l10n-id"];
  }

  #l10nRequest = 0;
  #options = [];
  #value = "";

  connectedCallback() {
    this.#render();
  }

  attributeChangedCallback(attrName) {
    if (attrName == "disabled") {
      this.#syncSelection();
      return;
    }
    this.#render();
  }

  get options() {
    return this.#options;
  }

  set options(options) {
    this.#options = options ?? [];
    this.#render();
  }

  get value() {
    return this.#value;
  }

  set value(value) {
    this.#value = value;
    this.#syncSelection();
  }

  get disabled() {
    return this.hasAttribute("disabled");
  }

  set disabled(disabled) {
    this.toggleAttribute("disabled", Boolean(disabled));
  }

  focus() {
    this.#selectedButton?.focus();
  }

  #render() {
    if (!this.isConnected || !this.#options.length) {
      return;
    }

    const labelId = `${this.id || "waterfox-mode-segmented"}-label`;
    const label = this.ownerDocument.createElement("span");
    label.className = "waterfox-mode-segmented-label";
    label.id = labelId;
    if (this.dataset.l10nId) {
      label.dataset.labelL10nId = this.dataset.l10nId;
    }

    const group = this.ownerDocument.createElement("div");
    group.className = "waterfox-mode-segmented-options";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", labelId);
    group.addEventListener("click", this);
    group.addEventListener("keydown", this);

    for (let option of this.#options) {
      const button = this.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "waterfox-mode-segmented-option";
      button.dataset.value = option.value;
      button.value = option.value;
      button.setAttribute("role", "radio");

      const icon = this.ownerDocument.createElement("img");
      icon.className = "waterfox-mode-segmented-icon";
      icon.src = option.imageSrc;
      icon.alt = "";

      const text = this.ownerDocument.createElement("span");
      text.className = "waterfox-mode-segmented-text";
      text.dataset.labelL10nId = option.l10nId;

      button.append(icon, text);
      group.append(button);
    }

    this.replaceChildren(label, group);
    this.#syncSelection();
    this.#localizeLabels();
  }

  async #localizeLabels() {
    const l10n = this.ownerDocument.l10n;
    if (!l10n) {
      return;
    }

    const request = ++this.#l10nRequest;
    const elements = Array.from(this.querySelectorAll("[data-label-l10n-id]"));
    const messages = await l10n.formatMessages(
      elements.map(element => ({ id: element.dataset.labelL10nId }))
    );
    if (request != this.#l10nRequest || !this.isConnected) {
      return;
    }

    for (let i = 0; i < elements.length; i++) {
      elements[i].textContent = this.#messageLabel(messages[i]);
    }
  }

  #messageLabel(message) {
    return (
      message?.attributes?.find(attribute => attribute.name == "label")
        ?.value ??
      message?.value ??
      ""
    );
  }

  #syncSelection() {
    const buttons = this.#buttons;
    const selectedButton = this.#selectedButton ?? buttons[0];

    for (let button of buttons) {
      const checked = button.dataset.value == this.#value;
      button.disabled = this.disabled;
      button.setAttribute("aria-checked", checked);
      button.tabIndex = button == selectedButton && !button.disabled ? 0 : -1;
    }
  }

  get #buttons() {
    return Array.from(this.querySelectorAll(".waterfox-mode-segmented-option"));
  }

  get #selectedButton() {
    return this.#buttons.find(button => button.dataset.value == this.#value);
  }

  handleEvent(event) {
    if (event.type == "click") {
      this.#handleClick(event);
    } else if (event.type == "keydown") {
      this.#handleKeyDown(event);
    }
  }

  #handleClick(event) {
    if (!Element.isInstance(event.target)) {
      return;
    }

    const button = event.target.closest(".waterfox-mode-segmented-option");
    if (!button || button.disabled) {
      return;
    }
    this.#selectValue(button.dataset.value);
  }

  #handleKeyDown(event) {
    if (this.disabled) {
      return;
    }

    const buttons = this.#buttons.filter(button => !button.disabled);
    if (!buttons.length) {
      return;
    }

    const currentButton = Element.isInstance(event.target)
      ? event.target.closest(".waterfox-mode-segmented-option")
      : null;
    let currentIndex = buttons.indexOf(currentButton);
    if (currentIndex < 0) {
      currentIndex = Math.max(buttons.indexOf(this.#selectedButton), 0);
    }

    let nextIndex;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (currentIndex + buttons.length - 1) % buttons.length;
        break;
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % buttons.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = buttons.length - 1;
        break;
      case " ":
      case "Enter":
        nextIndex = currentIndex;
        break;
      default:
        return;
    }

    event.preventDefault();
    buttons[nextIndex].focus();
    this.#selectValue(buttons[nextIndex].dataset.value);
  }

  #selectValue(value) {
    if (value == this.#value) {
      return;
    }
    this.value = value;
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

if (!customElements.get("waterfox-mode-segmented")) {
  customElements.define("waterfox-mode-segmented", WaterfoxModeSegmented);
}

function svgDataUri(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const BROWSER_STYLE_PREVIEW =
  "chrome://browser/content/waterfox/style/waterfox-style-";

// A full-bleed diagonal gradient; the blob corner shape is applied in CSS so
// the swatch matches the onboarding theme color tiles. The stops mirror the
// light variant of the WaterfoxThemeColors palettes.
function gradientSwatch(from, to) {
  return svgDataUri(`
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="1" stop-color="${to}"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" fill="url(#g)"/>
</svg>`);
}

const BROWSER_STYLE_OPTIONS = [
  {
    value: "nova",
    l10nId: "waterfox-appearance-browser-style-option-nova",
    imageSrc: `${BROWSER_STYLE_PREVIEW}nova.svg`,
  },
  {
    value: "proton",
    l10nId: "waterfox-appearance-browser-style-option-proton",
    imageSrc: `${BROWSER_STYLE_PREVIEW}proton.svg`,
  },
  {
    value: "photon",
    l10nId: "waterfox-appearance-browser-style-option-photon",
    imageSrc: `${BROWSER_STYLE_PREVIEW}photon.svg`,
  },
];

const THEME_COLORS = [
  {
    value: "default",
    l10nId: "waterfox-appearance-theme-color-option-default",
    imageSrc: gradientSwatch("#e7f3ff", "#b1d3f5"),
  },
  {
    value: "smoke",
    l10nId: "waterfox-appearance-theme-color-option-smoke",
    imageSrc: gradientSwatch("#f7f4f0", "#ebe4dc"),
  },
  {
    value: "ash",
    l10nId: "waterfox-appearance-theme-color-option-ash",
    imageSrc: gradientSwatch("#f7f8ff", "#dfe3f2"),
  },
  {
    value: "sun",
    l10nId: "waterfox-appearance-theme-color-option-sun",
    imageSrc: gradientSwatch("#fff0a8", "#ffd25f"),
  },
  {
    value: "spark",
    l10nId: "waterfox-appearance-theme-color-option-spark",
    imageSrc: gradientSwatch("#ffd8bd", "#ff9b6a"),
  },
  {
    value: "flame",
    l10nId: "waterfox-appearance-theme-color-option-flame",
    imageSrc: gradientSwatch("#ffd6de", "#ff8fa6"),
  },
  {
    value: "flare",
    l10nId: "waterfox-appearance-theme-color-option-flare",
    imageSrc: gradientSwatch("#ffd6f0", "#ff7fca"),
  },
  {
    value: "lavender",
    l10nId: "waterfox-appearance-theme-color-option-lavender",
    imageSrc: gradientSwatch("#efd6ff", "#c58cff"),
  },
  {
    value: "dusk",
    l10nId: "waterfox-appearance-theme-color-option-dusk",
    imageSrc: gradientSwatch("#e6dcff", "#b5a0ff"),
  },
  {
    value: "lagoon",
    l10nId: "waterfox-appearance-theme-color-option-lagoon",
    imageSrc: gradientSwatch("#d4ecff", "#79c8ff"),
  },
  {
    value: "tide",
    l10nId: "waterfox-appearance-theme-color-option-tide",
    imageSrc: gradientSwatch("#d8f4fb", "#80d5e5"),
  },
  {
    value: "pine",
    l10nId: "waterfox-appearance-theme-color-option-pine",
    imageSrc: gradientSwatch("#d8f6e5", "#80dca8"),
  },
];

Preferences.addAll([
  { id: CHROME_SHEET_PREF, type: "int" },
  { id: DENSITY_PREF, type: "int" },
  { id: STATUS_BAR_PREF, type: "bool" },
  { id: STATUS_BAR_TEXT_PREF, type: "bool" },
]);

function observeBranches(branches, emitChange) {
  for (let branch of branches) {
    Services.prefs.addObserver(branch, emitChange);
  }
  return () => {
    for (let branch of branches) {
      Services.prefs.removeObserver(branch, emitChange);
    }
  };
}

function statusBarOff(deps) {
  return !deps["waterfox-statusbar-enabled"].value;
}

Preferences.addSetting({
  id: "waterfox-browser-style",
  get: () => lazy.WaterfoxBrowserStyle.getStyle(),
  set: val => lazy.WaterfoxBrowserStyle.setStyle(val),
  setup: emitChange =>
    observeBranches([BROWSER_STYLE_PREF, NOVA_PREF], emitChange),
});

Preferences.addSetting({
  id: "waterfox-density",
  pref: DENSITY_PREF,
  get: val =>
    Object.keys(DENSITY_VALUES).find(key => DENSITY_VALUES[key] == val) ??
    "normal",
  set: val => DENSITY_VALUES[val] ?? DENSITY_VALUES.normal,
});

Preferences.addSetting({
  id: "waterfox-chrome-sheet",
  pref: CHROME_SHEET_PREF,
  get: val => val != CHROME_SHEET_OFF,
  set: enabled => (enabled ? CHROME_SHEET_ON : CHROME_SHEET_OFF),
});

Preferences.addSetting({
  id: "waterfox-theme-mode",
  get: () => lazy.WaterfoxThemeColors.getMode(),
  set: val => lazy.WaterfoxThemeColors.setMode(val),
  setup: emitChange => observeBranches([WATERFOX_THEME_MODE_PREF], emitChange),
});

Preferences.addSetting({
  id: "waterfox-theme-color",
  get: () => lazy.WaterfoxThemeColors.getColor(),
  set: val => lazy.WaterfoxThemeColors.setColor(val),
  setup: emitChange => observeBranches([WATERFOX_THEME_COLOR_PREF], emitChange),
});

Preferences.addSetting({
  id: "waterfox-statusbar-enabled",
  pref: STATUS_BAR_PREF,
});

Preferences.addSetting({
  id: "waterfox-statusbar-show-links",
  pref: STATUS_BAR_TEXT_PREF,
  deps: ["waterfox-statusbar-enabled"],
  disabled: statusBarOff,
});

SettingGroupManager.registerGroups({
  waterfoxBrowserStyle: {
    l10nId: "waterfox-appearance-browser-style-group",
    supportPage: "waterfox-browser-styles-and-colors",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-browser-style",
        control: "moz-visual-picker",
        controlAttrs: { class: "waterfox-browser-style-picker" },
        options: BROWSER_STYLE_OPTIONS.map(option => ({
          value: option.value,
          l10nId: option.l10nId,
          controlAttrs: {
            class: "setting-chooser-item",
            imagesrc: option.imageSrc,
          },
        })),
      },
      {
        id: "waterfox-density",
        l10nId: "waterfox-density-group",
        control: "waterfox-mode-segmented",
        controlAttrs: {
          class: "waterfox-mode-segmented",
          ".options": DENSITY_OPTIONS,
          searchkeywords: "density compact normal touch spacing size",
        },
      },
    ],
  },
  waterfoxThemeColors: {
    l10nId: "waterfox-appearance-theme-colors-group",
    supportPage: "waterfox-browser-styles-and-colors",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-theme-mode",
        l10nId: "waterfox-appearance-theme-mode-picker",
        control: "waterfox-mode-segmented",
        controlAttrs: {
          class: "waterfox-mode-segmented",
          ".options": THEME_MODES,
          searchkeywords: "theme mode system light dark",
        },
      },
      {
        id: "waterfox-theme-color",
        l10nId: "waterfox-appearance-theme-color-picker",
        control: "moz-visual-picker",
        controlAttrs: {
          class: "waterfox-color-grid",
          searchkeywords: "theme color accent palette",
        },
        options: THEME_COLORS.map(option => ({
          value: option.value,
          l10nId: option.l10nId,
          controlAttrs: {
            class: "waterfox-color-option",
            imagesrc: option.imageSrc,
          },
        })),
      },
    ],
  },
  waterfoxStatusBar: {
    l10nId: "waterfox-appearance-statusbar-heading",
    supportPage: "waterfox-status-bar",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-statusbar-enabled",
        l10nId: "waterfox-appearance-statusbar-enabled-toggle",
        control: "moz-toggle",
        controlAttrs: {
          searchkeywords: "status bar links bottom toolbar",
        },
      },
      {
        id: "waterfox-statusbar-show-links",
        l10nId: "waterfox-appearance-statusbar-links-toggle",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxInterfaceCustomizations: {
    l10nId: "waterfox-appearance-interface-customizations-group",
    supportPage: "waterfox-browser-styles-and-colors",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-chrome-sheet",
        l10nId: "waterfox-appearance-chrome-sheet",
        control: "moz-toggle",
        controlAttrs: {
          searchkeywords: "customise interface stylesheet on off",
        },
      },
    ],
  },
});

// The appearance styling uses shadow ::part() selectors for visual pickers,
// which only match from an author sheet in the preferences document. This
// module runs in the preferences global, so attach the sheet here.
(function injectAppearanceSheet() {
  const doc = globalThis.document;
  const href =
    "chrome://browser/content/waterfox/settings/waterfoxAppearance.css";
  if (!doc || doc.querySelector(`link[href="${href}"]`)) {
    return;
  }
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  (doc.head || doc.documentElement).appendChild(link);
})();
