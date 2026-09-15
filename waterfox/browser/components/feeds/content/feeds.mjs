/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const byId = id => document.getElementById(id);
const pending = new Map();
const errorIds = new Set([
  "feeds-error-unavailable",
  "feeds-error-private",
  "feeds-error-invalid-request",
  "feeds-error-invalid-url",
  "feeds-error-busy",
  "feeds-error-not-found",
  "feeds-error-operation",
  "feeds-error-not-active",
  "feeds-error-invalid-opml",
  "feeds-error-file-too-large",
]);
let nextRequest = 0;
let pageGeneration = 0;
let pageActive = true;
let ready = false;
let busy = false;
let backgroundUpdate = null;
let isPrivate = true;
let needsUpdate = false;
let previewGuid = null;
let previewItemsKey = null;
let completionFocus = null;
let focusGeneration = 0;

function recordFocusChange() {
  focusGeneration++;
}

document.addEventListener("focusin", recordFocusChange);
document.addEventListener("pointerdown", recordFocusChange);
document.addEventListener("keydown", event => {
  if (event.key === "Tab") {
    recordFocusChange();
  }
});
window.addEventListener("blur", recordFocusChange);

function localize(element, id, args) {
  document.l10n.setAttributes(element, id, args);
}

function setStatus(id, args) {
  byId("status").hidden = false;
  localize(byId("status"), id, args);
}

function showError(id) {
  byId("status").hidden = true;
  byId("error").hidden = false;
  localize(byId("error"), errorIds.has(id) ? id : "feeds-error-operation");
}

function inactivePageError() {
  return new DOMException("The feed page is no longer active", "AbortError");
}

function query(command, args = {}) {
  if (!pageActive) {
    return Promise.reject(inactivePageError());
  }
  const generation = pageGeneration;
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    document.dispatchEvent(
      new CustomEvent("FeedPage:Request", {
        detail: JSON.stringify({ id, command, args }),
      })
    );
  }).then(value => {
    if (!pageActive || generation !== pageGeneration) {
      throw inactivePageError();
    }
    return value;
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

function updateButton(button) {
  button.disabled =
    !ready || busy || (isPrivate && button.hasAttribute("data-mutates"));
}

function updateControls() {
  byId("subscribe-fields").disabled = !ready || busy || isPrivate;
  for (const button of document.querySelectorAll("button")) {
    updateButton(button);
  }
}

async function run(task, restoreFocus = true) {
  if (busy || !pageActive) {
    return;
  }
  const generation = pageGeneration;
  restoreFocus &&= document.hasFocus();
  const focused = document.activeElement;
  const row = focused.closest(".subscription");
  const rows = [...byId("subscriptions").children];
  const rowIndex = rows.indexOf(row);
  const action = focused.dataset.action;
  busy = true;
  if (backgroundUpdate) {
    backgroundUpdate = null;
    needsUpdate = true;
  }
  completionFocus = null;
  byId("error").hidden = true;
  setStatus(ready ? "feeds-status-working" : "feeds-status-loading");
  updateControls();
  const focusVersion = focusGeneration;
  try {
    await task();
  } catch (error) {
    if (
      pageActive &&
      generation === pageGeneration &&
      error.name !== "AbortError"
    ) {
      showError(error.message);
    }
  } finally {
    if (pageActive && generation === pageGeneration) {
      busy = false;
      updateControls();
      if (
        restoreFocus &&
        document.hasFocus() &&
        focusVersion === focusGeneration &&
        (document.activeElement === focused ||
          document.activeElement === document.body)
      ) {
        const newRows = [...byId("subscriptions").children];
        const newRow =
          newRows.find(item => item.dataset.guid === row?.dataset.guid) ||
          newRows[Math.min(rowIndex, newRows.length - 1)];
        const button = newRow
          ? [...newRow.querySelectorAll("button")].find(
              item => item.dataset.action === action
            )
          : null;
        const target =
          completionFocus ||
          button ||
          (focused.isConnected ? focused : byId("export"));
        if (!target.disabled) {
          target.focus();
        }
      }
      if (needsUpdate) {
        scheduleUpdate();
      }
    }
  }
}

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (value !== undefined) {
    element.textContent = value;
  }
  return element;
}

function restoreRemovedFocus(focused, replacement) {
  if (
    focused &&
    (!focused.isConnected || focused.closest("[hidden]")) &&
    document.hasFocus() &&
    (document.activeElement === document.body ||
      document.activeElement === focused) &&
    replacement &&
    !replacement.matches(":disabled")
  ) {
    replacement.focus();
  }
}

function renderSubscriptions(subscriptions) {
  const list = byId("subscriptions");
  const focused = document.activeElement;
  const focusedRow = list.contains(focused)
    ? focused.closest(".subscription")
    : null;
  const rowIndex = [...list.children].indexOf(focusedRow);
  const fragment = document.createDocumentFragment();
  for (const sub of subscriptions) {
    const title = sub.title || sub.feedURL;
    const row = node("li", "subscription");
    row.dataset.guid = sub.guid;
    const info = node("div", "subscription-info");
    info.append(
      node("h3", "feed-title", title),
      node("p", "feed-url", sub.feedURL)
    );
    const actions = node("div", "actions");
    for (const [command, id] of [
      ["Preview", "feeds-preview-button"],
      ["Refresh", "feeds-reload-button"],
      ["Remove", "feeds-remove-button"],
    ]) {
      const button = node("button");
      button.type = "button";
      button.dataset.action = command;
      if (command !== "Preview") {
        button.setAttribute("data-mutates", "");
      }
      localize(button, id, { title });
      updateButton(button);
      actions.append(button);
    }
    row.append(info, actions);
    fragment.append(row);
  }
  list.replaceChildren(fragment);
  updateControls();
  byId("empty").hidden = subscriptions.length !== 0;
  if (focusedRow) {
    const rows = [...list.children];
    const row =
      rows.find(item => item.dataset.guid === focusedRow.dataset.guid) ||
      rows[Math.min(rowIndex, rows.length - 1)];
    const replacement = row
      ? [...row.querySelectorAll("button")].find(
          button => button.dataset.action === focused.dataset.action
        )
      : byId("subscriptions-heading");
    restoreRemovedFocus(focused, replacement);
  }
  if (!subscriptions.some(sub => sub.guid === previewGuid)) {
    const previewFocused = byId("preview").contains(document.activeElement)
      ? document.activeElement
      : null;
    previewGuid = null;
    previewItemsKey = null;
    byId("preview").hidden = true;
    byId("preview-items").replaceChildren();
    byId("preview-title").textContent = "";
    restoreRemovedFocus(previewFocused, byId("subscriptions-heading"));
  }
}

async function loadList(isCurrent = () => true) {
  needsUpdate = false;
  const result = await query("List");
  if (!isCurrent()) {
    return false;
  }
  isPrivate = result.isPrivate;
  ready = true;
  byId("private-notice").hidden = !isPrivate;
  renderSubscriptions(result.subscriptions);
  return result;
}

function safeItemURL(value) {
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

function normalizedFeedURL(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /^https?:\/\/[^/?#]*@/i.test(value.trim().replace(/\\/g, "/"))
  ) {
    return null;
  }
  const href = safeItemURL(value);
  if (!href || href.length > 4096) {
    return null;
  }
  const url = new URL(href);
  url.hash = "";
  return url.href;
}

function renderPreview(preview) {
  previewGuid = preview.guid;
  byId("preview-title").textContent = preview.title;
  const key = JSON.stringify([preview.guid, preview.items]);
  if (key === previewItemsKey) {
    return;
  }
  const list = byId("preview-items");
  const focused = list.contains(document.activeElement)
    ? document.activeElement
    : null;
  const fragment = document.createDocumentFragment();
  for (const item of preview.items) {
    const row = node("li");
    const url = safeItemURL(item.url);
    const label = node(url ? "a" : "span", "", item.title || url || "");
    if (!item.title && !url) {
      localize(label, "feeds-item-untitled");
    }
    if (url) {
      label.href = url;
      label.target = "_blank";
      label.rel = "noopener noreferrer";
      label.referrerPolicy = "no-referrer";
    }
    row.append(label);
    fragment.append(row);
  }
  list.replaceChildren(fragment);
  previewItemsKey = key;
  byId("preview-empty").hidden = preview.items.length !== 0;
  byId("preview").hidden = false;
  const replacement = [...list.querySelectorAll("a")].find(
    link => link.href === focused?.href
  );
  restoreRemovedFocus(focused, replacement || byId("preview-heading"));
}

async function updateFromService(isCurrent = () => true) {
  if (!(await loadList(isCurrent))) {
    return;
  }
  const guid = previewGuid;
  if (guid) {
    const preview = await query("Preview", { guid });
    if (isCurrent() && previewGuid === guid) {
      renderPreview(preview);
    }
  }
}

function scheduleUpdate() {
  if (!pageActive) {
    return;
  }
  needsUpdate = true;
  if (busy || backgroundUpdate) {
    return;
  }
  const update = {};
  backgroundUpdate = update;
  const isCurrent = () => pageActive && backgroundUpdate === update;
  void updateFromService(isCurrent)
    .catch(error => {
      if (isCurrent() && error.name !== "AbortError") {
        showError(error.message);
      }
    })
    .finally(() => {
      if (backgroundUpdate === update) {
        backgroundUpdate = null;
        if (needsUpdate) {
          scheduleUpdate();
        }
      }
    });
}

document.addEventListener("FeedPage:Changed", scheduleUpdate);
window.addEventListener("pagehide", event => {
  if (!event.isTrusted) {
    return;
  }
  pageActive = false;
  pageGeneration++;
  ready = false;
  busy = false;
  backgroundUpdate = null;
  needsUpdate = false;
  completionFocus = null;
  for (const request of pending.values()) {
    request.reject(inactivePageError());
  }
  pending.clear();
  updateControls();
});
window.addEventListener("pageshow", event => {
  if (event.isTrusted && event.persisted) {
    pageActive = true;
    void run(async () => {
      await updateFromService();
      setStatus("feeds-status-ready");
    }, false);
  }
});

byId("subscribe-form").addEventListener("submit", event => {
  event.preventDefault();
  if (isPrivate || !ready) {
    return;
  }
  void run(async () => {
    const sub = await query("Create", {
      feedURL: byId("feed-url").value.trim(),
      title: byId("feed-title").value.trim(),
    });
    byId("subscribe-form").reset();
    await loadList();
    renderPreview(await query("Preview", { guid: sub.guid }));
    setStatus("feeds-status-preview");
    completionFocus = byId("preview-heading");
  });
});

byId("subscriptions").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) {
    return;
  }
  const { guid } = button.closest(".subscription").dataset;
  const command = button.dataset.action;
  void run(async () => {
    const result = await query(command, { guid });
    if (command === "Remove") {
      await loadList();
      setStatus("feeds-status-removed");
    } else {
      if (command === "Refresh") {
        await loadList();
      }
      renderPreview(result);
      setStatus(
        command === "Refresh" ? "feeds-status-reloaded" : "feeds-status-preview"
      );
      completionFocus = byId("preview-heading");
    }
  });
});

byId("import").addEventListener("click", () => {
  void run(async () => {
    const result = await query("Import");
    await loadList();
    setStatus(
      result.canceled ? "feeds-status-canceled" : "feeds-status-imported",
      result.canceled ? undefined : { count: result.count }
    );
  });
});

byId("export").addEventListener("click", () => {
  void run(async () => {
    const result = await query("Export");
    setStatus(
      result.canceled ? "feeds-status-canceled" : "feeds-status-exported"
    );
  });
});

// A discovered URL only prefills the form. Opening this page never fetches it.
const params = new URLSearchParams(location.search);
const initialURL = params.get("url");
if (initialURL && initialURL.length <= 4096) {
  byId("feed-url").value = initialURL;
}
void run(async () => {
  const { subscriptions } = await loadList();
  const url = normalizedFeedURL(initialURL);
  if (initialURL && !url) {
    showError("feeds-error-invalid-url");
  } else {
    if (
      url &&
      byId("feed-url").value === initialURL &&
      !byId("feed-title").value
    ) {
      const existing = subscriptions.find(sub => sub.feedURL === url);
      const title = existing ? existing.title : params.get("title");
      if (title && title.length <= 1024) {
        byId("feed-title").value = title;
      }
    }
    setStatus("feeds-status-ready");
  }
}, false);
