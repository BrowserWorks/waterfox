/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EXIT_CODE as EXIT_CODE_BASE } from "resource://gre/modules/BackgroundTasksManager.sys.mjs";
import { AppConstants as AC } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const EXIT_CODE = {
  ...EXIT_CODE_BASE,
  DISABLED_BY_POLICY: EXIT_CODE_BASE.LAST_RESERVED + 1,
  INVALID_ARGUMENT: EXIT_CODE_BASE.LAST_RESERVED + 2,
  MUTEX_NOT_LOCKABLE: EXIT_CODE_BASE.LAST_RESERVED + 3,
};

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
  ShellService: "moz-src:///browser/components/shell/ShellService.sys.mjs",
});
XPCOMUtils.defineLazyServiceGetters(lazy, {
  AlertsService: ["@mozilla.org/alerts-service;1", Ci.nsIAlertsService],
});
ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  let consoleOptions = {
    maxLogLevel: "error",
    maxLogLevelPref: "app.defaultagent.loglevel",
    prefix: "DefaultAgent",
  };
  return new ConsoleAPI(consoleOptions);
});

// Should be slightly longer than kNotificationTimeoutMs and kGleanSendWait below
// (divided by 1000 to convert millseconds to seconds) to not cause race
// between timeouts.
//
// Additionally, should be less than the Windows Scheduled Task timeout
// execTimeLimitBStr in ScheduledTask.cpp.
//
// Current bounds are 11 hours 55 minutes 10 seconds and 12 hours 5 minutes.
export const backgroundTaskTimeoutSec = 12 * 60 * 60;

// 11 hours 55 minutes in milliseconds.
const kNotificationTimeoutMs = 11 * 60 * 60 * 1000 + 55 * 60 * 1000;
// 10 seconds in milliseconds.
const kGleanSendWait = 10000;

const kNotificationShown = Object.freeze({
  notShown: "not-shown",
  shown: "shown",
  error: "error",
});

const kNotificationAction = Object.freeze({
  dismissedByTimeout: "dismissed-by-timeout",
  dismissedByButton: "dismissed-by-button",
  dismissedToActionCenter: "dismissed-to-action-center",
  makeFirefoxDefaultButton: "make-firefox-default-button",
  toastClicked: "toast-clicked",
  noAction: "no-action",
});

// We expect to be given a command string in argv[1], perhaps followed by other
// arguments depending on the command. The valid commands are:
// register-task [unique-token]
//   Create a Windows scheduled task that will launch this binary with the
//   do-task command every 24 hours, starting from 24 hours after register-task
//   is run. unique-token is required and should be some string that uniquely
//   identifies this installation of the product; typically this will be the
//   install path hash that's used for the update directory, the AppUserModelID,
//   and other related purposes.
// update-task [unique-token]
//   Update an existing task registration, without changing its schedule. This
//   should be called during updates of the application, in case this program
//   has been updated and any of the task parameters have changed. The unique
//   token argument is required and should be the same one that was passed in
//   when the task was registered.
// unregister-task [unique-token]
//   Removes the previously created task. The unique token argument is required
//   and should be the same one that was passed in when the task was registered.
// uninstall [unique-token]
//   Removes the previously created task, and also removes all registry entries
//   running the task may have created. The unique token argument is required
//   and should be the same one that was passed in when the task was registered.
// do-task [app-user-model-id]
//   Actually performs the default agent task, which currently means generating
//   and sending our telemetry ping and possibly showing a notification to the
//   user if their browser has switched from Firefox to Edge with Blink.
// set-default-browser-user-choice [app-user-model-id] [[.file1 ProgIDRoot1]
// ...]
//   Set the default browser via the UserChoice registry keys.  Additional
//   optional file extensions to register can be specified as additional
//   argument pairs: the first element is the file extension, the second element
//   is the root of a ProgID, which will be suffixed with `-$AUMI`.
export async function runBackgroundTask(commandLine) {
  Services.fog.initializeFOG(
    undefined,
    "firefox.desktop.background.defaultagent",
    /* disableInternalPings */ true
  );

  let defaultAgent = Cc["@mozilla.org/default-agent;1"].getService(
    Ci.nsIDefaultAgent
  );

  let command = commandLine.getArgument(0);

  // The uninstall and unregister commands are allowed even if the policy
  // disabling the task is set, so that uninstalls and updates always work.
  // Similarly, debug commands are always allowed.
  switch (command) {
    case "uninstall": {
      let token = commandLine.getArgument(1);
      lazy.log.info(`Uninstalling for token "${token}"`);
      defaultAgent.uninstall(token);
      return EXIT_CODE.SUCCESS;
    }
    case "unregister-task": {
      let token = commandLine.getArgument(1);
      lazy.log.info(`Unregistering task for token "${token}"`);
      defaultAgent.unregisterTask(token);
      return EXIT_CODE.SUCCESS;
    }
  }

  // We check for disablement by policy because that's assumed to be static.
  // But we don't check for disablement by remote settings so that
  // `register-task` and `update-task` can proceed as part of the update
  // cycle, waiting for remote (re-)enablement.
  if (defaultAgent.agentDisabled()) {
    lazy.log.warn("Default Agent disabled, exiting without running.");
    return EXIT_CODE.DISABLED_BY_POLICY;
  }

  switch (command) {
    case "register-task": {
      let token = commandLine.getArgument(1);
      lazy.log.info(`Registering task for token "${token}"`);
      defaultAgent.registerTask(token);
      return EXIT_CODE.SUCCESS;
    }
    case "update-task": {
      let token = commandLine.getArgument(1);
      lazy.log.info(`Updating task for token "${token}"`);
      defaultAgent.updateTask(token);
      return EXIT_CODE.SUCCESS;
    }
    case "do-task": {
      let aumid = commandLine.getArgument(1);
      let force = commandLine.findFlag("force", true) != -1;

      lazy.log.info(`Running do-task with AUMID "${aumid}"`);

      try {
        lazy.log.info("Running JS do-task.");
        await runWithRegistryLocked(async () => {
          await doTask(defaultAgent, force);
        });
      } catch (e) {
        if (e.message) {
          lazy.log.error(e.message);
        }

        if (e.result == Cr.NS_ERROR_NOT_AVAILABLE) {
          return EXIT_CODE.MUTEX_NOT_LOCKABLE;
        }

        return EXIT_CODE.EXCEPTION;
      }

      // Bug 1857333: We wait for arbitrary time for Glean to submit telemetry.
      lazy.log.info("Pinged glean, waiting for submission.");
      await new Promise(resolve => lazy.setTimeout(resolve, kGleanSendWait));

      return EXIT_CODE.SUCCESS;
    }
  }

  return EXIT_CODE.INVALID_ARGUMENT;
}

// Throws if unable to lock mutex (therefore function isn't run).
async function runWithRegistryLocked(aMutexGuardedFunction) {
  const kVendor = Services.appinfo.vendor || "";
  const kRegistryMutexName = `${kVendor}${AC.MOZ_APP_BASENAME}DefaultBrowserAgentRegistryMutex`;
  let mutexFactory = Cc["@mozilla.org/windows-mutex-factory;1"].getService(
    Ci.nsIWindowsMutexFactory
  );

  let mutex = mutexFactory.createMutex(kRegistryMutexName);
  mutex.tryLock(kRegistryMutexName);
  lazy.log.debug(`Locked named mutex: ${kRegistryMutexName}`);
  try {
    await aMutexGuardedFunction();
  } finally {
    mutex.unlock();
    lazy.log.debug(`Unlocked named mutex: ${kRegistryMutexName}`);
  }
}

const kSecondsPerDay = 24 /*hours*/ * 60 /*minutes*/ * 60; /*seconds*/

const kTaskExpirationSeconds = 90 /*days*/ * kSecondsPerDay;

export async function doTask(defaultAgent, force) {
  let secondsSinceAppRan;
  try {
    secondsSinceAppRan = defaultAgent.SecondsSinceLastAppRun();
  } catch (err) {
    if (err.result == Cr.NS_ERROR_NOT_AVAILABLE) {
      // There was no registry value to read to determine when the last app run occurred
      secondsSinceAppRan = 0;
    } else {
      // Something else happened. Let's log the error result for now.
      lazy.log.warn(
        "Unexpected error code in determining when the app last ran: " +
          err.result
      );
      secondsSinceAppRan = 0;
    }
  }
  const daysSinceLastAppLaunch = secondsSinceAppRan / kSecondsPerDay;
  if (secondsSinceAppRan > kTaskExpirationSeconds && !force) {
    lazy.log.warn("Main app has not run recently, exiting without running.");
    throw new Error("App hasn't run recently");
  }

  let browser = defaultAgent.getDefaultBrowser();
  lazy.log.debug(`Default browser: ${browser}`);
  let previousBrowser = defaultAgent.getReplacePreviousDefaultBrowser(browser);
  lazy.log.debug(`Previous browser: ${previousBrowser}`);
  let defaultPdfHandler = defaultAgent.getDefaultPdfHandler();
  lazy.log.debug(`Default PDF Handler: ${defaultPdfHandler}`);

  let isTaskbarPinned = "Error";
  try {
    let shellService = Cc["@mozilla.org/browser/shell-service;1"].getService(
      Ci.nsIWindowsShellService
    );
    let winTaskbar = Cc["@mozilla.org/windows-taskbar;1"].getService(
      Ci.nsIWinTaskbar
    );
    let pinned = await shellService.isCurrentAppPinnedToTaskbar(
      winTaskbar.defaultGroupId
    );
    isTaskbarPinned = pinned ? "IsPinned" : "NotPinned";
    lazy.log.debug(`Is pinned to taskbar: ${isTaskbarPinned}`);
  } catch (ex) {
    lazy.log.error(`Pin detection failed: ${ex}`);
  }

  let notificationTelemetry = {
    shown: kNotificationShown.notShown,
    action: kNotificationAction.noAction,
  };
  if ((browser == "edge-chrome" && previousBrowser == "firefox") || force) {
    lazy.log.info("Showing default browser intervention notification.");

    const alertName = "default_agent_intervention";
    let notification = showNotification(alertName);
    let timeout = makeTimeout(alertName);

    notificationTelemetry = await Promise.race([notification, timeout]);
  }
  lazy.log.debug(`Notification telemetry: ${notificationTelemetry}`);

  if (
    notificationTelemetry.action ==
      kNotificationAction.makeFirefoxDefaultButton ||
    notificationTelemetry.action == kNotificationAction.toastClicked
  ) {
    await lazy.ShellService.setDefaultBrowser(false).catch(e => {
      lazy.log.error(`setDefaultBrowser failed: ${e}`);
    });
  }

  defaultAgent.sendPing(
    browser,
    previousBrowser,
    defaultPdfHandler,
    notificationTelemetry.shown,
    notificationTelemetry.action,
    daysSinceLastAppLaunch,
    isTaskbarPinned
  );
}

async function showNotification(name) {
  let notificationTelemetry = {
    shown: kNotificationShown.error,
    action: kNotificationAction.noAction,
  };

  // Bug 1868714: We disable the notification server to defer on changes
  // necessary for it to work with Background Tasks.
  try {
    lazy.log.debug("Disabling notification server.");
    Services.prefs.setBoolPref(
      "alerts.useSystemBackend.windows.notificationserver.enabled",
      false
    );

    const l10n = new Localization([
      "branding/brand.ftl",
      // Background tasks are only used in a context where browser refs are
      // present; that it's in toolkit instead of browser is a historical
      // artifact of the default agent having previously been a
      // standalone application.
      // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
      "browser/backgroundtasks/defaultagent.ftl",
    ]);
    let [title, body, yesButtonText, noButtonText] = await l10n.formatValues([
      { id: "default-browser-notification-privacy-header-text" },
      { id: "default-browser-notification-privacy-body-text" },
      { id: "default-browser-notification-yes-button-text" },
      { id: "default-browser-notification-privacy-no-button-text" },
    ]);

    let yesAction = "yes-action";
    let noAction = "no-action";

    let alert = await makeAlert({
      name,
      title,
      body,
      actions: [
        {
          action: yesAction,
          title: yesButtonText,
        },
        {
          action: noAction,
          title: noButtonText,
        },
      ],
    });

    const { observer, shownPromise } = makeObserver({ yesAction, noAction });

    lazy.AlertsService.showAlert(alert, observer);

    notificationTelemetry = await shownPromise.promise;
  } catch (e) {
    if (e.message) {
      lazy.log.error(e.message);
    }
  } finally {
    // Reset the pref so we can assume the default value in the future.
    lazy.log.debug("Reenabling notification server.");
    Services.prefs.clearUserPref(
      "alerts.useSystemBackend.windows.notificationserver.enabled"
    );
  }

  return notificationTelemetry;
}

async function makeAlert(options) {
  let winalert = Cc["@mozilla.org/windows-alert-notification;1"].createInstance(
    Ci.nsIWindowsAlertNotification
  );
  winalert.imagePlacement = winalert.eIcon;

  let image = null;
  try {
    const uri = Services.io.newURI(
      "chrome://global/content/defaultagent/default-browser-notification-privacy-image.svg"
    );
    const channel = Services.io.newChannelFromURI(
      uri,
      null,
      Services.scriptSecurityManager.getSystemPrincipal(),
      null,
      Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      Ci.nsIContentPolicy.TYPE_IMAGE
    );
    image = await ChromeUtils.fetchDecodedImage(uri, channel);
  } catch (e) {
    lazy.log.error(`makeAlert image loading failed: ${e}`);
  }

  let alert = winalert.QueryInterface(Ci.nsIAlertNotification);
  let systemPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
  alert.init(
    options.name,
    null /* aImageURL */,
    options.title,
    options.body,
    true /* aTextClickable */,
    null /* aCookie */,
    null /* aDir */,
    null /* aLang */,
    null /* aData */,
    systemPrincipal,
    null /* aInPrivateBrowsing */,
    true /* aRequireInteraction */
  );
  alert.image = image;
  alert.imagePlacement = alert.eInline;

  alert.actions = options.actions;

  return alert;
}

function makeObserver(actions) {
  let shownPromise = Promise.withResolvers();
  let alertShowReceived = false;

  // We'll receive multiple callbacks which individually might indicate an
  // interaction. Only log the first one to disambiguate and reduce noise.
  let firstInteraction = true;
  let logFirstInteraction = message => {
    if (firstInteraction) {
      lazy.log.debug(message);
      firstInteraction = false;
    }
  };

  let observer = (subject, topic, data) => {
    switch (topic) {
      case "alertclickcallback":
        if (!subject) {
          logFirstInteraction(
            "Notification body clicked, setting default browser."
          );
          shownPromise.resolve({
            shown: kNotificationShown.shown,
            action: kNotificationAction.toastClicked,
          });
        } else {
          let alertAction = subject.QueryInterface(Ci.nsIAlertAction);
          switch (alertAction.action) {
            case actions.yesAction:
              logFirstInteraction(
                'Notification "yes" button clicked, setting default browser.'
              );
              shownPromise.resolve({
                shown: kNotificationShown.shown,
                action: kNotificationAction.makeFirefoxDefaultButton,
              });
              break;
            case actions.noAction:
              logFirstInteraction("Notification dismissed by button.");
              shownPromise.resolve({
                shown: kNotificationShown.shown,
                action: kNotificationAction.dismissedByButton,
              });
              break;
            default:
              lazy.log.error(`Unrecognized notification action ${data}`);
              throw new Error(
                `Unexpected notification action received: ${data}`
              );
          }
        }
        break;
      case "alertshow":
        alertShowReceived = true;
        break;
      case "alertfinished":
        if (alertShowReceived) {
          logFirstInteraction("Notification dismissed from action center.");
          shownPromise.resolve({
            shown: kNotificationShown.shown,
            action: kNotificationAction.dismissedToActionCenter,
          });
        } else {
          // Being dismissed without shown means an error occurred
          lazy.log.error("Error showing notification.");
          shownPromise.resolve({
            shown: kNotificationShown.error,
            action: kNotificationAction.noAction,
          });
        }
        break;
    }
  };

  return { observer, shownPromise };
}

function makeTimeout(alertName) {
  return new Promise(resolve => {
    // If the notification hasn't been activated or dismissed within 12 hours,
    // stop waiting for it.
    let timeoutMs = kNotificationTimeoutMs;

    // Allow overriding the notification timeout fron an environment variable.
    const envTimeoutKey = "MOZ_NOTIFICATION_TIMEOUT_MS";
    if (Services.env.exists(envTimeoutKey)) {
      let envTimeoutValue = Services.env.get(envTimeoutKey);
      if (!isNaN(envTimeoutValue)) {
        timeoutMs = Number(envTimeoutValue);
      } else {
        lazy.log.error(
          `Environment variable ${envTimeoutKey}=${envTimeoutValue} is not a number.`
        );
      }
    }
    lazy.log.info(`Registering notification timeout in ${timeoutMs}ms`);

    lazy.setTimeout(() => {
      lazy.log.warn(`Notification timed out after ${timeoutMs}ms`);

      lazy.AlertsService.closeAlert(alertName);

      resolve({
        shown: kNotificationShown.shown,
        action: kNotificationAction.dismissedByTimeout,
      });
    }, timeoutMs);
  });
}
