/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The query string is the persistence mechanism: every state change is
// rewritten into the URL so the group survives session restore unchanged.

const { TreeTabsGroups } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsGroups.sys.mjs"
);
const { TreeTabsService } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsService.sys.mjs"
);

const TREE_TOPICS = [
  "tree-tabs-attached",
  "tree-tabs-detached",
  "tree-tabs-structure-changed",
];

let gTitleElement;
let gTitleField;
let gTemporaryCheck;
let gAggressiveCheck;
let gTabsContainer;

let gDefaultTitle = "Group";
let gRenderTimer = null;

function getParams() {
  return new URLSearchParams(document.location.search);
}

function getOwnTab() {
  const browser = window.browsingContext?.embedderElement;
  const browserWindow = browser?.documentGlobal || null;
  const gBrowser = browserWindow?.gBrowser;
  if (!gBrowser) {
    return { browserWindow: null, gBrowser: null, tab: null };
  }
  return {
    browserWindow,
    gBrowser,
    tab: gBrowser.getTabForBrowser(browser),
  };
}

function getTreeContext(browserWindow, tab) {
  const params = getParams();
  const aliasTab = TreeTabsGroups.findTabByGuid(
    browserWindow,
    params.get("aliasGuid")
  );
  let openerTab = null;
  if (!aliasTab) {
    openerTab = TreeTabsGroups.findTabByGuid(
      browserWindow,
      params.get("openerGuid")
    );
  }
  return {
    childSource: aliasTab || tab,
    openerTab: openerTab == tab ? null : openerTab,
  };
}

function hasModifier(event) {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

function isAccelClick(event) {
  return Services.appinfo.OS == "Darwin" ? event.metaKey : event.ctrlKey;
}

function closeListedTab(gBrowser, tab) {
  if (TreeTabsGroups.isGroupTab(tab)) {
    TreeTabsService.removeGroupTab(tab);
  } else {
    gBrowser.removeTab(tab);
  }
}

function updateParameters(changes) {
  const params = getParams();
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === false) {
      params.delete(key);
    } else {
      params.set(key, value === true ? "true" : value);
    }
  }
  const url = new URL(document.location.href);
  url.search = params.toString();
  history.replaceState(null, "", url.href);
}

function scheduleLifetimeCleanup() {
  const { browserWindow, tab } = getOwnTab();
  if (!tab) {
    return;
  }
  setTimeout(() => {
    if (tab.isConnected && !tab.closing) {
      TreeTabsGroups.cleanupNeedlessGroupTabs(browserWindow, [
        tab,
        ...TreeTabsService.getAncestors(tab),
      ]);
    }
  });
}

function currentTitle() {
  return getParams().get("title") || gDefaultTitle;
}

function applyTitle() {
  const title = currentTitle();
  gTitleElement.textContent = title;
  document.title = title;
  const { gBrowser, tab } = getOwnTab();
  if (tab) {
    gBrowser.setTabTitle(tab);
  }
}

function enterTitleEdit() {
  gTitleField.value = currentTitle();
  gTitleElement.hidden = true;
  gTitleField.hidden = false;
  gTitleField.focus();
  gTitleField.select();
}

function exitTitleEdit(commit) {
  if (gTitleField.hidden) {
    return;
  }
  if (commit && gTitleField.value.trim()) {
    updateParameters({ title: gTitleField.value.trim() });
  }
  gTitleField.hidden = true;
  gTitleElement.hidden = false;
  applyTitle();
}

function syncCheckboxes() {
  const params = getParams();
  gTemporaryCheck.checked = params.get("temporary") == "true";
  gAggressiveCheck.checked = params.get("temporaryAggressive") == "true";
}

// A default title follows the first child, like TST's "«tab» and more".
async function maybeUpdateDefaultTitle() {
  const params = getParams();
  if (params.has("title")) {
    return;
  }
  const { browserWindow, tab } = getOwnTab();
  const context = tab ? getTreeContext(browserWindow, tab) : null;
  const firstChild = context?.childSource
    ? TreeTabsService.getChildren(context.childSource)[0]
    : null;
  if (context?.openerTab) {
    gDefaultTitle = await document.l10n.formatValue(
      "waterfox-tree-group-tabs-from",
      { title: context.openerTab.label }
    );
  } else if (firstChild) {
    gDefaultTitle = await document.l10n.formatValue(
      "waterfox-tree-group-title-and-more",
      { title: firstChild.label }
    );
  } else {
    gDefaultTitle = await document.l10n.formatValue(
      "waterfox-tree-group-default-title"
    );
  }
  applyTitle();
}

function renderTree() {
  const { browserWindow, gBrowser, tab } = getOwnTab();
  gTabsContainer.textContent = "";
  if (!tab) {
    return;
  }

  function appendChildren(parent, level) {
    for (const child of TreeTabsService.getChildren(parent)) {
      appendTab(child, level);
    }
  }

  function appendTab(
    child,
    level,
    { associated = false, recurse = true } = {}
  ) {
    const isGroupTab = TreeTabsGroups.isGroupTab(child);
    const item = document.createElement("div");
    item.className = "item";
    item.classList.toggle("associated", associated);
    item.classList.toggle("group-tab", isGroupTab);
    item.style.setProperty("--level", level);

    const favicon = document.createElement("img");
    favicon.className = "favicon";
    favicon.src = isGroupTab
      ? "chrome://global/skin/icons/folder.svg"
      : child.image || "chrome://global/skin/icons/defaultFavicon.svg";
    favicon.alt = "";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = child.label;
    item.append(favicon, label);

    item.addEventListener("click", event => {
      if (event.button != 0) {
        return;
      }
      if (isAccelClick(event)) {
        event.preventDefault();
        event.stopPropagation();
        closeListedTab(gBrowser, child);
      } else if (!hasModifier(event)) {
        gBrowser.selectedTab = child;
      }
    });
    item.addEventListener("auxclick", event => {
      if (event.button != 1 || hasModifier(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeListedTab(gBrowser, child);
    });

    gTabsContainer.appendChild(item);
    if (recurse) {
      appendChildren(child, level + 1);
    }
  }

  const { childSource, openerTab } = getTreeContext(browserWindow, tab);
  if (openerTab) {
    appendTab(openerTab, 0, { associated: true, recurse: false });
    appendChildren(childSource, 1);
  } else {
    appendChildren(childSource, 0);
  }
}

function scheduleRender() {
  if (gRenderTimer) {
    return;
  }
  gRenderTimer = setTimeout(() => {
    gRenderTimer = null;
    maybeUpdateDefaultTitle();
    renderTree();
  }, 100);
}

const gObserver = {
  observe(subject) {
    const payload = subject?.wrappedJSObject ?? subject;
    const { browserWindow: ownWindow } = getOwnTab();
    const eventWindow =
      payload?.window ||
      payload?.tab?.documentGlobal ||
      payload?.parent?.documentGlobal ||
      null;
    if (!eventWindow || eventWindow == ownWindow) {
      scheduleRender();
    }
  },
};

function handleChromeEvent(event) {
  if (event.type == "TabAttrModified") {
    const changed = event.detail?.changed || [];
    if (changed.includes("label") || changed.includes("image")) {
      scheduleRender();
    }
  }
}

function init() {
  gTitleElement = document.getElementById("title");
  gTitleField = document.getElementById("title-field");
  gTemporaryCheck = document.getElementById("temporary");
  gAggressiveCheck = document.getElementById("temporaryAggressive");
  gTabsContainer = document.getElementById("tabs");

  syncCheckboxes();
  applyTitle();
  maybeUpdateDefaultTitle();
  renderTree();

  gTitleElement.addEventListener("click", event => {
    if (event.button == 0 && !event.ctrlKey && !event.metaKey) {
      enterTitleEdit();
    }
  });
  window.addEventListener("keydown", event => {
    if (event.key == "F2" && gTitleField.hidden) {
      enterTitleEdit();
    }
  });
  gTitleField.addEventListener("keydown", event => {
    if (event.key == "Enter") {
      exitTitleEdit(true);
    } else if (event.key == "Escape") {
      exitTitleEdit(false);
    }
  });
  gTitleField.addEventListener("blur", () => exitTitleEdit(true));

  // The two lifetimes are mutually exclusive.
  gTemporaryCheck.addEventListener("change", () => {
    updateParameters({
      temporary: gTemporaryCheck.checked,
      temporaryAggressive: false,
    });
    syncCheckboxes();
    scheduleLifetimeCleanup();
  });
  gAggressiveCheck.addEventListener("change", () => {
    updateParameters({
      temporaryAggressive: gAggressiveCheck.checked,
      temporary: false,
    });
    syncCheckboxes();
    scheduleLifetimeCleanup();
  });

  for (const topic of TREE_TOPICS) {
    Services.obs.addObserver(gObserver, topic);
  }
  const { gBrowser } = getOwnTab();
  gBrowser?.tabContainer?.addEventListener(
    "TabAttrModified",
    handleChromeEvent
  );

  window.addEventListener(
    "unload",
    () => {
      for (const topic of TREE_TOPICS) {
        Services.obs.removeObserver(gObserver, topic);
      }
      gBrowser?.tabContainer?.removeEventListener(
        "TabAttrModified",
        handleChromeEvent
      );
    },
    { once: true }
  );
}

if (document.readyState == "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
