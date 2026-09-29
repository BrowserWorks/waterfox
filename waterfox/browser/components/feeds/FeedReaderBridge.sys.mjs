/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  isFeedReaderURL,
  MAX_ITEM_DESCRIPTION_LENGTH,
} from "resource:///modules/FeedConstants.sys.mjs";
import { sanitizeFeedArticleContent } from "resource:///modules/FeedArticleContent.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  PrivateTab: "resource:///modules/PrivateTab.sys.mjs",
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
});

const MAX_ARTICLES_PER_BROWSER = 16;
const MAX_AGE_MS = 5 * 60 * 1000;
const articlesByBrowser = new WeakMap();
const articlesByActor = new WeakMap();

function sourceContext(manager, browsingContext) {
  const browser = browsingContext.embedderElement;
  const { documentURI, documentPrincipal } = manager;
  if (
    browsingContext.parent ||
    browsingContext.currentWindowGlobal !== manager ||
    !manager.isCurrentGlobal ||
    manager.remoteType !== "privilegedabout" ||
    !browser?.isConnected ||
    documentURI.spec.split(/[?#]/, 1)[0] !== "about:feeds" ||
    isFeedReaderURL(documentURI.spec) ||
    !documentPrincipal.isContentPrincipal ||
    documentPrincipal.URI?.spec.split(/[?#]/, 1)[0] !== "about:feeds"
  ) {
    throw new Error("Unavailable feed Reader source");
  }
  const tab = browser.documentGlobal?.gBrowser?.getTabForBrowser(browser);
  const isPrivate = !!(
    documentPrincipal.originAttributes.privateBrowsingId ||
    lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) ||
    (tab && lazy.PrivateTab.isPrivate(tab))
  );
  return {
    browser,
    source: manager,
    sourceContext: browsingContext,
    isPrivate,
    originAttributes: ChromeUtils.originAttributesToSuffix(
      documentPrincipal.originAttributes
    ),
  };
}

function frameContext(actor) {
  const { manager, browsingContext } = actor;
  const parent = browsingContext.parent;
  const principal = manager.documentPrincipal;
  if (
    !parent ||
    parent.parent ||
    browsingContext.currentWindowGlobal !== manager ||
    !manager.isCurrentGlobal ||
    !isFeedReaderURL(manager.documentURI.spec) ||
    !principal.isContentPrincipal ||
    principal.URI?.spec.split(/[?#]/, 1)[0] !== "about:feeds"
  ) {
    throw new Error("Unavailable feed Reader frame");
  }
  const context = sourceContext(parent.currentWindowGlobal, parent);
  if (
    ChromeUtils.originAttributesToSuffix(principal.originAttributes) !==
    context.originAttributes
  ) {
    throw new Error("Mismatched feed Reader origin attributes");
  }
  return context;
}

function matchesContext(record, context) {
  return (
    record.browser === context.browser &&
    record.source === context.source &&
    record.sourceContext === context.sourceContext &&
    record.isPrivate === context.isPrivate &&
    record.originAttributes === context.originAttributes
  );
}

function escapeText(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getRecord(actor) {
  try {
    const context = frameContext(actor);
    const record = articlesByActor.get(actor);
    return record && matchesContext(record, context) ? record : null;
  } catch {
    return null;
  }
}

export const FeedReaderBridge = {
  prepare(actor, snapshot) {
    const context = sourceContext(actor.manager, actor.browsingContext);
    const uri = Services.io.newURI(snapshot.url);
    if (
      (!uri.schemeIs("http") && !uri.schemeIs("https")) ||
      uri.userPass ||
      uri.spec.length > 4096 ||
      typeof snapshot.title !== "string" ||
      !snapshot.title.trim() ||
      snapshot.title.length > 1000 ||
      typeof snapshot.description !== "string" ||
      snapshot.description.length > MAX_ITEM_DESCRIPTION_LENGTH
    ) {
      throw new Error("Invalid cached feed article");
    }
    const content =
      sanitizeFeedArticleContent(snapshot.content, uri.spec) ||
      snapshot.description
        .split(/\n+/)
        .filter(line => line.trim())
        .map(line => `<p>${escapeText(line)}</p>`)
        .join("");
    const textContent = new DOMParser().parseFromString(content, "text/html")
      .body.textContent;
    const article = {
      url: uri.spec,
      title: snapshot.title,
      byline:
        typeof snapshot.byline === "string"
          ? snapshot.byline.slice(0, 1000)
          : "",
      content,
      textContent,
      length: textContent.length,
      lang: null,
      detectedLanguage: null,
      dir: null,
    };
    lazy.ReaderMode._assignReadTime(article);

    let records = articlesByBrowser.get(context.browser);
    if (!records) {
      records = new Map();
      articlesByBrowser.set(context.browser, records);
    }
    for (const [token, record] of records) {
      if (record.expires <= Date.now() || !matchesContext(record, context)) {
        records.delete(token);
      }
    }
    const token = Services.uuid.generateUUID().toString();
    records.set(token, {
      ...context,
      article,
      expires: Date.now() + MAX_AGE_MS,
    });
    while (records.size > MAX_ARTICLES_PER_BROWSER) {
      records.delete(records.keys().next().value);
    }
    return (
      "about:feeds?view=reader&url=" +
      encodeURIComponent(article.url) +
      "&feedArticle=" +
      encodeURIComponent(token)
    );
  },

  getArticle(actor) {
    try {
      let record = getRecord(actor);
      if (!record) {
        const context = frameContext(actor);
        const url = new URL(actor.manager.documentURI.spec);
        const records = articlesByBrowser.get(context.browser);
        const token = url.searchParams.get("feedArticle");
        record = records?.get(token);
        if (
          !record ||
          record.expires <= Date.now() ||
          !matchesContext(record, context) ||
          url.searchParams.getAll("view").length !== 1 ||
          url.searchParams.getAll("feedArticle").length !== 1 ||
          url.searchParams.getAll("url").length !== 1 ||
          url.searchParams.get("url") !== record.article.url
        ) {
          return null;
        }
        records.delete(token);
        articlesByActor.set(actor, record);
      }
      return { ...record.article };
    } catch {
      return null;
    }
  },

  openLink(actor, value) {
    const record = getRecord(actor);
    if (!record || typeof value !== "string" || value.length > 4096) {
      return;
    }
    const uri = Services.io.newURI(value);
    if ((!uri.schemeIs("http") && !uri.schemeIs("https")) || uri.userPass) {
      return;
    }
    const principal = actor.manager.documentPrincipal;
    Services.scriptSecurityManager.checkLoadURIWithPrincipal(
      principal,
      uri,
      Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL
    );
    const referrerInfo = Cc["@mozilla.org/referrer-info;1"].createInstance(
      Ci.nsIReferrerInfo
    );
    referrerInfo.init(Ci.nsIReferrerInfo.EMPTY, false, null);
    record.browser.documentGlobal.openLinkIn(uri.spec, "tab", {
      triggeringPrincipal: principal,
      allowInheritPrincipal: false,
      referrerInfo,
      private: lazy.PrivateBrowsingUtils.isBrowserPrivate(record.browser),
      isContentWindowPrivate: record.isPrivate,
      userContextId: principal.originAttributes.userContextId,
    });
  },

  release(actor) {
    articlesByActor.delete(actor);
  },
};
