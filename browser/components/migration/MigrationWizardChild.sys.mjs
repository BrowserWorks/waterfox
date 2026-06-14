/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MigrationWizardConstants } from "chrome://browser/content/migration/migration-wizard-constants.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "SHOW_IMPORT_ALL_PREF",
  "browser.migrate.content-modal.import-all.enabled",
  false
);

/**
 * This class is responsible for updating the state of a <migration-wizard>
 * component, and for listening for events from that component to perform
 * various migration functions.
 */
export class MigrationWizardChild extends JSWindowActorChild {
  #wizardEl = null;

  /**
   * Returns true if the current OS is macOS Sequoia (macOS 15) or later.
   * Safari's password export UI changed in Sequoia, so we show a different
   * set of import instructions before and after this version. macOS 15 maps
   * to Darwin kernel version 24, which is what Services.sysinfo reports as
   * the platform "version" on macOS.
   *
   * This is a static method (rather than an inline check) so that tests can
   * stub it to exercise both instruction variants.
   *
   * @returns {boolean}
   */
  static isMacOSSequoiaOrLater() {
    return AppConstants.isPlatformAndVersionAtLeast("macosx", "24.0.0");
  }

  /**
   * Retrieves the list of browsers and profiles from the parent process, and then
   * puts the migration wizard onto the selection page showing the list that they
   * can import from.
   *
   * @param {boolean} [allowOnlyFileMigrators=null]
   *   Set to true if showing the selection page is allowed if no browser migrators
   *   are found. If not true, and no browser migrators are found, then the wizard
   *   will be sent to the NO_BROWSERS_FOUND page.
   * @param {string} [migratorKey=null]
   *   If set, this will automatically select the first associated migrator with that
   *   migratorKey in the selector. If not set, the first item in the retrieved list
   *   of migrators will be selected.
   * @param {string} [fileImportErrorMessage=null]
   *   If set, this will display an error message below the browser / profile selector
   *   indicating that something had previously gone wrong with an import of type
   *   MIGRATOR_TYPES.FILE.
   */
  async #populateMigrators(
    allowOnlyFileMigrators,
    migratorKey,
    fileImportErrorMessage
  ) {
    let migrators = await this.sendQuery("GetAvailableMigrators");
    let hasBrowserMigrators = migrators.some(migrator => {
      return migrator.type == MigrationWizardConstants.MIGRATOR_TYPES.BROWSER;
    });
    let hasFileMigrators = migrators.some(migrator => {
      return migrator.type == MigrationWizardConstants.MIGRATOR_TYPES.FILE;
    });
    if (!hasBrowserMigrators && !allowOnlyFileMigrators) {
      this.setComponentState({
        page: MigrationWizardConstants.PAGES.NO_BROWSERS_FOUND,
        hasFileMigrators,
      });
      this.#sendTelemetryEvent("noBrowsersFound");
    } else {
      this.setComponentState({
        migrators,
        page: MigrationWizardConstants.PAGES.SELECTION,
        showImportAll: lazy.SHOW_IMPORT_ALL_PREF,
        migratorKey,
        fileImportErrorMessage,
      });
    }
  }

  /**
   * General event handler function for events dispatched from the
   * <migration-wizard> component.
   *
   * @param {Event} event
   *   The DOM event being handled.
   * @returns {Promise}
   */
  async handleEvent(event) {
    this.#wizardEl = event.target;

    switch (event.type) {
      case "MigrationWizard:RequestState": {
        this.#sendTelemetryEvent("opened");
        await this.#requestState(
          event.detail?.allowOnlyFileMigrators,
          event.detail?.migratorKey
        );
        break;
      }

      case "MigrationWizard:BeginMigration": {
        let extraArgs = this.#recordBeginMigrationEvent(event.detail);

        let hasPermissions = await this.sendQuery("CheckPermissions", {
          key: event.detail.key,
          type: event.detail.type,
        });

        if (!hasPermissions) {
          if (event.detail.key == "safari") {
            this.#sendTelemetryEvent("safariPerms");
            this.setComponentState({
              page: MigrationWizardConstants.PAGES.SAFARI_PERMISSION,
            });
          } else {
            console.error(
              `A migrator with key ${event.detail.key} needs permissions, ` +
                "and no UI exists for that right now."
            );
          }
          return;
        }

        await this.beginMigration(event.detail, extraArgs);
        break;
      }

      case "MigrationWizard:RequestSafariPermissions": {
        let success = await this.sendQuery("RequestSafariPermissions");
        if (success) {
          let extraArgs = this.#constructExtraArgs(event.detail);
          await this.beginMigration(event.detail, extraArgs);
        }
        break;
      }

      case "MigrationWizard:SelectManualPasswordFile": {
        let path = await this.sendQuery("SelectManualPasswordFile");
        if (path) {
          event.detail.manualPasswordFilePath = path;

          let passwordResourceIndex = event.detail.resourceTypes.indexOf(
            MigrationWizardConstants.DISPLAYED_RESOURCE_TYPES.PASSWORDS
          );
          event.detail.resourceTypes.splice(passwordResourceIndex, 1);

          let extraArgs = this.#constructExtraArgs(event.detail);
          await this.beginMigration(event.detail, extraArgs);
        }
        break;
      }

      case "MigrationWizard:OpenAboutAddons": {
        this.sendAsyncMessage("OpenAboutAddons");
        break;
      }

      case "MigrationWizard:PermissionsNeeded": {
        // In theory, the migrator permissions might be requested on any
        // platform - but in practice, this only happens on Linux, so that's
        // why the event is named linux_perms.
        this.#sendTelemetryEvent("linuxPerms", {
          migrator_key: event.detail.key,
        });
        break;
      }

      case "MigrationWizard:GetPermissions": {
        let success = await this.sendQuery("GetPermissions", {
          key: event.detail.key,
        });
        if (success) {
          await this.#requestState(true /* allowOnlyFileMigrators */);
        }
        break;
      }

      case "MigrationWizard:OpenURL": {
        this.sendAsyncMessage("OpenURL", {
          url: event.detail.url,
          where: event.detail.where,
        });
        break;
      }

      case "MigrationWizard:LaunchMacOSPasswordsApp": {
        this.sendAsyncMessage("LaunchMacOSPasswordsApp");
        break;
      }
    }
  }

  async #requestState(allowOnlyFileMigrators, migratorKey) {
    this.setComponentState({
      page: MigrationWizardConstants.PAGES.LOADING,
    });

    await this.#populateMigrators(allowOnlyFileMigrators, migratorKey);

    this.#wizardEl.dispatchEvent(
      new this.contentWindow.CustomEvent("MigrationWizard:Ready", {
        bubbles: true,
      })
    );
  }

  /**
   * Sends a message to the parent actor to record Event Telemetry.
   *
   * @param {string} type
   *   The type of event being recorded.
   * @param {object} [args=null]
   *   Optional extra_args to supply for the event.
   */
  #sendTelemetryEvent(type, args) {
    this.sendAsyncMessage("RecordEvent", { type, args });
  }

  /**
   * Constructs extra arguments to pass to some Event Telemetry based
   * on the MigrationDetails passed up from the MigrationWizard.
   *
   * See migration-wizard.mjs for a definition of MigrationDetails.
   *
   * @param {object} migrationDetails
   *   A MigrationDetails object.
   * @returns {object}
   */
  #constructExtraArgs(migrationDetails) {
    let extraArgs = {
      migrator_key: migrationDetails.key,
      history: "0",
      formdata: "0",
      passwords: "0",
      bookmarks: "0",
      payment_methods: "0",
      extensions: "0",
      other: 0,
    };

    for (let type of migrationDetails.resourceTypes) {
      switch (type) {
        case MigrationWizardConstants.DISPLAYED_RESOURCE_TYPES.HISTORY: {
          extraArgs.history = "1";
          break;
        }

        case MigrationWizardConstants.DISPLAYED_RESOURCE_TYPES.FORMDATA: {
          extraArgs.formdata = "1";
          break;
        }

        case MigrationWizardConstants.DISPLAYED_RESOURCE_TYPES.PASSWORDS: {
          extraArgs.passwords = "1";
          break;
        }

        case MigrationWizardConstants.DISPLAYED_RESOURCE_TYPES.BOOKMARKS: {
          extraArgs.bookmarks = "1";
          break;
        }

        case MigrationWizardConstants.DISPLAYED_RESOURCE_TYPES.EXTENSIONS: {
          extraArgs.extensions = "1";
          break;
        }

        case MigrationWizardConstants.DISPLAYED_RESOURCE_TYPES
          .PAYMENT_METHODS: {
          extraArgs.payment_methods = "1";
          break;
        }

        default: {
          extraArgs.other++;
        }
      }
    }

    return extraArgs;
  }

  /**
   * This migration wizard combines a lot of steps (selecting the browser, profile,
   * resources, and starting the migration) into a single page. This helper method
   * records Event Telemetry for each of those actions at the same time when a
   * migration begins.
   *
   * This method returns the extra_args object that was constructed for the
   * resources_selected and migration_started event so that a
   * "migration_finished" event can use the same extra_args without
   * regenerating it.
   *
   * See migration-wizard.mjs for a definition of MigrationDetails.
   *
   * @param {object} migrationDetails
   *   A MigrationDetails object.
   * @returns {object}
   */
  #recordBeginMigrationEvent(migrationDetails) {
    this.#sendTelemetryEvent("browserSelected", {
      migrator_key: migrationDetails.key,
    });

    if (migrationDetails.profile) {
      this.#sendTelemetryEvent("profileSelected", {
        migrator_key: migrationDetails.key,
      });
    }

    let extraArgs = this.#constructExtraArgs(migrationDetails);

    extraArgs.configured = String(Number(migrationDetails.expandedDetails));
    this.#sendTelemetryEvent("resourcesSelected", extraArgs);
    delete extraArgs.configured;

    this.#sendTelemetryEvent("migrationStarted", extraArgs);
    return extraArgs;
  }

  /**
   * Sends a message to the parent actor to attempt a migration.
   *
   * See migration-wizard.mjs for a definition of MigrationDetails.
   *
   * @param {object} migrationDetails
   *   A MigrationDetails object.
   * @param {object} extraArgs
   *   Extra argument object to pass to the Event Telemetry for finishing
   *   the migration.
   * @returns {Promise<undefined>}
   *   Returns a Promise that resolves after the parent responds to the migration
   *   message.
   */
  async beginMigration(migrationDetails, extraArgs) {
    // We redirect to manual password import for browsers that require a CSV file.
    if (
      migrationDetails.resourceTypes.includes(
        MigrationWizardConstants.DISPLAYED_RESOURCE_TYPES.PASSWORDS
      ) &&
      !migrationDetails.manualPasswordFilePath
    ) {
      if (migrationDetails.key == "safari") {
        this.#sendTelemetryEvent("safariPasswordFile");
        this.setComponentState({
          page: MigrationWizardChild.isMacOSSequoiaOrLater()
            ? MigrationWizardConstants.PAGES.SAFARI_PASSWORD_PERMISSION
            : MigrationWizardConstants.PAGES
                .SAFARI_PASSWORD_PERMISSION_PRE_SEQUOIA,
        });
        return;
      } else if (
        migrationDetails.key == "chrome" &&
        AppConstants.platform == "win"
      ) {
        this.#sendTelemetryEvent("chromePasswordFile");
        this.setComponentState({
          page: MigrationWizardConstants.PAGES
            .CHROME_WINDOWS_PASSWORD_PERMISSION,
        });
        return;
      }
    }

    extraArgs = await this.sendQuery("Migrate", {
      migrationDetails,
      extraArgs,
    });
    this.#sendTelemetryEvent("migrationFinished", extraArgs);

    this.#wizardEl.dispatchEvent(
      new this.contentWindow.CustomEvent("MigrationWizard:DoneMigration", {
        bubbles: true,
      })
    );
  }

  /**
   * General message handler function for messages received from the
   * associated MigrationWizardParent JSWindowActor.
   *
   * @param {ReceiveMessageArgument} message
   *   The message received from the MigrationWizardParent.
   */
  receiveMessage(message) {
    switch (message.name) {
      case "UpdateProgress": {
        this.setComponentState({
          page: MigrationWizardConstants.PAGES.PROGRESS,
          progress: message.data.progress,
          key: message.data.key,
        });
        break;
      }
      case "UpdateFileImportProgress": {
        this.setComponentState({
          page: MigrationWizardConstants.PAGES.FILE_IMPORT_PROGRESS,
          progress: message.data.progress,
          title: message.data.title,
        });
        break;
      }
      case "FileImportProgressError": {
        this.#populateMigrators(
          true,
          message.data.migratorKey,
          message.data.fileImportErrorMessage
        );
        break;
      }
    }
  }

  /**
   * Calls the `setState` method on the <migration-wizard> component. The
   * state is cloned into the execution scope of this.#wizardEl.
   *
   * @param {object} state The state object that a <migration-wizard>
   *   component expects. See the documentation for the element's setState
   *   method for more details.
   */
  setComponentState(state) {
    if (!this.#wizardEl) {
      return;
    }
    // We waive XrayWrappers in the event that the element is embedded in
    // a document without system privileges, like about:welcome.
    Cu.waiveXrays(this.#wizardEl).setState(
      Cu.cloneInto(
        state,
        // documentGlobal doesn't exist in content windows.
        // eslint-disable-next-line mozilla/use-documentGlobal
        this.#wizardEl.ownerDocument.defaultView
      )
    );
  }
}
