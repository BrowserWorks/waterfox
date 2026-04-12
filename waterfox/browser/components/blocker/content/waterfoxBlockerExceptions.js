/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { IOUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/IOUtils.sys.mjs"
);

const PREF_BLOCKER_EXCEPTIONS = "waterfox.blocker.siteExceptions";

/**
 * Normalises a domain string for preference storage and matching.
 *
 * @param {string} input Raw user or preference value.
 * @returns {string} Lowercased hostname without a trailing dot.
 */
function normalizeDomain(input) {
  let domain = String(input || "")
    .trim()
    .toLowerCase();
  if (domain.endsWith(".")) {
    domain = domain.slice(0, -1);
  }
  return domain;
}

function normalizeExceptionCandidates(text) {
  const valid = [];
  const invalid = [];
  const seen = new Set();

  for (const rawCandidate of String(text || "").split(/[\r\n,]+/)) {
    const candidate = rawCandidate.trim();
    if (!candidate) {
      continue;
    }

    let normalized = "";
    try {
      const url =
        candidate.startsWith("http://") || candidate.startsWith("https://")
          ? new URL(candidate)
          : new URL(`http://${candidate}`);
      normalized = normalizeDomain(url.hostname);
    } catch (_) {
      normalized = "";
    }

    if (!normalized) {
      invalid.push(candidate);
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    valid.push(normalized);
  }

  return { invalid, valid };
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

async function readTextFile(file) {
  return IOUtils.readUTF8(file.path);
}

async function writeTextFile(file, contents) {
  await IOUtils.writeUTF8(file.path, contents, { overwrite: true });
}

/**
 * Manages the blocker exceptions dialog.
 *
 * Keeps a set of normalised exception hostnames in memory, renders the list,
 * and saves changes to `waterfox.blocker.siteExceptions` when the dialog is
 * accepted.
 */
var gWaterfoxBlockerExceptionsManager = {
  _createExceptionListItem(exception) {
    const richlistitem = document.createXULElement("richlistitem");
    richlistitem.setAttribute("domain", exception);
    const row = document.createXULElement("hbox");
    row.setAttribute("style", "flex: 1");

    const hbox = document.createXULElement("hbox");
    const website = document.createXULElement("label");
    website.setAttribute("class", "website-name-value");
    website.setAttribute("value", exception);
    hbox.setAttribute("class", "website-name");
    hbox.setAttribute("style", "flex: 3 3; width: 0");
    hbox.appendChild(website);
    row.appendChild(hbox);

    richlistitem.appendChild(row);
    return richlistitem;
  },
  _exceptions: new Set(),
  _list: null,

  _loadExceptions() {
    const exceptionsFromPref = Services.prefs.getStringPref(
      PREF_BLOCKER_EXCEPTIONS,
      "[]"
    );

    if (!exceptionsFromPref?.trim()) {
      return;
    }

    let exceptions = [];
    try {
      const parsed = JSON.parse(exceptionsFromPref);
      if (Array.isArray(parsed)) {
        exceptions = parsed;
      }
    } catch (_) {
      // Fallback for legacy/comma-separated values.
      exceptions = exceptionsFromPref.trim().split(",");
    }

    for (const exception of exceptions) {
      const normalized = normalizeDomain(exception);
      if (normalized) {
        this._exceptions.add(normalized);
      }
    }
  },
  _prefLocked: false,
  _refreshActionState() {
    this.onExceptionInput();
    this._setRemoveButtonState();
  },

  _removeExceptionFromList(exception) {
    this._exceptions.delete(exception);
    const exceptionlistitem = document.getElementsByAttribute(
      "domain",
      exception
    )[0];
    if (exceptionlistitem) {
      exceptionlistitem.remove();
    }
  },

  _setRemoveButtonState() {
    if (!this._list) {
      return;
    }

    if (this._prefLocked) {
      this._removeAllButton.disabled = true;
      this._removeButton.disabled = true;
      return;
    }

    const hasSelection = this._list.selectedIndex >= 0;

    this._removeButton.disabled = !hasSelection;
    const disabledItems = this._list.querySelectorAll(
      "label.website-name-value[disabled='true']"
    );

    this._removeAllButton.disabled =
      this._list.itemCount === disabledItems.length;
  },

  _sortExceptions(list, frag, column) {
    let sortDirection;

    if (!column) {
      column = document.querySelector("treecol[data-isCurrentSortCol=true]");
      sortDirection =
        column.getAttribute("data-last-sortDirection") || "ascending";
    } else {
      sortDirection = column.getAttribute("data-last-sortDirection");
      sortDirection =
        sortDirection === "ascending" ? "descending" : "ascending";
    }

    const sortFunc = (a, b) => {
      return comp.compare(a.getAttribute("domain"), b.getAttribute("domain"));
    };

    const comp = new Services.intl.Collator(undefined, {
      usage: "sort",
    });

    const items = Array.from(frag.querySelectorAll("richlistitem"));

    if (sortDirection === "descending") {
      items.sort((a, b) => sortFunc(b, a));
    } else {
      items.sort(sortFunc);
    }

    // Re-append items in the correct order:
    items.forEach(item => {
      frag.appendChild(item);
    });

    const cols = list.previousElementSibling.querySelectorAll("treecol");
    cols.forEach(c => {
      c.removeAttribute("data-isCurrentSortCol");
      c.removeAttribute("sortDirection");
    });
    column.setAttribute("data-isCurrentSortCol", "true");
    column.setAttribute("sortDirection", sortDirection);
    column.setAttribute("data-last-sortDirection", sortDirection);
  },

  /**
   * Adds a new exception from the URL input field.
   *
   * The input may contain one or more hostnames or URLs, one per line.
   * Valid hostnames are added to the in-memory set and invalid entries are
   * kept in the field so they can be corrected.
   */
  addException() {
    if (this._prefLocked) {
      return;
    }

    const textbox = document.getElementById("url");
    const { invalid, valid } = normalizeExceptionCandidates(textbox.value);

    if (!valid.length && invalid.length) {
      this._showInvalidEntriesAlert(invalid);
      return;
    }

    let addedCount = 0;
    for (const domain of valid) {
      if (!this._exceptions.has(domain)) {
        this._exceptions.add(domain);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      this.buildExceptionList();
    }

    if (invalid.length) {
      // The text field keeps only the invalid entries so the user can fix
      // them without retyping any valid allowlist values.
      textbox.value = invalid.join("\n");
      this._showInvalidEntriesAlert(invalid);
      textbox.select();
      textbox.focus();
    } else {
      textbox.value = "";
    }

    textbox.focus();

    this._refreshActionState();
  },

  /**
   * Rebuilds and sorts the exceptions list from the in-memory set.
   *
   * @param {Element|undefined} sortCol Column element used to control sort direction.
   */
  buildExceptionList(sortCol) {
    // Clear old entries.
    const oldItems = this._list.querySelectorAll("richlistitem");
    for (const item of oldItems) {
      item.remove();
    }
    const frag = document.createDocumentFragment();

    const exceptions = Array.from(this._exceptions.values());

    for (const exception of exceptions) {
      const richlistitem = this._createExceptionListItem(exception);
      frag.appendChild(richlistitem);
    }

    // Sort exceptions.
    this._sortExceptions(this._list, frag, sortCol);

    this._list.appendChild(frag);

    this._setRemoveButtonState();
  },

  /**
   * Handles command events from the dialog controls.
   *
   * @param {Event} event DOM command event.
   */
  handleEvent(event) {
    switch (event.target.id) {
      case "key_close":
        window.close();
        break;

      case "btnAddException":
        this.addException();
        break;
      case "importExceptions":
        this.importExceptions();
        break;
      case "exportExceptions":
        this.exportExceptions();
        break;
      case "removeException":
        this.onExceptionDelete();
        break;
      case "removeAllExceptions":
        this.onAllExceptionsDelete();
        break;
    }
  },

  /**
   * Initialises the dialog UI, listeners, and current exception state.
   */
  init() {
    document.addEventListener("dialogaccept", () => this.onApplyChanges());

    this._btnAddException = document.getElementById("btnAddException");
    this._importButton = document.getElementById("importExceptions");
    this._exportButton = document.getElementById("exportExceptions");
    this._removeButton = document.getElementById("removeException");
    this._removeAllButton = document.getElementById("removeAllExceptions");

    this._list = document.getElementById("permissionsBox");
    this._list.addEventListener("keypress", event =>
      this.onListBoxKeyPress(event)
    );
    this._list.addEventListener("select", () => this.onListBoxSelect());

    this._urlField = document.getElementById("url");
    this._urlField.addEventListener("input", () => this.onExceptionInput());
    this._urlField.addEventListener("keydown", event =>
      this.onExceptionKeyPress(event)
    );

    document
      .getElementById("siteCol")
      .addEventListener("click", event =>
        this.buildExceptionList(event.target)
      );

    document.addEventListener("command", this);

    this.onExceptionInput();
    this._loadExceptions();
    this.buildExceptionList();

    this._urlField.focus();

    this._prefLocked = Services.prefs.prefIsLocked(PREF_BLOCKER_EXCEPTIONS);

    document.getElementById("exceptionDialog").getButton("accept").disabled =
      this._prefLocked;
    this._urlField.disabled = this._prefLocked;
    this._importButton.disabled = this._prefLocked;

    this._refreshActionState();
  },

  onAllExceptionsDelete() {
    for (const exception of this._exceptions.values()) {
      this._removeExceptionFromList(exception);
    }

    this._setRemoveButtonState();
  },

  /**
   * Saves the in-memory exceptions set to preferences.
   */
  onApplyChanges() {
    if (this._exceptions.size === 0) {
      Services.prefs.setStringPref(PREF_BLOCKER_EXCEPTIONS, "[]");
      return;
    }

    const exceptions = Array.from(this._exceptions.values());
    Services.prefs.setStringPref(
      PREF_BLOCKER_EXCEPTIONS,
      JSON.stringify(exceptions)
    );
  },

  onExceptionDelete() {
    const richlistitem = this._list.selectedItem;
    if (!richlistitem) {
      return;
    }

    const exception = richlistitem.getAttribute("domain");

    this._removeExceptionFromList(exception);

    this._setRemoveButtonState();
  },

  onExceptionInput() {
    this._btnAddException.disabled =
      this._prefLocked || !this._urlField.value.trim();
  },

  _showInvalidEntriesAlert(invalid) {
    const preview = invalid.slice(0, 5).join("\n");
    document.l10n
      .formatValues([
        { id: "waterfox-blocker-exceptions-invalid-title" },
        {
          id: "waterfox-blocker-exceptions-invalid-message",
          args: {
            count: invalid.length,
            entries: preview,
          },
        },
      ])
      .then(([title, message]) => {
        Services.prompt.alert(window, title, message);
      });
  },

  async importExceptions() {
    if (this._prefLocked) {
      return;
    }

    const [
      importTitle,
      importErrorTitle,
      importErrorMessage,
      importSummaryTitle,
      importSummaryMessage,
    ] = await document.l10n.formatValues([
      { id: "waterfox-blocker-exceptions-import-title" },
      { id: "waterfox-blocker-exceptions-import-error-title" },
      { id: "waterfox-blocker-exceptions-import-error-message" },
      { id: "waterfox-blocker-exceptions-import-summary-title" },
      { id: "waterfox-blocker-exceptions-import-summary-message" },
    ]);

    const picker = await pickTextFile(
      Ci.nsIFilePicker.modeOpen,
      importTitle,
      "waterfox-allowlist.txt"
    );
    if (!picker) {
      return;
    }

    let text = "";
    try {
      text = await readTextFile(picker);
    } catch (err) {
      console.error("[WaterfoxBlocker] Failed to import allowlist:", err);
      Services.prompt.alert(window, importErrorTitle, importErrorMessage);
      return;
    }

    const { invalid, valid } = normalizeExceptionCandidates(text);
    let addedCount = 0;
    for (const domain of valid) {
      if (!this._exceptions.has(domain)) {
        this._exceptions.add(domain);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      this.buildExceptionList();
    }

    this._refreshActionState();

    if (invalid.length) {
      this._showInvalidEntriesAlert(invalid);
      return;
    }

    Services.prompt.alert(window, importSummaryTitle, importSummaryMessage);
  },

  async exportExceptions() {
    const [
      exportTitle,
      exportErrorTitle,
      exportErrorMessage,
      exportSummaryTitle,
      exportSummaryMessage,
    ] = await document.l10n.formatValues([
      { id: "waterfox-blocker-exceptions-export-title" },
      { id: "waterfox-blocker-exceptions-export-error-title" },
      { id: "waterfox-blocker-exceptions-export-error-message" },
      { id: "waterfox-blocker-exceptions-export-summary-title" },
      { id: "waterfox-blocker-exceptions-export-summary-message" },
    ]);

    const file = await pickTextFile(
      Ci.nsIFilePicker.modeSave,
      exportTitle,
      "waterfox-allowlist.txt"
    );
    if (!file) {
      return;
    }

    const contents = Array.from(this._exceptions.values())
      .sort((a, b) => a.localeCompare(b))
      .join("\n");

    try {
      await writeTextFile(file, contents ? `${contents}\n` : "");
    } catch (err) {
      console.error("[WaterfoxBlocker] Failed to export allowlist:", err);
      Services.prompt.alert(window, exportErrorTitle, exportErrorMessage);
      return;
    }

    Services.prompt.alert(window, exportSummaryTitle, exportSummaryMessage);
  },

  /**
   * Handles keyboard interaction for the exception input field.
   *
   * Pressing Ctrl/Cmd+Enter adds the current entries when possible.
   *
   * @param {KeyboardEvent} event Keypress event from the input field.
   */
  onExceptionKeyPress(event) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      this._btnAddException.click();
      if (document.activeElement === this._urlField) {
        event.preventDefault();
      }
    }
  },

  /**
   * Handles keyboard deletion for selected list entries.
   *
   * @param {KeyboardEvent} event Keypress event from the list.
   */
  onListBoxKeyPress(event) {
    if (!this._list.selectedItem) {
      return;
    }

    if (this._prefLocked) {
      return;
    }

    if (
      event.keyCode === KeyEvent.DOM_VK_DELETE ||
      (AppConstants.platform === "macosx" &&
        event.keyCode === KeyEvent.DOM_VK_BACK_SPACE)
    ) {
      this.onExceptionDelete();
      event.preventDefault();
    }
  },

  onListBoxSelect() {
    this._setRemoveButtonState();
  },
};

document.addEventListener("DOMContentLoaded", () => {
  gWaterfoxBlockerExceptionsManager.init();
});
