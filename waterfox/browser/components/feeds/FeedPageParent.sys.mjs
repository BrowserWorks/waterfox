/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LiveBookmarks: "resource:///modules/LiveBookmarks.sys.mjs",
  serializeOPML: "resource:///modules/LiveBookmarks.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["browser/waterfox/feeds.ftl"])
);

const CHANGE_TOPIC = "waterfox-live-bookmarks-changed";
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 1024;
const MAX_PREVIEW_ITEMS = 200;
const MAX_OPML_BYTES = 2 * 1024 * 1024;
const GUID_PATTERN = /^[a-zA-Z0-9_-]{12}$/;
const MUTATIONS = new Set(["Create", "Remove", "Refresh", "Import"]);
const READ_ONLY = new Set(["List", "Preview"]);
const REQUEST_FIELDS = new Map([
  ["List", []],
  ["Create", ["feedURL", "title"]],
  ["Remove", ["guid"]],
  ["Preview", ["guid"]],
  ["Refresh", ["guid"]],
  ["Import", []],
  ["Export", []],
]);

/** An error identifier safe to expose to about:feeds. */
class FeedPageError extends Error {
  constructor(id) {
    super(id);
    this.id = id;
  }
}

function text(value) {
  return typeof value === "string" ? value.slice(0, MAX_TITLE_LENGTH) : "";
}

function feedURL(value, principal) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_URL_LENGTH ||
    /[\p{Cc}\s]/u.test(value)
  ) {
    throw new FeedPageError("feeds-error-invalid-url");
  }
  try {
    const uri = Services.io.newURI(value);
    if ((!uri.schemeIs("https") && !uri.schemeIs("http")) || uri.userPass) {
      throw new Error("Not an HTTP(S) URL without credentials");
    }
    const normalized = uri.mutate().setRef("").finalize();
    Services.scriptSecurityManager.checkLoadURIWithPrincipal(
      principal,
      normalized,
      Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL
    );
    if (normalized.spec.length > MAX_URL_LENGTH) {
      throw new Error("URL too long");
    }
    return normalized.spec;
  } catch {
    throw new FeedPageError("feeds-error-invalid-url");
  }
}

/** Grants narrow feed operations to the current, non-system about:feeds page. */
export class FeedPageParent extends JSWindowActorParent {
  #observing = false;
  #busy = false;

  #assertPage() {
    try {
      const manager = this.manager;
      const context = this.browsingContext;
      const { documentURI, documentPrincipal } = manager;
      if (
        !context.parent &&
        context.currentWindowGlobal === manager &&
        manager.isCurrentGlobal &&
        manager.remoteType === "privilegedabout" &&
        context.embedderElement &&
        documentURI?.spec.split(/[?#]/, 1)[0] === "about:feeds" &&
        documentPrincipal.isContentPrincipal &&
        documentPrincipal.URI?.spec.split(/[?#]/, 1)[0] === "about:feeds"
      ) {
        return;
      }
    } catch {
      // Actor getters can throw after navigation destroys the manager.
    }
    throw new FeedPageError("feeds-error-unavailable");
  }

  get #isPrivate() {
    return (
      this.manager.documentPrincipal.originAttributes.privateBrowsingId !== 0 ||
      lazy.PrivateBrowsingUtils.isBrowserPrivate(
        this.browsingContext.embedderElement
      )
    );
  }

  #assertAllowed(command) {
    this.#assertPage();
    if (MUTATIONS.has(command) && this.#isPrivate) {
      throw new FeedPageError("feeds-error-private");
    }
  }

  #validateRequest(command, data) {
    const fields = REQUEST_FIELDS.get(command);
    if (
      !fields ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).some(key => !fields.includes(key)) ||
      (fields.includes("guid") &&
        (typeof data.guid !== "string" || !GUID_PATTERN.test(data.guid))) ||
      (command === "Create" &&
        data.title !== undefined &&
        (typeof data.title !== "string" ||
          data.title.length > MAX_TITLE_LENGTH))
    ) {
      throw new FeedPageError("feeds-error-invalid-request");
    }
    if (command === "Create") {
      return {
        feedURL: feedURL(data.feedURL, this.manager.documentPrincipal),
        title: data.title?.trim() || "",
      };
    }
    return data;
  }

  async receiveMessage({ name, data }) {
    let acquired = false;
    try {
      this.#assertPage();
      const command = name.startsWith("Feeds:") ? name.slice(6) : "";
      this.#assertAllowed(command);
      const request = this.#validateRequest(command, data);
      if (!READ_ONLY.has(command)) {
        if (this.#busy) {
          throw new FeedPageError("feeds-error-busy");
        }
        this.#busy = true;
        acquired = true;
      }
      await lazy.LiveBookmarks.init();
      this.#assertAllowed(command);

      let value;
      switch (command) {
        case "List":
          if (!this.#observing) {
            Services.obs.addObserver(this.#onChange, CHANGE_TOPIC);
            this.#observing = true;
          }
          value = {
            isPrivate: this.#isPrivate,
            subscriptions: lazy.LiveBookmarks.list()
              .map(sub => this.#metadata(sub))
              .filter(Boolean),
          };
          break;
        case "Create":
          value = this.#metadata(
            await lazy.LiveBookmarks.create({
              ...request,
              parentGuid: lazy.PlacesUtils.bookmarks.menuGuid,
            })
          );
          break;
        case "Remove":
          this.#getSubscription(request.guid);
          await lazy.LiveBookmarks.remove(request.guid);
          break;
        case "Preview": {
          const sub = this.#getSubscription(request.guid);
          value = this.#preview(sub, lazy.LiveBookmarks.peek(sub.guid) || {});
          break;
        }
        case "Refresh": {
          const sub = this.#getSubscription(request.guid);
          const result = await lazy.LiveBookmarks.refresh(sub.guid, {
            force: true,
          });
          this.#assertAllowed(command);
          value = this.#preview(sub, result);
          break;
        }
        case "Import":
          value = await this.#importOPML();
          break;
        case "Export":
          value = await this.#exportOPML();
          break;
      }
      this.#assertPage();
      return { ok: true, value };
    } catch (error) {
      if (!(error instanceof FeedPageError)) {
        console.error("FeedPage operation failed", error);
      }
      return {
        ok: false,
        error:
          error instanceof FeedPageError ? error.id : "feeds-error-operation",
      };
    } finally {
      if (acquired) {
        this.#busy = false;
      }
    }
  }

  #getSubscription(guid) {
    const sub = lazy.LiveBookmarks.get(guid);
    if (!sub) {
      throw new FeedPageError("feeds-error-not-found");
    }
    return sub;
  }

  #optionalURL(value) {
    try {
      return feedURL(value, this.manager.documentPrincipal);
    } catch {
      return "";
    }
  }

  #metadata(sub) {
    if (!sub || !GUID_PATTERN.test(sub.guid)) {
      return null;
    }
    const url = this.#optionalURL(sub.feedURL);
    return url
      ? {
          guid: sub.guid,
          feedURL: url,
          title: text(sub.title),
          siteURL: this.#optionalURL(sub.siteURL),
        }
      : null;
  }

  #preview(sub, cached = {}) {
    return {
      ...this.#metadata(sub),
      title: text(cached.title) || text(sub.title) || sub.feedURL,
      items: (Array.isArray(cached.items) ? cached.items : [])
        .slice(0, MAX_PREVIEW_ITEMS)
        .filter(item => item && typeof item === "object")
        .map(item => ({
          id: text(item.id),
          title: text(item.title),
          url: this.#optionalURL(item.url),
        })),
    };
  }

  async #pickFile(command) {
    this.#assertAllowed(command);
    const save = command === "Export";
    const [title, filter, filename] = await lazy.l10n.formatValues([
      { id: save ? "feeds-export-picker-title" : "feeds-import-picker-title" },
      { id: "feeds-opml-file-filter" },
      { id: "feeds-export-filename" },
    ]);
    this.#assertAllowed(command);
    if (!title || !filter || (save && !filename)) {
      throw new FeedPageError("feeds-error-unavailable");
    }
    const browser = this.browsingContext.embedderElement;
    if (
      !this.browsingContext.isActive ||
      !this.browsingContext.canOpenModalPicker ||
      browser.documentGlobal.gBrowser.selectedBrowser !== browser
    ) {
      throw new FeedPageError("feeds-error-not-active");
    }
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(
      this.browsingContext,
      title,
      save ? Ci.nsIFilePicker.modeSave : Ci.nsIFilePicker.modeOpen
    );
    picker.appendFilter(filter, "*.opml;*.xml");
    if (save) {
      picker.defaultString = filename;
      picker.defaultExtension = "opml";
    }
    const result = await new Promise(resolve => picker.open(resolve));
    this.#assertAllowed(command);
    if (
      result !== Ci.nsIFilePicker.returnOK &&
      !(save && result === Ci.nsIFilePicker.returnReplace)
    ) {
      return null;
    }
    return picker.file;
  }

  async #importOPML() {
    const file = await this.#pickFile("Import");
    if (!file) {
      return { canceled: true };
    }
    const info = await IOUtils.stat(file.path);
    this.#assertAllowed("Import");
    if (info.type !== "regular") {
      throw new FeedPageError("feeds-error-invalid-opml");
    }
    if (info.size > MAX_OPML_BYTES) {
      throw new FeedPageError("feeds-error-file-too-large");
    }
    const bytes = await IOUtils.read(file.path, {
      maxBytes: MAX_OPML_BYTES + 1,
    });
    this.#assertAllowed("Import");
    if (bytes.length > MAX_OPML_BYTES) {
      throw new FeedPageError("feeds-error-file-too-large");
    }
    let xml;
    try {
      xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
        throw new Error("OPML must not declare entities");
      }
    } catch {
      throw new FeedPageError("feeds-error-invalid-opml");
    }
    const count = await lazy.LiveBookmarks.importOPML(
      xml,
      lazy.PlacesUtils.bookmarks.menuGuid
    );
    return { canceled: false, count };
  }

  async #exportOPML() {
    const file = await this.#pickFile("Export");
    if (!file) {
      return { canceled: true };
    }
    this.#assertAllowed("Export");
    const xml = lazy.serializeOPML(lazy.LiveBookmarks.list());
    await IOUtils.writeUTF8(file.path, xml);
    return { canceled: false };
  }

  #onChange = () => {
    try {
      this.#assertPage();
      this.sendAsyncMessage("Feeds:Changed");
    } catch {
      // Inactive and navigating documents must not receive subscription data.
    }
  };

  didDestroy() {
    if (this.#observing) {
      Services.obs.removeObserver(this.#onChange, CHANGE_TOPIC);
      this.#observing = false;
    }
  }
}
