/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  LightweightThemeManager:
    "resource://gre/modules/LightweightThemeManager.sys.mjs",
});

export const WATERFOX_THEME_MODE_PREF = "browser.theme.waterfox.mode";
export const WATERFOX_THEME_COLOR_PREF = "browser.theme.waterfox.color";
export const WATERFOX_THEME_ID = "waterfox-dynamic-theme@browserworks.org";

const ACTIVE_THEME_PREF = "extensions.activeThemeID";
const DEFAULT_THEME_ID = "default-theme@mozilla.org";
const THEME_UPDATE_TOPIC = "lightweight-theme-styling-update";
const DEFAULT_MODE = "system";
const DEFAULT_COLOR = "default";
const LEGACY_COLOR_ALIASES = Object.freeze({ classic: DEFAULT_COLOR });
const THEME_VERSION = "1.0";
const BASE_URI = Services.io.newURI("resource://gre/");
const MODES = new Set(["system", "light", "dark"]);
const IN_CONTENT_THEME_EXPERIMENT = Object.freeze({
  colors: {
    waterfox_accent_primary: "--color-accent-primary",
    waterfox_accent_primary_hover: "--color-accent-primary-hover",
    waterfox_accent_primary_active: "--color-accent-primary-active",
    waterfox_background_color_information: "--background-color-information",
    waterfox_icon_color_information: "--icon-color-information",
  },
});

const PALETTES = {
  default: {
    labelId: "waterfox-onboarding-color-default-label",
    swatch:
      "linear-gradient(135deg, light-dark(#e7f3ff, #0d2640), light-dark(#b1d3f5, #081a2d))",
    light: {
      frame: "#e7f3ff",
      toolbar: "#f7fbff",
      toolbar_text: "#09429f",
      tab_background_text: "#09429f",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#0a2540",
      toolbar_field_border_focus: "#09429f",
      tab_line: "#09429f",
      icons_attention: "#09429f",
      ntp_background: "#f7fbff",
      ntp_text: "#0a2540",
    },
    dark: {
      frame: "#0d2640",
      toolbar: "#081a2d",
      toolbar_text: "#d7ecff",
      tab_background_text: "#d7ecff",
      tab_selected: "#123556",
      toolbar_field: "#061523",
      toolbar_field_text: "#d7ecff",
      toolbar_field_border_focus: "#b1d3f5",
      tab_line: "#b1d3f5",
      icons_attention: "#b1d3f5",
      ntp_background: "#061523",
      ntp_text: "#d7ecff",
    },
    images: {
      light: {
        theme_frame: {
          "linear-gradient": "96deg, #e7f3ff 39.84%, #b1d3f5 101.72%",
        },
      },
      dark: {
        theme_frame: {
          "linear-gradient": "96deg, #0d2640 39.84%, #081a2d 101.72%",
        },
      },
    },
    content: {
      light: {
        waterfox_accent_primary: "#09429f",
        waterfox_accent_primary_hover: "#083578",
        waterfox_accent_primary_active: "#07295c",
        waterfox_background_color_information: "#d8e7f3",
        waterfox_icon_color_information: "#09429f",
      },
      dark: {
        waterfox_accent_primary: "#b1d3f5",
        waterfox_accent_primary_hover: "#c5def6",
        waterfox_accent_primary_active: "#d8e7f3",
        waterfox_background_color_information: "#07295c",
        waterfox_icon_color_information: "#c5def6",
      },
    },
  },
  smoke: {
    labelId: "waterfox-onboarding-color-smoke-label",
    swatch:
      "linear-gradient(135deg, light-dark(#f7f4f0, #2f2824), light-dark(#ebe4dc, #c9aa8f))",
    light: {
      frame: "#f7f4f0",
      toolbar: "#fffaf5",
      toolbar_text: "#3d342d",
      tab_background_text: "#3d342d",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#2b211b",
      toolbar_field_border_focus: "#b89b82",
      tab_line: "#b89b82",
      icons_attention: "#8a6f5a",
      ntp_background: "#fffaf5",
      ntp_text: "#2b211b",
    },
    dark: {
      frame: "#2f2824",
      toolbar: "#231f1c",
      toolbar_text: "#f4ece4",
      tab_background_text: "#f4ece4",
      tab_selected: "#3b332e",
      toolbar_field: "#1f1a17",
      toolbar_field_text: "#f4ece4",
      toolbar_field_border_focus: "#c9aa8f",
      tab_line: "#c9aa8f",
      icons_attention: "#c9aa8f",
      ntp_background: "#1f1a17",
      ntp_text: "#f4ece4",
    },
  },
  ash: {
    labelId: "waterfox-onboarding-color-ash-label",
    swatch:
      "linear-gradient(135deg, light-dark(#f7f8ff, #2b3038), light-dark(#dfe3f2, #4b5360))",
    light: {
      frame: "#eef1fb",
      toolbar: "#fbfcff",
      toolbar_text: "#2d3340",
      tab_background_text: "#2d3340",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#222832",
      toolbar_field_border_focus: "#8d99b5",
      tab_line: "#8d99b5",
      icons_attention: "#6f7d98",
      ntp_background: "#fbfcff",
      ntp_text: "#222832",
    },
    dark: {
      frame: "#252a33",
      toolbar: "#1b1f27",
      toolbar_text: "#edf1f8",
      tab_background_text: "#edf1f8",
      tab_selected: "#303641",
      toolbar_field: "#151922",
      toolbar_field_text: "#edf1f8",
      toolbar_field_border_focus: "#9aa6bd",
      tab_line: "#9aa6bd",
      icons_attention: "#9aa6bd",
      ntp_background: "#151922",
      ntp_text: "#edf1f8",
    },
  },
  sun: {
    labelId: "waterfox-onboarding-color-sun-label",
    swatch:
      "linear-gradient(135deg, light-dark(#fff0a8, #3a2b00), light-dark(#ffd25f, #ffd25f))",
    light: {
      frame: "#fff0a8",
      toolbar: "#fff8d6",
      toolbar_text: "#473400",
      tab_background_text: "#473400",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#332400",
      toolbar_field_border_focus: "#d68b00",
      tab_line: "#d68b00",
      icons_attention: "#b86f00",
      ntp_background: "#fffaf0",
      ntp_text: "#332400",
    },
    dark: {
      frame: "#3a2b00",
      toolbar: "#241b00",
      toolbar_text: "#fff0a8",
      tab_background_text: "#fff0a8",
      tab_selected: "#4a3800",
      toolbar_field: "#1c1500",
      toolbar_field_text: "#fff0a8",
      toolbar_field_border_focus: "#ffd25f",
      tab_line: "#ffd25f",
      icons_attention: "#ffd25f",
      ntp_background: "#1c1500",
      ntp_text: "#fff0a8",
    },
  },
  spark: {
    labelId: "waterfox-onboarding-color-spark-label",
    swatch:
      "linear-gradient(135deg, light-dark(#ffd8bd, #3b1e10), light-dark(#ff9b6a, #ff9b6a))",
    light: {
      frame: "#ffd8bd",
      toolbar: "#fff2e8",
      toolbar_text: "#4a240f",
      tab_background_text: "#4a240f",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#351707",
      toolbar_field_border_focus: "#e36b2c",
      tab_line: "#e36b2c",
      icons_attention: "#c55217",
      ntp_background: "#fff8f2",
      ntp_text: "#351707",
    },
    dark: {
      frame: "#3b1e10",
      toolbar: "#27140a",
      toolbar_text: "#ffd8bd",
      tab_background_text: "#ffd8bd",
      tab_selected: "#4a2816",
      toolbar_field: "#1f1008",
      toolbar_field_text: "#ffd8bd",
      toolbar_field_border_focus: "#ff9b6a",
      tab_line: "#ff9b6a",
      icons_attention: "#ff9b6a",
      ntp_background: "#1f1008",
      ntp_text: "#ffd8bd",
    },
  },
  flame: {
    labelId: "waterfox-onboarding-color-flame-label",
    swatch:
      "linear-gradient(135deg, light-dark(#ffd6de, #3b1721), light-dark(#ff8fa6, #ff8fa6))",
    light: {
      frame: "#ffd6de",
      toolbar: "#fff0f3",
      toolbar_text: "#4d1f2b",
      tab_background_text: "#4d1f2b",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#38131d",
      toolbar_field_border_focus: "#d94862",
      tab_line: "#d94862",
      icons_attention: "#be2f49",
      ntp_background: "#fff7f9",
      ntp_text: "#38131d",
    },
    dark: {
      frame: "#3b1721",
      toolbar: "#260e15",
      toolbar_text: "#ffd6de",
      tab_background_text: "#ffd6de",
      tab_selected: "#4d1f2b",
      toolbar_field: "#1f0b11",
      toolbar_field_text: "#ffd6de",
      toolbar_field_border_focus: "#ff8fa6",
      tab_line: "#ff8fa6",
      icons_attention: "#ff8fa6",
      ntp_background: "#1f0b11",
      ntp_text: "#ffd6de",
    },
  },
  flare: {
    labelId: "waterfox-onboarding-color-flare-label",
    swatch:
      "linear-gradient(135deg, light-dark(#ffd6f0, #38122b), light-dark(#ff7fca, #ff7fca))",
    light: {
      frame: "#ffd6f0",
      toolbar: "#fff0fa",
      toolbar_text: "#4a1739",
      tab_background_text: "#4a1739",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#351029",
      toolbar_field_border_focus: "#d72f92",
      tab_line: "#d72f92",
      icons_attention: "#b91f79",
      ntp_background: "#fff7fc",
      ntp_text: "#351029",
    },
    dark: {
      frame: "#38122b",
      toolbar: "#240b1c",
      toolbar_text: "#ffd6f0",
      tab_background_text: "#ffd6f0",
      tab_selected: "#4a1739",
      toolbar_field: "#1d0916",
      toolbar_field_text: "#ffd6f0",
      toolbar_field_border_focus: "#ff7fca",
      tab_line: "#ff7fca",
      icons_attention: "#ff7fca",
      ntp_background: "#1d0916",
      ntp_text: "#ffd6f0",
    },
  },
  lavender: {
    labelId: "waterfox-onboarding-color-lavender-label",
    swatch:
      "linear-gradient(135deg, light-dark(#efd6ff, #2d173f), light-dark(#c58cff, #c58cff))",
    light: {
      frame: "#efd6ff",
      toolbar: "#fbf3ff",
      toolbar_text: "#3b1a56",
      tab_background_text: "#3b1a56",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#2a113f",
      toolbar_field_border_focus: "#8f4bd8",
      tab_line: "#8f4bd8",
      icons_attention: "#7437bd",
      ntp_background: "#fdf8ff",
      ntp_text: "#2a113f",
    },
    dark: {
      frame: "#2d173f",
      toolbar: "#1f0f2d",
      toolbar_text: "#efd6ff",
      tab_background_text: "#efd6ff",
      tab_selected: "#3b1a56",
      toolbar_field: "#180b24",
      toolbar_field_text: "#efd6ff",
      toolbar_field_border_focus: "#c58cff",
      tab_line: "#c58cff",
      icons_attention: "#c58cff",
      ntp_background: "#180b24",
      ntp_text: "#efd6ff",
    },
  },
  dusk: {
    labelId: "waterfox-onboarding-color-dusk-label",
    swatch:
      "linear-gradient(135deg, light-dark(#e6dcff, #24163d), light-dark(#b5a0ff, #b5a0ff))",
    light: {
      frame: "#e6dcff",
      toolbar: "#f8f4ff",
      toolbar_text: "#2d1b55",
      tab_background_text: "#2d1b55",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#20123d",
      toolbar_field_border_focus: "#7d5ce1",
      tab_line: "#7d5ce1",
      icons_attention: "#6043c2",
      ntp_background: "#fbf9ff",
      ntp_text: "#20123d",
    },
    dark: {
      frame: "#24163d",
      toolbar: "#181026",
      toolbar_text: "#e6dcff",
      tab_background_text: "#e6dcff",
      tab_selected: "#2d1b55",
      toolbar_field: "#120b1f",
      toolbar_field_text: "#e6dcff",
      toolbar_field_border_focus: "#b5a0ff",
      tab_line: "#b5a0ff",
      icons_attention: "#b5a0ff",
      ntp_background: "#120b1f",
      ntp_text: "#e6dcff",
    },
  },
  lagoon: {
    labelId: "waterfox-onboarding-color-lagoon-label",
    swatch:
      "linear-gradient(135deg, light-dark(#d4ecff, #102b40), light-dark(#79c8ff, #79c8ff))",
    light: {
      frame: "#d4ecff",
      toolbar: "#eef8ff",
      toolbar_text: "#123a56",
      tab_background_text: "#123a56",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#0b2a40",
      toolbar_field_border_focus: "#238ad6",
      tab_line: "#238ad6",
      icons_attention: "#0b72bd",
      ntp_background: "#f6fbff",
      ntp_text: "#0b2a40",
    },
    dark: {
      frame: "#102b40",
      toolbar: "#0b1e2d",
      toolbar_text: "#d4ecff",
      tab_background_text: "#d4ecff",
      tab_selected: "#173b56",
      toolbar_field: "#081724",
      toolbar_field_text: "#d4ecff",
      toolbar_field_border_focus: "#79c8ff",
      tab_line: "#79c8ff",
      icons_attention: "#79c8ff",
      ntp_background: "#081724",
      ntp_text: "#d4ecff",
    },
  },
  tide: {
    labelId: "waterfox-onboarding-color-tide-label",
    swatch:
      "linear-gradient(135deg, light-dark(#d8f4fb, #102f36), light-dark(#80d5e5, #80d5e5))",
    light: {
      frame: "#d8f4fb",
      toolbar: "#effbfe",
      toolbar_text: "#123d46",
      tab_background_text: "#123d46",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#0a2b32",
      toolbar_field_border_focus: "#1b9db2",
      tab_line: "#1b9db2",
      icons_attention: "#087f92",
      ntp_background: "#f7fdff",
      ntp_text: "#0a2b32",
    },
    dark: {
      frame: "#102f36",
      toolbar: "#0a2026",
      toolbar_text: "#d8f4fb",
      tab_background_text: "#d8f4fb",
      tab_selected: "#163d46",
      toolbar_field: "#07191d",
      toolbar_field_text: "#d8f4fb",
      toolbar_field_border_focus: "#80d5e5",
      tab_line: "#80d5e5",
      icons_attention: "#80d5e5",
      ntp_background: "#07191d",
      ntp_text: "#d8f4fb",
    },
  },
  pine: {
    labelId: "waterfox-onboarding-color-pine-label",
    swatch:
      "linear-gradient(135deg, light-dark(#d8f6e5, #102f20), light-dark(#80dca8, #80dca8))",
    light: {
      frame: "#d8f6e5",
      toolbar: "#f0fcf5",
      toolbar_text: "#123d27",
      tab_background_text: "#123d27",
      tab_selected: "#ffffff",
      toolbar_field: "#ffffff",
      toolbar_field_text: "#0a2d1a",
      toolbar_field_border_focus: "#2a9d5b",
      tab_line: "#2a9d5b",
      icons_attention: "#178348",
      ntp_background: "#f7fff9",
      ntp_text: "#0a2d1a",
    },
    dark: {
      frame: "#102f20",
      toolbar: "#0a2015",
      toolbar_text: "#d8f6e5",
      tab_background_text: "#d8f6e5",
      tab_selected: "#173d2a",
      toolbar_field: "#07190f",
      toolbar_field_text: "#d8f6e5",
      toolbar_field_border_focus: "#80dca8",
      tab_line: "#80dca8",
      icons_attention: "#80dca8",
      ntp_background: "#07190f",
      ntp_text: "#d8f6e5",
    },
  },
};

const COLOR_ORDER = [
  DEFAULT_COLOR,
  "smoke",
  "ash",
  "sun",
  "spark",
  "flame",
  "flare",
  "lavender",
  "dusk",
  "lagoon",
  "tide",
  "pine",
];

function normalizeMode(mode) {
  return MODES.has(mode) ? mode : DEFAULT_MODE;
}

function normalizeColor(color) {
  color = LEGACY_COLOR_ALIASES[color] ?? color;
  return PALETTES[color] ? color : DEFAULT_COLOR;
}

function parseHexColor(color) {
  const normalized = color.replace("#", "");
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function toHexColor({ r, g, b }) {
  return `#${[r, g, b]
    .map(channel => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixHexColor(color, mixColor, mixWeight) {
  const base = parseHexColor(color);
  const mix = parseHexColor(mixColor);
  return toHexColor({
    r: base.r * (1 - mixWeight) + mix.r * mixWeight,
    g: base.g * (1 - mixWeight) + mix.g * mixWeight,
    b: base.b * (1 - mixWeight) + mix.b * mixWeight,
  });
}

function relativeLuminance(color) {
  const linearized = Object.values(parseHexColor(color)).map(channel => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * linearized[0] + 0.7152 * linearized[1] + 0.0722 * linearized[2]
  );
}

function contrastRatio(color, against) {
  const foreground = relativeLuminance(color);
  const background = relativeLuminance(against);
  const lighter = Math.max(foreground, background);
  const darker = Math.min(foreground, background);
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureContrast(color, against, mixColor) {
  let adjusted = color;
  for (let weight = 0; contrastRatio(adjusted, against) < 4.5; weight += 0.05) {
    if (weight > 0.65) {
      return adjusted;
    }
    adjusted = mixHexColor(color, mixColor, weight);
  }
  return adjusted;
}

function deriveInContentColors(colors, variant) {
  const isLight = variant === "light";
  const contrastColor = isLight ? "#ffffff" : "#252428";
  const contrastMixColor = isLight ? "#000000" : "#ffffff";
  const subtleMixColor = isLight ? "#ffffff" : "#000000";
  const accent = ensureContrast(
    colors.icons_attention,
    contrastColor,
    contrastMixColor
  );

  return {
    waterfox_accent_primary: accent,
    waterfox_accent_primary_hover: mixHexColor(accent, contrastMixColor, 0.12),
    waterfox_accent_primary_active: mixHexColor(accent, contrastMixColor, 0.24),
    waterfox_background_color_information: mixHexColor(
      accent,
      subtleMixColor,
      isLight ? 0.88 : 0.62
    ),
    waterfox_icon_color_information: accent,
  };
}

function makeThemeDetails(color, variant) {
  const palette = PALETTES[color];
  const colors = palette[variant];
  return {
    colors: {
      ...colors,
      ...deriveInContentColors(colors, variant),
      ...palette.content?.[variant],
    },
    images: palette.images?.[variant],
    properties: {
      color_scheme: variant,
      content_color_scheme: variant,
    },
  };
}

function notifyTheme(data) {
  Services.obs.notifyObservers(data, "lightweight-theme-styling-update");
}

export const WaterfoxThemeColors = {
  _initialized: false,
  _defaultThemeReapplyPending: false,

  get colors() {
    return COLOR_ORDER.map(id => ({
      id,
      labelId: PALETTES[id].labelId,
      swatch: PALETTES[id].swatch,
    }));
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    Services.prefs.addObserver(WATERFOX_THEME_MODE_PREF, this);
    Services.prefs.addObserver(WATERFOX_THEME_COLOR_PREF, this);
    Services.prefs.addObserver(ACTIVE_THEME_PREF, this);
    Services.obs.addObserver(this, THEME_UPDATE_TOPIC);

    if (
      Services.prefs.prefHasUserValue(WATERFOX_THEME_COLOR_PREF) &&
      normalizeColor(Services.prefs.getStringPref(WATERFOX_THEME_COLOR_PREF)) ==
        DEFAULT_COLOR
    ) {
      Services.prefs.clearUserPref(WATERFOX_THEME_COLOR_PREF);
    }

    if (this.hasSelection()) {
      this.apply();
    }
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    Services.prefs.removeObserver(WATERFOX_THEME_MODE_PREF, this);
    Services.prefs.removeObserver(WATERFOX_THEME_COLOR_PREF, this);
    Services.prefs.removeObserver(ACTIVE_THEME_PREF, this);
    Services.obs.removeObserver(this, THEME_UPDATE_TOPIC);
    this._initialized = false;
  },

  observe(subject, topic) {
    if (topic === THEME_UPDATE_TOPIC) {
      this._onThemeUpdate(subject?.wrappedJSObject);
      return;
    }

    if (this.hasSelection()) {
      this.apply();
    } else {
      this._clearThemeData();
    }
  },

  _onThemeUpdate(data) {
    if (
      data?.theme?.id !== DEFAULT_THEME_ID ||
      !this.hasSelection() ||
      this._defaultThemeReapplyPending
    ) {
      return;
    }

    this._defaultThemeReapplyPending = true;
    Services.tm.dispatchToMainThread(() => {
      this._defaultThemeReapplyPending = false;
      if (
        this._initialized &&
        this.hasSelection() &&
        this.shouldApply() &&
        lazy.LightweightThemeManager.themeData.theme?.id === DEFAULT_THEME_ID
      ) {
        this.apply();
      }
    });
  },

  hasSelection() {
    return (
      Services.prefs.prefHasUserValue(WATERFOX_THEME_MODE_PREF) ||
      Services.prefs.prefHasUserValue(WATERFOX_THEME_COLOR_PREF)
    );
  },

  getMode() {
    return normalizeMode(
      Services.prefs.getStringPref(WATERFOX_THEME_MODE_PREF, DEFAULT_MODE)
    );
  },

  getColor() {
    return normalizeColor(
      Services.prefs.getStringPref(WATERFOX_THEME_COLOR_PREF, DEFAULT_COLOR)
    );
  },

  setMode(mode) {
    Services.prefs.setStringPref(WATERFOX_THEME_MODE_PREF, normalizeMode(mode));
    return this.apply();
  },

  setColor(color) {
    color = normalizeColor(color);
    if (color == DEFAULT_COLOR) {
      if (Services.prefs.prefHasUserValue(WATERFOX_THEME_COLOR_PREF)) {
        Services.prefs.clearUserPref(WATERFOX_THEME_COLOR_PREF);
      }
      if (this.hasSelection()) {
        return this.apply();
      }
      return this._clearThemeData();
    }

    Services.prefs.setStringPref(WATERFOX_THEME_COLOR_PREF, color);
    return this.apply();
  },

  shouldApply() {
    const activeTheme = Services.prefs.getStringPref(ACTIVE_THEME_PREF, "");
    return !activeTheme || activeTheme === DEFAULT_THEME_ID;
  },

  buildThemeData(mode = this.getMode(), color = this.getColor()) {
    mode = normalizeMode(mode);
    color = normalizeColor(color);

    let lightDetails = makeThemeDetails(color, "light");
    let darkDetails = makeThemeDetails(color, "dark");

    if (mode === "light") {
      darkDetails = null;
    } else if (mode === "dark") {
      lightDetails = darkDetails;
      darkDetails = null;
    }

    return lazy.LightweightThemeManager.themeDataFrom(
      lightDetails,
      darkDetails,
      IN_CONTENT_THEME_EXPERIMENT,
      BASE_URI,
      WATERFOX_THEME_ID,
      THEME_VERSION,
      null
    );
  },

  apply() {
    if (!this.shouldApply()) {
      return null;
    }

    const data = this.buildThemeData();
    lazy.LightweightThemeManager.fallbackThemeData = data;
    notifyTheme(data);
    return data;
  },

  _clearThemeData() {
    const data = { theme: null };
    lazy.LightweightThemeManager.fallbackThemeData = null;
    notifyTheme(data);
    return data;
  },

  clear() {
    for (let pref of [WATERFOX_THEME_MODE_PREF, WATERFOX_THEME_COLOR_PREF]) {
      if (Services.prefs.prefHasUserValue(pref)) {
        Services.prefs.clearUserPref(pref);
      }
    }
    return this._clearThemeData();
  },
};
