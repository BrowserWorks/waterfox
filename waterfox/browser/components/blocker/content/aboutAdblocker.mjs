/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { WaterfoxBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);
const { WaterfoxShields } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxShields.sys.mjs"
);

const PREF_ENABLED = "waterfox.blocker.enabled";
const PREF_ALLOW_SEARCH_PARTNER_ADS = "waterfox.blocker.allowSearchPartnerAds";
const PREF_SHOW_BADGE = "waterfox.blocker.showBadge";
const PREF_CNAME_UNCLOAKING = "waterfox.blocker.cnameUncloaking";
const PREF_FILTER_LIST_URLS = "waterfox.blocker.filterListUrls";
const PREF_CUSTOM_RULES = "waterfox.blocker.customRules";
const PREF_ENABLED_LISTS = "waterfox.blocker.enabledLists";
const PREF_LIST_REFRESH_INTERVAL_HOURS =
  "waterfox.blocker.listRefreshIntervalHours";
const PREF_SHIELDS_FINGERPRINTING = "waterfox.shields.fingerprinting";
const PREF_SHIELDS_JAVASCRIPT = "waterfox.shields.javascript";
const PREF_SHIELDS_LANGUAGE_REDUCTION = "waterfox.shields.languageReduction";
const PREF_SHIELDS_SITE_SETTINGS = "waterfox.shields.siteSettings";
const DEFAULT_LIST_REFRESH_INTERVAL_HOURS = 168;
const MIN_LIST_REFRESH_INTERVAL_HOURS = 1;
const MAX_LIST_REFRESH_INTERVAL_HOURS = 720;

const STATUS_CLEAR_DELAY_MS = 3000;

// ── Filter list category metadata ─────────────────────────────────────────────

const CATEGORY_ORDER = [
  "core",
  "privacy",
  "annoyances",
  "optional",
  "regional",
];
const EXPANDED_BY_DEFAULT = new Set(["core", "privacy", "annoyances"]);

const CATEGORY_LABELS = Object.freeze({
  annoyances: "Annoyances",
  core: "Default",
  optional: "Optional",
  privacy: "Privacy",
  regional: "Regional",
});

const CATEGORY_L10N_IDS = Object.freeze({
  annoyances: "waterfox-blocker-filter-lists-category-annoyances",
  core: "waterfox-blocker-filter-lists-category-core",
  optional: "waterfox-blocker-filter-lists-category-optional",
  privacy: "waterfox-blocker-filter-lists-category-privacy",
  regional: "waterfox-blocker-filter-lists-category-regional",
});

// ── Shared utility helpers ────────────────────────────────────────────────────

function normalizeDomain(input) {
  let domain = String(input || "")
    .trim()
    .toLowerCase();
  if (domain.endsWith(".")) {
    domain = domain.slice(0, -1);
  }
  return domain;
}

function getCustomFilterListUrls() {
  const raw = Services.prefs.getStringPref(PREF_FILTER_LIST_URLS, "");
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(Boolean);
    }
  } catch (_) {}
  return raw.split(/[,\n\r]+/).filter(Boolean);
}

function normalizeCustomFilterListUrls(values) {
  const urls = [];
  const invalid = [];
  const seen = new Set();

  for (const value of values) {
    const candidate = String(value || "").trim();
    if (!candidate) {
      continue;
    }
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (_) {
      invalid.push(candidate);
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      invalid.push(candidate);
      continue;
    }
    if (seen.has(parsed.href)) {
      continue;
    }
    seen.add(parsed.href);
    urls.push(parsed.href);
    if (urls.length >= 100) {
      break;
    }
  }
  return { invalid, urls };
}

function normalizeCustomRulesText(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .slice(0, 10000)
    .join("\n")
    .trim();
}

function formatDateTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) {
    return "";
  }

  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return "";
  }
}

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (!value) {
    return "";
  }

  const hours = Math.max(1, Math.round(value / (60 * 60 * 1000)));
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function clampRefreshIntervalHours(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_LIST_REFRESH_INTERVAL_HOURS;
  }
  return Math.max(
    MIN_LIST_REFRESH_INTERVAL_HOURS,
    Math.min(MAX_LIST_REFRESH_INTERVAL_HOURS, Math.round(number))
  );
}

// ── Filter list utilities ─────────────────────────────────────────────────────

function getCategoryKey(category) {
  return (
    String(category || "")
      .trim()
      .toLowerCase() || "optional"
  );
}

function getCategoryLabelInfo(category) {
  const key = getCategoryKey(category);
  if (Object.hasOwn(CATEGORY_LABELS, key)) {
    return { fallback: CATEGORY_LABELS[key], l10nId: CATEGORY_L10N_IDS[key] };
  }
  return {
    fallback: key
      .split(/[-_ ]+/)
      .filter(Boolean)
      .map(part => part[0].toUpperCase() + part.slice(1))
      .join(" "),
    l10nId: "",
  };
}

function getCategorySortIndex(category) {
  const index = CATEGORY_ORDER.indexOf(getCategoryKey(category));
  return index === -1 ? 999 : index;
}

function getSourceHost(entry) {
  const firstUrl = String(entry?.sources?.[0]?.url || "").trim();
  if (!firstUrl) {
    return "";
  }
  try {
    return new URL(firstUrl).hostname || firstUrl;
  } catch (_) {}
  try {
    return Services.io.newURI(firstUrl).host || firstUrl;
  } catch (_) {}
  return (
    firstUrl.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/)?.[1] || firstUrl
  );
}

// ── Status message helpers ────────────────────────────────────────────────────

const _statusTimers = new Map();

function showStatus(elementId, l10nId, args = null) {
  const el = document.getElementById(elementId);
  if (!el) {
    return;
  }
  if (_statusTimers.has(elementId)) {
    clearTimeout(_statusTimers.get(elementId));
  }
  el.removeAttribute("hidden");
  document.l10n.setAttributes(el, l10nId, args || undefined);
  const timer = setTimeout(() => {
    el.setAttribute("hidden", "hidden");
    _statusTimers.delete(elementId);
  }, STATUS_CLEAR_DELAY_MS);
  _statusTimers.set(elementId, timer);
}

// ── Filter Lists Dialog ───────────────────────────────────────────────────────

var gFilterListsDialog = {
  /** @type {Array} In-memory filter list entries with mutable `enabled` field. */
  _entries: [],
  _customUrlsPrefLocked: false,
  _enabledListsPrefLocked: false,
  _refreshInProgress: false,
  _refreshIntervalPrefLocked: false,

  open() {
    const dialog = document.getElementById("fl-dialog");
    if (!dialog) {
      return;
    }

    this._customUrlsPrefLocked = Services.prefs.prefIsLocked(
      PREF_FILTER_LIST_URLS
    );
    this._enabledListsPrefLocked =
      Services.prefs.prefIsLocked(PREF_ENABLED_LISTS);
    this._refreshIntervalPrefLocked = Services.prefs.prefIsLocked(
      PREF_LIST_REFRESH_INTERVAL_HOURS
    );

    // Populate fields from current pref values.
    const urlsField = document.getElementById("fl-custom-urls");
    urlsField.value = getCustomFilterListUrls().join("\n");
    urlsField.disabled = this._customUrlsPrefLocked;

    const refreshIntervalField = document.getElementById(
      "fl-refresh-interval-hours"
    );
    refreshIntervalField.value = String(
      clampRefreshIntervalHours(
        Services.prefs.getIntPref(
          PREF_LIST_REFRESH_INTERVAL_HOURS,
          DEFAULT_LIST_REFRESH_INTERVAL_HOURS
        )
      )
    );
    refreshIntervalField.disabled = this._refreshIntervalPrefLocked;

    document.getElementById("fl-save").disabled =
      this._customUrlsPrefLocked &&
      this._enabledListsPrefLocked &&
      this._refreshIntervalPrefLocked;

    this._hideError();
    this._hideRefreshStatus();

    // Load catalog asynchronously and build the category list.
    const categoriesContainer = document.getElementById("fl-categories");
    categoriesContainer.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "modal-loading";
    loading.textContent = "\u2026"; // ellipsis
    categoriesContainer.appendChild(loading);

    this._loadEntries().then(entries => {
      this._entries = entries;
      this._buildCategories();
    });

    dialog.showModal();
  },

  close() {
    document.getElementById("fl-dialog")?.close();
  },

  async _loadEntries() {
    let catalog = [];
    try {
      catalog = await WaterfoxBlockerService.getFilterListCatalog();
    } catch (err) {
      console.error("[WaterfoxBlocker] Failed to load filter lists:", err);
    }
    if (!Array.isArray(catalog)) {
      return [];
    }
    return catalog
      .map(entry => ({
        category: getCategoryKey(entry.category),
        enabled: !!entry.enabled,
        id: String(entry.id || ""),
        metadata: entry.metadata || null,
        sourceHost: getSourceHost(entry),
        title: String(entry.title || entry.id || ""),
      }))
      .filter(entry => !!entry.id)
      .sort((a, b) => {
        const diff =
          getCategorySortIndex(a.category) - getCategorySortIndex(b.category);
        if (diff !== 0) {
          return diff;
        }
        if (a.category !== b.category) {
          return a.category.localeCompare(b.category);
        }
        return a.title.localeCompare(b.title);
      });
  },

  _buildCategories() {
    const container = document.getElementById("fl-categories");
    container.replaceChildren();

    if (!this._entries.length) {
      const empty = document.createElement("p");
      document.l10n.setAttributes(
        empty,
        "waterfox-blocker-filter-lists-empty-state"
      );
      container.appendChild(empty);
      return;
    }

    const grouped = new Map();
    for (const entry of this._entries) {
      if (!grouped.has(entry.category)) {
        grouped.set(entry.category, []);
      }
      grouped.get(entry.category).push(entry);
    }

    const unknownCategories = [...grouped.keys()]
      .filter(cat => !CATEGORY_ORDER.includes(cat))
      .sort();

    for (const category of [...CATEGORY_ORDER, ...unknownCategories]) {
      const entries = grouped.get(category);
      if (!entries?.length) {
        continue;
      }
      container.appendChild(this._buildCategorySection(category, entries));
    }
  },

  _buildCategorySection(category, entries) {
    const details = document.createElement("details");
    details.className = "fl-category";
    details.open = EXPANDED_BY_DEFAULT.has(category);

    // ── Summary / header ──────────────────────────────────────────────────
    const summary = document.createElement("summary");
    summary.className = "fl-category-summary";

    const twisty = document.createElement("span");
    twisty.className = "fl-category-twisty";
    twisty.setAttribute("aria-hidden", "true");
    summary.appendChild(twisty);

    const titleSpan = document.createElement("span");
    titleSpan.className = "fl-category-title";
    const labelInfo = getCategoryLabelInfo(category);
    if (labelInfo.l10nId) {
      document.l10n.setAttributes(titleSpan, labelInfo.l10nId);
    } else {
      titleSpan.textContent = labelInfo.fallback;
    }
    summary.appendChild(titleSpan);

    const counter = document.createElement("span");
    counter.className = "fl-category-counter";
    summary.appendChild(counter);

    details.appendChild(summary);

    // ── Entry rows ────────────────────────────────────────────────────────
    const listDiv = document.createElement("div");
    listDiv.className = "fl-list";

    for (const entry of entries) {
      const row = document.createElement("label");
      row.className = "fl-list-row";

      const textDiv = document.createElement("div");
      textDiv.className = "fl-list-text";

      const titleEl = document.createElement("span");
      titleEl.className = "fl-list-title";
      titleEl.textContent = entry.title;
      textDiv.appendChild(titleEl);

      if (entry.sourceHost) {
        const sourceEl = document.createElement("span");
        sourceEl.className = "fl-list-source";
        sourceEl.textContent = entry.sourceHost;
        textDiv.appendChild(sourceEl);
      }

      const metadataText = this._formatEntryMetadata(entry);
      if (metadataText) {
        const metadataEl = document.createElement("span");
        metadataEl.className = "fl-list-metadata";
        metadataEl.textContent = metadataText;
        textDiv.appendChild(metadataEl);
      }

      row.appendChild(textDiv);

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = entry.enabled;
      checkbox.disabled = this._enabledListsPrefLocked;
      checkbox.addEventListener("change", () => {
        entry.enabled = checkbox.checked;
        this._updateCounter(counter, entries);
      });
      row.appendChild(checkbox);

      listDiv.appendChild(row);
    }

    details.appendChild(listDiv);
    this._updateCounter(counter, entries);
    return details;
  },

  _updateCounter(counterEl, entries) {
    const enabled = entries.filter(e => e.enabled).length;
    counterEl.textContent = `${enabled}\u200A/\u200A${entries.length}`;
  },

  _hideError() {
    const el = document.getElementById("fl-url-error");
    if (el) {
      el.setAttribute("hidden", "hidden");
      el.textContent = "";
    }
  },

  _showError(message) {
    const el = document.getElementById("fl-url-error");
    if (el) {
      el.removeAttribute("hidden");
      el.textContent = message;
    }
  },

  _hideRefreshStatus() {
    const el = document.getElementById("fl-refresh-status");
    if (el) {
      el.setAttribute("hidden", "hidden");
      el.textContent = "";
    }
  },

  _showRefreshStatus(l10nId) {
    const el = document.getElementById("fl-refresh-status");
    if (!el) {
      return;
    }
    el.removeAttribute("hidden");
    document.l10n.setAttributes(el, l10nId);
  },

  _formatEntryMetadata(entry) {
    const metadata = entry?.metadata;
    if (!metadata) {
      return "";
    }

    const parts = [];
    const lastFetched = formatDateTime(metadata.lastFetched);
    if (lastFetched) {
      parts.push(`Last updated: ${lastFetched}`);
    }

    const expiresAt = formatDateTime(metadata.expiresAt);
    if (expiresAt) {
      parts.push(`Next refresh: ${expiresAt}`);
    }

    const refreshIntervals = (metadata.sourceMetadata || [])
      .map(source => formatDuration(source.refreshAfterMs))
      .filter(Boolean);
    if (refreshIntervals.length) {
      parts.push(`Cadence: ${refreshIntervals[0]}`);
    }

    return parts.join(" \u2022 ");
  },

  async _refreshListsNow() {
    if (this._refreshInProgress) {
      return;
    }

    const refreshButton = document.getElementById("fl-refresh-now");
    this._refreshInProgress = true;
    refreshButton.disabled = true;
    this._showRefreshStatus("waterfox-blocker-filter-lists-refreshing");

    try {
      await WaterfoxBlockerService.refreshFilterLists();
      this._entries = await this._loadEntries();
      this._buildCategories();
      this._showRefreshStatus("waterfox-blocker-filter-lists-refreshed");
    } catch (err) {
      console.error("[WaterfoxBlocker] Failed to refresh filter lists:", err);
      this._showRefreshStatus("waterfox-blocker-filter-lists-refresh-failed");
    } finally {
      this._refreshInProgress = false;
      refreshButton.disabled = false;
    }
  },

  save() {
    this._hideError();

    // Validate and collect custom URL list.
    let customUrls = null;
    if (!this._customUrlsPrefLocked) {
      const urlsField = document.getElementById("fl-custom-urls");
      const { invalid, urls } = normalizeCustomFilterListUrls(
        urlsField.value.split(/\r?\n/)
      );
      if (invalid.length) {
        // Resolve the error message asynchronously and display inline.
        document.l10n
          .formatValues([
            { id: "waterfox-blocker-filter-lists-invalid-url-title" },
            {
              id: "waterfox-blocker-filter-lists-invalid-url-message",
              args: { urls: invalid.slice(0, 5).join("\n") },
            },
          ])
          .then(([_title, message]) => this._showError(message))
          .catch(() =>
            this._showError(
              `Use only HTTP/HTTPS URLs. Could not save:\n${invalid.slice(0, 5).join("\n")}`
            )
          );
        urlsField.focus();
        return;
      }
      customUrls = urls;
    }

    // Persist enabled-lists state.
    if (!this._enabledListsPrefLocked && this._entries.length) {
      const nextState = {};
      for (const entry of this._entries) {
        nextState[entry.id] = !!entry.enabled;
      }
      Services.prefs.setStringPref(
        PREF_ENABLED_LISTS,
        JSON.stringify(nextState)
      );
    }

    if (customUrls !== null) {
      Services.prefs.setStringPref(
        PREF_FILTER_LIST_URLS,
        JSON.stringify(customUrls)
      );
    }

    if (!this._refreshIntervalPrefLocked) {
      Services.prefs.setIntPref(
        PREF_LIST_REFRESH_INTERVAL_HOURS,
        clampRefreshIntervalHours(
          document.getElementById("fl-refresh-interval-hours")?.value
        )
      );
    }

    this.close();

    // Sync main-page fields.
    gAdblockerPage._loadFilterListUrls();
  },

  _wireEvents() {
    document
      .getElementById("fl-close")
      ?.addEventListener("click", () => this.close());
    document
      .getElementById("fl-cancel")
      ?.addEventListener("click", () => this.close());
    document
      .getElementById("fl-save")
      ?.addEventListener("click", () => this.save());
    document
      .getElementById("fl-refresh-now")
      ?.addEventListener("click", () => this._refreshListsNow());

    // Close when clicking the backdrop (outside the dialog box).
    document.getElementById("fl-dialog")?.addEventListener("click", event => {
      if (event.target === event.currentTarget) {
        this.close();
      }
    });
  },
};

// ── Page manager ──────────────────────────────────────────────────────────────

var gAdblockerPage = {
  /** @type {Set<string>} In-memory copy of sites with ad blocking disabled. */
  _adBlockAllowlist: new Set(),

  /** @type {{[key: string]: boolean}} Map of pref key -> locked state. */
  _prefLocked: {},
  _observingPrefs: false,

  onLoad() {
    this._checkPrefLocks();
    this._loadGeneralSettings();
    this._loadFilterListUrls();
    this._loadCustomRules();
    this._loadAllowlist();
    this._loadPrivacySettings();
    this._wireEvents();
    this._observePrefs();

    // Wire dialog events once.
    gFilterListsDialog._wireEvents();
  },

  onUnload() {
    this._unobservePrefs();
  },

  // ── Initialisation ──────────────────────────────────────────────────────────

  _checkPrefLocks() {
    for (const pref of [
      PREF_ENABLED,
      PREF_ALLOW_SEARCH_PARTNER_ADS,
      PREF_SHOW_BADGE,
      PREF_CNAME_UNCLOAKING,
      PREF_FILTER_LIST_URLS,
      PREF_CUSTOM_RULES,
      PREF_SHIELDS_FINGERPRINTING,
      PREF_SHIELDS_JAVASCRIPT,
      PREF_SHIELDS_LANGUAGE_REDUCTION,
      PREF_SHIELDS_SITE_SETTINGS,
    ]) {
      this._prefLocked[pref] = Services.prefs.prefIsLocked(pref);
    }
  },

  _observePrefs() {
    if (this._observingPrefs) {
      return;
    }

    for (const pref of [
      PREF_ENABLED,
      PREF_ALLOW_SEARCH_PARTNER_ADS,
      PREF_SHOW_BADGE,
      PREF_CNAME_UNCLOAKING,
      PREF_SHIELDS_FINGERPRINTING,
      PREF_SHIELDS_JAVASCRIPT,
      PREF_SHIELDS_LANGUAGE_REDUCTION,
      PREF_SHIELDS_SITE_SETTINGS,
    ]) {
      Services.prefs.addObserver(pref, this);
    }
    this._observingPrefs = true;
  },

  _unobservePrefs() {
    if (!this._observingPrefs) {
      return;
    }

    for (const pref of [
      PREF_ENABLED,
      PREF_ALLOW_SEARCH_PARTNER_ADS,
      PREF_SHOW_BADGE,
      PREF_CNAME_UNCLOAKING,
      PREF_SHIELDS_FINGERPRINTING,
      PREF_SHIELDS_JAVASCRIPT,
      PREF_SHIELDS_LANGUAGE_REDUCTION,
      PREF_SHIELDS_SITE_SETTINGS,
    ]) {
      try {
        Services.prefs.removeObserver(pref, this);
      } catch (_) {}
    }
    this._observingPrefs = false;
  },

  observe(_subject, topic, data) {
    if (topic !== "nsPref:changed") {
      return;
    }

    switch (data) {
      case PREF_ENABLED:
      case PREF_ALLOW_SEARCH_PARTNER_ADS:
      case PREF_SHOW_BADGE:
      case PREF_CNAME_UNCLOAKING:
        this._loadGeneralSettings();
        break;

      case PREF_SHIELDS_FINGERPRINTING:
      case PREF_SHIELDS_JAVASCRIPT:
      case PREF_SHIELDS_LANGUAGE_REDUCTION:
        this._loadPrivacySettings();
        break;

      case PREF_SHIELDS_SITE_SETTINGS:
        this._loadAllowlist();
        break;

      default:
        break;
    }
  },

  _loadGeneralSettings() {
    const map = [
      { id: "adblocker-enabled", pref: PREF_ENABLED, defaultValue: true },
      {
        id: "adblocker-search-partner",
        pref: PREF_ALLOW_SEARCH_PARTNER_ADS,
        defaultValue: true,
      },
      { id: "adblocker-show-badge", pref: PREF_SHOW_BADGE, defaultValue: true },
      {
        id: "adblocker-cname",
        pref: PREF_CNAME_UNCLOAKING,
        defaultValue: true,
      },
    ];

    for (const { id, pref, defaultValue } of map) {
      const el = document.getElementById(id);
      if (!el) {
        continue;
      }
      el.checked =
        pref === PREF_ENABLED
          ? WaterfoxShields.getGlobalAdBlockEnabled()
          : Services.prefs.getBoolPref(pref, defaultValue);
      el.disabled = this._prefLocked[pref];
    }

    const saveBtn = document.getElementById("save-general");
    if (saveBtn) {
      saveBtn.disabled = map.every(({ pref }) => this._prefLocked[pref]);
    }
  },

  _loadFilterListUrls() {
    const el = document.getElementById("filter-list-urls");
    if (el) {
      el.value = getCustomFilterListUrls().join("\n");
      el.disabled = this._prefLocked[PREF_FILTER_LIST_URLS];
    }
    const saveBtn = document.getElementById("save-filter-lists");
    if (saveBtn) {
      saveBtn.disabled = this._prefLocked[PREF_FILTER_LIST_URLS];
    }
  },

  _loadCustomRules() {
    const el = document.getElementById("custom-rules");
    if (el) {
      el.value = normalizeCustomRulesText(
        Services.prefs.getStringPref(PREF_CUSTOM_RULES, "")
      );
      el.disabled = this._prefLocked[PREF_CUSTOM_RULES];
    }
    const saveBtn = document.getElementById("save-my-filters");
    if (saveBtn) {
      saveBtn.disabled = this._prefLocked[PREF_CUSTOM_RULES];
    }
  },

  _loadAllowlist() {
    this._adBlockAllowlist = new Set(
      WaterfoxShields.getSiteAdBlockExceptions()
    );
    this._renderAllowlist();
  },

  // ── Allowlist rendering ─────────────────────────────────────────────────────

  _renderAllowlist() {
    const container = document.getElementById("allowlist-sites");
    if (!container) {
      return;
    }
    container.replaceChildren();

    const sorted = [...this._adBlockAllowlist].sort();
    for (const site of sorted) {
      const item = document.createElement("div");
      item.className = "adblocker-allowlist-item";

      const siteLabel = document.createElement("span");
      siteLabel.textContent = site;
      item.appendChild(siteLabel);

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "\xD7";
      removeBtn.setAttribute("aria-label", `Remove ${site}`);
      removeBtn.className = "adblocker-allowlist-remove";
      removeBtn.disabled = this._prefLocked[PREF_SHIELDS_SITE_SETTINGS];
      removeBtn.addEventListener("click", () => {
        this._removeAllowlistSite(site);
      });
      item.appendChild(removeBtn);

      container.appendChild(item);
    }
    container.hidden = !sorted.length;

    const input = document.getElementById("allowlist-input");
    if (input) {
      input.disabled = this._prefLocked[PREF_SHIELDS_SITE_SETTINGS];
    }

    const addButton = document.getElementById("allowlist-add");
    if (addButton) {
      addButton.disabled = this._prefLocked[PREF_SHIELDS_SITE_SETTINGS];
    }
  },

  _addAllowlistSite(domain) {
    if (this._prefLocked[PREF_SHIELDS_SITE_SETTINGS]) {
      return false;
    }

    const normalized = normalizeDomain(domain);
    if (!normalized) {
      return false;
    }
    this._adBlockAllowlist.add(normalized);
    WaterfoxShields.setSiteAdBlockEnabled(normalized, false);
    this._renderAllowlist();
    return true;
  },

  _removeAllowlistSite(domain) {
    if (this._prefLocked[PREF_SHIELDS_SITE_SETTINGS]) {
      return;
    }

    this._adBlockAllowlist.delete(domain);
    WaterfoxShields.clearSiteAdBlockEnabled(domain);
    this._renderAllowlist();
    showStatus("status-allowlist", "waterfox-adblocker-status-allowlist-saved");
  },

  // ── Event wiring ────────────────────────────────────────────────────────────

  _wireEvents() {
    const bindings = [
      ["save-general", "click", () => this._saveGeneralSettings()],
      ["save-filter-lists", "click", () => this._saveFilterListUrls()],
      ["save-my-filters", "click", () => this._saveCustomRules()],
      ["open-filter-lists", "click", () => gFilterListsDialog.open()],
      ["allowlist-add", "click", () => this._onAllowlistAdd()],
      ["save-privacy", "click", () => this._savePrivacySettings()],
    ];

    for (const [id, event, handler] of bindings) {
      document.getElementById(id)?.addEventListener(event, handler);
    }

    this._wireNavigation();

    document
      .getElementById("allowlist-input")
      ?.addEventListener("keypress", event => {
        if (event.key === "Enter") {
          this._onAllowlistAdd();
        }
      });
  },

  _wireNavigation() {
    const navItems = [
      ["category-general", "section-general"],
      ["category-filter-lists", "section-filter-lists"],
      ["category-my-filters", "section-my-filters"],
      ["category-allowlist", "section-allowlist"],
      ["category-privacy", "section-privacy"],
    ]
      .map(([navId, sectionId]) => ({
        nav: document.getElementById(navId),
        section: document.getElementById(sectionId),
      }))
      .filter(item => item.nav && item.section);

    const selectNavItem = selectedNav => {
      for (const { nav } of navItems) {
        const selected = nav === selectedNav;
        nav.classList.toggle("selected", selected);
        nav.setAttribute("aria-selected", String(selected));
      }
    };

    for (const { nav } of navItems) {
      nav.addEventListener("click", () => {
        selectNavItem(nav);
      });
    }

    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(entry => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) {
          return;
        }

        const match = navItems.find(item => item.section === visible.target);
        if (match) {
          selectNavItem(match.nav);
        }
      },
      {
        root: document.querySelector(".adblocker-main"),
        threshold: [0.25, 0.5, 0.75],
      }
    );

    for (const { section } of navItems) {
      observer.observe(section);
    }
  },

  _onAllowlistAdd() {
    const input = document.getElementById("allowlist-input");
    if (!input) {
      return;
    }
    const domain = input.value.trim();
    if (this._addAllowlistSite(domain)) {
      input.value = "";
      showStatus(
        "status-allowlist",
        "waterfox-adblocker-status-allowlist-saved"
      );
    }
  },

  // ── Privacy Shields section ─────────────────────────────────────────────────

  _loadPrivacySettings() {
    const fpLevel = WaterfoxShields.getGlobalFingerprintingLevel();
    const langLevel = WaterfoxShields.getGlobalLanguageReduction();
    const javascriptEnabled = WaterfoxShields.getGlobalJavascriptEnabled();

    const fpRadio = document.querySelector(
      `input[name="fingerprinting"][value="${fpLevel}"]`
    );
    if (fpRadio) {
      fpRadio.checked = true;
    }

    const langRadio = document.querySelector(
      `input[name="languageReduction"][value="${langLevel}"]`
    );
    if (langRadio) {
      langRadio.checked = true;
    }

    const javascriptRadio = document.querySelector(
      `input[name="javascript"][value="${javascriptEnabled ? 1 : 0}"]`
    );
    if (javascriptRadio) {
      javascriptRadio.checked = true;
    }

    const privacyControls = [
      {
        selector: 'input[name="fingerprinting"]',
        pref: PREF_SHIELDS_FINGERPRINTING,
      },
      {
        selector: 'input[name="languageReduction"]',
        pref: PREF_SHIELDS_LANGUAGE_REDUCTION,
      },
      {
        selector: 'input[name="javascript"]',
        pref: PREF_SHIELDS_JAVASCRIPT,
      },
    ];

    for (const { selector, pref } of privacyControls) {
      for (const control of document.querySelectorAll(selector)) {
        control.disabled = this._prefLocked[pref];
      }
    }

    const saveButton = document.getElementById("save-privacy");
    if (saveButton) {
      saveButton.disabled = privacyControls.every(
        ({ pref }) => this._prefLocked[pref]
      );
    }
  },

  _savePrivacySettings() {
    if (!this._prefLocked[PREF_SHIELDS_FINGERPRINTING]) {
      const fpRadio = document.querySelector(
        'input[name="fingerprinting"]:checked'
      );
      if (fpRadio) {
        WaterfoxShields.setGlobalFingerprintingLevel(
          parseInt(fpRadio.value, 10)
        );
      }
    }

    if (!this._prefLocked[PREF_SHIELDS_LANGUAGE_REDUCTION]) {
      const langRadio = document.querySelector(
        'input[name="languageReduction"]:checked'
      );
      if (langRadio) {
        WaterfoxShields.setGlobalLanguageReduction(
          parseInt(langRadio.value, 10)
        );
      }
    }

    if (!this._prefLocked[PREF_SHIELDS_JAVASCRIPT]) {
      const javascriptRadio = document.querySelector(
        'input[name="javascript"]:checked'
      );
      if (javascriptRadio) {
        WaterfoxShields.setGlobalJavascriptEnabled(
          javascriptRadio.value === "1"
        );
      }
    }

    showStatus("status-privacy", "waterfox-shields-status-saved");
  },

  // ── Save actions ────────────────────────────────────────────────────────────

  _saveGeneralSettings() {
    const map = [
      { id: "adblocker-enabled", pref: PREF_ENABLED },
      { id: "adblocker-search-partner", pref: PREF_ALLOW_SEARCH_PARTNER_ADS },
      { id: "adblocker-show-badge", pref: PREF_SHOW_BADGE },
      { id: "adblocker-cname", pref: PREF_CNAME_UNCLOAKING },
    ];
    try {
      for (const { id, pref } of map) {
        if (this._prefLocked[pref]) {
          continue;
        }
        const el = document.getElementById(id);
        if (el) {
          if (pref === PREF_ENABLED) {
            WaterfoxShields.setGlobalAdBlockEnabled(el.checked);
          } else {
            Services.prefs.setBoolPref(pref, el.checked);
          }
        }
      }
      showStatus("status-general", "waterfox-adblocker-status-general-saved");
    } catch (err) {
      console.error("[about:adblocker] Failed to save general settings:", err);
    }
  },

  _saveFilterListUrls() {
    const el = document.getElementById("filter-list-urls");
    if (!el || this._prefLocked[PREF_FILTER_LIST_URLS]) {
      return;
    }
    const { invalid, urls } = normalizeCustomFilterListUrls(
      el.value.split(/\r?\n/)
    );
    if (invalid.length) {
      showStatus(
        "status-filter-lists",
        "waterfox-adblocker-status-filter-lists-invalid",
        { urls: invalid.slice(0, 5).join("\n") }
      );
      el.focus();
      return;
    }
    Services.prefs.setStringPref(PREF_FILTER_LIST_URLS, JSON.stringify(urls));
    showStatus(
      "status-filter-lists",
      "waterfox-adblocker-status-filter-lists-saved"
    );
  },

  _saveCustomRules() {
    const el = document.getElementById("custom-rules");
    if (!el || this._prefLocked[PREF_CUSTOM_RULES]) {
      return;
    }
    Services.prefs.setStringPref(
      PREF_CUSTOM_RULES,
      normalizeCustomRulesText(el.value)
    );
    showStatus(
      "status-my-filters",
      "waterfox-adblocker-status-my-filters-saved"
    );
  },
};

document.addEventListener("DOMContentLoaded", () => {
  gAdblockerPage.onLoad();
});

window.addEventListener("unload", () => {
  gAdblockerPage.onUnload();
});
