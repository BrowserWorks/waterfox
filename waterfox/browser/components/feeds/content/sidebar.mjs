/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { LiveBookmarks } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarks.sys.mjs"
);
const { FeedReaderState } = ChromeUtils.importESModule(
  "resource:///modules/FeedReaderState.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
);
const { BrowserUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/BrowserUtils.sys.mjs"
);

const browserWindow = window.browsingContext.topChromeWindow;
const isPrivate = PrivateBrowsingUtils.isWindowPrivate(browserWindow);
const topics = [
  "waterfox-live-bookmarks-changed",
  "waterfox-feed-reader-state-changed",
];

const listeners = new AbortController();
const expanded = new Set();
const limits = new Map();
const PAGE_SIZE = 50;
const faviconCache = new Map();
let active = true;
let ready = false;
let refreshing = false;
let unreadOnly = false;
let scheduled = false;
let updatePending = false;
let generation = 0;
let renderGeneration = 0;

let sources = [];

function byId(id) {
  return document.getElementById(id);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function localize(node, id, args) {
  document.l10n.setAttributes(node, id, args);
  return node;
}

function safeURL(value) {
  const url = URL.parse(value);
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return null;
  }
  return url.href;
}

function setFavicon(image, pageURL, fallback) {
  const page = safeURL(pageURL);
  image.alt = "";
  image.dataset.page = page || "";
  image.dataset.fallback = fallback;
  if (!image.hasAttribute("src")) {
    image.src = fallback;
  }
  const token = {};
  image._faviconRequest = token;
  if (!page) {
    image.src = fallback;
    return;
  }
  if (!faviconCache.has(page)) {
    faviconCache.set(
      page,
      Promise.resolve()
        .then(() =>
          PlacesUtils.favicons.getFaviconForPage(Services.io.newURI(page), 16)
        )
        .then(icon => icon?.dataURI.spec || null)
        .catch(() => null)
    );
  }
  faviconCache.get(page).then(src => {
    if (active && image.isConnected && image._faviconRequest === token) {
      image.src = src || fallback;
    }
  });
}

function onFaviconChanged(events) {
  const hosts = new Set(
    events.map(event => URL.parse(event.url)?.host).filter(Boolean)
  );
  for (const page of faviconCache.keys()) {
    if (hosts.has(URL.parse(page)?.host)) {
      faviconCache.delete(page);
    }
  }
  for (const image of document.querySelectorAll("img[data-page]")) {
    if (hosts.has(URL.parse(image.dataset.page)?.host)) {
      setFavicon(image, image.dataset.page, image.dataset.fallback);
    }
  }
}

function showError(error) {
  if (!active) {
    return;
  }
  console.error("Could not update the feeds sidebar", error);
  localize(
    byId("error"),
    error?.name === "LiveBookmarksStorageError"
      ? "feeds-sidebar-storage-error"
      : "feeds-sidebar-error"
  );
  byId("error").hidden = false;
}

function updateRefresh() {
  const button = byId("refresh");
  button.disabled = !ready || isPrivate || refreshing || !sources.length;
  button.classList.toggle("refreshing", refreshing);
  byId("subscriptions").setAttribute("aria-busy", String(refreshing));
}

async function load() {
  const current = ++generation;
  const subscriptions = LiveBookmarks.list();
  const folders = new Map();
  const next = await Promise.all(
    subscriptions.map(async sub => {
      const folder = await PlacesUtils.bookmarks.fetch(sub.guid);
      if (!folder) {
        return null;
      }
      if (!folders.has(folder.parentGuid)) {
        folders.set(
          folder.parentGuid,
          PlacesUtils.bookmarks.fetch(folder.parentGuid)
        );
      }
      const parentFolder = await folders.get(folder.parentGuid);
      const items = (LiveBookmarks.cachedFeed(sub.guid)?.items || [])
        .filter(
          item =>
            typeof item.id === "string" &&
            !!item.id.length &&
            item.id.length <= 1000 &&
            !/\p{Cc}/u.test(item.id) &&
            safeURL(item.url)
        )
        .map(item => ({
          ...item,
          ...FeedReaderState.get(sub.feedURL, item.id),
        }));
      return {
        ...sub,
        parentGuid: folder.parentGuid,
        parentTitle: parentFolder
          ? PlacesUtils.bookmarks.getLocalizedTitle(parentFolder)
          : "",
        items,
        status: LiveBookmarks.peek(sub.guid)?.status,
        unread: items.filter(item => !item.read).length,
      };
    })
  );
  if (!active || generation !== current) {
    return;
  }
  sources = next
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.parentTitle.localeCompare(b.parentTitle) ||
        a.title.localeCompare(b.title)
    );
  render();
  updateRefresh();
}

function scheduleUpdate() {
  if (!active) {
    return;
  }
  if (!ready) {
    updatePending = true;
    return;
  }
  if (scheduled) {
    return;
  }
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (active) {
      load().catch(showError);
    }
  });
}

function articleList(entries, key, showSource = false) {
  const list = element("ul", "article-list");
  const limit = limits.get(key) || PAGE_SIZE;
  for (const { sub, item } of entries.slice(0, limit)) {
    const row = element("li", "article-row");
    const link = element("a", "article-link");
    const icon = element("img", "article-icon");
    setFavicon(icon, item.url, "chrome://global/skin/icons/defaultFavicon.svg");
    const text = element("span", "article-text");
    const titleText = item.title || item.url;
    const title = element("span", "article-title", titleText);
    title.dir = "auto";
    text.appendChild(title);
    link.append(icon, text);
    link.href = safeURL(item.url);
    link.dataset.guid = sub.guid;
    link.dataset.id = item.id;
    link.dataset.read = String(item.read);
    localize(
      link,
      item.read ? "feeds-sidebar-article-read" : "feeds-sidebar-article-unread"
    );
    link.dataset.focus = JSON.stringify([sub.guid, item.id, "open"]);
    link.title = `${titleText}\n${item.url}`;
    link.setAttribute("referrerpolicy", "no-referrer");
    link.setAttribute("rel", "noopener noreferrer");
    if (showSource) {
      text.appendChild(element("span", "article-source", sub.title));
    }
    row.appendChild(link);
    const read = element("moz-button");
    read.type = "icon ghost";
    read.setAttribute(
      "iconsrc",
      item.read
        ? "chrome://global/skin/icons/eye-slash.svg"
        : "chrome://global/skin/icons/eye.svg"
    );
    read.dataset.action = "read";
    read.dataset.guid = sub.guid;
    read.dataset.id = item.id;
    read.dataset.focus = JSON.stringify([sub.guid, item.id, "read"]);
    read.disabled = isPrivate;
    localize(
      read,
      item.read ? "feeds-sidebar-mark-unread" : "feeds-sidebar-mark-read",
      { title: titleText }
    );
    row.appendChild(read);
    list.appendChild(row);
  }
  if (entries.length > limit) {
    const row = element("li");
    const more = element("moz-button");
    more.appendChild(localize(element("span"), "feeds-show-more"));
    more.dataset.focus = `more-${key}`;
    more.addEventListener("click", () => {
      limits.set(key, limit + PAGE_SIZE);
      const firstNew = entries[limit];
      render(JSON.stringify([firstNew.sub.guid, firstNew.item.id, "open"]));
    });
    row.appendChild(more);
    list.appendChild(row);
  }
  return list;
}

function fillFeed(details, sub, items) {
  details.querySelector(".feed-content")?.remove();
  if (!details.open) {
    return;
  }
  const content = element("div", "feed-content");
  if (items.length) {
    content.appendChild(
      articleList(
        items.map(item => ({ sub, item })),
        sub.guid
      )
    );
  }
  if (!items.length || sub.status === "error" || sub.status === "loading") {
    let message = "feeds-preview-empty";
    if (sub.status === "error") {
      message = "feeds-health-error";
    } else if (sub.status === "loading") {
      message = "feeds-health-loading";
    }
    content.appendChild(localize(element("p", "feed-status"), message));
  }

  details.appendChild(content);
}

function render(preferredFocus = null) {
  const currentRender = ++renderGeneration;
  const container = byId("subscriptions");
  const focused = document.activeElement;
  const focusKey =
    preferredFocus || (document.hasFocus() && focused?.dataset.focus);
  const fallbackKeys = [];
  if (focusKey && !preferredFocus) {
    const selector =
      focused.dataset.action === "read" ? '[data-action="read"]' : "a[data-id]";
    const controls = Array.from(container.querySelectorAll(selector));
    const index = controls.indexOf(focused);
    if (index !== -1) {
      fallbackKeys.push(
        ...controls.slice(index + 1).map(node => node.dataset.focus)
      );
      fallbackKeys.push(
        ...controls
          .slice(0, index)
          .reverse()
          .map(node => node.dataset.focus)
      );
    }
    const guid =
      focused.dataset.guid || focused.closest("details")?.dataset.guid;
    if (guid) {
      fallbackKeys.push(`feed-${guid}`);
    }
  }
  const query = byId("search").value.trim().toLocaleLowerCase();
  byId("unread").setAttribute("aria-pressed", String(unreadOnly));
  byId("unread").ariaPressed = String(unreadOnly);
  byId("unread").type = unreadOnly ? "primary" : "ghost";
  const filtered = sources.map(sub => ({
    sub,
    items: sub.items.filter(
      item =>
        (!unreadOnly || !item.read) &&
        (!query ||
          `${sub.title} ${item.title}`.toLocaleLowerCase().includes(query))
    ),
  }));
  const fragment = document.createDocumentFragment();
  if (unreadOnly) {
    const entries = filtered.flatMap(({ sub, items }) =>
      items.map(item => ({ sub, item }))
    );
    entries.sort((a, b) => (b.item.published || 0) - (a.item.published || 0));
    fragment.appendChild(articleList(entries, "unread", true));
  } else {
    const groups = new Map();
    for (const { sub, items } of filtered) {
      if (
        query &&
        !items.length &&
        !sub.title.toLocaleLowerCase().includes(query)
      ) {
        continue;
      }
      if (!groups.has(sub.parentGuid)) {
        const section = element("section");
        const heading = element("h2", "folder-heading", sub.parentTitle);
        heading.id = `folder-${sub.parentGuid}`;
        heading.hidden = [
          PlacesUtils.bookmarks.menuGuid,
          PlacesUtils.bookmarks.toolbarGuid,
          PlacesUtils.bookmarks.unfiledGuid,
          PlacesUtils.bookmarks.mobileGuid,
        ].includes(sub.parentGuid);
        section.setAttribute("aria-labelledby", heading.id);
        section.appendChild(heading);
        groups.set(sub.parentGuid, section);
        fragment.appendChild(section);
      }
      const details = element("details", "feed");
      details.dataset.guid = sub.guid;
      details.open = expanded.has(sub.guid) || !!query;
      const summary = element("summary");
      summary.dataset.focus = `feed-${sub.guid}`;
      const heading = element("span", "feed-heading");
      const icon = element("img", "feed-icon");
      setFavicon(
        icon,
        safeURL(sub.siteURL) || sub.feedURL,
        "chrome://browser/content/feeds/feed.svg"
      );
      heading.append(icon, element("span", "feed-title", sub.title));
      const count = element("span", "unread-count", String(sub.unread));
      count.dataset.count = String(sub.unread);
      count.setAttribute("aria-hidden", "true");
      heading.appendChild(count);
      summary.appendChild(heading);
      localize(summary, "feeds-sidebar-source", {
        title: sub.title,
        count: sub.unread,
      });
      details.appendChild(summary);
      fillFeed(details, sub, items);
      let wasOpen = details.open;
      details.addEventListener("toggle", () => {
        if (!active || !details.isConnected || wasOpen === details.open) {
          return;
        }
        wasOpen = details.open;
        if (details.open) {
          expanded.add(sub.guid);
        } else {
          expanded.delete(sub.guid);
        }
        fillFeed(details, sub, items);
      });
      groups.get(sub.parentGuid).appendChild(details);
    }
  }
  container.replaceChildren(fragment);
  const hasResults = unreadOnly
    ? filtered.some(({ items }) => items.length)
    : !!container.querySelector("details");
  const empty = byId("empty");
  empty.hidden = hasResults;
  let emptyMessage = "feeds-empty-unread";
  if (!sources.length) {
    emptyMessage = "feeds-empty";
  } else if (query) {
    emptyMessage = "feeds-empty-results";
  }
  localize(empty, emptyMessage);

  if (focusKey) {
    restoreFocus([focusKey, ...fallbackKeys], currentRender);
  }
}

async function restoreFocus(keys, currentRender) {
  const controls = new Map(
    Array.from(byId("subscriptions").querySelectorAll("[data-focus]"), node => [
      node.dataset.focus,
      node,
    ])
  );
  const target =
    keys.map(key => controls.get(key)).find(Boolean) || byId("unread");
  await target.updateComplete;
  if (
    active &&
    currentRender === renderGeneration &&
    (document.activeElement === document.body ||
      document.activeElement === target)
  ) {
    target.focus();
  }
}

function openReader() {
  browserWindow.openTrustedLinkIn("about:feeds", "tab");
}

function handleArticle(event) {
  const link = event.target.closest("a[data-id]");
  const read = event.target.closest('[data-action="read"]');
  const target = link || read;
  if (
    !target ||
    (event.type === "auxclick" ? event.button !== 1 : event.button > 0)
  ) {
    return;
  }
  event.preventDefault();
  const sub = sources.find(source => source.guid === target.dataset.guid);
  const item = sub?.items.find(entry => entry.id === target.dataset.id);
  const url = item && safeURL(item.url);
  if (!url) {
    return;
  }
  if (link) {
    const referrerInfo = Cc["@mozilla.org/referrer-info;1"].createInstance(
      Ci.nsIReferrerInfo
    );
    referrerInfo.init(Ci.nsIReferrerInfo.EMPTY, false, null);
    let where = BrowserUtils.whereToOpenLink(event, false, true);
    if (where === "current") {
      where = "tab";
    }
    browserWindow.openWebLinkIn(url, where, {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal(
        {}
      ),
      allowInheritPrincipal: false,
      referrerInfo,
    });
  }
  if (!isPrivate) {
    FeedReaderState.setRead(sub.feedURL, item.id, link ? true : !item.read);
  }
}

async function refresh() {
  if (isPrivate || !ready || refreshing) {
    return;
  }
  refreshing = true;
  byId("error").hidden = true;

  updateRefresh();
  try {
    const results = await Promise.allSettled(
      sources.map(sub => LiveBookmarks.refresh(sub.guid, { force: true }))
    );
    if (active) {
      await load();
      const failure = results.find(result => result.status === "rejected");
      if (failure) {
        showError(failure.reason);
      }
    }
  } finally {
    refreshing = false;
    if (active) {
      updateRefresh();
    }
  }
}

byId("private-notice").hidden = !isPrivate;
byId("open-reader").addEventListener("click", openReader);
byId("search").addEventListener("input", () => {
  limits.clear();
  render();
});
byId("unread").addEventListener("click", () => {
  unreadOnly = !unreadOnly;
  render();
});
byId("refresh").addEventListener("click", () => refresh().catch(showError));
byId("subscriptions").addEventListener("click", handleArticle);
byId("subscriptions").addEventListener("auxclick", handleArticle);
const observer = { observe: scheduleUpdate };
for (const topic of topics) {
  Services.obs.addObserver(observer, topic);
}
PlacesUtils.observers.addListener(["favicon-changed"], onFaviconChanged);
window.addEventListener(
  "unload",
  () => {
    active = false;
    generation++;
    listeners.abort();
    PlacesUtils.observers.removeListener(["favicon-changed"], onFaviconChanged);
    faviconCache.clear();
    for (const topic of topics) {
      Services.obs.removeObserver(observer, topic);
    }
  },
  { once: true }
);
window.addEventListener(
  "SidebarFocused",
  async () => {
    await byId("search").updateComplete;
    if (active) {
      byId("search").focus();
    }
  },
  { signal: listeners.signal }
);

try {
  await Promise.all([LiveBookmarks.init(), FeedReaderState.init()]);
  if (active) {
    do {
      updatePending = false;
      await load();
    } while (active && updatePending);
    if (active) {
      ready = true;
      byId("recovery-notice").hidden = !LiveBookmarks.recovery;
      updateRefresh();
    }
  }
} catch (error) {
  if (active) {
    byId("empty").hidden = true;
    showError(error);
  }
} finally {
  if (active) {
    document.body.dataset.ready = "true";
  }
}
