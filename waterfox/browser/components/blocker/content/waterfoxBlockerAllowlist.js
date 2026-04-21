/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { WaterfoxShields } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxShields.sys.mjs"
);

const PREF_SHIELDS_SITE_SETTINGS = "waterfox.shields.siteSettings";

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
 * Manages the ad-blocking allowlist dialog.
 *
 * The allowlist is stored as `adBlock: false` inside WaterfoxShields site
 * settings, preserving any other per-site shield overrides on the same host.
 */
var gWaterfoxBlockerAllowlistManager = {
  _allowlist: new Set(),
  _btnAddSite: null,
  _list: null,
  _originalAllowlist: new Set(),
  _prefLocked: false,
  _removeAllButton: null,
  _removeButton: null,
  _urlField: null,

  _createAllowlistItem(domain) {
    const richlistitem = document.createXULElement("richlistitem");
    richlistitem.setAttribute("domain", domain);

    const row = document.createXULElement("hbox");
    row.setAttribute("style", "flex: 1");

    const hbox = document.createXULElement("hbox");
    hbox.setAttribute("class", "website-name");
    hbox.setAttribute("style", "flex: 3 3; width: 0");

    const website = document.createXULElement("label");
    website.setAttribute("class", "website-name-value");
    website.setAttribute("value", domain);

    hbox.appendChild(website);
    row.appendChild(hbox);
    richlistitem.appendChild(row);
    return richlistitem;
  },

  _loadAllowlist() {
    this._allowlist.clear();
    this._originalAllowlist.clear();

    for (const domain of WaterfoxShields.getSiteAdBlockExceptions()) {
      const normalized = normalizeDomain(domain);
      if (!normalized) {
        continue;
      }
      this._allowlist.add(normalized);
      this._originalAllowlist.add(normalized);
    }
  },

  _removeDomainFromList(domain) {
    this._allowlist.delete(domain);
    const allowlistItem = document.getElementsByAttribute("domain", domain)[0];
    if (allowlistItem) {
      allowlistItem.remove();
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
    this._removeAllButton.disabled = !this._list.itemCount;
  },

  _sortAllowlist(list, frag, column) {
    const columnWasProvided = !!column;
    column ||= document.querySelector("treecol[data-isCurrentSortCol=true]");
    if (!column) {
      return;
    }

    let sortDirection = column.getAttribute("data-last-sortDirection");
    if (columnWasProvided) {
      sortDirection =
        sortDirection === "ascending" ? "descending" : "ascending";
    }
    sortDirection ||= "ascending";

    const comp = new Services.intl.Collator(undefined, { usage: "sort" });
    const items = Array.from(frag.querySelectorAll("richlistitem"));
    const sortFunc = (a, b) =>
      comp.compare(a.getAttribute("domain"), b.getAttribute("domain"));

    if (sortDirection === "descending") {
      items.sort((a, b) => sortFunc(b, a));
    } else {
      items.sort(sortFunc);
    }

    for (const item of items) {
      frag.appendChild(item);
    }

    const cols = list.previousElementSibling.querySelectorAll("treecol");
    for (const col of cols) {
      col.removeAttribute("data-isCurrentSortCol");
      col.removeAttribute("sortDirection");
    }
    column.setAttribute("data-isCurrentSortCol", "true");
    column.setAttribute("sortDirection", sortDirection);
    column.setAttribute("data-last-sortDirection", sortDirection);
  },

  addSite() {
    if (this._prefLocked) {
      return;
    }

    let inputValue = this._urlField.value.trim();
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

    if (!this._allowlist.has(domain)) {
      this._allowlist.add(domain);
      this.buildAllowlist();
    }

    this._urlField.value = "";
    this._urlField.focus();
    this.onSiteInput();
    this._setRemoveButtonState();
  },

  buildAllowlist(sortCol) {
    const oldItems = this._list.querySelectorAll("richlistitem");
    for (const item of oldItems) {
      item.remove();
    }

    const frag = document.createDocumentFragment();
    for (const domain of this._allowlist.values()) {
      frag.appendChild(this._createAllowlistItem(domain));
    }

    this._sortAllowlist(this._list, frag, sortCol);
    this._list.appendChild(frag);
    this._setRemoveButtonState();
  },

  handleEvent(event) {
    switch (event.target.id) {
      case "key_close":
        window.close();
        break;
      case "btnAddSite":
        this.addSite();
        break;
      case "removeSite":
        this.onSiteDelete();
        break;
      case "removeAllSites":
        this.onAllSitesDelete();
        break;
    }
  },

  init() {
    this._prefLocked = Services.prefs.prefIsLocked(PREF_SHIELDS_SITE_SETTINGS);

    document.addEventListener("dialogaccept", () => this.onApplyChanges());
    document.addEventListener("command", this);

    this._btnAddSite = document.getElementById("btnAddSite");
    this._removeButton = document.getElementById("removeSite");
    this._removeAllButton = document.getElementById("removeAllSites");

    this._list = document.getElementById("permissionsBox");
    this._list.addEventListener("keypress", event =>
      this.onListBoxKeyPress(event)
    );
    this._list.addEventListener("select", () => this.onListBoxSelect());

    this._urlField = document.getElementById("url");
    this._urlField.addEventListener("input", () => this.onSiteInput());
    this._urlField.addEventListener("keypress", event =>
      this.onSiteKeyPress(event)
    );

    document
      .getElementById("siteCol")
      .addEventListener("click", event => this.buildAllowlist(event.target));

    this._loadAllowlist();
    this.buildAllowlist();

    document.getElementById("allowlistDialog").getButton("accept").disabled =
      this._prefLocked;
    this._urlField.disabled = this._prefLocked;

    this.onSiteInput();
    this._setRemoveButtonState();
    this._urlField.focus();
  },

  onAllSitesDelete() {
    for (const domain of Array.from(this._allowlist.values())) {
      this._removeDomainFromList(domain);
    }
    this._setRemoveButtonState();
  },

  onApplyChanges() {
    if (this._prefLocked) {
      return;
    }

    for (const domain of this._originalAllowlist.values()) {
      if (!this._allowlist.has(domain)) {
        WaterfoxShields.clearSiteAdBlockEnabled(domain);
      }
    }

    for (const domain of this._allowlist.values()) {
      WaterfoxShields.setSiteAdBlockEnabled(domain, false);
    }
  },

  onSiteDelete() {
    const richlistitem = this._list.selectedItem;
    if (!richlistitem) {
      return;
    }

    this._removeDomainFromList(richlistitem.getAttribute("domain"));
    this._setRemoveButtonState();
  },

  onSiteInput() {
    this._btnAddSite.disabled =
      this._prefLocked || !this._urlField.value.trim();
  },

  onSiteKeyPress(event) {
    if (event.keyCode === KeyEvent.DOM_VK_RETURN) {
      this._btnAddSite.click();
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
      this.onSiteDelete();
      event.preventDefault();
    }
  },

  onListBoxSelect() {
    this._setRemoveButtonState();
  },
};

document.addEventListener("DOMContentLoaded", () => {
  gWaterfoxBlockerAllowlistManager.init();
});
