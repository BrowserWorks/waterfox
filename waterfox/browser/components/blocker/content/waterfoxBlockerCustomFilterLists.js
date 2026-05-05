/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const PREF_FILTER_LIST_URLS = "waterfox.blocker.filterListUrls";

function normalizeUrl(input) {
  let value = String(input || "").trim();
  if (!value) {
    return "";
  }

  if (!value.startsWith("http:") && !value.startsWith("https:")) {
    value = `https://${value}`;
  }

  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return url.href;
    }
  } catch (_) {
    // Invalid user-entered URLs are rejected below.
  }

  return "";
}

function parseUrlPref(raw) {
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    // Migration path for profiles that stored comma-separated URLs.
    return raw.split(",");
  }
}

var gWaterfoxBlockerCustomFilterLists = {
  _createListItem(url) {
    const richlistitem = document.createXULElement("richlistitem");
    richlistitem.setAttribute("url", url);
    const row = document.createXULElement("hbox");
    row.setAttribute("style", "flex: 1");

    const hbox = document.createXULElement("hbox");
    const label = document.createXULElement("label");
    label.setAttribute("class", "website-name-value");
    label.setAttribute("value", url);
    hbox.setAttribute("class", "website-name");
    hbox.setAttribute("style", "flex: 3 3; width: 0");
    hbox.appendChild(label);
    row.appendChild(hbox);

    richlistitem.appendChild(row);
    return richlistitem;
  },

  _urls: new Set(),
  _list: null,
  _prefLocked: false,

  _loadUrls() {
    const raw = Services.prefs.getStringPref(PREF_FILTER_LIST_URLS, "");

    for (const entry of parseUrlPref(raw)) {
      const normalized = normalizeUrl(entry);
      if (normalized) {
        this._urls.add(normalized);
      }
    }
  },

  _removeUrlFromList(url) {
    this._urls.delete(url);
    const item = document.querySelector(
      `richlistitem[url="${CSS.escape(url)}"]`
    );
    if (item) {
      item.remove();
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

    this._removeButton.disabled = this._list.selectedIndex < 0;
    this._removeAllButton.disabled = this._list.itemCount === 0;
  },

  _sortList(list, frag, column) {
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

    const comp = new Services.intl.Collator(undefined, { usage: "sort" });
    const items = Array.from(frag.querySelectorAll("richlistitem"));

    const sortFunc = (a, b) =>
      comp.compare(a.getAttribute("url"), b.getAttribute("url"));

    if (sortDirection === "descending") {
      items.sort((a, b) => sortFunc(b, a));
    } else {
      items.sort(sortFunc);
    }

    items.forEach(item => frag.appendChild(item));

    const cols = list.previousElementSibling.querySelectorAll("treecol");
    cols.forEach(c => {
      c.removeAttribute("data-isCurrentSortCol");
      c.removeAttribute("sortDirection");
    });
    column.setAttribute("data-isCurrentSortCol", "true");
    column.setAttribute("sortDirection", sortDirection);
    column.setAttribute("data-last-sortDirection", sortDirection);
  },

  addUrl() {
    if (this._prefLocked) {
      return;
    }

    const textbox = document.getElementById("url");
    const normalized = normalizeUrl(textbox.value);

    if (!normalized) {
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

    if (!this._urls.has(normalized)) {
      this._urls.add(normalized);
      this.buildList();
    }

    textbox.value = "";
    textbox.focus();
    this.onInput();
    this._setRemoveButtonState();
  },

  buildList(sortCol) {
    const oldItems = this._list.querySelectorAll("richlistitem");
    for (const item of oldItems) {
      item.remove();
    }

    const frag = document.createDocumentFragment();
    for (const url of this._urls.values()) {
      frag.appendChild(this._createListItem(url));
    }

    this._sortList(this._list, frag, sortCol);
    this._list.appendChild(frag);
    this._setRemoveButtonState();
  },

  handleEvent(event) {
    switch (event.target.id) {
      case "btnAddUrl":
        this.addUrl();
        break;
      case "removeUrl":
        this.onDelete();
        break;
      case "removeAllUrls":
        this.onAllDelete();
        break;
    }
  },

  init() {
    document.addEventListener("dialogaccept", () => this.onApplyChanges());

    this._btnAdd = document.getElementById("btnAddUrl");
    this._removeButton = document.getElementById("removeUrl");
    this._removeAllButton = document.getElementById("removeAllUrls");

    this._list = document.getElementById("urlListBox");
    this._list.addEventListener("keypress", event =>
      this.onListBoxKeyPress(event)
    );
    this._list.addEventListener("select", () => this.onListBoxSelect());

    this._urlField = document.getElementById("url");
    this._urlField.addEventListener("input", () => this.onInput());
    this._urlField.addEventListener("keypress", event =>
      this.onKeyPress(event)
    );

    document
      .getElementById("urlCol")
      .addEventListener("click", event => this.buildList(event.target));

    document.addEventListener("command", this);

    this.onInput();
    this._loadUrls();
    this.buildList();

    this._urlField.focus();

    this._prefLocked = Services.prefs.prefIsLocked(PREF_FILTER_LIST_URLS);

    document
      .getElementById("customFilterListsDialog")
      .getButton("accept").disabled = this._prefLocked;
    this._urlField.disabled = this._prefLocked;

    this.onInput();
    this._setRemoveButtonState();
  },

  onAllDelete() {
    for (const url of this._urls.values()) {
      this._removeUrlFromList(url);
    }
    this._setRemoveButtonState();
  },

  onApplyChanges() {
    Services.prefs.setStringPref(
      PREF_FILTER_LIST_URLS,
      JSON.stringify(Array.from(this._urls.values()))
    );
  },

  onDelete() {
    const richlistitem = this._list.selectedItem;
    if (!richlistitem) {
      return;
    }

    this._removeUrlFromList(richlistitem.getAttribute("url"));
    this._setRemoveButtonState();
  },

  onInput() {
    this._btnAdd.disabled = this._prefLocked || !this._urlField.value.trim();
  },

  onKeyPress(event) {
    if (event.keyCode === KeyEvent.DOM_VK_RETURN) {
      this._btnAdd.click();
      if (document.activeElement === this._urlField) {
        event.preventDefault();
      }
    }
  },

  onListBoxKeyPress(event) {
    if (!this._list.selectedItem || this._prefLocked) {
      return;
    }

    if (
      event.keyCode === KeyEvent.DOM_VK_DELETE ||
      (AppConstants.platform === "macosx" &&
        event.keyCode === KeyEvent.DOM_VK_BACK_SPACE)
    ) {
      this.onDelete();
      event.preventDefault();
    }
  },

  onListBoxSelect() {
    this._setRemoveButtonState();
  },
};

document.addEventListener("DOMContentLoaded", () => {
  gWaterfoxBlockerCustomFilterLists.init();
});
