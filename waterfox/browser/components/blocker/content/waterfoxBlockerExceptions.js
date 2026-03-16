/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
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
   * The input is normalised to a hostname and added to the in-memory set.
   * Invalid values show the standard invalid URI prompt.
   */
  addException() {
    if (this._prefLocked) {
      return;
    }

    const textbox = document.getElementById("url");
    let inputValue = textbox.value.trim(); // trim any leading and trailing space
    if (!inputValue.startsWith("http:") && !inputValue.startsWith("https:")) {
      inputValue = `http://${inputValue}`;
    }

    let domain = "";
    try {
      const uri = Services.io.newURI(inputValue);
      domain = normalizeDomain(uri.host);
      if (!domain) {
        throw new Error("Invalid host");
      }
    } catch (_) {
      document.l10n
        .formatValues([
          { id: "permissions-invalid-uri-title" },
          { id: "permissions-invalid-uri-label" },
        ])
        .then(([title, message]) => {
          Services.prompt.alert(window, title, message);
        });
      return;
    }

    if (!this._exceptions.has(domain)) {
      this._exceptions.add(domain);
      this.buildExceptionList();
    }

    textbox.value = "";
    textbox.focus();

    // covers a case where the site exists already, so the buttons don't disable
    this.onExceptionInput();

    // enable "remove all" button as needed
    this._setRemoveButtonState();
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
    this._removeButton = document.getElementById("removeException");
    this._removeAllButton = document.getElementById("removeAllExceptions");

    this._list = document.getElementById("permissionsBox");
    this._list.addEventListener("keypress", event =>
      this.onListBoxKeyPress(event)
    );
    this._list.addEventListener("select", () => this.onListBoxSelect());

    this._urlField = document.getElementById("url");
    this._urlField.addEventListener("input", () => this.onExceptionInput());
    this._urlField.addEventListener("keypress", event =>
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

    this.onExceptionInput();
    this._setRemoveButtonState();
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
    const exception = richlistitem.getAttribute("domain");

    this._removeExceptionFromList(exception);

    this._setRemoveButtonState();
  },

  onExceptionInput() {
    this._btnAddException.disabled = this._prefLocked || !this._urlField.value;
  },

  /**
   * Handles keyboard interaction for the exception input field.
   *
   * Pressing Enter adds the current exception when possible.
   *
   * @param {KeyboardEvent} event Keypress event from the input field.
   */
  onExceptionKeyPress(event) {
    if (event.keyCode === KeyEvent.DOM_VK_RETURN) {
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
