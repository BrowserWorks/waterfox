/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FeedPreview: "resource:///modules/FeedPreview.sys.mjs",
  LiveBookmarks: "resource:///modules/LiveBookmarks.sys.mjs",
  MAX_FEED_URL_LENGTH: "resource:///modules/LiveBookmarks.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  PrivateTab: "resource:///modules/PrivateTab.sys.mjs",
  validateSubscriptionURL: "resource:///modules/LiveBookmarks.sys.mjs",
});

const controllers = new WeakMap();
const pendingSubmissions = new Map();
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
    if (session?.ready && !session.closing) {
      if (
        lazy.LiveBookmarks.getByFeedURL(
          session.ui?.url.value ?? session.feedURL
        )
      ) {
        this._reanchor(session);
      }
      if (!session.busy) {
        this._subscriptionState(session);
      }
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

  _reanchor(session) {
    if (
      session.anchor?.id !== "pageAction-urlbar-waterfox-feeds" ||
      session.panel?.state !== "open"
    ) {
      return;
    }
    const doc = this.win.document;
    const fallback = ["star-button-box", "urlbar"]
      .map(id => doc.getElementById(id))
      .find(element => this._visible(element));
    if (fallback) {
      session.anchor.setAttribute("aria-expanded", "false");
      session.anchor = fallback;
      session.panel.moveToAnchor(fallback, "bottomcenter topright");
    }
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

  async open(feed, triggerEvent = null) {
    const win = this.win;
    const inputSource =
      triggerEvent?.inputSource ?? triggerEvent?.mozInputSource;
    const focusOptions = {};
    if (
      win.KeyboardEvent.isInstance(triggerEvent) ||
      inputSource === win.MouseEvent.MOZ_SOURCE_KEYBOARD
    ) {
      focusOptions.focusVisible = true;
    } else if (
      [
        win.MouseEvent.MOZ_SOURCE_MOUSE,
        win.MouseEvent.MOZ_SOURCE_TOUCH,
        win.MouseEvent.MOZ_SOURCE_PEN,
      ].includes(inputSource) ||
      (win.TouchEvent && win.TouchEvent.isInstance(triggerEvent)) ||
      ["mouse", "touch", "pen"].includes(triggerEvent?.pointerType)
    ) {
      focusOptions.focusVisible = false;
    }
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
      focusOptions,
      feedURL,
      title: (feed.title || feedURL).slice(0, MAX_TITLE_LENGTH),
      isPrivate:
        lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
        lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) ||
        lazy.PrivateTab.isPrivate(win.gBrowser.selectedTab),
      restoreFocus: true,
      ready: false,
      busy: false,
      closing: false,
      finished: false,
      previewToken: 0,
      preview: null,
      createdGuid: null,
      subscription: null,
      renaming: false,
      titleEdited: false,
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
      win.MozXULElement.insertFTLIfNeeded("browser/waterfox/feeds.ftl");
      this._build(session, roots.filter(Boolean));
      this.subscriptionsChanged();
      do {
        await this._loadPreview(session);
        if (!this._isCurrent(session)) {
          return;
        }
        await doc.l10n.translateFragment(session.panel);
        if (!this._isCurrent(session)) {
          return;
        }
      } while (session.ready && session.previewURL !== session.ui.url.value);
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
             class="panel-no-padding" orient="vertical" tabspecific="true"
             aria-labelledby="waterfox-feed-subscribe-heading"
             norestorefocus="true" xmlns:html="${HTML_NS}">
        <vbox class="waterfox-feed-subscribe-content">
          <hbox class="panel-header waterfox-feed-subscribe-header" align="center">
            <html:h1 id="waterfox-feed-subscribe-heading"
                     data-l10n-id="feeds-subscribe-heading"/>
            <html:button id="waterfox-feed-header-close" type="button"
                         data-l10n-id="feeds-close"/>
          </hbox>
          <toolbarseparator/>
          <vbox class="panel-subview-body waterfox-feed-subscribe-scroll" flex="1">
          <vbox class="waterfox-feed-publisher">
            <hbox class="waterfox-feed-identity" align="center">
              <image id="waterfox-feed-icon" class="waterfox-feed-icon" aria-hidden="true"/>
              <vbox class="waterfox-feed-identity-text" flex="1">
                <html:h3 id="waterfox-feed-preview-title"/>
                <html:p id="waterfox-feed-preview-source"/>
              </vbox>
              <button id="waterfox-feed-rename" data-l10n-id="feeds-subscribe-rename"
                      aria-controls="waterfox-feed-name-field" aria-expanded="false"/>
            </hbox>
            <vbox id="waterfox-feed-name-field" class="waterfox-feed-subscribe-field"
                  hidden="hidden">
              <label control="waterfox-feed-title" data-l10n-id="feeds-subscribe-title"/>
              <html:input id="waterfox-feed-title" type="text" autocomplete="off"/>
            </vbox>
            <html:p id="waterfox-feed-preview-description" hidden="hidden"/>
          </vbox>
          <html:p id="waterfox-feed-subscribe-private" hidden="hidden"
                  data-l10n-id="feeds-subscribe-private"/>
          <vbox id="waterfox-feed-preview" hidden="hidden">
            <html:p id="waterfox-feed-preview-message" role="status" aria-live="polite"/>
            <html:button id="waterfox-feed-full-preview" type="button" hidden="hidden">
              <html:span data-l10n-id="feeds-subscribe-full-preview"/>
            </html:button>
          </vbox>
          <vbox id="waterfox-feed-subscribe-details" class="waterfox-feed-subscribe-details">
            <vbox class="waterfox-feed-subscribe-field" hidden="hidden">
              <label control="waterfox-feed-url" data-l10n-id="feeds-subscribe-url"/>
              <html:input id="waterfox-feed-url" type="url" autocomplete="off"
                          spellcheck="false"/>
            </vbox>
            <vbox class="waterfox-feed-subscribe-field">
              <label id="waterfox-feed-folder-label" control="waterfox-feed-folder"
                     data-l10n-id="feeds-subscribe-folder"/>
              <menulist id="waterfox-feed-folder" size="large"
                        aria-labelledby="waterfox-feed-folder-label">
                <menupopup/>
              </menulist>
              <vbox id="waterfox-feed-folder-tree-container"/>
            </vbox>
          </vbox>
          <html:p id="waterfox-feed-destination" hidden="hidden"/>
          <html:p id="waterfox-feed-subscribe-error" role="alert"
                  aria-atomic="true" hidden="hidden"/>
          <html:p id="waterfox-feed-subscribe-status" role="status" tabindex="-1"
                  aria-atomic="true" hidden="hidden"/>
          </vbox>
          <html:moz-button-group class="panel-footer waterfox-feed-subscribe-actions">
            <button id="waterfox-feed-cancel" class="footer-button"
                    data-l10n-id="feeds-subscribe-cancel"/>
            <button id="waterfox-feed-undo" class="footer-button" hidden="hidden"
                    data-l10n-id="feeds-subscribe-undo"/>
            <button id="waterfox-feed-open" class="footer-button" hidden="hidden"
                    data-l10n-id="feeds-subscribe-open"/>
            <button id="waterfox-feed-subscribe" class="footer-button primary" default="true"
                    data-l10n-id="feeds-subscribe-button"/>
          </html:moz-button-group>
        </vbox>
      </panel>
    `);
    const panel = (session.panel = fragment.firstElementChild);
    this.panelSession = session;
    const element = suffix => panel.querySelector(`#waterfox-feed-${suffix}`);
    session.ui = {
      title: element("title"),
      rename: element("rename"),
      url: element("url"),
      folder: element("folder"),
      treeContainer: element("folder-tree-container"),
      details: element("subscribe-details"),
      headerClose: element("header-close"),
      preview: element("preview"),
      icon: element("icon"),
      previewTitle: element("preview-title"),
      previewSource: element("preview-source"),
      previewDescription: element("preview-description"),
      previewMessage: element("preview-message"),
      fullPreview: element("full-preview"),
      destination: element("destination"),
      open: element("open"),
      undo: element("undo"),
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
    ui.previewTitle.textContent = session.title;
    ui.previewSource.textContent = new URL(session.feedURL).hostname;
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
    ui.rename.addEventListener("command", () => {
      if (!this._canEdit(session) || session.subscription) {
        return;
      }
      session.renaming = true;
      ui.title.parentElement.hidden = false;
      ui.rename.setAttribute("aria-expanded", "true");
      ui.title.focus();
      ui.title.select();
    });
    ui.title.addEventListener("input", () => {
      session.titleEdited = true;
      ui.previewTitle.textContent = ui.title.value || session.title;
      this._clearError(session);
    });
    ui.url.addEventListener("input", () => {
      this._clearError(session);
      this._subscriptionState(session, false);
      ui.previewTitle.textContent = ui.title.value || ui.url.value;
      ui.previewSource.textContent = "";
      ui.previewDescription.textContent = "";
      ui.previewDescription.hidden = true;
      try {
        ui.previewSource.textContent = new URL(
          lazy.validateSubscriptionURL(ui.url.value)
        ).hostname;
      } catch {}
    });
    ui.url.addEventListener("change", () => this._loadPreview(session));
    ui.open.addEventListener("command", () => {
      if (this._isCurrent(session) && !session.busy && session.subscription) {
        win.openTrustedLinkIn("about:feeds", "tab");
        this._dismiss(session, false);
      }
    });
    ui.undo.addEventListener("command", () => {
      this._undo(session).catch(console.error);
    });
    ui.fullPreview.addEventListener("click", () => this._openPreview(session));
    ui.headerClose.addEventListener("click", () => {
      if (this._isCurrent(session) && !session.busy) {
        this._dismiss(session);
      }
    });
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
        } else if (
          [
            ui.subscribe,
            ui.cancel,
            ui.headerClose,
            ui.rename,
            ui.open,
            ui.undo,
            ui.fullPreview,
          ].includes(event.target)
        ) {
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
        let target = ui.subscribe.disabled ? ui.cancel : ui.subscribe;
        if (session.subscription) {
          target = ui.open;
        }
        target.focus(session.focusOptions);
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
    if (session.ready) {
      this._subscriptionState(session);
    }
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
    session.previewToken++;
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

  _isPrivate(session) {
    return (
      session.isPrivate ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(this.win) ||
      lazy.PrivateBrowsingUtils.isBrowserPrivate(session.browser) ||
      lazy.PrivateTab.isPrivate(
        this.win.gBrowser.getTabForBrowser(session.browser)
      )
    );
  }

  _subscriptionState(session, refreshPreview = true) {
    if (
      !this._isCurrent(session) ||
      !session.ui ||
      !session.ready ||
      session.busy
    ) {
      return;
    }
    const sub = lazy.LiveBookmarks.getByFeedURL(session.ui.url.value);
    if (session.completed && !sub) {
      session.completed = false;
    }
    const previous = session.subscription;
    session.subscription = sub;
    if (session.createdGuid && sub?.guid !== session.createdGuid) {
      session.createdGuid = null;
    }
    const ui = session.ui;
    const focused = this.win.document.activeElement;
    const restoreFocus =
      session.panel.state === "open" &&
      this.win.document.hasFocus() &&
      session.panel.contains(focused);
    const completed = !!session.completed && !!sub;
    const subscribed = !!sub;
    session.panel.classList.toggle("subscribed", subscribed);
    ui.cancel.hidden = subscribed;
    ui.title.parentElement.hidden = subscribed || !session.renaming;
    ui.rename.hidden = subscribed;
    ui.rename.setAttribute(
      "aria-expanded",
      String(!ui.title.parentElement.hidden)
    );
    ui.folder.parentElement.hidden = subscribed;
    ui.details.hidden = subscribed;
    ui.subscribe.hidden = subscribed;
    ui.open.hidden = !subscribed;
    for (const [button, primary] of [
      [ui.subscribe, !subscribed],
      [ui.open, subscribed],
    ]) {
      button.classList.toggle("primary", primary);
      if (primary) {
        button.setAttribute("default", "true");
      } else {
        button.removeAttribute("default");
      }
    }
    ui.undo.hidden =
      !completed ||
      session.createdGuid !== sub.guid ||
      this._isPrivate(session);
    ui.destination.hidden = !sub;
    ui.status.hidden = !sub;
    if (sub) {
      this.win.document.l10n.setAttributes(
        ui.status,
        completed ? "feeds-subscribe-success" : "feeds-subscribe-already"
      );
      this._showDestination(session, sub);
    }
    if (previous?.guid !== sub?.guid || session.previewURL !== ui.url.value) {
      session.previewToken++;
      session.preview = null;
      session.previewURL = null;
      ui.preview.hidden = true;
      ui.fullPreview.hidden = true;
      if (refreshPreview && session.panel.state === "open") {
        this._loadPreview(session);
      }
    }
    this._updateControls(session);
    if (restoreFocus && !this._visible(focused)) {
      let target = ui.subscribe.disabled ? ui.cancel : ui.subscribe;
      if (subscribed) {
        target = ui.open;
      }
      target.focus();
    }
  }

  async _showDestination(session, sub) {
    try {
      const folder = await lazy.PlacesUtils.bookmarks.fetch(sub.guid);
      const parent =
        folder && (await lazy.PlacesUtils.bookmarks.fetch(folder.parentGuid));
      if (this._isCurrent(session) && session.subscription?.guid === sub.guid) {
        const name =
          parent && lazy.PlacesUtils.bookmarks.getLocalizedTitle(parent);
        if (name) {
          this.win.document.l10n.setAttributes(
            session.ui.destination,
            "feeds-subscribe-destination",
            { folder: name }
          );
        } else {
          session.ui.destination.hidden = true;
        }
      }
    } catch (error) {
      console.error("Could not find feed destination", error);
      if (this._isCurrent(session) && session.subscription?.guid === sub.guid) {
        session.ui.destination.hidden = true;
      }
    }
  }

  async _loadPreview(session) {
    if (!this._isCurrent(session) || !session.ready || session.busy) {
      return;
    }
    const ui = session.ui;
    const value = ui.url.value;
    const token = ++session.previewToken;
    session.previewURL = value;
    session.preview = null;
    ui.preview.hidden = false;
    ui.previewMessage.hidden = false;
    ui.icon.removeAttribute("src");
    ui.previewTitle.textContent = ui.title.value || value;
    ui.previewSource.textContent = "";
    ui.previewDescription.hidden = true;
    ui.previewDescription.textContent = "";
    ui.fullPreview.hidden = true;
    let feedURL;
    try {
      feedURL = lazy.validateSubscriptionURL(value);
      ui.previewSource.textContent = new URL(feedURL).hostname;
    } catch {
      this.win.document.l10n.setAttributes(
        ui.previewMessage,
        "feeds-subscribe-preview-invalid"
      );
      return;
    }
    const sub = lazy.LiveBookmarks.getByFeedURL(feedURL);
    this.win.document.l10n.setAttributes(
      ui.previewMessage,
      sub ? "feeds-subscribe-preview-empty" : "feeds-subscribe-preview-loading"
    );
    try {
      const cached = sub ? lazy.LiveBookmarks.peek(sub.guid) : null;
      const feed = sub
        ? cached && { ...cached, title: sub.title }
        : await lazy.FeedPreview.load(session.global, feedURL);
      if (
        !this._isCurrent(session) ||
        token !== session.previewToken ||
        ui.url.value !== value
      ) {
        return;
      }
      if (feed) {
        session.preview = { feedURL, feed };
        ui.previewTitle.textContent = (
          (session.titleEdited && ui.title.value) ||
          feed.title ||
          sub?.title ||
          session.title
        ).slice(0, MAX_TITLE_LENGTH);
        ui.previewSource.textContent = new URL(
          feed.siteURL || feedURL
        ).hostname;
        if (feed.siteURL) {
          ui.icon.setAttribute("src", `page-icon:${feed.siteURL}`);
        }
        ui.previewDescription.textContent = feed.description || "";
        ui.previewDescription.hidden = !feed.description;
      } else {
        ui.previewTitle.textContent = sub?.title || session.title;
        ui.previewSource.textContent = new URL(
          sub?.siteURL || feedURL
        ).hostname;
      }
      this.win.document.l10n.setAttributes(
        ui.previewMessage,
        "feeds-subscribe-preview-empty"
      );
      ui.previewMessage.hidden = !!feed?.items.length;
      ui.fullPreview.hidden = !session.preview || this._isPrivate(session);
    } catch (error) {
      if (!this._isCurrent(session) || token !== session.previewToken) {
        return;
      }
      console.error("Could not preview feed", error);
      ui.previewSource.textContent = new URL(feedURL).hostname;
      this.win.document.l10n.setAttributes(
        ui.previewMessage,
        "feeds-subscribe-preview-error"
      );
    }
  }

  _openPreview(session) {
    if (
      !this._isCurrent(session) ||
      this._isPrivate(session) ||
      !session.preview ||
      session.subscription ||
      session.busy ||
      session.ui.url.value !== session.previewURL
    ) {
      return;
    }
    const { feedURL, feed } = session.preview;
    let tab;
    try {
      tab = this.win.gBrowser.addTrustedTab("about:blank");
      const browser = tab.linkedBrowser;
      const url = lazy.FeedPreview.set(browser.browsingContext, {
        feedURL,
        feed,
      });
      browser.loadURI(Services.io.newURI(url), {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
        loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
      });
      this.win.gBrowser.selectedTab = tab;
      this._dismiss(session, false);
    } catch (error) {
      if (tab) {
        this.win.gBrowser.removeTab(tab);
      }
      console.error("Could not open feed preview", error);
      this._showError(session, "feeds-subscribe-preview-open-error");
    }
  }

  _canEdit(session) {
    return (
      this._isCurrent(session) &&
      session.ready &&
      !session.busy &&
      !session.completed &&
      !this._isPrivate(session)
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
    ui.rename.disabled = !this._canEdit(session) || !!session.subscription;
    ui.url.disabled = disabled;
    ui.folder.disabled =
      disabled || this._isPrivate(session) || !!session.subscription;
    ui.subscribe.disabled =
      disabled || this._isPrivate(session) || !!session.subscription;
    ui.undo.disabled = disabled || this._isPrivate(session);
    ui.fullPreview.disabled = disabled || this._isPrivate(session);
    ui.cancel.disabled = session.busy;
    ui.headerClose.disabled = session.busy;
    ui.open.disabled = session.busy;
    if (session.tree) {
      session.tree.disabled =
        disabled || this._isPrivate(session) || !!session.subscription;
    }
    ui.status.hidden = !session.busy && !session.subscription;
    if (session.busy) {
      this.win.document.l10n.setAttributes(
        ui.status,
        session.busy === "undo"
          ? "feeds-subscribe-removing"
          : "feeds-subscribe-busy"
      );
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
      if (input === session.ui.title) {
        session.renaming = true;
        session.ui.rename.setAttribute("aria-expanded", "true");
      }
      input.parentElement.hidden = false;
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

  async _undo(session) {
    if (!this._canEditUndo(session)) {
      return;
    }
    const guid = session.createdGuid;
    const feedURL = session.subscription.feedURL;
    this._clearError(session);
    session.busy = "undo";
    this._updateControls(session);
    try {
      const folder = await lazy.PlacesUtils.bookmarks.fetch(guid);
      if (
        !this._isCurrent(session) ||
        this._isPrivate(session) ||
        !folder ||
        folder.parentGuid !== session.createdParentGuid ||
        lazy.LiveBookmarks.getByFeedURL(feedURL)?.guid !== guid
      ) {
        throw new Error("Subscription changed before Undo");
      }
      await lazy.LiveBookmarks.remove(guid);
      if (!this._isCurrent(session)) {
        return;
      }
      session.createdGuid = null;
      session.completed = false;
      session.busy = false;
      this._subscriptionState(session);
      this.win.document.l10n.setAttributes(
        session.ui.status,
        "feeds-subscribe-undone"
      );
      session.ui.status.hidden = false;
      if (
        this.win.document.hasFocus() &&
        session.panel.contains(this.win.document.activeElement)
      ) {
        session.ui.status.focus();
      }
    } catch (error) {
      if (!this._isCurrent(session)) {
        return;
      }
      console.error("Could not undo feed subscription", error);
      session.busy = false;
      this._subscriptionState(session);
      this._showError(session, "feeds-subscribe-undo-error");
    }
  }

  _canEditUndo(session) {
    return (
      this._isCurrent(session) &&
      session.ready &&
      !session.busy &&
      !this._isPrivate(session) &&
      session.completed &&
      session.createdGuid &&
      session.subscription?.guid === session.createdGuid &&
      lazy.LiveBookmarks.getByFeedURL(session.subscription.feedURL)?.guid ===
        session.createdGuid
    );
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
    const existing = lazy.LiveBookmarks.getByFeedURL(feedURL);
    if (existing) {
      this._subscriptionState(session);
      return;
    }
    const attempt = {};
    const firstAttempt = !pendingSubmissions.has(feedURL);
    if (firstAttempt) {
      pendingSubmissions.set(feedURL, attempt);
    }
    session.busy = "subscribe";
    this._updateControls(session);
    try {
      const result = await lazy.LiveBookmarks.createWithResult({
        feedURL,
        title,
        parentGuid,
      });
      const created = result.subscription;
      if (!this._isCurrent(session)) {
        return;
      }
      const current = lazy.LiveBookmarks.getByFeedURL(feedURL);
      if (!current || current.guid !== created.guid) {
        throw new Error("Subscription was removed during creation");
      }
      let folder;
      try {
        folder = await lazy.PlacesUtils.bookmarks.fetch(created.guid);
      } catch (error) {
        console.error("Could not verify subscription folder for Undo", error);
      }
      if (!this._isCurrent(session)) {
        return;
      }
      session.completed = result.created;
      session.createdGuid =
        firstAttempt &&
        result.created &&
        folder?.parentGuid === parentGuid &&
        (!title || created.title === title)
          ? created.guid
          : null;
      session.createdParentGuid = parentGuid;
      session.busy = false;
      this._destroyFolderTree(session);
      this._subscriptionState(session);
      if (
        this.win.document.hasFocus() &&
        session.panel.contains(this.win.document.activeElement)
      ) {
        ui.status.focus();
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
    } finally {
      if (pendingSubmissions.get(feedURL) === attempt) {
        pendingSubmissions.delete(feedURL);
      }
    }
  }
}

export const FeedSubscribePanel = {
  async open(win, feed, triggerEvent = null) {
    if (win.closed || !win.gBrowser) {
      return;
    }
    let controller = controllers.get(win);
    if (!controller) {
      controller = new SubscribeController(win);
      controllers.set(win, controller);
    }
    await controller.open(feed, triggerEvent);
  },

  hideIfStale(win, feeds = null) {
    controllers.get(win)?.hideIfStale(feeds);
  },

  subscriptionsChanged(win) {
    controllers.get(win)?.subscriptionsChanged();
  },
};
