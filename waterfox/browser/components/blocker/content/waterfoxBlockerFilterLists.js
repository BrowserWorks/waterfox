/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { WaterfoxBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);

const PREF_ENABLED_LISTS = "waterfox.blocker.enabledLists";
const PREF_LIST_REFRESH_INTERVAL_HOURS =
  "waterfox.blocker.listRefreshIntervalHours";
const DEFAULT_LIST_REFRESH_INTERVAL_HOURS = 168;
const MIN_LIST_REFRESH_INTERVAL_HOURS = 1;
const MAX_LIST_REFRESH_INTERVAL_HOURS = 720;

const CATEGORY_ORDER = ["core", "privacy", "annoyances", "optional", "regional"];
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function getCategoryKey(category) {
  return String(category || "").trim().toLowerCase() || "optional";
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
      .map(p => p[0].toUpperCase() + p.slice(1))
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

// ── Page manager ──────────────────────────────────────────────────────────────

var gFilterListsPage = {
  _entries: [],
  _enabledListsPrefLocked: false,
  _refreshInProgress: false,
  _refreshIntervalPrefLocked: false,

  init() {
    this._enabledListsPrefLocked = Services.prefs.prefIsLocked(PREF_ENABLED_LISTS);
    this._refreshIntervalPrefLocked = Services.prefs.prefIsLocked(
      PREF_LIST_REFRESH_INTERVAL_HOURS
    );

    const refreshIntervalField = document.getElementById("fl-refresh-interval-hours");
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
      this._enabledListsPrefLocked &&
      this._refreshIntervalPrefLocked;

    const categoriesContainer = document.getElementById("fl-categories");
    categoriesContainer.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "modal-loading";
    loading.textContent = "\u2026";
    categoriesContainer.appendChild(loading);

    this._loadEntries().then(entries => {
      this._entries = entries;
      this._buildCategories();
    });

    this._wireEvents();
  },

  _wireEvents() {
    document
      .getElementById("fl-cancel")
      ?.addEventListener("click", () => window.close());
    document
      .getElementById("fl-save")
      ?.addEventListener("click", () => this.save());
    document
      .getElementById("fl-refresh-now")
      ?.addEventListener("click", () => this._refreshListsNow());
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
      .map(s => formatDuration(s.refreshAfterMs))
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
    if (!this._enabledListsPrefLocked && this._entries.length) {
      const nextState = {};
      for (const entry of this._entries) {
        nextState[entry.id] = !!entry.enabled;
      }
      Services.prefs.setStringPref(PREF_ENABLED_LISTS, JSON.stringify(nextState));
    }

    if (!this._refreshIntervalPrefLocked) {
      Services.prefs.setIntPref(
        PREF_LIST_REFRESH_INTERVAL_HOURS,
        clampRefreshIntervalHours(
          document.getElementById("fl-refresh-interval-hours")?.value
        )
      );
    }

    window.close();
  },
};

document.addEventListener("DOMContentLoaded", () => {
  gFilterListsPage.init();
});
