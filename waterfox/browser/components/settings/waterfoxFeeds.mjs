/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LiveBookmarks: "resource:///modules/LiveBookmarks.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  PrivateTab: "resource:///modules/PrivateTab.sys.mjs",
});

const MAX_OPML_BYTES = 2 * 1024 * 1024;
const innerWindowId = window.windowGlobalChild.innerWindowId;
let busy = false;
let feedback = null;

/** An expected preferences failure whose message is a localization ID. */
class FeedSettingsError extends Error {}

function isPrivate() {
  const context = window.browsingContext;
  const browser = context?.embedderElement;
  return (
    !browser ||
    context.usePrivateBrowsing ||
    lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) ||
    lazy.PrivateTab.isPrivate(
      browser.documentGlobal.gBrowser.getTabForBrowser(browser)
    )
  );
}

function assertAllowed(action) {
  const context = window.browsingContext;
  if (
    window.closed ||
    context?.currentWindowGlobal?.innerWindowId !== innerWindowId
  ) {
    throw new FeedSettingsError("waterfox-feeds-error-unavailable");
  }
  if (action !== "export" && isPrivate()) {
    throw new FeedSettingsError("waterfox-feeds-private-notice");
  }
}

async function pickFile(action) {
  assertAllowed(action);
  const save = action === "export";
  const [title, filter, filename] = await document.l10n.formatValues([
    { id: `waterfox-feeds-${action}-picker-title` },
    { id: "waterfox-feeds-opml-file-filter" },
    { id: "waterfox-feeds-export-filename" },
  ]);
  assertAllowed(action);
  if (!title || !filter || (save && !filename)) {
    throw new FeedSettingsError("waterfox-feeds-error-unavailable");
  }
  const context = window.browsingContext;
  const browser = context.embedderElement;
  if (
    !context.isActive ||
    !context.canOpenModalPicker ||
    browser?.documentGlobal.gBrowser.selectedBrowser !== browser
  ) {
    throw new FeedSettingsError("waterfox-feeds-error-not-active");
  }
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
    Ci.nsIFilePicker
  );
  picker.init(
    context,
    title,
    save ? Ci.nsIFilePicker.modeSave : Ci.nsIFilePicker.modeOpen
  );
  picker.appendFilter(filter, "*.opml;*.xml");
  if (save) {
    picker.defaultString = filename;
    picker.defaultExtension = "opml";
  }
  const result = await new Promise(resolve => picker.open(resolve));
  assertAllowed(action);
  return result === Ci.nsIFilePicker.returnOK ||
    (save && result === Ci.nsIFilePicker.returnReplace)
    ? picker.file
    : null;
}

async function importOPML(file) {
  const info = await IOUtils.stat(file.path);
  assertAllowed("import");
  if (info.type !== "regular") {
    throw new FeedSettingsError("waterfox-feeds-error-invalid-opml");
  }
  if (info.size > MAX_OPML_BYTES) {
    throw new FeedSettingsError("waterfox-feeds-error-file-too-large");
  }
  const bytes = await IOUtils.read(file.path, { maxBytes: MAX_OPML_BYTES + 1 });
  assertAllowed("import");
  if (bytes.length > MAX_OPML_BYTES) {
    throw new FeedSettingsError("waterfox-feeds-error-file-too-large");
  }
  let xml;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
      throw new Error("OPML must not declare entities");
    }
  } catch {
    throw new FeedSettingsError("waterfox-feeds-error-invalid-opml");
  }
  return lazy.LiveBookmarks.planOPML(xml);
}

async function confirmImport(plan) {
  const [title, message, importLabel] = await document.l10n.formatValues([
    { id: "waterfox-feeds-import-review-title" },
    {
      id: "waterfox-feeds-import-review-message",
      args: { newCount: plan.newCount, duplicateCount: plan.duplicateCount },
    },
    { id: "waterfox-feeds-import-review-confirm" },
  ]);
  assertAllowed("import");
  if (!title || !message || !importLabel) {
    throw new FeedSettingsError("waterfox-feeds-error-unavailable");
  }
  return (
    Services.prompt.confirmExBC(
      window.browsingContext,
      Services.prompt.MODAL_TYPE_CONTENT,
      title,
      message,
      (Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0) |
        (Services.prompt.BUTTON_TITLE_CANCEL * Services.prompt.BUTTON_POS_1) |
        Services.prompt.BUTTON_POS_1_DEFAULT,
      importLabel,
      null,
      null,
      null,
      {}
    ) == 0
  );
}

async function runAction(action) {
  if (busy) {
    return;
  }
  busy = true;
  feedback = {
    l10nId: "waterfox-feeds-status-working",
    type: "info",
  };
  Preferences.getSetting("waterfox-feeds-state").onChange();
  try {
    assertAllowed(action);
    await lazy.LiveBookmarks.init();
    assertAllowed(action);
    let count;
    const file = await pickFile(action);
    if (!file) {
      feedback.l10nId = "waterfox-feeds-status-canceled";
      return;
    }
    assertAllowed(action);
    if (action === "import") {
      const plan = await importOPML(file);
      if (!(await confirmImport(plan))) {
        feedback.l10nId = "waterfox-feeds-status-canceled";
        return;
      }
      assertAllowed("import");
      count = await lazy.LiveBookmarks.importOPML(plan);
    } else {
      const xml = await lazy.LiveBookmarks.exportOPML();
      assertAllowed("export");
      await IOUtils.writeUTF8(file.path, xml);
    }
    feedback.l10nId = `waterfox-feeds-status-${action}`;
    feedback.l10nArgs = action === "import" ? { count } : undefined;
    feedback.type = "success";
  } catch (error) {
    if (
      !(error instanceof FeedSettingsError) &&
      error?.code != "OPML_PLAN_CHANGED"
    ) {
      console.error("Feed settings operation failed", error);
    }
    if (error?.code == "OPML_PLAN_CHANGED") {
      feedback.l10nId = "waterfox-feeds-error-import-changed";
    } else if (error instanceof FeedSettingsError) {
      feedback.l10nId = error.message;
    } else {
      feedback.l10nId = `waterfox-feeds-error-${action}`;
    }
    feedback.type = "error";
  } finally {
    busy = false;
    Preferences.getSetting("waterfox-feeds-state").onChange();
  }
}

Preferences.addAll([
  { id: "browser.feeds.discovery.enabled", type: "bool" },
  { id: "browser.feeds.articleOpening", type: "string" },
  { id: "browser.feeds.loadImages", type: "bool" },
]);

Preferences.addSetting({
  id: "waterfox-feeds-discovery",
  pref: "browser.feeds.discovery.enabled",
});
Preferences.addSetting({
  id: "waterfox-feeds-article-opening",
  pref: "browser.feeds.articleOpening",
});
Preferences.addSetting({
  id: "waterfox-feeds-load-images",
  pref: "browser.feeds.loadImages",
});
Preferences.addSetting({ id: "waterfox-feeds-open" });
Preferences.addSetting({ id: "waterfox-feeds-state", get: () => busy });
Preferences.addSetting({
  id: "waterfox-feeds-private-notice",
  visible: isPrivate,
});

for (const action of ["import", "export"]) {
  Preferences.addSetting({
    id: `waterfox-feeds-${action}`,
    deps: ["waterfox-feeds-state"],
    disabled: () => busy || (action !== "export" && isPrivate()),
    onUserClick: () => runAction(action),
  });
}

Preferences.addSetting({
  id: "waterfox-feeds-opml-status",
  deps: ["waterfox-feeds-state"],
  visible: () => !!feedback,
  getControlConfig(config) {
    return {
      ...config,
      l10nId: feedback?.l10nId,
      l10nArgs: feedback?.l10nArgs,
      controlAttrs: {
        role: "status",
        "aria-atomic": "true",
        type: feedback?.type || "info",
      },
    };
  },
});

SettingGroupManager.registerGroups({
  waterfoxFeeds: {
    l10nId: "waterfox-feeds-group",
    headingLevel: 2,
    items: [
      {
        id: "waterfox-feeds-discovery",
        l10nId: "waterfox-feeds-discovery-toggle",
        control: "moz-toggle",
      },
      {
        id: "waterfox-feeds-private-notice",
        l10nId: "waterfox-feeds-private-notice",
        control: "moz-message-bar",
        controlAttrs: { role: "status" },
      },
      {
        id: "waterfox-feeds-open",
        l10nId: "waterfox-feeds-open-link",
        control: "moz-box-link",
        controlAttrs: {
          href: "about:feeds",
        },
      },
    ],
  },
  waterfoxFeedsSubscribe: {
    l10nId: "waterfox-feeds-reading-group",
    headingLevel: 2,
    items: [
      {
        id: "waterfox-feeds-article-opening",
        l10nId: "waterfox-feeds-article-opening",
        control: "moz-radio-group",
        options: [
          { value: "reader", l10nId: "waterfox-feeds-opening-reader" },
          { value: "original", l10nId: "waterfox-feeds-opening-original" },
        ],
      },
      {
        id: "waterfox-feeds-load-images",
        l10nId: "waterfox-feeds-load-images-toggle",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxFeedsOPML: {
    l10nId: "waterfox-feeds-opml-group",
    headingLevel: 2,
    items: [
      {
        id: "waterfox-feeds-import",
        l10nId: "waterfox-feeds-import-button",
        control: "moz-button",
      },
      {
        id: "waterfox-feeds-export",
        l10nId: "waterfox-feeds-export-button",
        control: "moz-button",
      },
      {
        id: "waterfox-feeds-opml-status",
        control: "moz-message-bar",
      },
    ],
  },
});
