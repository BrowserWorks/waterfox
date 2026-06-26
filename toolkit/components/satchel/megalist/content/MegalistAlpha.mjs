/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, when } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
});

// Directly import moz-button here, otherwise, moz-button will be loaded and upgraded on DOMContentLoaded, after MegalistAlpha is first updated.
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";

// eslint-disable-next-line import/no-unassigned-import
import { PasswordCard } from "chrome://global/content/megalist/components/password-card/password-card.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/megalist/components/login-form/login-form.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/megalist/components/notification-message-bar/notification-message-bar.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/megalist/components/virtual-passwords-list/virtual-passwords-list.mjs";

// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/sidebar/sidebar-panel-header.mjs";

const DISPLAY_MODES = {
  ALERTS: "DisplayAlerts",
  ALL: "DisplayAll",
};

const VIEW_MODES = {
  LIST: "List",
  ADD: "Add",
  EDIT: "Edit",
  ALERTS: "Alerts",
};

const INPUT_CHANGE_DELAY = 300;

export class MegalistAlpha extends MozLitElement {
  constructor() {
    super();
    this.searchText = "";
    this.records = [];
    this.header = null;
    this.notification = null;
    this.reauthResolver = null;
    this.displayMode = DISPLAY_MODES.ALL;
    this.inputChangeTimeout = null;
    this.viewMode = VIEW_MODES.LIST;
    this.selectedRecord = null;
    this.sidebarHiding = false;
    this.shouldShowPrimaryPasswordAuth = false;

    // This is used to force re-rendering the virtual list after receiving snapshot
    this.listVersion = 0;

    window.addEventListener("MessageFromViewModel", ev =>
      this.#onMessageFromViewModel(ev)
    );
    window.addEventListener("SidebarWillShow", () => {
      this.sidebarHiding = false;
    });
    window.addEventListener("SidebarWillHide", ev => {
      this.sidebarHiding = true;
      this.#onSidebarWillHide(ev);
    });
  }

  static get properties() {
    return {
      selectedRecord: { type: Object },
      searchText: { type: String },
      records: { type: Array },
      header: { type: Object },
      notification: { type: Object },
      displayMode: { type: String },
      viewMode: { type: String },
      shouldShowPrimaryPasswordAuth: { type: Boolean },
    };
  }

  updated(changedProperties) {
    if (changedProperties.has("viewMode")) {
      const oldViewMode = changedProperties.get("viewMode");
      if (oldViewMode == VIEW_MODES.EDIT && this.viewMode === VIEW_MODES.LIST) {
        // If we are switching from EDIT to LIST mode when `sidebarHiding` is true,
        // we need to hide the sidebar because we blocked it from hiding
        // previously when the user was editing a password.
        if (this.sidebarHiding) {
          const { BrowserWindowTracker } = ChromeUtils.importESModule(
            "resource:///modules/BrowserWindowTracker.sys.mjs"
          );
          const window = BrowserWindowTracker.getTopWindow({
            allowFromInactiveWorkspace: true,
          });
          window.SidebarController.hide();
        }
      }
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.#messageToViewModel("Refresh");
    this.#sendCommand("UpdateDisplayMode", { value: this.displayMode });
  }

  async getUpdateComplete() {
    await super.getUpdateComplete();
    const passwordCards = Array.from(
      this.shadowRoot.querySelectorAll("password-card")
    );
    await Promise.all(passwordCards.map(el => el.updateComplete));
  }

  #onPasswordRevealClick(concealed, lineIndex) {
    if (concealed) {
      this.#messageToViewModel("Command", {
        commandId: "Reveal",
        snapshotId: lineIndex,
      });
    } else {
      this.#messageToViewModel("Command", {
        commandId: "Conceal",
        snapshotId: lineIndex,
      });
    }
  }

  #onMessageFromViewModel({ detail }) {
    const functionName = `receive${detail.name}`;
    if (!(functionName in this)) {
      console.warn(`Received unknown message "${detail.name}"`);
    }
    this[functionName]?.(detail.data);
  }

  #onInputChange(e) {
    const searchText = e.target.value;
    this.searchText = searchText;
    this.viewMode = VIEW_MODES.LIST;
    this.selectedRecord = null;

    this.#debounce(
      () => this.#messageToViewModel("UpdateFilter", { searchText }),
      INPUT_CHANGE_DELAY
    )();
  }

  #onAddButtonClick(trigger) {
    this.viewMode = VIEW_MODES.ADD;
    this.#recordToolbarAction("add_new", trigger);
  }

  #onRadioButtonChange(e) {
    this.displayMode = e.target.value;
    this.#sendCommand("UpdateDisplayMode", { value: this.displayMode });

    let gleanAction =
      this.displayMode === DISPLAY_MODES.ALL
        ? "list_state_all"
        : "list_state_alerts";
    this.#recordToolbarAction(gleanAction, "toolbar");
  }

  #hasPendingEditChange(loginFromForm) {
    return !lazy.LoginHelper.doLoginsMatch(
      {
        username: this.selectedRecord.username.value,
        password: this.selectedRecord.password.value,
        origin: this.selectedRecord.origin.href,
      },
      loginFromForm,
      {}
    );
  }

  #onCancelLoginForm(loginFromForm) {
    if (
      this.viewMode == VIEW_MODES.EDIT &&
      this.#hasPendingEditChange(loginFromForm)
    ) {
      this.#sendCommand("DiscardChanges");
      return;
    }

    this.viewMode = VIEW_MODES.LIST;
    this.notification = null;
  }

  #onSaveLoginForm(loginForm) {
    if (this.viewMode == VIEW_MODES.ADD) {
      this.#sendCommand("AddLogin", { value: loginForm });
    } else if (this.viewMode == VIEW_MODES.EDIT) {
      if (!this.#hasPendingEditChange(loginForm)) {
        this.viewMode = VIEW_MODES.LIST;
        return;
      }
      loginForm.guid = this.selectedRecord.origin.guid;
      this.#sendCommand("UpdateLogin", {
        value: loginForm,
      });
      this.#sendCommand("Cancel", {}, this.selectedRecord.password.lineIndex);
    }
  }

  #openMenu(e) {
    const panelList = this.shadowRoot.querySelector("panel-list");
    const menuButton = this.shadowRoot.querySelector(
      "#more-options-menubutton"
    );
    menuButton.setAttribute("aria-expanded", "true");

    panelList.addEventListener(
      "hidden",
      () => menuButton.setAttribute("aria-expanded", "false"),
      { once: true }
    );

    panelList.toggle(e);
  }

  #recordToolbarAction(action, trigger = "") {
    Glean.contextualManager.toolbarAction.record({
      trigger,
      option_name: action,
    });
  }

  #recordNotificationShown(id) {
    const gleanNotificationString = id.replaceAll("-", "_");
    Glean.contextualManager.notificationShown.record({
      notification_detail: gleanNotificationString,
    });
  }

  #messageToViewModel(messageName, data) {
    window.windowGlobalChild
      .getActor("Megalist")
      .sendAsyncMessage(messageName, data);
  }

  #sendCommand(commandId, options = {}, snapshotId = 0) {
    // TODO(Bug 1913302): snapshotId should be optional for global commands.
    // Right now, we always pass 0 and overwrite when needed.
    this.#messageToViewModel("Command", {
      commandId,
      snapshotId,
      ...options,
    });
  }

  receiveShowSnapshots({ snapshots }) {
    const [header, records] = this.#createLoginRecords(snapshots);
    this.header = header;
    this.records = records;
  }

  receiveSnapshot({ snapshotId, snapshot }) {
    const recordIndex = Math.floor((snapshotId - 1) / 3);
    const field = snapshot.field;
    this.records[recordIndex][field] = snapshot;
    this.requestUpdate();

    this.listVersion += 1;
  }

  receiveSetNotification(notification) {
    this.#recordNotificationShown(notification.id);
    this.notification = notification;
    this.viewMode = notification.viewMode ?? this.viewMode;
  }

  receiveSetDisplayMode(displayMode) {
    this.displayMode = displayMode;
  }

  receiveReauthResponse(isAuthorized) {
    this.reauthResolver?.(isAuthorized);
  }

  receiveDiscardChangesConfirmed() {
    this.viewMode = VIEW_MODES.LIST;
    this.selectedRecord = null;
    this.notification = null;
  }

  reauthCommandHandler(commandFn) {
    return new Promise((resolve, _reject) => {
      this.reauthResolver = resolve;
      commandFn();
    });
  }

  receivePrimaryPasswordAuthenticated(authenticated) {
    this.shouldShowPrimaryPasswordAuth = !authenticated;
  }

  #createLoginRecords(snapshots) {
    const header = snapshots.shift();
    const records = [];

    for (let i = 0; i < snapshots.length; i += 3) {
      records.push({
        origin: snapshots[i],
        username: snapshots[i + 1],
        password: snapshots[i + 2],
      });
    }

    return [header, records];
  }

  #debounce(callback, delay) {
    return () => {
      clearTimeout(this.inputChangeTimeout);
      this.inputChangeTimeout = setTimeout(() => {
        callback();
      }, delay);
    };
  }

  #onSidebarWillHide(e) {
    // Prevent hiding the sidebar if a password is being edited and show a
    // message asking to confirm if the user wants to discard their changes.
    if (this.viewMode != VIEW_MODES.EDIT) {
      return;
    }

    const loginForm = this.shadowRoot.querySelector("login-form");
    const loginFromForm = {
      origin: loginForm.originValue || loginForm.originField.input.value,
      username: loginForm.usernameField.input.value.trim(),
      password: loginForm.passwordField.value,
    };
    if (this.#hasPendingEditChange(loginFromForm)) {
      this.#sendCommand("DiscardChanges");
      e.preventDefault();
    }
  }

  #handleNoLoginsFocusInOrOut(isFocusIn) {
    const group = this.shadowRoot.querySelector(".no-logins-card-buttons");
    const btns = group.querySelectorAll("moz-button");

    btns.forEach(btn => {
      btn.setAttribute("tabindex", isFocusIn ? "-1" : "0");
    });
  }

  #handleNoLoginsKeydown(e) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
      return;
    }

    const browserBtn = this.shadowRoot.querySelector(
      ".empty-state-import-from-browser"
    );
    const fileBtn = this.shadowRoot.querySelector(
      ".empty-state-import-from-file"
    );
    const addBtn = this.shadowRoot.querySelector(".empty-state-add-password");
    const focusables = [browserBtn, fileBtn, addBtn];
    const currentIndex = focusables.findIndex(el =>
      el.shadowRoot?.contains(e.composedTarget)
    );

    e.preventDefault();

    const direction = e.key === "ArrowUp" ? -1 : 1;
    const newIndex = currentIndex + direction;

    if (newIndex >= 0 && newIndex < focusables.length) {
      focusables[newIndex]?.focus();
    }
  }

  heightCalculator = items =>
    items.reduce((sum, item) => sum + PasswordCard.getItemHeight(item), 0);

  itemTemplate = ({ origin: displayOrigin, username, password }, index) => {
    return html` <password-card
      @keydown=${e => {
        if (e.shiftKey && e.key === "Tab") {
          e.preventDefault();
          this.shadowRoot.querySelector(".passwords-list").focus();
        } else if (e.key === "Tab") {
          e.preventDefault();
          const webContent = lazy.BrowserWindowTracker.getTopWindow({
            allowFromInactiveWorkspace: true,
          }).gBrowser.selectedTab.linkedBrowser;
          webContent.focus();
        }
      }}
      role="group"
      aria-label=${displayOrigin.value}
      .origin=${displayOrigin}
      .username=${username}
      .password=${password}
      .messageToViewModel=${this.#messageToViewModel.bind(this)}
      .reauthCommandHandler=${commandFn => this.reauthCommandHandler(commandFn)}
      .onPasswordRevealClick=${(concealed, lineIndex) =>
        this.#onPasswordRevealClick(concealed, lineIndex)}
      .handleEditButtonClick=${() => {
        this.viewMode = VIEW_MODES.EDIT;
        this.selectedRecord = this.records[index];
      }}
      .handleViewAlertClick=${() => {
        this.viewMode = VIEW_MODES.ALERTS;
        this.selectedRecord = this.records[index];
      }}
    >
    </password-card>`;
  };

  renderList() {
    const scroller = this.shadowRoot.querySelector(
      ".sidebar-panel-scrollable-content"
    );

    return this.records.length
      ? html`
          <virtual-passwords-list
            class="passwords-list"
            role="listbox"
            tabindex="0"
            data-l10n-id="contextual-manager-passwords-list-label"
            @keydown=${e => {
              // Handle up/down arrow key navigation between password cards.
              if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
                return;
              }

              const passwordsList = e.currentTarget;

              let active = this.shadowRoot.activeElement;
              let cardToFocus;
              if (active === passwordsList) {
                if (e.key === "ArrowDown") {
                  cardToFocus = passwordsList.querySelector("password-card");
                }
              } else {
                const cards = Array.from(
                  passwordsList.querySelectorAll("password-card")
                );
                const currentIndex = cards.findIndex(card => card === active);
                let nextIndex =
                  e.key === "ArrowUp" ? currentIndex - 1 : currentIndex + 1;
                if (nextIndex < 0 || nextIndex >= cards.length) {
                  return;
                }
                cardToFocus = cards[nextIndex];
              }

              if (cardToFocus) {
                e.preventDefault();
                cardToFocus.focusByKeyEvent(e);
              }
            }}
            .items=${this.records}
            .scroller=${scroller}
            .version=${this.listVersion}
            .itemHeightEstimate=${PasswordCard.DEFAULT_PASSWORD_CARD_HEIGHT}
            .heightCalculator=${this.heightCalculator}
            .template=${this.itemTemplate}
          >
          </virtual-passwords-list>
        `
      : this.renderEmptyState();
  }

  renderAlertsList() {
    const { origin, username, password } = this.selectedRecord;
    const alerts = [
      {
        displayAlert: origin.breached,
        notification: origin.breachedNotification,
      },
      {
        displayAlert: password.vulnerable,
        notification: password.vulnerableNotification,
      },
      {
        displayAlert: !username.value.length,
        notification: username.noUsernameNotification,
      },
    ];

    const handleButtonClick = async () => {
      const isAuthenticated = await this.reauthCommandHandler(() =>
        this.#messageToViewModel("Command", {
          commandId: "Edit",
          snapshotId: this.selectedRecord.password.lineIndex,
        })
      );

      if (!isAuthenticated) {
        return;
      }

      this.viewMode = VIEW_MODES.EDIT;
    };

    const getIconSrc = () => {
      return document.dir === "rtl"
        ? // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
          "chrome://browser/skin/forward.svg"
        : // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
          "chrome://browser/skin/back.svg";
    };

    return html`
      <moz-card
        class="alert-card"
        data-l10n-id="contextual-manager-passwords-alert-card"
      >
        <moz-button
          type="icon ghost"
          iconSrc=${getIconSrc()}
          data-l10n-id="contextual-manager-passwords-alert-back-button"
          @click=${() => (this.viewMode = VIEW_MODES.LIST)}
        >
        </moz-button>
        <ul data-l10n-id="contextual-manager-passwords-alert-list">
          ${alerts.map(({ displayAlert, notification }) =>
            when(
              displayAlert,
              () => {
                this.#recordNotificationShown(notification.id);
                return html`
                  <li>
                    <notification-message-bar
                      exportparts="support-link"
                      .notification=${{
                        ...notification,
                        onButtonClick: handleButtonClick,
                      }}
                      .messageHandler=${(commandId, options) =>
                        this.#sendCommand(commandId, options)}
                    >
                    </notification-message-bar>
                  </li>
                `;
              },
              () => ""
            )
          )}
        </ul>
      </moz-card>
    `;
  }

  renderEmptyState() {
    if (this.header) {
      const { total, count } = this.header.value;
      if (!total) {
        return this.renderNoLoginsCard();
      } else if (!count) {
        return this.renderEmptySearchResults();
      }
    }

    return "";
  }

  renderNoLoginsCard() {
    return html`
      <moz-card class="empty-state-card">
        <div
          role="region"
          class="no-logins-card-content"
          aria-labelledby="no-logins-card-heading"
        >
          <img
            src="chrome://branding/content/about-logo.svg"
            role="presentation"
            alt=""
          />
          <strong
            class="no-logins-card-heading"
            data-l10n-id="contextual-manager-passwords-no-passwords-header-2"
          ></strong>
          <p
            data-l10n-id="contextual-manager-passwords-no-passwords-message"
          ></p>
          <p
            data-l10n-id="contextual-manager-passwords-no-passwords-get-started-message"
          ></p>
          <div
            class="no-logins-card-buttons"
            @focusin=${() => this.#handleNoLoginsFocusInOrOut(true)}
            @focusout=${() => this.#handleNoLoginsFocusInOrOut(false)}
            @keydown=${this.#handleNoLoginsKeydown}
          >
            <moz-button
              class="empty-state-import-from-browser"
              data-l10n-id="contextual-manager-passwords-command-import-from-browser"
              type="primary"
              @click=${() => {
                this.#sendCommand("ImportFromBrowser");
                this.#recordToolbarAction("import_browser", "empty_state_card");
              }}
            ></moz-button>
            <moz-button
              class="empty-state-import-from-file"
              data-l10n-id="contextual-manager-passwords-command-import"
              @click=${() => {
                this.#sendCommand("Import");
                this.#recordToolbarAction("import_file", "empty_state_card");
              }}
            ></moz-button>
            <moz-button
              class="empty-state-add-password"
              data-l10n-id="contextual-manager-passwords-add-manually"
              @click=${() => this.#onAddButtonClick("empty_state_card")}
            ></moz-button>
          </div>
        </div>
      </moz-card>
    `;
  }

  renderEmptySearchResults() {
    return html` <moz-card
      class="empty-state-card"
      data-l10n-id="contextual-manager-passwords-no-passwords-found-header"
    >
      <div
        id="no-results-message"
        class="empty-search-results"
        data-l10n-id="contextual-manager-passwords-no-passwords-found-message-2"
      ></div>
    </moz-card>`;
  }

  renderContent() {
    switch (this.viewMode) {
      case VIEW_MODES.LIST:
        return this.renderList();
      case VIEW_MODES.ADD:
        return html` <login-form
          .onClose=${() => this.#onCancelLoginForm()}
          .onSaveClick=${loginFromForm => this.#onSaveLoginForm(loginFromForm)}
        >
        </login-form>`;
      case VIEW_MODES.EDIT:
        return html` <login-form
          type="edit"
          originValue=${this.selectedRecord.origin.href}
          usernameValue=${this.selectedRecord.username.value}
          ?passwordVisible=${!this.selectedRecord.password.concealed}
          .passwordValue=${this.selectedRecord.password.value}
          .onPasswordRevealClick=${() =>
            this.#onPasswordRevealClick(
              this.selectedRecord.password.concealed,
              this.selectedRecord.password.lineIndex
            )}
          .onClose=${loginFromForm => this.#onCancelLoginForm(loginFromForm)}
          .onSaveClick=${loginFromForm => this.#onSaveLoginForm(loginFromForm)}
          .onDeleteClick=${() => {
            const login = {
              origin: this.selectedRecord.origin,
              guid: this.selectedRecord.origin.guid,
            };
            this.#sendCommand("DeleteLogin", { value: login });
          }}
          .onOriginClick=${e => {
            e.preventDefault();
            this.#sendCommand("OpenLink", {
              value: this.selectedRecord.origin.href,
            });
          }}
        >
        </login-form>`;
      case VIEW_MODES.ALERTS:
        return this.renderAlertsList();
      default:
        return "";
    }
  }

  renderSearch() {
    const hasResults = this.records.length;
    const describedBy = hasResults ? "" : "no-results-message";
    return html`
      <div
        class="search-container"
        @click=${() => {
          this.shadowRoot.querySelector(".search").focus();
        }}
      >
        <div class="search-icon"></div>
        <input
          class="search"
          type="search"
          data-l10n-id="contextual-manager-filter-input"
          .value=${this.searchText}
          aria-describedby=${describedBy}
          @input=${e => this.#onInputChange(e)}
        />
      </div>
    `;
  }

  renderRadioButtons() {
    return html`
      <div
        data-l10n-id="contextual-manager-passwords-radiogroup-label"
        role="radiogroup"
      >
        <input
          @change=${this.#onRadioButtonChange}
          .checked=${this.displayMode === DISPLAY_MODES.ALL}
          type="radio"
          id="allLogins"
          name="logins"
          .value=${DISPLAY_MODES.ALL}
        />
        <label
          for="allLogins"
          data-l10n-id="contextual-manager-passwords-radiobutton-all"
          data-l10n-args=${JSON.stringify({ total: this.header.value.total })}
        ></label>

        <input
          @change=${this.#onRadioButtonChange}
          .checked=${this.displayMode === DISPLAY_MODES.ALERTS}
          type="radio"
          id="alerts"
          name="logins"
          .value=${DISPLAY_MODES.ALERTS}
        />
        <label
          for="alerts"
          data-l10n-id="contextual-manager-passwords-radiobutton-alerts"
          data-l10n-args=${JSON.stringify({ total: this.header.value.alerts })}
        ></label>
      </div>
    `;
  }

  renderMenu() {
    return html`
      <moz-button
        @click=${this.#openMenu}
        @mousedown=${e => {
          e.stopPropagation();
        }}
        type="icon ghost"
        iconSrc="chrome://global/skin/icons/more.svg"
        aria-expanded="false"
        aria-haspopup="menu"
        data-l10n-id="contextual-manager-menu-more-options-button"
        id="more-options-menubutton"
      ></moz-button>
      <panel-list
        role="menu"
        aria-labelledby="more-options-menubutton"
        data-l10n-id="contextual-manager-more-options-popup"
      >
        <panel-item
          action="add-password"
          data-l10n-id="contextual-manager-passwords-command-create"
          @click=${() => this.#onAddButtonClick("toolbar")}
        ></panel-item>
        <panel-item
          action="import-from-browser"
          data-l10n-id="contextual-manager-passwords-command-import-from-browser"
          @click=${() => {
            this.#sendCommand("ImportFromBrowser");
            this.#recordToolbarAction("import_browser", "toolbar");
          }}
        ></panel-item>
        <panel-item
          action="import-from-file"
          data-l10n-id="contextual-manager-passwords-command-import"
          @click=${() => {
            this.#sendCommand("Import");
            this.#recordToolbarAction("import_file", "toolbar");
          }}
        ></panel-item>
        <panel-item
          action="export-logins"
          data-l10n-id="contextual-manager-passwords-command-export"
          @click=${() => {
            this.#sendCommand("Export");
            this.#recordToolbarAction("export", "toolbar");
          }}
          ?disabled=${!this.header?.value.total}
        ></panel-item>
        <panel-item
          action="remove-all-logins"
          data-l10n-id="contextual-manager-passwords-command-remove-all"
          @click=${() => {
            this.#sendCommand("RemoveAll");
            this.#recordToolbarAction("remove_all", "toolbar");
          }}
          ?disabled=${!this.header?.value.total}
        ></panel-item>
        <hr />
        <panel-item
          action="open-preferences"
          data-l10n-id="contextual-manager-passwords-command-options"
          @click=${() => {
            const command = this.header.commands.find(
              command => command.id === "Settings"
            );
            this.#sendCommand("OpenLink", { value: command.url });
            this.#recordToolbarAction("preferences", "toolbar");
          }}
        ></panel-item>
        <panel-item
          action="open-help"
          data-l10n-id="contextual-manager-passwords-command-help"
          @click=${() => {
            const command = this.header.commands.find(
              command => command.id === "Help"
            );
            this.#sendCommand("OpenLink", { value: command.url });
            this.#recordToolbarAction("help", "toolbar");
          }}
        ></panel-item>
      </panel-list>
    `;
  }

  renderToolbar() {
    return html`
      <div class="first-row">${this.renderSearch()} ${this.renderMenu()}</div>
      ${this.header
        ? html` <div class="second-row">${this.renderRadioButtons()}</div> `
        : ""}
    `;
  }

  async #scrollPasswordCardIntoView(guid) {
    this.viewMode = VIEW_MODES.LIST;

    const matchingRecordIndex = this.records.findIndex(
      record => record.origin.guid === guid
    );
    if (matchingRecordIndex === -1) {
      return;
    }

    const scroll = async () => {
      // Virtual list is ready at this point, but the password card might not be render
      // because it is not in the viewport. So we need to update the activeIndex so that
      // the password card is created.
      const virtualList = this.shadowRoot.querySelector(
        "virtual-passwords-list"
      );
      virtualList.activeIndex = matchingRecordIndex;
      await virtualList.updateComplete;

      const passwordCard = virtualList.getItem(matchingRecordIndex);
      await passwordCard.updateComplete;
      passwordCard.scrollIntoView({ block: "center" });
      passwordCard.originLine.focus();
    };

    const virtualList = this.shadowRoot.querySelector("virtual-passwords-list");
    let sublist = virtualList?.getSubListForItem(matchingRecordIndex);
    if (!sublist) {
      this.addEventListener("virtual-list-ready", () => scroll(), {
        once: true,
      });
    } else {
      scroll();
    }
  }

  renderNotification() {
    if (!this.notification) {
      return "";
    }

    return html`
      <notification-message-bar
        exportparts="support-link"
        .notification=${this.notification}
        .onDismiss=${() => {
          this.notification = null;
        }}
        .messageHandler=${(commandId, options, snapshotId) =>
          this.#sendCommand(commandId, options, snapshotId)}
        @view-login=${e => this.#scrollPasswordCardIntoView(e.detail.guid)}
      >
      </notification-message-bar>
    `;
  }

  renderReauthPrimaryPassword() {
    return html`
      <moz-card class="empty-state-card">
        <div class="reauth-card-content">
          <img
            src="chrome://branding/content/about-logo.svg"
            role="presentation"
            alt=""
          />
          <strong
            class="no-logins-card-heading"
            data-l10n-id="contextual-manager-primary-password-reauth-header"
          ></strong>
          <a
            is="moz-support-link"
            data-l10n-id="contextual-manager-primary-password-learn-more-link"
            support-page="primary-password-stored-logins"
            @click=${e => {
              e.preventDefault();
              this.#sendCommand("OpenLink", {
                value:
                  "https://support.mozilla.org/en-US/kb/use-primary-password-protect-stored-logins",
              });
            }}
          >
          </a>
          <div class="no-logins-card-buttons">
            <moz-button
              class="empty-state-import-from-browser"
              data-l10n-id="contextual-manager-primary-password-reauth-button"
              type="primary"
              @click=${() => {
                this.#messageToViewModel("ReauthPrimaryPassword");
              }}
            ></moz-button>
          </div>
        </div>
      </moz-card>
    `;
  }

  renderAuthenticatedView() {
    return html`${this.renderNotification()} ${this.renderContent()}`;
  }

  render() {
    const showToolbar =
      this.viewMode === VIEW_MODES.LIST && this.header?.value?.total > 0;

    return html`
      <link
        rel="stylesheet"
        href="chrome://global/content/megalist/megalist.css"
      />
      <link
        rel="stylesheet"
        href="chrome://browser/content/sidebar/sidebar.css"
      />
      <div
        class="container sidebar-panel"
        aria-labelledby="sidebar-menu-cpm-header"
      >
        <sidebar-panel-header
          data-l10n-id="sidebar-menu-cpm-header"
          data-l10n-attrs="heading"
          view="viewCPMSidebar"
        >
          ${when(!this.shouldShowPrimaryPasswordAuth && showToolbar, () =>
            this.renderToolbar()
          )}
        </sidebar-panel-header>
        <div class="sidebar-panel-scrollable-content">
          ${!this.shouldShowPrimaryPasswordAuth
            ? this.renderAuthenticatedView()
            : this.renderReauthPrimaryPassword()}
        </div>
      </div>
    `;
  }
}

customElements.define("megalist-alpha", MegalistAlpha);
