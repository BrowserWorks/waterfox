/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { IOUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/IOUtils.sys.mjs"
);

const MAX_LOG_ENTRIES = 5000;
const DEFAULT_EXPORT_FILENAME = "waterfox-blocker-logger.json";

const FALLBACK_L10N = Object.freeze({
  "waterfox-blocker-logger-clear": "Clear",
  "waterfox-blocker-logger-column-action": "Action",
  "waterfox-blocker-logger-column-rule": "Rule",
  "waterfox-blocker-logger-column-source": "Source",
  "waterfox-blocker-logger-column-time": "Time",
  "waterfox-blocker-logger-column-type": "Type",
  "waterfox-blocker-logger-column-url": "URL",
  "waterfox-blocker-logger-current-tab-only": "Current tab only",
  "waterfox-blocker-logger-details-empty": "Select an entry to inspect it.",
  "waterfox-blocker-logger-empty": "No blocker log entries yet.",
  "waterfox-blocker-logger-empty-filtered":
    "No entries match the current tab or row filter.",
  "waterfox-blocker-logger-export": "Export…",
  "waterfox-blocker-logger-export-done-message":
    "The visible blocker log entries were saved.",
  "waterfox-blocker-logger-export-done-title": "Export complete",
  "waterfox-blocker-logger-export-error-message":
    "The blocker log could not be written.",
  "waterfox-blocker-logger-export-error-title": "Export failed",
  "waterfox-blocker-logger-export-title": "Export Blocker Log",
  "waterfox-blocker-logger-filter": "Filter logger rows",
  "waterfox-blocker-logger-field-action": "Action",
  "waterfox-blocker-logger-field-document-url": "Document URL",
  "waterfox-blocker-logger-field-message": "Message",
  "waterfox-blocker-logger-field-rule": "Rule",
  "waterfox-blocker-logger-field-scope": "Scope",
  "waterfox-blocker-logger-field-source": "Source",
  "waterfox-blocker-logger-field-tab-id": "Tab ID",
  "waterfox-blocker-logger-field-time": "Timestamp",
  "waterfox-blocker-logger-field-type": "Type",
  "waterfox-blocker-logger-field-url": "URL",
  "waterfox-blocker-logger-pause": "Pause",
  "waterfox-blocker-logger-resume": "Resume",
  "waterfox-blocker-logger-state-live": "Live",
  "waterfox-blocker-logger-state-paused": "Paused",
});

function createXULElement(tag, attrs = {}) {
  const element = document.createXULElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) {
      element.setAttribute(name, value);
    }
  }
  return element;
}

function formatFallback(l10nId, args = null) {
  if (l10nId === "waterfox-blocker-logger-summary") {
    return `${Number(args?.shown || 0)} of ${Number(
      args?.total || 0
    )} entries shown`;
  }

  return FALLBACK_L10N[l10nId] || "";
}

function setLabelL10nAttributes(element, l10nId, args = null) {
  if (!element || !l10nId) {
    return;
  }

  const fallback = formatFallback(l10nId, args);
  if (fallback) {
    element.setAttribute("label", fallback);
    element.setAttribute("value", fallback);
    element.textContent = fallback;
  }

  document.l10n.setAttributes(element, l10nId, args || undefined);
}

function setTextL10nAttributes(element, l10nId, args = null) {
  if (!element || !l10nId) {
    return;
  }

  const fallback = formatFallback(l10nId, args);
  if (fallback) {
    element.textContent = fallback;
    element.setAttribute("value", fallback);
  }

  document.l10n.setAttributes(element, l10nId, args || undefined);
}

async function formatValueWithFallback(l10nId, args = null) {
  const fallback = formatFallback(l10nId, args) || l10nId;
  try {
    const value = await document.l10n.formatValue(l10nId, args || undefined);
    if (value && value !== l10nId) {
      return value;
    }
  } catch (_) {}

  return fallback;
}

async function formatValuesWithFallback(requests) {
  const values = [];
  for (const request of requests) {
    values.push(await formatValueWithFallback(request.id, request.args));
  }
  return values;
}

function readFirstString(raw, keys) {
  for (const key of keys) {
    const value = raw?.[key];
    if (value === undefined || value === null) {
      continue;
    }

    const text = String(value).trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function readFirstNumber(raw, keys, fallback = 0) {
  for (const key of keys) {
    const value = Number(raw?.[key]);
    if (!Number.isNaN(value) && value) {
      return value;
    }
  }

  return fallback;
}

function makeFilePicker() {
  return Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
}

async function pickTextFile(mode, title, defaultString) {
  const picker = makeFilePicker();
  picker.init(window.browsingContext, title, mode);
  picker.appendFilters(Ci.nsIFilePicker.filterText);
  picker.appendFilters(Ci.nsIFilePicker.filterAll);
  if (defaultString) {
    picker.defaultString = defaultString;
  }

  const result = await new Promise(resolve => picker.open(resolve));
  if (
    result !== Ci.nsIFilePicker.returnOK &&
    result !== Ci.nsIFilePicker.returnReplace
  ) {
    return null;
  }

  return picker.file;
}

async function writeTextFile(file, contents) {
  await IOUtils.writeUTF8(file.path, contents, { overwrite: true });
}

function normalizeEntry(entry, index) {
  const raw = entry || {};
  const timestamp = readFirstNumber(
    raw,
    ["timestamp", "timeStamp", "time", "createdAt"],
    Date.now()
  );
  const browserId = readFirstNumber(
    raw,
    ["browserId", "tabId", "browsingContextId", "contextId"],
    0
  );
  const url = readFirstString(raw, ["url", "requestUrl", "resourceUrl"]);
  const documentUrl = readFirstString(raw, [
    "documentUrl",
    "docURL",
    "docUrl",
    "sourceUrl",
    "initiatorUrl",
  ]);
  const type = readFirstString(raw, ["type", "requestType", "category"]);
  const decision = readFirstString(raw, [
    "decision",
    "action",
    "result",
    "outcome",
  ]);
  const rule = readFirstString(raw, [
    "rule",
    "matchedRule",
    "filter",
    "matchedFilter",
  ]);
  const source = readFirstString(raw, [
    "source",
    "engine",
    "filterSource",
    "reason",
    "phase",
  ]);
  const message = readFirstString(raw, ["message", "detail", "text"]);
  const scope = readFirstString(raw, ["scope", "tabScope"]);
  const title = readFirstString(raw, ["title"]);
  const key =
    readFirstString(raw, ["id", "key", "entryId"]) ||
    `${timestamp}-${browserId}-${url || "entry"}-${type || "event"}-${index}`;

  return {
    browserId,
    decision,
    documentUrl,
    id: key,
    message,
    raw,
    rule,
    scope,
    source,
    timestamp,
    title,
    type,
    url,
  };
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "—";
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(timestamp));
  } catch (_) {
    return new Date(timestamp).toLocaleTimeString();
  }
}

function formatEntryScope(entry, currentBrowserId) {
  if (entry.scope) {
    return entry.scope;
  }

  if (!entry.browserId) {
    return "";
  }

  if (currentBrowserId && entry.browserId === currentBrowserId) {
    return "Current tab";
  }

  return `Tab ${entry.browserId}`;
}

function formatAction(decision) {
  const value = String(decision || "").trim();
  if (!value) {
    return "Event";
  }

  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, char => char.toUpperCase());
}

function createDetailRow(labelL10nId, valueText) {
  const row = createXULElement("hbox", {
    class: "waterfox-blocker-logger-detail-row",
    align: "start",
  });

  const label = createXULElement("label", {
    class: "waterfox-blocker-logger-detail-label",
  });
  setLabelL10nAttributes(label, labelL10nId);

  const value = createXULElement("description", {
    class: "text-deemphasized waterfox-blocker-logger-detail-value",
    flex: "1",
  });
  value.textContent = valueText || "—";

  row.appendChild(label);
  row.appendChild(value);
  return row;
}

/**
 * Lightweight logger shell for blocker events.
 *
 * The window owns an in-memory snapshot of log entries, renders a scrollable
 * list, and exposes a small imperative API on `window.WaterfoxBlockerLogger`
 * so the parent side can feed entries later without us coupling this shell to
 * request logic.
 */
var gWaterfoxBlockerLogger = {
  _allEntries: [],
  _currentBrowserId: 0,
  _currentFilterText: "",
  _detailsRows: null,
  _exportButton: null,
  _filterInput: null,
  _list: null,
  _pauseButton: null,
  _paused: false,
  _pausedQueue: [],
  _selectedEntryId: "",
  _summaryLabel: null,
  _stateLabel: null,
  _currentTabOnlyCheckbox: null,

  init() {
    this._list = document.getElementById("waterfoxBlockerLoggerList");
    this._detailsRows = document.getElementById(
      "waterfoxBlockerLoggerDetailsRows"
    );
    this._summaryLabel = document.getElementById("waterfoxBlockerSummary");
    this._stateLabel = document.getElementById("waterfoxBlockerLoggerState");
    this._pauseButton = document.getElementById("waterfoxBlockerLoggerPause");
    this._exportButton = document.getElementById("waterfoxBlockerLoggerExport");
    this._filterInput = document.getElementById("waterfoxBlockerLoggerFilter");
    this._currentTabOnlyCheckbox = document.getElementById(
      "waterfoxBlockerLoggerCurrentTabOnly"
    );

    this._pauseButton.addEventListener("command", () => this.togglePause());
    this._exportButton.addEventListener("command", () => this.exportEntries());
    document
      .getElementById("waterfoxBlockerLoggerClear")
      .addEventListener("command", () => this.clearEntries());
    this._currentTabOnlyCheckbox.addEventListener("command", () => {
      this.setCurrentTabOnly(!!this._currentTabOnlyCheckbox.checked);
    });
    this._filterInput.addEventListener("input", () => {
      this.setFilterText(this._filterInput.value);
    });
    this._filterInput.addEventListener("keydown", event => {
      if (event.key === "Escape" && this._filterInput.value) {
        this.setFilterText("");
        event.preventDefault();
      }
    });
    this._list.addEventListener("select", () => this._onSelectEntry());

    this._installWindowApi();
    this._loadInitialState();
    this._render();
  },

  _installWindowApi() {
    const api = {
      appendEntries: entries => this.appendEntries(entries),
      clearEntries: () => this.clearEntries(),
      exportEntries: () => this.exportEntries(),
      getSnapshot: () => this.getSnapshot(),
      setCurrentBrowserId: browserId => this.setCurrentBrowserId(browserId),
      setCurrentTabOnly: enabled => this.setCurrentTabOnly(enabled),
      setEntries: entries => this.setEntries(entries),
      setFilterText: text => this.setFilterText(text),
      setPaused: paused => this.setPaused(paused),
      togglePause: () => this.togglePause(),
    };

    window.WaterfoxBlockerLogger = api;
    window.gWaterfoxBlockerLogger = api;
  },

  _loadInitialState() {
    const initialState = window.arguments?.[0] || {};
    const state = Array.isArray(initialState)
      ? { entries: initialState }
      : initialState;

    const openerBrowserId = this._getOpenerBrowserId();
    this._currentBrowserId =
      Number(
        state.browserId ?? state.currentBrowserId ?? openerBrowserId ?? 0
      ) || 0;

    this._paused = !!state.paused;
    if (typeof state.currentTabOnly === "boolean") {
      this._currentTabOnlyCheckbox.checked = state.currentTabOnly;
    } else {
      this._currentTabOnlyCheckbox.checked = true;
    }
    this._currentFilterText = String(state.filterText || "").trim();
    this._filterInput.value = this._currentFilterText;

    let initialEntries = [];
    if (Array.isArray(state.entries)) {
      initialEntries = state.entries;
    } else if (Array.isArray(state.logEntries)) {
      initialEntries = state.logEntries;
    }

    this._allEntries = initialEntries.map((entry, index) =>
      normalizeEntry(entry, index)
    );
  },

  _getOpenerBrowserId() {
    try {
      const selectedBrowser = window.opener?.gBrowser?.selectedBrowser;
      if (selectedBrowser?.browsingContext?.browserId) {
        return Number(selectedBrowser.browsingContext.browserId) || 0;
      }
    } catch (_) {}

    return 0;
  },

  _getVisibleEntries() {
    let entries = this._allEntries;

    if (this._currentTabOnlyCheckbox?.checked && this._currentBrowserId) {
      entries = entries.filter(
        entry => !entry.browserId || entry.browserId === this._currentBrowserId
      );
    }

    const query = this._currentFilterText.trim().toLowerCase();
    if (!query) {
      return [...entries];
    }

    const terms = query.split(/\s+/).filter(Boolean);
    return entries.filter(entry =>
      terms.every(term => this._getEntrySearchText(entry).includes(term))
    );
  },

  _getEntrySearchText(entry) {
    return [
      formatTimestamp(entry.timestamp),
      formatAction(entry.decision),
      formatEntryScope(entry, this._currentBrowserId),
      entry.type,
      entry.source,
      entry.rule,
      entry.message,
      entry.documentUrl,
      entry.url,
      entry.browserId,
    ]
      .filter(value => value !== undefined && value !== null)
      .join(" ")
      .toLowerCase();
  },

  _getSelectedEntry() {
    return (
      this._allEntries.find(entry => entry.id === this._selectedEntryId) || null
    );
  },

  _setSummaryText() {
    const visibleEntries = this._getVisibleEntries();
    const shown = visibleEntries.length;
    const total = this._allEntries.length;

    setTextL10nAttributes(
      this._summaryLabel,
      "waterfox-blocker-logger-summary",
      {
        shown,
        total,
      }
    );
    setTextL10nAttributes(
      this._stateLabel,
      this._paused
        ? "waterfox-blocker-logger-state-paused"
        : "waterfox-blocker-logger-state-live"
    );
    this._stateLabel.setAttribute("data-paused", String(this._paused));

    this._pauseButton.setAttribute(
      "data-l10n-id",
      this._paused
        ? "waterfox-blocker-logger-resume"
        : "waterfox-blocker-logger-pause"
    );
    this._pauseButton.setAttribute(
      "label",
      formatFallback(
        this._paused
          ? "waterfox-blocker-logger-resume"
          : "waterfox-blocker-logger-pause"
      )
    );

    this._currentTabOnlyCheckbox.disabled = !this._currentBrowserId;
    this._exportButton.disabled = !visibleEntries.length;
  },

  _render() {
    const selectedBefore = this._selectedEntryId;
    const visibleEntries = this._getVisibleEntries();

    this._list.textContent = "";

    if (!visibleEntries.length) {
      const empty = createXULElement("richlistitem", {
        class:
          "waterfox-blocker-logger-item waterfox-blocker-logger-empty-state",
        disabled: "true",
      });
      const label = createXULElement("label", {
        class: "text-deemphasized",
        flex: "1",
        crop: "end",
      });
      setLabelL10nAttributes(
        label,
        this._currentTabOnlyCheckbox.checked || this._currentFilterText
          ? "waterfox-blocker-logger-empty-filtered"
          : "waterfox-blocker-logger-empty"
      );
      empty.appendChild(label);
      this._list.appendChild(empty);
      this._detailsRows.textContent = "";
      const emptyDetails = createXULElement("description", {
        class: "text-deemphasized waterfox-blocker-logger-details-empty",
      });
      setLabelL10nAttributes(
        emptyDetails,
        "waterfox-blocker-logger-details-empty"
      );
      this._detailsRows.appendChild(emptyDetails);
      this._setSummaryText();
      return;
    }

    for (const entry of visibleEntries) {
      this._list.appendChild(this._createEntryItem(entry));
    }

    let selectedItem = null;
    if (selectedBefore) {
      selectedItem = Array.from(this._list.children).find(
        item => item.getAttribute("entrykey") === selectedBefore
      );
    }
    if (!selectedItem) {
      selectedItem = this._list.firstElementChild;
    }

    if (selectedItem) {
      this._list.selectedItem = selectedItem;
      this._selectedEntryId = selectedItem.getAttribute("entrykey") || "";
      this._renderDetails(this._getSelectedEntry());
    }

    this._setSummaryText();
  },

  _createEntryItem(entry) {
    const item = createXULElement("richlistitem", {
      class: "waterfox-blocker-logger-item",
      entrykey: entry.id,
      browserid: entry.browserId || 0,
    });

    const row = createXULElement("hbox", {
      class: "waterfox-blocker-logger-row",
      align: "center",
    });

    const timeLabel = createXULElement("label", {
      class:
        "waterfox-blocker-logger-cell waterfox-blocker-logger-cell-time text-deemphasized",
      crop: "end",
    });
    timeLabel.setAttribute("value", formatTimestamp(entry.timestamp));

    const action = createXULElement("label", {
      class:
        "waterfox-blocker-logger-cell waterfox-blocker-logger-cell-action waterfox-blocker-logger-action-pill",
      crop: "end",
    });
    action.setAttribute(
      "data-action",
      (entry.decision || "").toLowerCase() || "noop"
    );
    action.setAttribute("value", formatAction(entry.decision));

    const typeLabel = createXULElement("label", {
      class:
        "waterfox-blocker-logger-cell waterfox-blocker-logger-cell-type text-deemphasized",
      crop: "end",
    });
    typeLabel.setAttribute("value", entry.type || "—");

    const sourceLabel = createXULElement("label", {
      class:
        "waterfox-blocker-logger-cell waterfox-blocker-logger-cell-source text-deemphasized",
      crop: "end",
    });
    sourceLabel.setAttribute(
      "value",
      formatEntryScope(entry, this._currentBrowserId) || entry.source || "—"
    );

    const ruleLabel = createXULElement("label", {
      class:
        "waterfox-blocker-logger-cell waterfox-blocker-logger-cell-rule text-deemphasized",
      crop: "end",
    });
    ruleLabel.setAttribute("value", entry.rule || entry.source || "—");

    const urlLabel = createXULElement("label", {
      class:
        "waterfox-blocker-logger-cell waterfox-blocker-logger-cell-url waterfox-blocker-logger-url",
      crop: "end",
    });
    urlLabel.setAttribute("value", entry.url || entry.title || "—");

    row.appendChild(timeLabel);
    row.appendChild(action);
    row.appendChild(typeLabel);
    row.appendChild(sourceLabel);
    row.appendChild(ruleLabel);
    row.appendChild(urlLabel);
    item.appendChild(row);
    return item;
  },

  _renderDetails(entry) {
    this._detailsRows.textContent = "";

    if (!entry) {
      this._detailsRows.appendChild(
        createDetailRow(
          "waterfox-blocker-logger-field-message",
          "Select an entry to inspect it."
        )
      );
      return;
    }

    const scope = formatEntryScope(entry, this._currentBrowserId);
    const fields = [
      ["waterfox-blocker-logger-field-time", formatTimestamp(entry.timestamp)],
      ["waterfox-blocker-logger-field-scope", scope || "—"],
      ["waterfox-blocker-logger-field-type", entry.type || "—"],
      ["waterfox-blocker-logger-field-action", formatAction(entry.decision)],
      ["waterfox-blocker-logger-field-url", entry.url || "—"],
      ["waterfox-blocker-logger-field-document-url", entry.documentUrl || "—"],
      ["waterfox-blocker-logger-field-rule", entry.rule || "—"],
      ["waterfox-blocker-logger-field-message", entry.message || "—"],
      ["waterfox-blocker-logger-field-source", entry.source || "—"],
      ["waterfox-blocker-logger-field-tab-id", entry.browserId || "—"],
    ];

    for (const [l10nId, valueText] of fields) {
      if (valueText && valueText !== "—") {
        this._detailsRows.appendChild(
          createDetailRow(l10nId, String(valueText))
        );
      }
    }
  },

  _onSelectEntry() {
    const selected = this._list.selectedItem;
    if (!selected) {
      return;
    }

    this._selectedEntryId = selected.getAttribute("entrykey") || "";
    this._renderDetails(this._getSelectedEntry());
  },

  appendEntries(entries) {
    const normalized = Array.isArray(entries)
      ? entries.map((entry, index) =>
          normalizeEntry(entry, this._allEntries.length + index)
        )
      : [];

    if (!normalized.length) {
      return;
    }

    if (this._paused) {
      this._pausedQueue.push(...normalized);
      if (this._pausedQueue.length > MAX_LOG_ENTRIES) {
        this._pausedQueue.splice(0, this._pausedQueue.length - MAX_LOG_ENTRIES);
      }
      return;
    }

    this._allEntries.push(...normalized);
    if (this._allEntries.length > MAX_LOG_ENTRIES) {
      this._allEntries.splice(0, this._allEntries.length - MAX_LOG_ENTRIES);
    }
    this._render();
  },

  clearEntries() {
    this._allEntries = [];
    this._pausedQueue = [];
    this._selectedEntryId = "";
    this._render();
  },

  exportEntries() {
    const entries = this._getVisibleEntries();
    if (!entries.length) {
      return;
    }

    this._doExport(entries, DEFAULT_EXPORT_FILENAME);
  },

  async _doExport(entries, defaultName) {
    let file;
    try {
      file = await pickTextFile(
        Ci.nsIFilePicker.modeSave,
        await formatValueWithFallback("waterfox-blocker-logger-export-title"),
        defaultName
      );
    } catch (err) {
      console.error("[WaterfoxBlockerLogger] Failed to pick export file:", err);
      return;
    }

    if (!file) {
      return;
    }

    const contents = `${JSON.stringify(entries, null, 2)}\n`;
    try {
      await writeTextFile(file, contents);
      const [title, message] = await formatValuesWithFallback([
        { id: "waterfox-blocker-logger-export-done-title" },
        { id: "waterfox-blocker-logger-export-done-message" },
      ]);
      Services.prompt.alert(window, title, message);
    } catch (err) {
      console.error("[WaterfoxBlockerLogger] Failed to export entries:", err);
      const [title, message] = await formatValuesWithFallback([
        { id: "waterfox-blocker-logger-export-error-title" },
        { id: "waterfox-blocker-logger-export-error-message" },
      ]);
      Services.prompt.alert(window, title, message);
    }
  },

  getSnapshot() {
    return {
      currentBrowserId: this._currentBrowserId,
      currentTabOnly: !!this._currentTabOnlyCheckbox?.checked,
      entries: [...this._allEntries],
      filterText: this._currentFilterText,
      paused: this._paused,
      pausedQueueLength: this._pausedQueue.length,
      selectedEntryId: this._selectedEntryId,
      visibleEntries: this._getVisibleEntries(),
    };
  },

  setCurrentBrowserId(browserId) {
    this._currentBrowserId = Number(browserId) || 0;
    this._render();
  },

  setCurrentTabOnly(enabled) {
    this._currentTabOnlyCheckbox.checked = !!enabled;
    this._render();
  },

  setFilterText(text) {
    this._currentFilterText = String(text || "").trim();
    if (this._filterInput.value !== this._currentFilterText) {
      this._filterInput.value = this._currentFilterText;
    }
    this._selectedEntryId = "";
    this._render();
  },

  setEntries(entries) {
    const normalized = Array.isArray(entries)
      ? entries.map((entry, index) => normalizeEntry(entry, index))
      : [];

    this._allEntries = normalized.slice(-MAX_LOG_ENTRIES);
    this._render();
  },

  setPaused(paused) {
    const nextPaused = !!paused;
    if (this._paused === nextPaused) {
      return;
    }

    this._paused = nextPaused;
    if (!this._paused && this._pausedQueue.length) {
      this._allEntries.push(...this._pausedQueue);
      this._pausedQueue = [];
      if (this._allEntries.length > MAX_LOG_ENTRIES) {
        this._allEntries.splice(0, this._allEntries.length - MAX_LOG_ENTRIES);
      }
    }

    this._render();
  },

  togglePause() {
    this.setPaused(!this._paused);
  },
};

window.addEventListener("DOMContentLoaded", () => {
  gWaterfoxBlockerLogger.init();
});
