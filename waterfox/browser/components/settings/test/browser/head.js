/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

async function openPrefsTab(pane) {
  let url = "about:preferences" + (pane ? "#" + pane : "");
  let tab = BrowserTestUtils.addTab(gBrowser, url);
  let initialized = BrowserTestUtils.waitForEvent(
    tab.linkedBrowser,
    "Initialized",
    true
  );
  gBrowser.selectedTab = tab;
  await initialized;
  return tab;
}

async function settingGroupRenders(doc, groupId) {
  await BrowserTestUtils.waitForMutationCondition(
    doc.getElementById("mainPrefPane"),
    { childList: true, subtree: true },
    () => doc.querySelector(`setting-group[groupid="${groupId}"]`)
  );
  return doc.querySelector(`setting-group[groupid="${groupId}"]`);
}

function synthesizeClick(el) {
  el.scrollIntoView({ block: "center" });
  el.click();
}
