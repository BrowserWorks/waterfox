/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Test for About Dialog background check for updates
// with the update downloaded when the About Dialog is opened.
add_task(async function aboutDialog_backgroundCheck_downloaded() {
  const appVersion = `${parseInt(Services.appinfo.version, 10) + 1}.0`;
  const displayVersion = `${appVersion}.1`;
  const releaseNotesURL =
    "https://example.com/releases/%DISPLAY_VERSION%/?version=%VERSION%&locale=%LOCALE%";
  await SpecialPowers.pushPrefEnv({
    set: [["app.releaseNotesURL.aboutDialog", releaseNotesURL]],
  });

  let params = {
    backgroundUpdate: true,
    waitForUpdateState: STATE_PENDING,
    version: appVersion,
    queryString: `&displayVersion=${displayVersion}`,
  };
  await runAboutDialogUpdateTest(params, [
    {
      panelId: "apply",
      checkActiveUpdate: { state: STATE_PENDING },
      continueFile: null,
    },
    aboutDialog => {
      const update = aboutDialog.gAppUpdater.update;
      ok(update, "The pending update metadata should be available");
      is(
        update?.appVersion,
        appVersion,
        "The target app version should be used"
      );
      is(
        update?.displayVersion,
        displayVersion,
        "The target display version should be used"
      );

      const releaseNotesLink =
        aboutDialog.document.getElementById("releasenotes");
      is(
        releaseNotesLink.href,
        Services.urlFormatter.formatURL(
          releaseNotesURL
            .replaceAll("%VERSION%", appVersion)
            .replaceAll("%DISPLAY_VERSION%", displayVersion)
        ),
        "Release notes should link to the pending update, not the installed version"
      );
      ok(!releaseNotesLink.hidden, "The release notes link should be visible");
    },
  ]);
});
