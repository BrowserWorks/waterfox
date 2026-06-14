/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function createLogin(origin, username, password) {
  const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
    Ci.nsILoginInfo
  );
  login.init(origin, "", null, username, password, "", "");
  return login;
}

add_task(async function test_about_passwords_loads_and_filters() {
  const login = createLogin(
    "https://example.com",
    "waterfox-user",
    "waterfox-password"
  );
  const storedLogin = await Services.logins.addLoginAsync(login);

  let tab;
  try {
    tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "about:passwords"
    );
    const doc = tab.linkedBrowser.contentDocument;
    const tree = doc.getElementById("signonsTree");
    await TestUtils.waitForCondition(
      () => tree?.view?.rowCount === 1,
      "Waiting for the classic password manager to list the seeded login"
    );

    is(doc.location.href, "about:passwords", "The classic password page loads");
    is(
      tree.view.getCellText(0, { id: "siteCol" }),
      "https://example.com",
      "The saved login origin appears"
    );
    is(
      tree.view.getCellText(0, { id: "userCol" }),
      "waterfox-user",
      "The saved login username appears"
    );

    const filter = doc.getElementById("filter");
    filter.value = "does-not-match";
    filter.dispatchEvent(
      new doc.defaultView.InputEvent("input", { bubbles: true })
    );
    await TestUtils.waitForCondition(
      () => tree.view.rowCount === 0,
      "Waiting for the filtered login list to empty"
    );
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await Services.logins.removeLoginAsync(storedLogin);
  }
});
