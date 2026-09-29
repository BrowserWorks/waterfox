/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AboutReader } from "moz-src:///toolkit/components/reader/AboutReader.sys.mjs";
import { sanitizeFeedArticleContent } from "resource:///modules/FeedArticleContent.sys.mjs";
import { MAX_ITEM_CONTENT_LENGTH } from "resource:///modules/FeedConstants.sys.mjs";

const IMAGE_PREF = "browser.feeds.loadImages";

function httpURL(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\p{Cc}\s]/u.test(value)
  ) {
    return null;
  }
  const url = URL.parse(value);
  return url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password
    ? url.href
    : null;
}

export function FeedReader(actor, articlePromise) {
  // AboutReader calls our overrides synchronously during construction.
  this._actor = actor;
  this._docRef = Cu.getWeakReference(actor.contentWindow.document);
  this._winRef = Cu.getWeakReference(actor.contentWindow);
  this._feedImages = [];
  this._pageHidden = false;
  this._destroyed = false;
  this._articlePromise = Promise.resolve(articlePromise).catch(() => null);
  this._originalURL = this._getOriginalUrl(actor.contentWindow);
  if (!this._originalURL) {
    this._articlePromise = null;
    this._showError();
    return;
  }

  this._observingWindow = true;
  try {
    AboutReader.call(this, actor, this._articlePromise);
    Services.prefs.addObserver(IMAGE_PREF, this);
    this._observingImages = true;
    this._win.addEventListener("pageshow", this);
  } catch (error) {
    console.error("Could not initialize the feed reader", error);
    this._showError();
    this.clearActor();
    return;
  }

  // NarrateControls installs keyboard shortcuts even when its UI is hidden.
  const narration = this._doc.querySelector(".narrate-dropdown");
  if (narration) {
    narration.inert = true;
    for (const control of narration.querySelectorAll("button, input, select")) {
      control.disabled = true;
    }
  }
  for (const element of this._doc.querySelectorAll("[data-telemetry-id]")) {
    element.removeAttribute("data-telemetry-id");
  }
}

FeedReader.prototype = {
  constructor: FeedReader,

  _getOriginalUrl(win = this._win) {
    const page = URL.parse(win.location.href);
    if (
      page?.protocol !== "about:" ||
      page.pathname !== "feeds" ||
      page.searchParams.getAll("view").length !== 1 ||
      page.searchParams.get("view") !== "reader" ||
      page.searchParams.getAll("url").length !== 1
    ) {
      return null;
    }
    return httpURL(page.searchParams.get("url"));
  },

  async _loadArticle() {
    this._showProgressDelayed();
    try {
      const article = await this._articlePromise;
      if (this._destroyed || !this._actor) {
        return;
      }
      if (
        !article ||
        httpURL(article.url) !== this._originalURL ||
        typeof article.title !== "string" ||
        !article.title.trim() ||
        article.title.length > 1000 ||
        typeof article.content !== "string" ||
        article.content.length > MAX_ITEM_CONTENT_LENGTH
      ) {
        this._showError();
        return;
      }
      this._showContent(article);
    } catch (error) {
      if (!this._destroyed && this._actor) {
        console.error("Could not render the cached feed article", error);
        this._showError();
      }
    } finally {
      this._articlePromise = null;
    }
  },

  _showContent(article) {
    const content = sanitizeFeedArticleContent(
      article.content,
      this._originalURL
    );
    const fragment = this._createFeedContentFragment(content);
    if (!fragment.hasChildNodes()) {
      if (
        typeof article.textContent !== "string" ||
        !article.textContent.trim()
      ) {
        this._showError();
        return;
      }
      const paragraph = this._doc.createElement("p");
      paragraph.textContent = article.textContent.slice(
        0,
        MAX_ITEM_CONTENT_LENGTH
      );
      fragment.appendChild(paragraph);
    }

    this._win.clearTimeout(this._progressTimer);
    this._article = article;
    this._titleElement.textContent = article.title;
    this._creditsElement.textContent =
      typeof article.byline === "string" ? article.byline.slice(0, 1000) : "";
    this._doc.title = article.title;

    const fast = article.readingTimeMinsFast;
    const slow = article.readingTimeMinsSlow;
    this._readTimeElement.textContent = "";
    if (
      Number.isFinite(fast) &&
      Number.isFinite(slow) &&
      fast >= 0 &&
      slow >= fast
    ) {
      const hours = slow >= 120;
      this._readTimeElement.textContent = new Intl.NumberFormat(undefined, {
        style: "unit",
        unit: hours ? "hour" : "minute",
        unitDisplay: "long",
      }).formatRange(
        hours ? Math.round(fast / 60) : fast,
        hours ? Math.round(slow / 60) : slow
      );
    }
    const lang = article.lang ?? article.detectedLanguage;
    if (typeof lang === "string" && lang.length <= 100) {
      this._containerElement.setAttribute("lang", lang);
    }
    this._maybeSetTextDirection({ dir: article.dir === "rtl" ? "rtl" : "ltr" });
    this._contentElement.replaceChildren(fragment);
    this._messageElement.classList.remove("reader-show-element");
    this._headerElement.classList.add("reader-show-element");
    this._contentElement.classList.add("reader-show-element");
    this._doc.body.classList.add("loaded");
    this._languageDeferred.resolve(null);
    this._updateFeedImages();
    if (!this._pageHidden) {
      this._updateWideTables();
    }
    this._dispatchContentEvent("AboutReaderContentReady");
  },

  _createFeedContentFragment(content) {
    // Gecko data documents do not load resources. Strip sources before import.
    const parsed = new DOMParser().parseFromString(content, "text/html");
    const sources = [];
    for (const image of parsed.body.querySelectorAll("img")) {
      sources.push(httpURL(image.getAttribute("src")));
      image.removeAttribute("src");
      image.removeAttribute("srcset");
      image.setAttribute("referrerpolicy", "no-referrer");
    }
    for (const link of parsed.body.querySelectorAll("a[href]")) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      link.setAttribute("referrerpolicy", "no-referrer");
    }
    const fragment = this._doc.createDocumentFragment();
    for (const node of parsed.body.childNodes) {
      fragment.appendChild(this._doc.importNode(node, true));
    }
    this._updateFeedImages(false);
    this._feedImages = Array.from(
      fragment.querySelectorAll("img"),
      (template, index) => {
        const marker = this._doc.createTextNode(template.alt);
        template.replaceWith(marker);
        return { marker, template, src: sources[index], image: null };
      }
    );
    return fragment;
  },

  _updateFeedImages(allowImages = true) {
    const enabled =
      allowImages &&
      !this._destroyed &&
      !this._pageHidden &&
      !!this._actor &&
      Services.prefs.getBoolPref(IMAGE_PREF, true);
    for (const entry of this._feedImages) {
      if (enabled && entry.src && !entry.image && entry.marker.isConnected) {
        entry.image = entry.template.cloneNode(false);
        entry.marker.textContent = "";
        entry.marker.after(entry.image);
        entry.image.src = entry.src;
      } else if (!enabled && entry.image) {
        entry.image.onload = null;
        entry.image.removeAttribute("src");
        entry.image.removeAttribute("srcset");
        entry.image.remove();
        entry.image = null;
        entry.marker.textContent = entry.template.alt;
      }
    }
    if (enabled && this._article) {
      this._updateImageMargins();
    }
  },

  _showProgressDelayed() {
    this._progressTimer = this._win.setTimeout(() => {
      if (this._destroyed || this._article || this._error) {
        return;
      }
      const message = this._doc.querySelector(".reader-message");
      this._doc.l10n.setAttributes(message, "about-reader-loading");
      message.classList.add("reader-show-element");
    }, 300);
  },

  _showError() {
    this._win.clearTimeout(this._progressTimer);
    this._updateFeedImages(false);
    this._feedImages = [];
    this._article = null;
    this._error = true;
    const doc = this._doc;
    doc.querySelector(".reader-header").classList.remove("reader-show-element");
    const content = doc.querySelector(".moz-reader-content");
    content.classList.remove("reader-show-element");
    content.replaceChildren();
    doc.body.classList.remove("loaded");
    doc.documentElement.dataset.isError = "true";
    const message = doc.querySelector(".reader-message");
    doc.l10n.setAttributes(message, "about-reader-load-error");
    doc.l10n.setAttributes(
      doc.getElementById("reader-title"),
      "about-reader-load-error"
    );
    message.classList.add("reader-show-element");
    this._dispatchContentEvent("AboutReaderContentError");
  },

  _dispatchContentEvent(name) {
    this._doc.dispatchEvent(new this._win.CustomEvent(name, { bubbles: true }));
  },

  _requestFavicon() {},
  _onReaderClose() {},
  _setupColorsTabs() {},
  _setupCustomColors() {},
  _handleThemeFocus() {},

  _setupButton(id, callback) {
    if (id !== "close-button" && id !== "custom-colors-reset-button") {
      AboutReader.prototype._setupButton.call(this, id, callback);
    }
  },

  _setupSegmentedButton(id, ...args) {
    if (id !== "color-scheme-buttons") {
      AboutReader.prototype._setupSegmentedButton.call(this, id, ...args);
    }
  },

  _setColorSchemePref() {
    this._setColorScheme();
    return false;
  },

  _setColorScheme() {
    const colorScheme =
      this._feedColorScheme ||
      (this.colorSchemeMediaList.matches ? "dark" : "light");
    this._doc.documentElement.dataset.browserColorScheme = colorScheme;
    AboutReader.prototype._setColorScheme.call(
      this,
      this.forcedColorsMediaList.matches ? "hcm" : colorScheme
    );
  },

  receiveMessage(message) {
    if (this._destroyed || !this._originalURL) {
      return;
    }
    if (message.name === "FeedReader:ColorScheme") {
      if (["light", "dark"].includes(message.data?.colorScheme)) {
        this._feedColorScheme = message.data.colorScheme;
        this._setColorScheme();
      }
    } else if (
      ["Reader:ZoomIn", "Reader:ZoomOut", "Reader:ResetZoom"].includes(
        message.name
      )
    ) {
      AboutReader.prototype.receiveMessage.call(this, message);
    }
  },

  handleEvent(event) {
    if (!event.isTrusted || this._destroyed) {
      return;
    }
    switch (event.type) {
      case "click":
        if (event.target.classList?.contains("dropdown-toggle")) {
          this._toggleDropdownClicked(event);
        }
        break;
      case "blur":
        break;
      case "change":
        this._setColorScheme();
        break;
      case "pagehide": {
        this._pageHidden = true;
        this._closeDropdowns();
        this._updateFeedImages(false);
        this._intersectionObs.disconnect();
        this._cancelToolbarUpdate();
        if (!event.persisted) {
          const actor = this._actor;
          this.clearActor();
          actor?.readerModeHidden();
        }
        break;
      }
      case "pageshow":
        this._pageHidden = false;
        this._setColorScheme();
        this._intersectionObs.observe(this._doc.querySelector(".top-anchor"));
        this._updateFeedImages();
        if (this._article) {
          this._updateWideTables();
        }
        break;
      case "mousedown":
      case "touchstart":
      case "keydown":
      case "scroll":
      case "resize":
      case "wheel":
        AboutReader.prototype.handleEvent.call(this, event);
        break;
    }
  },

  observe(subject, topic, data) {
    if (topic === "nsPref:changed" && data === IMAGE_PREF) {
      this._updateFeedImages();
    } else if (
      topic === "inner-window-destroyed" &&
      subject.QueryInterface(Ci.nsISupportsPRUint64).data ===
        this._innerWindowId
    ) {
      this.clearActor();
    }
  },

  _topScrollChange(entries) {
    if (!this._destroyed && !this._pageHidden) {
      AboutReader.prototype._topScrollChange.call(this, entries);
    }
  },

  _scheduleToolbarOverlapHandler() {
    if (
      this._destroyed ||
      this._pageHidden ||
      this._enqueuedToolbarOverlapHandler
    ) {
      return;
    }
    this._enqueuedToolbarOverlapHandler = this._win.requestAnimationFrame(
      () => {
        this._toolbarTimer = this._win.setTimeout(() => {
          if (!this._destroyed && !this._pageHidden) {
            AboutReader.prototype._toolbarOverlapHandler.call(this);
          }
        }, 0);
      }
    );
  },

  _cancelToolbarUpdate() {
    const win = this._win;
    win?.cancelAnimationFrame(this._enqueuedToolbarOverlapHandler);
    win?.clearTimeout(this._toolbarTimer);
    delete this._enqueuedToolbarOverlapHandler;
  },

  clearActor() {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this._actor = null;
    this._articlePromise = null;
    this._article = null;
    this._updateFeedImages(false);
    this._feedImages = [];
    if (this._observingImages) {
      Services.prefs.removeObserver(IMAGE_PREF, this);
      this._observingImages = false;
    }
    if (this._observingWindow) {
      try {
        Services.obs.removeObserver(this, "inner-window-destroyed");
      } catch {
        // Construction can fail before AboutReader registers the observer.
      }
      this._observingWindow = false;
    }
    this.colorSchemeMediaList?.removeEventListener("change", this);
    this.forcedColorsMediaList?.removeEventListener("change", this);
    this._intersectionObs?.disconnect();
    this._cancelToolbarUpdate();
    const doc = this._doc;
    const win = this._win;
    win?.clearTimeout(this._progressTimer);
    for (const type of [
      "mousedown",
      "keydown",
      "click",
      "touchstart",
      "scroll",
    ]) {
      doc?.removeEventListener(type, this);
    }
    doc?.removeEventListener("blur", this, true);
    for (const type of ["pagehide", "pageshow", "resize", "wheel"]) {
      win?.removeEventListener(type, this);
    }
  },
};

Object.setPrototypeOf(FeedReader.prototype, AboutReader.prototype);
