/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LiveBookmarks: "resource:///modules/LiveBookmarks.sys.mjs",
  MAX_FEED_URL_LENGTH: "resource:///modules/LiveBookmarks.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  validateSubscriptionURL: "resource:///modules/LiveBookmarks.sys.mjs",
});

const controllers = new WeakMap();
const HTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_TITLE_LENGTH = 1024;

/** Controls one browser window's subscription popup sessions. */
class SubscribeController {
  constructor(win) {
    this.win = win;
    this.session = null;
    this.closed = Promise.resolve();
    win.gBrowser.tabContainer.addEventListener("TabSelect", () =>
      this.hideIfStale()
    );
    win.addEventListener(
      "unload",
      () => {
        for (const session of [this.session, this.panelSession]) {
          if (session) {
            session.restoreFocus = false;
            this._finish(session);
          }
        }
      },
      { once: true }
    );
  }

  _sameDocument(session) {
    return (
      !this.win.closed &&
      this.win.gBrowser?.selectedBrowser === session.browser &&
      session.browser.browsingContext?.currentWindowGlobal === session.global &&
      session.global?.isCurrentGlobal
    );
  }

  _isCurrent(session) {
    this.hideIfStale();
    return this.session === session && !session.closing;
  }

  hideIfStale(feeds = null) {
    if (
      this.session &&
      (!this._sameDocument(this.session) ||
        (feeds && !feeds.some(feed => feed.feedURL === this.session.feedURL)))
    ) {
      this._dismiss(this.session, false);
    }
  }

  subscriptionsChanged() {
    this.hideIfStale();
    const session = this.session;
    if (
      session?.ready &&
      !session.closing &&
      !session.busy &&
      lazy.LiveBookmarks.getByFeedURL(session.ui?.url.value ?? session.feedURL)
    ) {
      this._dismiss(session);
    }
  }

  _visible(element) {
    return (
      element?.isConnected &&
      !element.hidden &&
      element.checkVisibility({ checkVisibilityCSS: true })
    );
  }

  _anchor() {
    const doc = this.win.document;
    return ["pageAction-urlbar-waterfox-feeds", "star-button-box", "urlbar"]
      .map(id => doc.getElementById(id))
      .find(element => this._visible(element));
  }

  _loadStylesheet() {
    if (!this.stylesheet) {
      const doc = this.win.document;
      const link = doc.createElementNS(HTML_NS, "link");
      link.rel = "stylesheet";
      link.href = "chrome://browser/content/feeds/subscribe.css";
      this.stylesheet = new Promise((resolve, reject) => {
        link.addEventListener("load", resolve, { once: true });
        link.addEventListener(
          "error",
          () =>
            reject(
              new Error("Could not load the feed subscription stylesheet")
            ),
          { once: true }
        );
        doc.documentElement.appendChild(link);
      }).catch(error => {
        link.remove();
        this.stylesheet = null;
        throw error;
      });
    }
    return this.stylesheet;
  }

  async open(feed) {
    const win = this.win;
    const doc = win.document;
    const browser = win.gBrowser.selectedBrowser;
    const global = browser.browsingContext.currentWindowGlobal;
    const focused = this.session?.panel?.contains(doc.activeElement)
      ? this.session.focused
      : doc.activeElement;
    const feedURL = lazy.validateSubscriptionURL(feed.feedURL);
    if (this.session) {
      this._dismiss(this.session, false);
    }
    const session = (this.session = {
      browser,
      global,
      focused,
      feedURL,
      title: (feed.title || feedURL).slice(0, MAX_TITLE_LENGTH),
      isPrivate: lazy.PrivateBrowsingUtils.isWindowPrivate(win),
      restoreFocus: true,
      ready: false,
      busy: false,
      closing: false,
      finished: false,
    });
    try {
      await this.closed;
      if (!this._isCurrent(session)) {
        return;
      }
      await this._loadStylesheet();
      if (!this._isCurrent(session)) {
        return;
      }
      const bookmarks = lazy.PlacesUtils.bookmarks;
      let roots = [];
      try {
        [, roots] = await Promise.all([
          lazy.LiveBookmarks.init(),
          Promise.all(
            [
              bookmarks.menuGuid,
              bookmarks.toolbarGuid,
              bookmarks.unfiledGuid,
              bookmarks.mobileGuid,
            ].map(guid => bookmarks.fetch(guid))
          ),
        ]);
        session.ready = roots.every(root => this._validFolder(root));
      } catch (error) {
        console.error("Could not initialize feed subscription controls", error);
      }
      if (!this._isCurrent(session)) {
        return;
      }
      if (session.ready && lazy.LiveBookmarks.getByFeedURL(feedURL)) {
        this._dismiss(session);
        return;
      }
      win.MozXULElement.insertFTLIfNeeded("browser/waterfox/feeds.ftl");
      this._build(session, roots.filter(Boolean));
      await doc.l10n.translateFragment(session.panel);
      if (!this._isCurrent(session)) {
        return;
      }
      this.subscriptionsChanged();
      if (!this._isCurrent(session)) {
        return;
      }
      session.anchor = this._anchor();
      if (!session.anchor) {
        this._dismiss(session, false);
        return;
      }
      session.panel.openPopup(session.anchor, {
        position: "bottomcenter topright",
        triggerEvent: null,
      });
    } catch (error) {
      this._dismiss(session, false);
      throw error;
    }
  }

  _build(session, roots) {
    const win = this.win;
    const doc = win.document;
    const fragment = win.MozXULElement.parseXULToFragment(`
      <panel id="waterfox-feed-subscribe-panel" type="arrow" role="dialog"
             aria-labelledby="waterfox-feed-subscribe-heading"
             norestorefocus="true" xmlns:html="${HTML_NS}">
        <vbox class="waterfox-feed-subscribe-content">
          <html:h2 id="waterfox-feed-subscribe-heading"
                   data-l10n-id="feeds-subscribe-heading"/>
          <html:p id="waterfox-feed-subscribe-private" hidden="hidden"
                  data-l10n-id="feeds-subscribe-private"/>
          <vbox class="waterfox-feed-subscribe-field">
            <label control="waterfox-feed-title" data-l10n-id="feeds-subscribe-title"/>
            <html:input id="waterfox-feed-title" type="text" autocomplete="off"/>
          </vbox>
          <vbox class="waterfox-feed-subscribe-field">
            <label control="waterfox-feed-url" data-l10n-id="feeds-subscribe-url"/>
            <html:input id="waterfox-feed-url" type="url" autocomplete="off"
                        spellcheck="false"/>
          </vbox>
          <vbox class="waterfox-feed-subscribe-field">
            <label id="waterfox-feed-folder-label" control="waterfox-feed-folder"
                   data-l10n-id="feeds-subscribe-folder"/>
            <menulist id="waterfox-feed-folder" size="large" native="true"
                      aria-labelledby="waterfox-feed-folder-label">
              <menupopup/>
            </menulist>
            <vbox id="waterfox-feed-folder-tree-container"/>
          </vbox>
          <html:p id="waterfox-feed-subscribe-error" role="alert"
                  aria-atomic="true" hidden="hidden"/>
          <html:p id="waterfox-feed-subscribe-status" role="status" tabindex="-1"
                  aria-atomic="true" hidden="hidden"/>
          <hbox class="waterfox-feed-subscribe-actions">
            <button id="waterfox-feed-cancel" data-l10n-id="feeds-subscribe-cancel"/>
            <button id="waterfox-feed-subscribe" default="true"
                    data-l10n-id="feeds-subscribe-button"/>
          </hbox>
        </vbox>
      </panel>
    `);
    const panel = (session.panel = fragment.firstElementChild);
    this.panelSession = session;
    const element = suffix => panel.querySelector(`#waterfox-feed-${suffix}`);
    session.ui = {
      title: element("title"),
      url: element("url"),
      folder: element("folder"),
      treeContainer: element("folder-tree-container"),
      error: element("subscribe-error"),
      status: element("subscribe-status"),
      subscribe: element("subscribe"),
      cancel: element("cancel"),
    };
    const ui = session.ui;
    ui.title.maxLength = MAX_TITLE_LENGTH;
    ui.title.value = session.title;
    ui.title.readOnly = session.isPrivate;
    ui.url.maxLength = lazy.MAX_FEED_URL_LENGTH;
    ui.url.value = session.feedURL;
    ui.url.readOnly = session.isPrivate;
    if (session.isPrivate) {
      element("subscribe-private").hidden = false;
      panel.setAttribute("aria-describedby", "waterfox-feed-subscribe-private");
    }
    const popup = ui.folder.firstElementChild;
    session.folderItems = new Map();
    for (const root of roots) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute(
        "label",
        lazy.PlacesUtils.bookmarks.getLocalizedTitle(root)
      );
      item.setAttribute("value", root.guid);
      popup.appendChild(item);
      session.folderItems.set(root.guid, item);
    }
    session.parentGuid = lazy.PlacesUtils.bookmarks.menuGuid;
    session.separator = popup.appendChild(
      doc.createXULElement("menuseparator")
    );
    session.chooseFolder = popup.appendChild(doc.createXULElement("menuitem"));
    doc.l10n.setAttributes(
      session.chooseFolder,
      "feeds-subscribe-choose-folder"
    );
    ui.folder.addEventListener("command", () => this._folderCommand(session));
    for (const input of [ui.title, ui.url]) {
      input.addEventListener("input", () => this._clearError(session));
    }
    ui.cancel.addEventListener("command", () => {
      if (this._isCurrent(session) && !session.busy) {
        this._dismiss(session);
      }
    });
    ui.subscribe.addEventListener("command", () => {
      this._subscribe(session).catch(console.error);
    });
    panel.addEventListener("keypress", event => {
      if (
        event.key === "Enter" &&
        !event.defaultPrevented &&
        !event.isComposing
      ) {
        if ([ui.title, ui.url].includes(event.target)) {
          event.preventDefault();
          this._subscribe(session).catch(console.error);
        } else if ([ui.subscribe, ui.cancel].includes(event.target)) {
          event.preventDefault();
          event.target.click();
        }
      }
    });
    panel.addEventListener("popupshown", event => {
      if (event.target === panel && this._isCurrent(session)) {
        if (session.anchor.id === "pageAction-urlbar-waterfox-feeds") {
          session.anchor.setAttribute("aria-expanded", "true");
        }
        const target = session.ready ? ui.title : ui.cancel;
        target.focus();
        if (target === ui.title) {
          target.select();
        }
      }
    });
    panel.addEventListener("popuphiding", event => {
      if (event.target === panel) {
        session.closing = true;
        session.focusOnHide = doc.activeElement;
      }
    });
    panel.addEventListener("popuphidden", event => {
      if (event.target === panel) {
        this._finish(session);
      }
    });
    this.closed = new Promise(resolve => {
      session.resolveClosed = resolve;
    });
    (doc.getElementById("mainPopupSet") || doc.documentElement).appendChild(
      panel
    );
    ui.folder.selectedItem =
      session.folderItems.get(session.parentGuid) || null;
    this._updateControls(session);
    if (!session.ready) {
      this._showError(session, "feeds-subscribe-setup-error");
    }
  }

  _dismiss(session, restoreFocus = true) {
    if (session.finished) {
      return;
    }
    session.closing = true;
    session.restoreFocus &&= restoreFocus;
    if (session.panel && session.panel.state !== "closed" && !this.win.closed) {
      session.panel.hidePopup();
    } else {
      this._finish(session);
    }
  }

  _finish(session) {
    if (session.finished) {
      return;
    }
    session.finished = true;
    session.closing = true;
    if (session.anchor?.id === "pageAction-urlbar-waterfox-feeds") {
      session.anchor.setAttribute("aria-expanded", "false");
    }
    const doc = this.win.document;
    const focus = doc.activeElement;
    const restore =
      this.session === session &&
      session.restoreFocus &&
      this._sameDocument(session) &&
      doc.hasFocus() &&
      (!focus ||
        focus === doc.body ||
        focus === doc.documentElement ||
        focus === session.focusOnHide) &&
      session.panel?.contains(session.focusOnHide);
    if (this.session === session) {
      this.session = null;
    }
    if (this.panelSession === session) {
      this.panelSession = null;
    }
    this._destroyFolderTree(session);
    session.panel?.replaceChildren();
    session.panel?.remove();
    session.panel = null;
    session.ui = null;
    session.folderItems?.clear();
    session.customFolder = null;
    session.chooseFolder = null;
    session.separator = null;
    session.resolveClosed?.();
    if (restore) {
      const target = [session.focused, session.anchor].find(element => {
        if (!this._visible(element) || element.disabled) {
          return false;
        }
        const popup = element.closest("panel, menupopup");
        return !popup || popup.state === "open";
      });
      (target || session.browser).focus();
    }
  }

  _destroyFolderTree(session) {
    const tree = session.tree;
    if (!tree) {
      return;
    }
    // XUL resets controllers on detach, so clean up while still connected.
    tree.disconnectedCallback();
    tree._controller = null;
    tree.remove();
    session.tree = null;
  }

  _canEdit(session) {
    return (
      this._isCurrent(session) &&
      session.ready &&
      !session.busy &&
      !session.isPrivate &&
      !lazy.PrivateBrowsingUtils.isWindowPrivate(this.win)
    );
  }

  _updateControls(session) {
    const ui = session.ui;
    const focusStatus =
      session.busy &&
      this.win.document.hasFocus() &&
      session.panel.contains(this.win.document.activeElement);
    const disabled = !session.ready || session.busy;
    ui.title.disabled = disabled;
    ui.url.disabled = disabled;
    ui.folder.disabled = disabled || session.isPrivate;
    ui.subscribe.disabled = disabled || session.isPrivate;
    ui.cancel.disabled = session.busy;
    if (session.tree) {
      session.tree.disabled = disabled || session.isPrivate;
    }
    ui.status.hidden = !session.busy;
    if (session.busy) {
      this.win.document.l10n.setAttributes(ui.status, "feeds-subscribe-busy");
      if (focusStatus) {
        ui.status.focus();
      }
    }
  }

  _clearError(session) {
    if (!this._isCurrent(session) || !session.ui) {
      return;
    }
    session.ui.error.hidden = true;
    for (const element of [
      session.ui.title,
      session.ui.url,
      session.ui.folder,
    ]) {
      element.removeAttribute("aria-invalid");
      element.removeAttribute("aria-describedby");
    }
  }

  _showError(session, id, input = null) {
    if (!this._isCurrent(session) || !session.ui) {
      return;
    }
    this._clearError(session);
    session.ui.error.hidden = false;
    this.win.document.l10n.setAttributes(session.ui.error, id);
    if (input) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", "waterfox-feed-subscribe-error");
      if (this.win.document.hasFocus()) {
        input.focus();
      }
    }
  }

  _validFolder(folder) {
    const bookmarks = lazy.PlacesUtils.bookmarks;
    return (
      folder?.type === bookmarks.TYPE_FOLDER &&
      ![bookmarks.rootGuid, bookmarks.tagsGuid].includes(folder.guid)
    );
  }

  _folderCommand(session) {
    if (!this._canEdit(session)) {
      return;
    }
    const folder = session.ui.folder;
    if (folder.selectedItem === session.chooseFolder) {
      folder.selectedItem =
        session.folderItems.get(session.parentGuid) || session.customFolder;
      const popup = folder.firstElementChild;
      if (popup.state === "closed") {
        this._showFolderTree(session);
      } else {
        popup.addEventListener(
          "popuphidden",
          () => this._showFolderTree(session),
          { once: true }
        );
        popup.hidePopup();
      }
      return;
    }
    session.parentGuid = folder.selectedItem.value;
    this._clearError(session);
    if (session.tree) {
      session.tree.selectItems([session.parentGuid]);
    }
  }

  _showFolderTree(session) {
    if (!this._canEdit(session)) {
      return;
    }
    try {
      if (!session.tree) {
        const win = this.win;
        if (!win.customElements.get("places-tree")) {
          Services.scriptloader.loadSubScript(
            "chrome://browser/content/places/places-tree.js",
            win
          );
        }
        const fragment = win.MozXULElement.parseXULToFragment(`
          <tree id="waterfox-feed-folder-tree" is="places-tree" class="placesTree"
                disableUserActions="true" hidecolumnpicker="true" seltype="single"
                aria-labelledby="waterfox-feed-folder-label">
            <treecols>
              <treecol anonid="title" flex="1" primary="true" hideheader="true"/>
            </treecols>
            <treechildren flex="1"/>
          </tree>
        `);
        const tree = (session.tree = fragment.firstElementChild);
        session.ui.treeContainer.appendChild(tree);
        tree.place =
          "place:excludeItems=1&excludeQueries=1&type=" +
          Ci.nsINavHistoryQueryOptions.RESULTS_AS_ROOTS_QUERY;
        tree.selectItems([session.parentGuid]);
        tree.addEventListener("select", () => this._treeSelect(session));
      }
      session.tree.focus();
    } catch (error) {
      console.error("Could not display bookmark folders", error);
      this._destroyFolderTree(session);
      this._showError(
        session,
        "feeds-subscribe-folder-error",
        session.ui.folder
      );
    }
  }

  _treeSelect(session) {
    if (!this._canEdit(session)) {
      return;
    }
    const node = session.tree.selectedNode;
    if (!node || !lazy.PlacesUtils.nodeIsFolderOrShortcut(node)) {
      return;
    }
    const guid = lazy.PlacesUtils.getConcreteItemGuid(node);
    const bookmarks = lazy.PlacesUtils.bookmarks;
    if (!guid || [bookmarks.rootGuid, bookmarks.tagsGuid].includes(guid)) {
      return;
    }
    const doc = this.win.document;
    let item = session.folderItems.get(guid);
    if (!item) {
      if (!session.customFolder) {
        session.customFolder = doc.createXULElement("menuitem");
        session.separator.before(session.customFolder);
      }
      item = session.customFolder;
      item.setAttribute("value", guid);
      if (node.title) {
        item.removeAttribute("data-l10n-id");
        item.setAttribute("label", node.title);
      } else {
        doc.l10n.setAttributes(item, "feeds-subscribe-untitled-folder");
      }
    }
    session.parentGuid = guid;
    session.ui.folder.selectedItem = item;
    this._clearError(session);
  }

  async _subscribe(session) {
    if (!this._canEdit(session)) {
      return;
    }
    const ui = session.ui;
    let feedURL;
    try {
      feedURL = lazy.validateSubscriptionURL(ui.url.value);
    } catch {
      this._showError(session, "feeds-subscribe-invalid-url", ui.url);
      return;
    }
    if (ui.title.value.length > MAX_TITLE_LENGTH) {
      this._showError(session, "feeds-subscribe-invalid-title", ui.title);
      return;
    }
    const title = ui.title.value;
    const parentGuid = session.parentGuid;
    this._clearError(session);
    session.busy = true;
    this._updateControls(session);
    try {
      await lazy.LiveBookmarks.create({ feedURL, title, parentGuid });
      if (this._isCurrent(session)) {
        this._dismiss(session);
      }
    } catch (error) {
      if (!this._isCurrent(session)) {
        return;
      }
      console.error("Could not subscribe to feed", error);
      let invalidFolder = false;
      try {
        invalidFolder = !this._validFolder(
          await lazy.PlacesUtils.bookmarks.fetch(parentGuid)
        );
      } catch {}
      if (!this._isCurrent(session)) {
        return;
      }
      session.busy = false;
      this._updateControls(session);
      this._showError(
        session,
        invalidFolder
          ? "feeds-subscribe-folder-error"
          : "feeds-subscribe-error",
        invalidFolder ? ui.folder : ui.url
      );
    }
  }
}

export const FeedSubscribePanel = {
  async open(win, feed) {
    if (win.closed || !win.gBrowser) {
      return;
    }
    let controller = controllers.get(win);
    if (!controller) {
      controller = new SubscribeController(win);
      controllers.set(win, controller);
    }
    await controller.open(feed);
  },

  hideIfStale(win, feeds = null) {
    controllers.get(win)?.hideIfStale(feeds);
  },

  subscriptionsChanged(win) {
    controllers.get(win)?.subscriptionsChanged();
  },
};
