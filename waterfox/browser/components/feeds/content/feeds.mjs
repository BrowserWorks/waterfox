/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const byId = id => document.getElementById(id);
const pending = new Map();
const errors = new Set([
  "feeds-error-unavailable",
  "feeds-error-private",
  "feeds-error-invalid-request",
  "feeds-error-invalid-url",
  "feeds-error-busy",
  "feeds-error-not-found",
  "feeds-error-operation",
  "feeds-error-preview-expired",
  "feeds-reader-load-error",
  "feeds-error-retry-later",
  "feeds-error-saved-limit",
]);
const params = new URLSearchParams(location.search);
const direct = params.has("preview");
document.l10n.setAttributes(
  document.querySelector("title"),
  direct ? "feeds-direct-page-title" : "feeds-reader-page-title"
);
const restoredView = history.state?.feedView;
let initialSource = restoredView ? null : params.get("source");
let nextRequest = 0;
let active = true;
let busy = false;
let ready = false;
let updating = false;
let needsUpdate = false;
let feedModel = null;
let scope =
  restoredView?.scope ||
  (params.has("folder")
    ? { kind: "folder", guid: params.get("folder") }
    : { kind: params.get("view") === "saved" ? "saved" : "all" });
let loadGeneration = 0;
const articleSignatures = new WeakMap();
let sourceStructure = "";
let readerArticle = null;
let readerGeneration = 0;
let readerHistoryPending = false;

let directFeed = null;
let directCreatedGuid = null;
let visibleLimit = restoredView?.visibleLimit || 100;
let previewGeneration = 0;

function localize(node, id, args) {
  const current = document.l10n.getAttributes(node);
  if (
    current.id !== id ||
    JSON.stringify(current.args) !== JSON.stringify(args ?? null)
  ) {
    document.l10n.setAttributes(node, id, args);
  }
}

function setStatus(id) {
  localize(byId("status"), id);
}

function showError(error) {
  const target = byId("add-dialog").open ? byId("add-error") : byId("error");
  localize(
    target,
    errors.has(error?.message) ? error.message : "feeds-error-operation"
  );
  target.hidden = false;
}

function query(command, args = {}) {
  if (!active) {
    return Promise.reject(new DOMException("Page is inactive", "AbortError"));
  }
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    document.dispatchEvent(
      new CustomEvent("FeedPage:Request", {
        detail: JSON.stringify({ id, command, args }),
      })
    );
  });
}

document.addEventListener("FeedPage:Response", event => {
  let response;
  try {
    response = JSON.parse(event.detail);
  } catch {
    return;
  }
  const request = pending.get(response?.id);
  if (!request) {
    return;
  }
  pending.delete(response.id);
  if (response.result?.ok) {
    request.resolve(response.result.value);
  } else {
    request.reject(new Error(response.result?.error));
  }
});

function controls() {
  for (const button of document.querySelectorAll(
    '#article-list button[data-action="open"]'
  )) {
    button.disabled = !ready || busy;
  }
  byId("add-preview-button").disabled = !ready || busy;

  for (const button of document.querySelectorAll("[data-mutates]")) {
    button.disabled = !ready || busy || feedModel?.isPrivate;
  }
}

async function run(task) {
  if (busy || !active) {
    return;
  }
  busy = true;
  byId("error").hidden = true;
  byId("add-error").hidden = true;
  setStatus("feeds-status-working");
  controls();
  try {
    await task();
  } catch (error) {
    if (active && error.name !== "AbortError") {
      showError(error);
    }
  } finally {
    busy = false;
    controls();
    if (readerHistoryPending && active) {
      restoreReaderHistory();
    }
    if (needsUpdate) {
      scheduleUpdate();
    }
  }
}

function element(tag, className, value) {
  const result = document.createElement(tag);
  if (className) {
    result.className = className;
  }
  if (value !== undefined) {
    result.textContent = value;
  }
  return result;
}

function safeURL(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function setFeedIcon(node, siteURL) {
  const website = safeURL(siteURL);
  if (node.dataset.site === (website || "")) {
    return;
  }
  node.dataset.site = website || "";
  node.replaceChildren();
  if (website) {
    const image = element("img");
    image.alt = "";
    image.src = `page-icon:${website}`;
    image.addEventListener("error", () => image.remove(), { once: true });
    node.append(image);
  }
}

function keyFor(article) {
  return JSON.stringify([article.feedURL, article.id]);
}

function entries() {
  if (scope.kind === "saved") {
    return feedModel.savedArticles;
  }
  if (scope.kind === "all") {
    return feedModel.articles;
  }
  if (scope.kind === "source") {
    return feedModel.articles.filter(article => article.guid === scope.guid);
  }
  const guids = new Set(
    feedModel.subscriptions
      .filter(sub => sub.parentGuid === scope.guid)
      .map(sub => sub.guid)
  );
  return feedModel.articles.filter(article => guids.has(article.guid));
}

function visibleEntries() {
  const search = byId("article-search").value.trim().toLocaleLowerCase();
  const filter = feedModel.preferences.filter;
  const articles = entries().filter(
    article =>
      (scope.kind === "saved" || filter !== "unread" || !article.read) &&
      `${article.title} ${article.description} ${article.source}`
        .toLocaleLowerCase()
        .includes(search)
  );
  const order = feedModel.preferences.order === "oldest" ? 1 : -1;
  articles.sort((a, b) => {
    if (a.published == null) {
      return b.published == null ? 0 : 1;
    }
    if (b.published == null) {
      return -1;
    }
    return order * (a.published - b.published);
  });
  return articles;
}

function labelButton(id, action, article) {
  const button = element("button");
  button.type = "button";
  button.dataset.action = action;
  button.dataset.key = keyFor(article);
  localize(button, id);
  if (["read", "save"].includes(action)) {
    button.dataset.mutates = "";
  }
  if (action === "save") {
    button.classList.add("save-action");
    button.setAttribute("aria-pressed", article.saved);
  }
  return button;
}

function originalLink(article, label) {
  const link = element("a", "", label);
  link.href = safeURL(article.url) || "about:feeds";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  link.dataset.original = keyFor(article);
  return link;
}

function articleNode(article) {
  const row = element("li", `article-card${article.read ? "" : " unread"}`);
  row.dataset.key = keyFor(article);
  const heading = element("h4");
  if (feedModel.preferences.opening === "original") {
    heading.append(originalLink(article, article.title));
  } else {
    const openButton = element("button", "", article.title);
    openButton.type = "button";
    openButton.dataset.action = "open";
    openButton.dataset.key = keyFor(article);
    localize(openButton, "feeds-open-article", { title: article.title });
    heading.append(openButton);
  }
  const content = element("div", "article-content");
  const metadata = element("p", "article-meta secondary");
  const icon = element("span", "feed-icon");
  icon.setAttribute("aria-hidden", "true");
  setFeedIcon(
    icon,
    feedModel.subscriptions.find(sub => sub.guid === article.guid)?.siteURL
  );
  metadata.append(icon, element("span", "", article.source));
  if (Number.isFinite(article.published)) {
    const date = element("time");
    date.dateTime = new Date(article.published).toISOString();
    localize(date, "feeds-article-date", { date: article.published });
    metadata.append(date);
  }
  content.append(metadata, heading);
  if (article.description) {
    content.append(
      element("p", "entry-content", article.description.slice(0, 320))
    );
  }
  const read = labelButton(
    article.read ? "feeds-mark-unread-button" : "feeds-mark-read-button",
    "read",
    article
  );
  read.classList.add("read-indicator");
  row.append(
    read,
    content,
    labelButton(
      article.saved ? "feeds-unsave-button" : "feeds-save-button",
      "save",
      article
    )
  );
  return row;
}

function dayStart(timestamp) {
  const date = new Date(timestamp);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  ).getTime();
}

function dateGroup(article, today) {
  if (!Number.isFinite(article.published)) {
    return { key: "undated", id: "feeds-undated" };
  }
  const day = dayStart(article.published);
  if (day === today) {
    return { key: day, id: "feeds-today" };
  }
  if (day === dayStart(today - 1)) {
    return { key: day, id: "feeds-yesterday" };
  }
  return { key: day, id: "feeds-article-date", date: day };
}

function reconcileChildren(container, children) {
  let next = container.firstElementChild;
  for (const child of children) {
    if (child !== next) {
      if (child.isConnected && container.isConnected) {
        container.moveBefore(child, next);
      } else {
        container.insertBefore(child, next);
      }
    }
    next = child.nextElementSibling;
  }
  while (next) {
    const stale = next;
    next = next.nextElementSibling;
    stale.remove();
  }
}

function updateArticleNode(row, article) {
  row.classList.toggle("unread", !article.read);
  localize(
    row.querySelector('[data-action="read"]'),
    article.read ? "feeds-mark-unread-button" : "feeds-mark-read-button"
  );
  const save = row.querySelector('[data-action="save"]');
  localize(save, article.saved ? "feeds-unsave-button" : "feeds-save-button");
  save.setAttribute("aria-pressed", article.saved);
}

function renderEmptyCollection(items) {
  const empty = byId("empty");
  empty.hidden = !!items.length;
  const noSubscriptions = !feedModel.subscriptions.length;
  const searching = !!byId("article-search").value.trim();
  const emptyActions = {
    "empty-add": noSubscriptions && scope.kind !== "saved",
    "empty-all":
      !searching &&
      scope.kind !== "saved" &&
      !noSubscriptions &&
      feedModel.preferences.filter === "unread",
    "empty-clear": searching,
  };
  byId("empty-actions").hidden =
    !!items.length || !Object.values(emptyActions).some(Boolean);
  for (const [id, visible] of Object.entries(emptyActions)) {
    byId(id).hidden = !!items.length || !visible;
  }
  if (!items.length) {
    let message = "feeds-preview-empty";
    if (scope.kind === "saved") {
      message = "feeds-empty-saved";
    } else if (searching) {
      message = "feeds-empty-results";
    } else if (feedModel.preferences.filter === "unread") {
      message = "feeds-empty-unread";
    } else if (noSubscriptions) {
      message = "feeds-empty";
    }
    localize(empty, message);
  }
}

function renderCollection() {
  const focused = document.activeElement;
  const focusKey = focused.dataset.key;
  const focusAction = focused.dataset.action;
  const list = byId("article-list");
  const items = visibleEntries();
  const rows = new Map(
    [...list.querySelectorAll(".article-card")].map(row => [
      row.dataset.key,
      row,
    ])
  );
  const sections = new Map(
    [...list.children].map(section => [section.dataset.day, section])
  );
  const groups = new Map();
  const today = dayStart(Date.now());
  for (const article of items.slice(0, visibleLimit)) {
    const group = dateGroup(article, today);
    const day = String(group.key);
    if (!groups.has(day)) {
      let section = sections.get(day);
      if (!section) {
        section = element("li", "date-group");
        section.dataset.day = day;
        section.append(element("h3"), element("ol"));
      }
      localize(
        section.firstElementChild,
        group.id,
        group.date === undefined ? undefined : { date: group.date }
      );
      groups.set(day, { section, rows: [] });
    }
    const signature = JSON.stringify([
      article.title,
      article.url,
      article.description,
      article.source,
      article.published,
      feedModel.preferences.opening,
      feedModel.subscriptions.find(sub => sub.guid === article.guid)?.siteURL,
    ]);
    let row = rows.get(keyFor(article));
    if (!row || articleSignatures.get(row) !== signature) {
      row = articleNode(article);
      articleSignatures.set(row, signature);
    } else {
      updateArticleNode(row, article);
    }
    groups.get(day).rows.push(row);
  }
  for (const group of groups.values()) {
    reconcileChildren(group.section.lastElementChild, group.rows);
  }
  reconcileChildren(
    list,
    [...groups.values()].map(group => group.section)
  );
  byId("show-more").hidden = items.length <= visibleLimit;
  list.classList.toggle("grid", feedModel.preferences.display === "grid");
  if (focusKey && !focused.isConnected && list.contains(focused) === false) {
    const replacement = [...list.querySelectorAll("[data-key]")].find(
      node =>
        node.dataset.key === focusKey && node.dataset.action === focusAction
    );
    (replacement || byId("collection-title")).focus({ preventScroll: true });
  }
  let title = null;
  if (scope.kind === "saved") {
    title = "feeds-saved";
  } else if (scope.kind === "folder") {
    title = feedModel.folders.find(folder => folder.guid === scope.guid)?.title;
  } else if (scope.kind !== "all") {
    title = feedModel.subscriptions.find(sub => sub.guid === scope.guid)?.title;
  }
  if (scope.kind === "all" || scope.kind === "saved") {
    localize(
      byId("collection-title"),
      scope.kind === "saved" ? "feeds-saved" : "feeds-all"
    );
  } else {
    byId("collection-title").removeAttribute("data-l10n-id");
    byId("collection-title").textContent = title || "";
  }
  if (scope.kind === "all" && !byId("article-search").value.trim()) {
    localize(byId("collection-count"), "feeds-unread-count", {
      count: feedModel.articles.filter(article => !article.read).length,
      feeds: feedModel.subscriptions.length,
    });
  } else {
    localize(byId("collection-count"), "feeds-article-count", {
      count: items.length,
    });
  }
  byId("source-actions").hidden = scope.kind !== "source";
  const source =
    scope.kind === "source"
      ? feedModel.subscriptions.find(sub => sub.guid === scope.guid)
      : null;
  byId("source-url").hidden = !source;
  byId("source-health").hidden = !source;
  if (source) {
    byId("source-url").textContent = source.feedURL;
    localize(
      byId("source-health"),
      `feeds-health-${["idle", "loading", "ready", "error"].includes(source.status) ? source.status : "idle"}`
    );
    localize(byId("refresh-source"), "feeds-reload-button", { title });
    localize(byId("remove-source"), "feeds-remove-button", { title });
  }
  renderEmptyCollection(items);
  byId("filter-all").setAttribute(
    "aria-pressed",
    feedModel.preferences.filter !== "unread"
  );
  byId("filter-unread").setAttribute(
    "aria-pressed",
    feedModel.preferences.filter === "unread"
  );
  byId("order").value = feedModel.preferences.order;
  for (const display of ["list", "grid"]) {
    byId(`display-${display}`).setAttribute(
      "aria-pressed",
      feedModel.preferences.display === display
    );
  }
  for (const [id, selected] of [
    ["all-feeds", scope.kind !== "saved"],
    ["saved-feeds", scope.kind === "saved"],
    ["all-scope", scope.kind === "all"],
  ]) {
    if (selected) {
      byId(id).setAttribute("aria-current", "page");
    } else {
      byId(id).removeAttribute("aria-current");
    }
  }
  controls();
}

function renderSources() {
  const focused = document.activeElement;
  const { scope: focusedScope, guid: focusedGuid } = focused.dataset;
  const unreadBySource = new Map();
  for (const article of feedModel.articles) {
    if (!article.read) {
      unreadBySource.set(
        article.guid,
        (unreadBySource.get(article.guid) || 0) + 1
      );
    }
  }
  const unreadByFolder = new Map();
  for (const sub of feedModel.subscriptions) {
    unreadByFolder.set(
      sub.parentGuid,
      (unreadByFolder.get(sub.parentGuid) || 0) +
        (unreadBySource.get(sub.guid) || 0)
    );
  }
  const unreadTotal = [...unreadBySource.values()].reduce(
    (sum, count) => sum + count,
    0
  );
  byId("all-count").textContent = unreadTotal;
  localize(byId("all-scope"), "feeds-all-scope-button", { count: unreadTotal });
  const structure = JSON.stringify([
    feedModel.folders.map(folder => [folder.guid, folder.title]),
    feedModel.subscriptions.map(sub => [
      sub.guid,
      sub.parentGuid,
      sub.title,
      sub.feedURL,
      sub.siteURL,
    ]),
  ]);
  if (structure !== sourceStructure) {
    const fragment = document.createDocumentFragment();
    for (const folder of feedModel.folders) {
      const subscriptions = feedModel.subscriptions.filter(
        sub => sub.parentGuid === folder.guid
      );
      if (!subscriptions.length) {
        continue;
      }
      const row = element("li");
      const sources = element("ul", "folder-sources");
      for (const [item, kind, container] of [
        [folder, "folder", row],
        ...subscriptions.map(sub => [sub, "source", sources]),
      ]) {
        const button = element("button");
        button.type = "button";
        const count =
          (kind === "folder" ? unreadByFolder : unreadBySource).get(
            item.guid
          ) || 0;
        localize(button, "feeds-source-button", {
          title: item.title || item.feedURL,
          count,
        });
        button.append(
          element("span", "source-name", item.title || item.feedURL),
          element("span", "source-count", count)
        );
        button.lastElementChild.setAttribute("aria-hidden", "true");
        button.dataset.scope = kind;
        button.dataset.guid = item.guid;
        if (scope.kind === kind && scope.guid === item.guid) {
          button.setAttribute("aria-current", "page");
        }
        if (kind === "source") {
          const icon = element("span", "feed-icon");
          icon.setAttribute("aria-hidden", "true");
          setFeedIcon(icon, item.siteURL);
          button.prepend(icon);
          const sourceRow = element("li");
          sourceRow.append(button);
          container.append(sourceRow);
        } else {
          container.append(button);
        }
      }
      row.append(sources);
      fragment.append(row);
    }
    byId("folders").replaceChildren(fragment);
    sourceStructure = structure;
  }
  for (const button of byId("folders").querySelectorAll("button[data-scope]")) {
    const { scope: kind, guid } = button.dataset;
    const count =
      (kind === "folder" ? unreadByFolder : unreadBySource).get(guid) || 0;
    const counter = button.querySelector(".source-count");
    if (counter.textContent !== String(count)) {
      counter.textContent = count;
    }
    localize(button, "feeds-source-button", {
      title: button.querySelector(".source-name").textContent,
      count,
    });
    if (scope.kind === kind && scope.guid === guid) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }
  if (focusedScope && !focused.isConnected && document.hasFocus()) {
    const replacement = [...byId("folders").querySelectorAll("button")].find(
      button =>
        button.dataset.scope === focusedScope &&
        button.dataset.guid === focusedGuid
    );
    (replacement || byId("all-scope")).focus({ preventScroll: true });
  }
}

function updateArticleState(article, state) {
  const key = keyFor(article);
  for (const entry of [...feedModel.articles, ...feedModel.savedArticles]) {
    if (keyFor(entry) === key) {
      Object.assign(entry, state);
    }
  }
}

function render() {
  if (!feedModel) {
    return;
  }
  byId("private-notice").hidden = !feedModel.isPrivate;
  const saved = scope.kind === "saved";
  const reading = !!readerArticle;
  document.body.classList.toggle("saved-view", saved && !direct);
  document.body.classList.toggle("reader-mode", reading);
  document.querySelector(".rail").hidden = reading;
  byId("subscription-manager").hidden = direct || saved || reading;
  byId("collection").hidden = direct || reading;
  byId("reader").hidden = !reading;
  if (reading) {
    renderReaderState();
  } else if (!direct) {
    if (!saved) {
      renderSources();
    }
    renderCollection();
  }
  populateFolders();
  controls();
}

function populateFolders() {
  const select = byId("direct-folder");
  const selected = select.value;
  if (
    select.options.length === feedModel.folders.length &&
    feedModel.folders.every(
      (folder, index) =>
        select.options[index].value === folder.guid &&
        select.options[index].textContent === folder.title
    )
  ) {
    return;
  }
  select.replaceChildren(
    ...feedModel.folders.map(folder => {
      const option = element("option", "", folder.title);
      option.value = folder.guid;
      return option;
    })
  );
  if (feedModel.folders.some(folder => folder.guid === selected)) {
    select.value = selected;
  }
}

async function load() {
  const generation = ++loadGeneration;
  const nextModel = await query("List");
  if (!active || generation !== loadGeneration) {
    return;
  }
  const anchors =
    feedModel && window.scrollY > 0
      ? [...byId("article-list").querySelectorAll(".article-card")]
          .map(node => ({
            node,
            top: node.getBoundingClientRect().top,
            bottom: node.getBoundingClientRect().bottom,
          }))
          .filter(
            anchor => anchor.bottom > 0 && anchor.top < window.innerHeight
          )
      : [];
  feedModel = nextModel;
  ready = true;
  if (
    initialSource &&
    !direct &&
    feedModel.subscriptions.some(sub => sub.guid === initialSource)
  ) {
    scope = { kind: "source", guid: initialSource };
  }
  initialSource = null;
  if (
    scope.guid &&
    !feedModel.subscriptions.some(sub => sub.guid === scope.guid) &&
    !feedModel.folders.some(folder => folder.guid === scope.guid)
  ) {
    scope = { kind: "all" };
  }
  render();
  const scrollAfterRender = window.scrollY;
  await document.l10n.translateFragment(byId("collection"));
  if (
    active &&
    generation === loadGeneration &&
    window.scrollY === scrollAfterRender
  ) {
    const anchor = anchors.find(item => item.node.isConnected);
    if (anchor) {
      window.scrollBy(0, anchor.node.getBoundingClientRect().top - anchor.top);
    }
  }
}

function scheduleUpdate() {
  needsUpdate = true;
  if (updating || busy || !active) {
    return;
  }
  updating = true;
  needsUpdate = false;
  void load()
    .catch(error => {
      if (active && error.name !== "AbortError") {
        showError(error);
      }
    })
    .finally(() => {
      updating = false;
      if (needsUpdate) {
        scheduleUpdate();
      }
    });
}

document.addEventListener("FeedPage:Changed", scheduleUpdate);
window.addEventListener("pagehide", event => {
  if (!event.isTrusted) {
    return;
  }
  rememberView();
  active = false;
  ready = false;
  for (const request of pending.values()) {
    request.reject(new DOMException("Page is inactive", "AbortError"));
  }
  pending.clear();
});
window.addEventListener("pageshow", event => {
  if (event.isTrusted && event.persisted) {
    active = true;
    scheduleUpdate();
  }
});

function showScope(kind, guid) {
  if (direct) {
    location.href = kind === "saved" ? "about:feeds?view=saved" : "about:feeds";
    return;
  }
  scope = { kind, guid };
  visibleLimit = 100;
  rememberView();
  render();
  byId("collection-title").focus();
}

byId("all-feeds").addEventListener("click", () => showScope("all"));
byId("all-scope").addEventListener("click", () => showScope("all"));
byId("saved-feeds").addEventListener("click", () => showScope("saved"));
byId("folders").addEventListener("click", event => {
  const button = event.target.closest("button[data-scope]");
  if (button) {
    showScope(button.dataset.scope, button.dataset.guid);
  }
});

function rememberView() {
  if (!direct && !readerArticle) {
    history.replaceState(
      {
        ...history.state,
        feedView: {
          scope,
          search: byId("article-search").value,
          visibleLimit,
          scrollY: window.scrollY,
          focusKey: document.activeElement.dataset.key,
        },
      },
      ""
    );
  }
}

function renderReaderState() {
  const current = findArticle(keyFor(readerArticle));
  if (current) {
    readerArticle.read = current.read;
    readerArticle.saved = current.saved;
  }
  localize(
    byId("reader-read"),
    readerArticle.read ? "feeds-mark-unread" : "feeds-mark-read"
  );
  localize(
    byId("reader-save"),
    readerArticle.saved ? "feeds-reader-saved" : "feeds-reader-save"
  );
  byId("reader-save").setAttribute("aria-pressed", readerArticle.saved);
}

async function openReader(article, pushHistory = true) {
  const generation = ++readerGeneration;
  rememberView();
  const result = await query("OpenReader", {
    feedURL: article.feedURL,
    id: article.id,
  });
  if (!active || generation !== readerGeneration) {
    return;
  }
  updateArticleState(article, result.state);
  if (pushHistory) {
    history.pushState(
      {
        ...history.state,
        feedReader: {
          feedURL: article.feedURL,
          id: article.id,
        },
      },
      ""
    );
  }
  readerArticle = { ...article, ...result.state };
  byId("reader").setAttribute("aria-label", article.title);
  localize(byId("reader-back"), "feeds-back-to-collection", {
    title: byId("collection-title").textContent,
  });
  byId("reader-source").textContent = article.source;
  setFeedIcon(
    byId("reader").querySelector(".feed-icon"),
    feedModel.subscriptions.find(sub => sub.guid === article.guid)?.siteURL
  );
  const date = byId("reader-date");
  date.hidden = !Number.isFinite(article.published);
  if (!date.hidden) {
    date.dateTime = new Date(article.published).toISOString();
    localize(date, "feeds-article-date", { date: article.published });
  }
  byId("reader-original").href = article.url;
  const frame = document.createElement("iframe");
  frame.id = "reader-frame";
  frame.title = article.title;
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.src = result.readerURL;
  frame.addEventListener(
    "load",
    () => {
      if (!active || generation !== readerGeneration || !frame.isConnected) {
        return;
      }
      const doc = frame.contentDocument;
      if (!doc || doc.documentURI !== result.readerURL) {
        showError(new Error("feeds-reader-load-error"));
        return;
      }
      const updateStatus = () => {
        if (!active || generation !== readerGeneration || !frame.isConnected) {
          return;
        }
        if (doc.documentElement.dataset.isError === "true") {
          showError(new Error("feeds-reader-load-error"));
        } else if (doc.body.classList.contains("loaded")) {
          setStatus("feeds-status-ready");
        }
      };
      doc.addEventListener("AboutReaderContentReady", updateStatus, {
        once: true,
      });
      doc.addEventListener("AboutReaderContentError", updateStatus, {
        once: true,
      });
      updateStatus();
    },
    { once: true }
  );
  setStatus("feeds-status-loading");
  byId("reader-frame-container").replaceChildren(frame);
  render();
  window.scrollTo(0, 0);
  byId("reader-back").focus({ preventScroll: true });
}

function enterReader(article) {
  void run(() => openReader(article));
}

function leaveReader() {
  ++readerGeneration;
  const focusKey = readerArticle && keyFor(readerArticle);
  readerArticle = null;
  byId("reader-frame-container").replaceChildren();
  render();
  const view = history.state?.feedView;
  const row = [...byId("article-list").querySelectorAll(".article-card")].find(
    node => node.dataset.key === (focusKey || view?.focusKey)
  );
  (row?.querySelector("h4 button, h4 a") || byId("collection-title")).focus({
    preventScroll: true,
  });
  window.scrollTo(0, view?.scrollY || 0);
}

byId("reader-back").addEventListener("click", () => {
  if (history.state?.feedReader) {
    history.back();
  } else {
    leaveReader();
  }
});
function restoreReaderHistory() {
  readerHistoryPending = busy;
  if (busy) {
    return;
  }
  const target = history.state?.feedReader;
  const article =
    target && findArticle(JSON.stringify([target.feedURL, target.id]));
  if (article) {
    void run(() => openReader(article, false));
  } else {
    leaveReader();
  }
}
window.addEventListener("popstate", () => {
  ++readerGeneration;
  restoreReaderHistory();
});
for (const [id, command, field] of [
  ["reader-read", "MarkRead", "read"],
  ["reader-save", "Save", "saved"],
]) {
  byId(id).addEventListener("click", () => {
    if (!readerArticle) {
      return;
    }
    const article = readerArticle;
    void run(async () => {
      const state = await query(command, {
        feedURL: article.feedURL,
        id: article.id,
        [field]: !article[field],
      });
      Object.assign(article, state);
      updateArticleState(article, state);
      await load();
      setStatus("feeds-status-ready");
    });
  });
}

function findArticle(key) {
  return [...feedModel.articles, ...feedModel.savedArticles].find(
    article => keyFor(article) === key
  );
}

byId("article-list").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) {
    return;
  }
  const article = findArticle(button.dataset.key);
  if (!article) {
    return;
  }
  if (button.dataset.action === "open") {
    enterReader(article);
  } else {
    void run(async () => {
      const change =
        button.dataset.action === "read"
          ? {
              command: "MarkRead",
              args: {
                feedURL: article.feedURL,
                id: article.id,
                read: !article.read,
              },
            }
          : {
              command: "Save",
              args: {
                feedURL: article.feedURL,
                id: article.id,
                saved: !article.saved,
              },
            };
      const state = await query(change.command, change.args);
      updateArticleState(article, state);
      await load();
      setStatus("feeds-status-ready");
    });
  }
});

for (const [id, value] of [
  ["filter-all", "all"],
  ["filter-unread", "unread"],
]) {
  byId(id).addEventListener("click", () => setPresentation("filter", value));
}
function setPresentation(preferenceName, value) {
  if (feedModel.isPrivate) {
    feedModel.preferences[preferenceName] = value;
    renderCollection();
    return;
  }
  void run(async () => {
    feedModel.preferences = await query("SetPreference", {
      name: preferenceName,
      value,
    });
    render();
  });
}
byId("order").addEventListener("change", event =>
  setPresentation("order", event.target.value)
);
for (const display of ["list", "grid"]) {
  byId(`display-${display}`).addEventListener("click", () =>
    setPresentation("display", display)
  );
}
byId("article-search").addEventListener("input", () => {
  visibleLimit = 100;
  renderCollection();
});
byId("empty-add").addEventListener("click", () => byId("add-feed").click());
byId("empty-clear").addEventListener("click", () => {
  byId("article-search").value = "";
  byId("article-search").focus();
  renderCollection();
});
byId("empty-all").addEventListener("click", () => byId("filter-all").click());
byId("show-more").addEventListener("click", () => {
  const previousLimit = visibleLimit;
  visibleLimit += 100;
  renderCollection();
  byId("article-list")
    .querySelectorAll(".article-card")
    [previousLimit]?.querySelector("h4 button, h4 a")
    ?.focus();
});

for (const [buttonId, command] of [
  ["refresh-source", "Refresh"],
  ["remove-source", "Remove"],
]) {
  byId(buttonId).addEventListener("click", () => {
    if (scope.kind !== "source" || feedModel.isPrivate) {
      return;
    }
    const { guid } = scope;
    void run(async () => {
      await query(command, { guid });
      await load();
      setStatus(
        command === "Remove" ? "feeds-status-removed" : "feeds-status-reloaded"
      );
    });
  });
}

function previewItems(items, listId) {
  const list = byId(listId);
  list.replaceChildren(
    ...items.map(item => {
      const row = element("li");
      const url = safeURL(item.url);
      if (url) {
        const link = element("a", "", item.title);
        link.href = url;
        link.rel = "noopener noreferrer";
        link.referrerPolicy = "no-referrer";
        row.append(link);
      } else {
        row.append(element("span", "", item.title));
      }
      if (Number.isFinite(item.published)) {
        const date = element("time", "secondary");
        date.dateTime = new Date(item.published).toISOString();
        localize(date, "feeds-article-date", { date: item.published });
        row.prepend(date);
      }
      if (item.description) {
        row.append(element("p", "entry-content", item.description));
      }
      return row;
    })
  );
}

function fillPreview(preview) {
  const title = byId("direct-title");
  title.removeAttribute("data-l10n-id");
  title.textContent = preview.title;
  byId("direct-destination").hidden = true;
  byId("direct-open").hidden = true;
  byId("direct-undo").hidden = true;
  byId("direct-url").textContent = preview.feedURL;
  byId("direct-empty").hidden = preview.items.length !== 0;
  byId("direct-description").textContent = preview.description;
  previewItems(preview.items, "direct-items");
  const website = safeURL(preview.siteURL);
  setFeedIcon(document.querySelector(".preview-icon"), website);
  byId("direct-site").textContent = website ? new URL(website).hostname : "";
  byId("direct-visit").hidden = !website;
  if (website) {
    byId("direct-visit").href = website;
  }
  updateDirectState(!!preview.existingGuid);
  byId("direct-name").value = preview.title;
  byId("direct-form").hidden = !!preview.existingGuid;
  if (preview.existingGuid) {
    byId("direct-open").hidden = false;
    showDestination("direct", preview.existingGuid);
  }
}

function updateDirectState(subscribed) {
  localize(
    byId("direct-state"),
    subscribed
      ? "feeds-preview-state-subscribed"
      : "feeds-preview-state-unsubscribed"
  );
  document
    .querySelector(".preview-sidebar")
    .classList.toggle("subscribed", subscribed);
  localize(
    byId("direct-form-title"),
    subscribed ? "feeds-subscribed-heading" : "feeds-subscribe-preview-heading"
  );
}

function showDestination(prefix, guid) {
  const sub = feedModel.subscriptions.find(item => item.guid === guid);
  const folder = feedModel.folders.find(item => item.guid === sub?.parentGuid);
  const destination = byId(`${prefix}-destination`);
  destination.hidden = !folder;
  if (folder) {
    destination.textContent = folder.title;
  }
  if (prefix === "direct" && guid) {
    byId("direct-open").href = `about:feeds?source=${encodeURIComponent(guid)}`;
  }
}

byId("add-feed").addEventListener("click", () => {
  previewGeneration++;
  byId("add-error").hidden = true;
  byId("add-loading").hidden = true;
  byId("add-url").value = "";
  byId("add-form").hidden = false;
  byId("add-dialog").showModal();
  byId("add-url").focus();
});
byId("add-close").addEventListener("click", () => byId("add-dialog").close());
byId("add-dialog").addEventListener("close", () => {
  previewGeneration++;
  if (document.hasFocus()) {
    byId("add-feed").focus();
  }
});
byId("add-cancel").addEventListener("click", () => byId("add-dialog").close());
byId("add-form").addEventListener("submit", event => {
  event.preventDefault();
  const url = byId("add-url").value.trim();
  if (!safeURL(url)) {
    showError(new Error("feeds-error-invalid-url"));
    return;
  }
  const generation = ++previewGeneration;
  void run(async () => {
    byId("add-loading").hidden = false;
    try {
      const preview = await query("PreviewURL", { feedURL: url });
      if (generation !== previewGeneration || !byId("add-dialog").open) {
        return;
      }
      location.href = preview.previewURL;
    } finally {
      byId("add-loading").hidden = true;
    }
  });
});

byId("direct-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!directFeed || feedModel.isPrivate) {
    return;
  }
  void run(async () => {
    const sub = await query("Create", {
      feedURL: directFeed.feedURL,
      title: byId("direct-name").value,
      parentGuid: byId("direct-folder").value,
    });
    byId("direct-form").hidden = true;
    byId("direct-open").hidden = false;
    directCreatedGuid = sub.created ? sub.guid : null;
    directFeed.existingGuid = sub.guid;
    byId("direct-undo").hidden = !directCreatedGuid;
    updateDirectState(true);
    await load();
    showDestination("direct", sub.guid);
    byId("direct-open").focus();
  });
});

byId("direct-undo").addEventListener("click", () => {
  if (!directCreatedGuid) {
    return;
  }
  void run(async () => {
    await query("Remove", { guid: directCreatedGuid });
    directCreatedGuid = null;
    directFeed.existingGuid = null;
    byId("direct-form").hidden = false;
    byId("direct-destination").hidden = true;
    byId("direct-open").hidden = true;
    byId("direct-undo").hidden = true;
    updateDirectState(false);
    await load();
    setStatus("feeds-status-removed");
    byId("direct-name").focus();
  });
});

document.addEventListener("click", event => {
  const link = event.target.closest("a[data-original]");
  if (!link || event.defaultPrevented || event.button !== 0) {
    return;
  }
  const article = findArticle(link.dataset.original);
  if (!article || article.read || feedModel.isPrivate || busy) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    void query("MarkRead", {
      feedURL: article.feedURL,
      id: article.id,
      read: true,
    });
    return;
  }
  event.preventDefault();
  const destination = link.href;
  void run(async () => {
    try {
      await query("MarkRead", {
        feedURL: article.feedURL,
        id: article.id,
        read: true,
      });
    } finally {
      location.assign(destination);
    }
  });
});

if (direct) {
  document.body.classList.add("direct-preview");
  byId("all-feeds").setAttribute("aria-current", "page");
  byId("subscription-manager").hidden = true;
  byId("collection").hidden = true;
  byId("direct-preview").hidden = false;
}
if (!direct && scope.kind === "saved") {
  document.body.classList.add("saved-view");
  byId("subscription-manager").hidden = true;
  localize(byId("collection-title"), "feeds-saved");
}
if (restoredView && !direct) {
  byId("article-search").value = restoredView.search || "";
}
void run(async () => {
  await load();
  if (restoredView && !direct) {
    const article = [
      ...byId("article-list").querySelectorAll(".article-card"),
    ].find(row => row.dataset.key === restoredView.focusKey);
    article?.querySelector("h4 button, h4 a")?.focus({ preventScroll: true });
    window.scrollTo(0, restoredView.scrollY || 0);
  }
  const target = history.state?.feedReader;
  if (target && !direct) {
    const article = findArticle(JSON.stringify([target.feedURL, target.id]));
    if (article) {
      await openReader(article, false);
    }
  }
  if (direct) {
    directFeed = await query("DirectPreview");
    fillPreview(directFeed);
    byId("direct-preview").hidden = false;
    if (document.hasFocus()) {
      byId(directFeed.existingGuid ? "direct-open" : "direct-name").focus();
    }
  }
  if (!readerArticle) {
    setStatus(direct ? "feeds-status-direct-preview" : "feeds-status-ready");
  }
});
