/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * @import { PanelList,  PanelItem } from "chrome://global/content/elements/panel-list.mjs"
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

import {
  UrlbarProvider,
  UrlbarUtils,
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserTestUtils: "resource://testing-common/BrowserTestUtils.sys.mjs",
  BrowserUIUtils: "resource:///modules/BrowserUIUtils.sys.mjs",
  DEFAULT_FORM_HISTORY_PARAM:
    "moz-src:///toolkit/components/search/SearchSuggestionController.sys.mjs",
  ExperimentAPI: "resource://nimbus/ExperimentAPI.sys.mjs",
  FormHistoryTestUtils:
    "resource://testing-common/FormHistoryTestUtils.sys.mjs",
  NimbusFeatures: "resource://nimbus/ExperimentAPI.sys.mjs",
  NimbusTestUtils: "resource://testing-common/NimbusTestUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  TestUtils: "resource://testing-common/TestUtils.sys.mjs",
  UrlbarController:
    "moz-src:///browser/components/urlbar/UrlbarController.sys.mjs",
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
  UrlbarSearchUtils:
    "moz-src:///browser/components/urlbar/UrlbarSearchUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "clipboardHelper",
  "@mozilla.org/widget/clipboardhelper;1",
  Ci.nsIClipboardHelper
);

/**
 * Utility class for testing <html:moz-urlbar> elements.
 */
class UrlbarInputTestUtils {
  /**
   * @param {(window: ChromeWindow) => UrlbarInput} getUrlbarInputForWindow
   */
  constructor(getUrlbarInputForWindow) {
    this.#urlbar = getUrlbarInputForWindow;
  }

  /**
   * This maps the categories used by the FX_SEARCHBAR_SELECTED_RESULT_METHOD
   * histogram to its indexes in the `labels` array. This only needs to be
   * used by tests that need to map from category names to indexes in histogram
   * snapshots. Actual app code can use these category names directly when
   * they add to a histogram.
   */
  SELECTED_RESULT_METHODS = {
    enter: 0,
    enterSelection: 1,
    click: 2,
    arrowEnterSelection: 3,
    tabEnterSelection: 4,
    rightClickEnter: 5,
  };

  // Fallback to the console.
  info = console.log;

  /**
   * Running this init allows helpers to access test scope helpers, like Assert
   * and SimpleTest. Note this initialization is not enforced, thus helpers
   * should always check the properties set here and provide a fallback path.
   *
   * @param {object} scope The global scope where tests are being run.
   */
  init(scope) {
    if (!scope) {
      throw new Error("Must initialize UrlbarInputTestUtils with a test scope");
    }
    // If you add other properties to `this`, null them in uninit().
    this.Assert = scope.Assert;
    this.info = scope.info;
    this.registerCleanupFunction = scope.registerCleanupFunction;

    if (Services.env.exists("XPCSHELL_TEST_PROFILE_DIR")) {
      this.initXPCShellDependencies();
    } else {
      // xpcshell doesn't support EventUtils.
      this.EventUtils = scope.EventUtils;
      this.SimpleTest = scope.SimpleTest;
    }

    this.registerCleanupFunction(() => {
      this.Assert = null;
      this.info = console.log;
      this.registerCleanupFunction = null;
      this.EventUtils = null;
      this.SimpleTest = null;
    });
  }

  /**
   * Waits to a search to be complete.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   */
  async promiseSearchComplete(win) {
    let waitForQuery = async () => {
      await this.promisePopupOpen(win, () => {});
      // Re-read `lastQueryContextPromise` after each await in case the query
      // was restarted (e.g., by the `reopenOnBlur` mechanism in
      // `promiseAutocompleteResultPopup`), and wait for the latest query.
      let promise;
      let context;
      do {
        promise = this.#urlbar(win).lastQueryContextPromise;
        context = await promise;
      } while (this.#urlbar(win).lastQueryContextPromise !== promise);
      return context;
    };
    /** @type {UrlbarQueryContext} */
    let context = await waitForQuery();
    if (this.#urlbar(win).searchMode) {
      // Search mode may start a second query.
      context = await waitForQuery();
    }
    if (this.#urlbar(win).view.oneOffSearchButtons?._rebuilding) {
      await new Promise(resolve =>
        this.#urlbar(win).view.oneOffSearchButtons.addEventListener(
          "rebuild",
          resolve,
          {
            once: true,
          }
        )
      );
    }
    return context;
  }

  /**
   * Starts a search for a given string and waits for the search to be complete.
   *
   * @param {object} options The options object.
   * @param {ChromeWindow} options.window The window containing the urlbar
   * @param {string} options.value the search string
   * @param {Function} options.waitForFocus The SimpleTest function
   * @param {boolean} [options.fireInputEvent] whether an input event should be
   *        used when starting the query (simulates the user's typing, sets
   *        userTypedValued, triggers engagement event telemetry, etc.)
   * @param {number} [options.selectionStart] The input's selectionStart
   * @param {number} [options.selectionEnd] The input's selectionEnd
   * @param {boolean} [options.reopenOnBlur] Whether this method should repoen
   *        the view if the input is blurred before the query finishes. This is
   *        necessary to work around spurious blurs in CI, which close the view
   *        and cancel the query, defeating the typical use of this method where
   *        your test waits for the query to finish. However, this behavior
   *        isn't always desired, for example if your test intentionally blurs
   *        the input before the query finishes. In that case, pass false.
   * @returns {Promise}
   *   The promise for the last query context.
   */
  async promiseAutocompleteResultPopup({
    window,
    value,
    waitForFocus,
    fireInputEvent = true,
    selectionStart = -1,
    selectionEnd = -1,
    reopenOnBlur = true,
  }) {
    if (this.SimpleTest) {
      await this.SimpleTest.promiseFocus(window);
    } else {
      await new Promise(resolve => waitForFocus(resolve, window));
    }

    const setup = () => {
      this.#urlbar(window).focus();
      // Using the value setter in some cases may trim and fetch unexpected
      // results, then pick an alternate path.
      if (
        lazy.UrlbarPrefs.get("trimURLs") &&
        value != lazy.BrowserUIUtils.trimURL(value)
      ) {
        this.#urlbar(window)._setValue(value);
        fireInputEvent = true;
      } else {
        this.#urlbar(window).value = value;
      }
      if (selectionStart >= 0 && selectionEnd >= 0) {
        this.#urlbar(window).selectionEnd = selectionEnd;
        this.#urlbar(window).selectionStart = selectionStart;
      }

      // An input event will start a new search, so be careful not to start a
      // search if we fired an input event since that would start two searches.
      if (fireInputEvent) {
        // This is necessary to get the urlbar to set gBrowser.userTypedValue.
        this.fireInputEvent(window);
      } else {
        this.#urlbar(window).setPageProxyState("invalid");
        this.#urlbar(window).startQuery();
      }
    };
    setup();

    // In Linux TV test, as there is case that the input field lost the focus
    // until showing popup, timeout failure happens since the expected poup
    // never be shown. To avoid this, if losing the focus, retry setup to open
    // popup.
    if (reopenOnBlur) {
      this.#urlbar(window).inputField.addEventListener("blur", setup, {
        once: true,
      });
    }
    const result = await this.promiseSearchComplete(window);
    if (reopenOnBlur) {
      this.#urlbar(window).inputField.removeEventListener("blur", setup);
    }
    return result;
  }

  /**
   * Waits for a result to be added at a certain index. Since we implement lazy
   * results replacement, even if we have a result at an index, it may be
   * related to the previous query, this methods ensures the result is current.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @param {number} index The index to look for
   * @throws {Error} When the index exceeds the number of available results
   */
  async waitForAutocompleteResultAt(win, index) {
    // TODO Bug 1530338: Quantum Bar doesn't yet implement lazy results replacement.
    await this.promiseSearchComplete(win);
    let container = this.getResultsContainer(win);
    if (index >= container.children.length) {
      throw new Error("Not enough results");
    }
    return container.children[index];
  }

  /**
   * Returns the oneOffSearchButtons object for the urlbar.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @returns {object} The oneOffSearchButtons
   */
  getOneOffSearchButtons(win) {
    return this.#urlbar(win).view.oneOffSearchButtons;
  }

  /**
   * Returns a specific button of a result.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @param {string} buttonName The name of the button, e.g. "menu", "0", etc.
   * @param {number} resultIndex The index of the result
   * @returns {HTMLSpanElement} The button
   */
  getButtonForResultIndex(win, buttonName, resultIndex) {
    return this.getRowAt(win, resultIndex).querySelector(
      `.urlbarView-button-${buttonName}`
    );
  }

  /**
   * Returns the UrlbarInput input element for the requested window.
   *
   * @param {ChromeWindow} window
   * @returns {UrlbarInput}
   */
  getUrlbar(window) {
    return this.#urlbar(window);
  }

  /**
   * Show the result menu button regardless of the result being hovered or
   + selected.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   */
  disableResultMenuAutohide(win) {
    let container = this.getResultsContainer(win);
    let attr = "disable-resultmenu-autohide";
    container.toggleAttribute(attr, true);
    this.registerCleanupFunction?.(() => {
      container.toggleAttribute(attr, false);
    });
  }

  /**
   * Opens the result menu of a specific result.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @param {object} [options] The options object.
   * @param {number} [options.resultIndex] The index of the result. Defaults
   *        to the current selected index.
   * @param {boolean} [options.byMouse] Whether to open the menu by mouse or
   *        keyboard.
   * @param {string} [options.activationKey] Key to activate the button with,
   *        defaults to KEY_Enter.
   */
  async openResultMenu(
    win,
    {
      resultIndex = this.#urlbar(win).view.selectedRowIndex,
      byMouse = false,
      activationKey = "KEY_Enter",
    } = {}
  ) {
    this.Assert?.ok(this.#urlbar(win).view.isOpen, "view should be open");
    let menuButton = this.getButtonForResultIndex(
      win,
      "result-menu",
      resultIndex
    );
    this.Assert?.ok(
      menuButton,
      `found the menu button at result index ${resultIndex}`
    );
    let promiseMenuOpen = lazy.BrowserTestUtils.waitForEvent(
      this.#urlbar(win).view.resultMenu,
      "popupshown"
    );
    if (byMouse) {
      this.info(
        `synthesizing mousemove on row to make the menu button visible`
      );
      await this.EventUtils.promiseElementReadyForUserInput(
        menuButton.closest(".urlbarView-row"),
        win,
        this.info
      );
      this.info(`got mousemove, now clicking the menu button`);
      this.EventUtils.synthesizeMouseAtCenter(menuButton, {}, win);
      this.info(`waiting for the menu popup to open via mouse`);
    } else {
      this.info(`selecting the result at index ${resultIndex}`);
      while (this.#urlbar(win).view.selectedRowIndex != resultIndex) {
        this.EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
      }
      if (this.getSelectedElement(win) != menuButton) {
        this.EventUtils.synthesizeKey("KEY_Tab", {}, win);
      }
      this.Assert?.equal(
        this.getSelectedElement(win),
        menuButton,
        `selected the menu button at result index ${resultIndex}`
      );
      this.EventUtils.synthesizeKey(activationKey, {}, win);
      this.info(`waiting for ${activationKey} to open the menu popup`);
    }
    await promiseMenuOpen;
    this.Assert?.equal(
      this.#urlbar(win).view.resultMenu.state,
      "open",
      "Checking popup state"
    );
  }

  /**
   * Opens the result menu of a specific result and gets a menu item by either
   * accesskey or command name. Either `accesskey` or `command` must be given.
   *
   * @param {object} options
   *   The options object.
   * @param {ChromeWindow} options.window
   *   The window containing the urlbar.
   * @param {string} [options.accesskey]
   *   The access key of the menu item to return.
   * @param {string} [options.command]
   *   The command name of the menu item to return.
   * @param {number} [options.resultIndex]
   *   The index of the result. Defaults to the current selected index.
   * @param {boolean} [options.openByMouse]
   *   Whether to open the menu by mouse or keyboard.
   * @param {Array} [options.submenuSelectors]
   *   If the command is in the top-level result menu, leave this as an empty
   *   array. If it's in a submenu, set this to an array where each element i is
   *   a selector that can be used to get the i'th menu item that opens a
   *   submenu.
   * @returns {Promise<XULElement>}
   *   Returns the menu item element.
   */
  async openResultMenuAndGetItem({
    window,
    accesskey,
    command,
    resultIndex = this.#urlbar(window).view.selectedRowIndex,
    openByMouse = false,
    submenuSelectors = [],
  }) {
    await this.openResultMenu(window, { resultIndex, byMouse: openByMouse });

    // Open the sequence of submenus that contains the item.
    for (let selector of submenuSelectors) {
      let menuitem =
        this.#urlbar(window).view.resultMenu.querySelector(selector);
      if (!menuitem) {
        throw new Error("Submenu item not found for selector: " + selector);
      }

      let promisePopup = lazy.BrowserTestUtils.waitForEvent(
        this.#urlbar(window).view.resultMenu,
        "popupshown"
      );

      if (AppConstants.platform == "macosx") {
        // Synthesized clicks don't work in the native Mac menu.
        this.info(
          "Calling openMenu() on submenu item with selector: " + selector
        );
        menuitem.openMenu(true);
      } else {
        this.info("Clicking submenu item with selector: " + selector);
        this.EventUtils.synthesizeMouseAtCenter(menuitem, {}, window);
      }

      this.info("Waiting for submenu popupshown event");
      await promisePopup;
      this.info("Got the submenu popupshown event");
    }

    // Now get the item.
    let menuitem;
    if (accesskey) {
      await lazy.BrowserTestUtils.waitForCondition(() => {
        menuitem = this.#urlbar(window).view.resultMenu.querySelector(
          `menuitem[accesskey=${accesskey}]`
        );
        return menuitem;
      }, "Waiting for strings to load");
    } else if (command) {
      menuitem = this.#urlbar(window).view.resultMenu.querySelector(
        `menuitem[data-command=${command}]`
      );
    } else {
      throw new Error("accesskey or command must be specified");
    }

    return menuitem;
  }

  /**
   * Opens the result menu of a specific result and presses an access key to
   * activate a menu item.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @param {string} accesskey The access key to press once the menu is open
   * @param {object} [options] The options object.
   * @param {number} [options.resultIndex] The index of the result. Defaults
   *        to the current selected index.
   * @param {boolean} [options.openByMouse] Whether to open the menu by mouse
   *        or keyboard.
   */
  async openResultMenuAndPressAccesskey(
    win,
    accesskey,
    {
      resultIndex = this.#urlbar(win).view.selectedRowIndex,
      openByMouse = false,
    } = {}
  ) {
    let menuitem = await this.openResultMenuAndGetItem({
      accesskey,
      resultIndex,
      openByMouse,
      window: win,
    });
    if (!menuitem) {
      throw new Error("Menu item not found for accesskey: " + accesskey);
    }

    let promiseCommand = lazy.BrowserTestUtils.waitForEvent(
      this.#urlbar(win).view.resultMenu,
      "command"
    );

    if (AppConstants.platform == "macosx") {
      // The native Mac menu doesn't support access keys.
      this.info("calling doCommand() to activate menu item");
      menuitem.doCommand();
      this.#urlbar(win).view.resultMenu.hidePopup(true);
    } else {
      this.info(`pressing access key (${accesskey}) to activate menu item`);
      this.EventUtils.synthesizeKey(accesskey, {}, win);
    }

    this.info("waiting for command event");
    await promiseCommand;
    this.info("got the command event");
  }

  /**
   * Opens the result menu of a specific result and clicks a menu item with a
   * specified command name.
   *
   * @param {ChromeWindow} win
   *   The window containing the urlbar.
   * @param {string|Array} commandOrArray
   *   If the command is in the top-level result menu, set this to the command
   *   name. If it's in a submenu, set this to an array where each element i is
   *   a selector that can be used to click the i'th menu item that opens a
   *   submenu, and the last element is the command name.
   * @param {object} options
   *   The options object.
   * @param {number} [options.resultIndex]
   *   The index of the result. Defaults to the current selected index.
   * @param {boolean} [options.openByMouse]
   *   Whether to open the menu by mouse or keyboard.
   */
  async openResultMenuAndClickItem(
    win,
    commandOrArray,
    {
      resultIndex = this.#urlbar(win).view.selectedRowIndex,
      openByMouse = false,
    } = {}
  ) {
    let submenuSelectors = Array.isArray(commandOrArray)
      ? commandOrArray
      : [commandOrArray];
    let command = submenuSelectors.pop();

    let menuitem = await this.openResultMenuAndGetItem({
      resultIndex,
      openByMouse,
      command,
      submenuSelectors,
      window: win,
    });
    if (!menuitem) {
      throw new Error("Menu item not found for command: " + command);
    }

    let promiseCommand = lazy.BrowserTestUtils.waitForEvent(
      this.#urlbar(win).view.resultMenu,
      "command"
    );

    if (AppConstants.platform == "macosx") {
      // Synthesized clicks don't work in the native Mac menu.
      this.info("calling doCommand() to activate menu item");
      menuitem.doCommand();
      this.#urlbar(win).view.resultMenu.hidePopup(true);
    } else {
      this.info("Clicking menu item with command: " + command);
      this.EventUtils.synthesizeMouseAtCenter(menuitem, {}, win);
    }

    this.info("Waiting for command event");
    await promiseCommand;
    this.info("Got the command event");
  }

  /**
   * Finds a non-autofill result matching the given URL and type in the
   * currently open results panel, selects it with arrow keys, and presses
   * Enter to load it. The search must be complete before calling this, since
   * it starts with a synchronous getResultCount call.
   *
   * @param {ChromeWindow} win The window containing the urlbar.
   * @param {string} url The URL to match against the result's payload.
   * @param {number} [type] The UrlbarUtils.RESULT_TYPE to match.
   *   Defaults to RESULT_TYPE.URL.
   */
  async pickResultAndWaitForLoad(win, url, type = UrlbarUtils.RESULT_TYPE.URL) {
    let resultCount = this.getResultCount(win);
    let targetIndex = -1;
    for (let i = 0; i < resultCount; i++) {
      let d = await this.getDetailsOfResultAt(win, i);
      if (
        !d.autofill &&
        d.result.payload.url === url &&
        d.result.type === type
      ) {
        targetIndex = i;
        break;
      }
    }
    this.Assert.notEqual(targetIndex, -1, "Should find the result in panel");

    let loadPromise = lazy.BrowserTestUtils.browserLoaded(
      win.gBrowser.selectedBrowser
    );
    while (this.getSelectedRowIndex(win) !== targetIndex) {
      this.EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
    }
    this.EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await loadPromise;
  }

  /**
   * Returns true if the oneOffSearchButtons are visible.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @returns {boolean} True if the buttons are visible.
   */
  getOneOffSearchButtonsVisible(win) {
    let buttons = this.getOneOffSearchButtons(win);
    return buttons.style.display != "none" && !buttons.container.hidden;
  }

  /**
   * Gets an abstracted representation of the result at an index.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @param {number} index The index to look for
   * @returns {Promise<object>} An object with numerous properties describing the result.
   */
  async getDetailsOfResultAt(win, index) {
    let element = await this.waitForAutocompleteResultAt(win, index);
    let details = {};
    let result = element.result;
    details.result = result;
    let { url, postData } = UrlbarUtils.getUrlFromResult(result);
    details.url = url;
    details.postData = postData;
    details.type = result.type;
    details.source = result.source;
    details.heuristic = result.heuristic;
    details.autofill = !!result.autofill;
    details.image =
      element.getElementsByClassName("urlbarView-favicon")[0]?.src;
    details.title = result.getDisplayableValueAndHighlights("title").value;
    details.tags = "tags" in result.payload ? result.payload.tags : [];
    details.isSponsored = result.payload.isSponsored;
    details.userContextId = result.payload.userContextId;
    let actions = element.getElementsByClassName("urlbarView-action");
    let urls = element.getElementsByClassName("urlbarView-url");
    let typeIcon = element.querySelector(".urlbarView-type-icon");
    await win.document.l10n.translateFragment(element);
    details.displayed = {
      title: element.getElementsByClassName("urlbarView-title")[0]?.textContent,
      action: actions.length ? actions[0].textContent : null,
      url: urls.length ? urls[0].textContent : null,
      typeIcon: typeIcon
        ? win.getComputedStyle(typeIcon)["background-image"]
        : null,
    };
    details.element = {
      action: element.getElementsByClassName("urlbarView-action")[0],
      row: element,
      separator: element.getElementsByClassName(
        "urlbarView-title-separator"
      )[0],
      title: element.getElementsByClassName("urlbarView-title")[0],
      url: element.getElementsByClassName("urlbarView-url")[0],
    };
    if (details.type == UrlbarUtils.RESULT_TYPE.SEARCH) {
      details.searchParams = {
        engine: result.payload.engine,
        keyword: result.payload.keyword,
        query: result.payload.query,
        suggestion: result.payload.suggestion,
        inPrivateWindow: result.payload.inPrivateWindow,
        isPrivateEngine: result.payload.isPrivateEngine,
      };
    } else if (details.type == UrlbarUtils.RESULT_TYPE.KEYWORD) {
      details.keyword = result.payload.keyword;
    } else if (details.type == UrlbarUtils.RESULT_TYPE.DYNAMIC) {
      details.dynamicType = result.payload.dynamicType;
    }
    return details;
  }

  /**
   * Gets the currently selected element.
   *
   * @param {ChromeWindow} win The window containing the urlbar.
   * @returns {HtmlElement|XulElement} The selected element.
   */
  getSelectedElement(win) {
    return this.#urlbar(win).view.selectedElement || null;
  }

  /**
   * Gets the index of the currently selected element.
   *
   * @param {ChromeWindow} win The window containing the urlbar.
   * @returns {number} The selected index.
   */
  getSelectedElementIndex(win) {
    return this.#urlbar(win).view.selectedElementIndex;
  }

  /**
   * Gets the row at a specific index.
   *
   * @param {ChromeWindow} win The window containing the urlbar.
   * @param {number} index The index to look for.
   * @returns {HTMLElement|XulElement} The selected row.
   */
  getRowAt(win, index) {
    return this.getResultsContainer(win).children.item(index);
  }

  /**
   * Gets the currently selected row. If the selected element is a descendant of
   * a row, this will return the ancestor row.
   *
   * @param {ChromeWindow} win The window containing the urlbar.
   * @returns {HTMLElement|XulElement} The selected row.
   */
  getSelectedRow(win) {
    return this.getRowAt(win, this.getSelectedRowIndex(win));
  }

  /**
   * Gets the index of the currently selected element.
   *
   * @param {ChromeWindow} win The window containing the urlbar.
   * @returns {number} The selected row index.
   */
  getSelectedRowIndex(win) {
    return this.#urlbar(win).view.selectedRowIndex;
  }

  /**
   * Selects the element at the index specified.
   *
   * @param {ChromeWindow} win The window containing the urlbar.
   * @param {number} index The index to select.
   */
  setSelectedRowIndex(win, index) {
    this.#urlbar(win).view.selectedRowIndex = index;
  }

  /**
   * Gets the results container div for the address bar.
   *
   * @param {ChromeWindow} win
   * @returns {HTMLDivElement}
   */
  getResultsContainer(win) {
    return this.#urlbar(win).view.panel.querySelector(".urlbarView-results");
  }

  /**
   * Gets the number of results.
   * You must wait for the query to be complete before using this.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @returns {number} the number of results.
   */
  getResultCount(win) {
    return this.getResultsContainer(win).children.length;
  }

  /**
   * Ensures at least one search suggestion is present.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @returns {Promise<number>}
   *   The index of the first suggestion
   * @throws {Error} When the index exceeds the number of available results
   */
  promiseSuggestionsPresent(win) {
    // TODO Bug 1530338: Quantum Bar doesn't yet implement lazy results replacement. When
    // we do that, we'll have to be sure the suggestions we find are relevant
    // for the current query. For now let's just wait for the search to be
    // complete.
    return this.promiseSearchComplete(win).then(context => {
      // Look for search suggestions.
      let firstSearchSuggestionIndex = context.results.findIndex(
        r => r.type == UrlbarUtils.RESULT_TYPE.SEARCH && r.payload.suggestion
      );
      if (firstSearchSuggestionIndex == -1) {
        throw new Error("Cannot find a search suggestion");
      }
      return firstSearchSuggestionIndex;
    });
  }

  /**
   * Waits for the given number of connections to an http server.
   *
   * @param {object} httpserver an HTTP Server instance
   * @param {number} count Number of connections to wait for
   * @returns {Promise} resolved when all the expected connections were started.
   */
  promiseSpeculativeConnections(httpserver, count) {
    if (!httpserver) {
      throw new Error("Must provide an http server");
    }
    return lazy.BrowserTestUtils.waitForCondition(
      () => httpserver.connectionNumber == count,
      "Waiting for speculative connection setup"
    );
  }

  /**
   * Waits for the popup to be shown.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @param {Function} openFn Function to be used to open the popup.
   * @returns {Promise} resolved once the popup is closed
   */
  async promisePopupOpen(win, openFn) {
    if (!openFn) {
      throw new Error("openFn should be supplied to promisePopupOpen");
    }
    await openFn();
    let urlbar = this.#urlbar(win);
    if (urlbar.view.isOpen) {
      return;
    }
    this.info("Waiting for the urlbar view to open");
    await new Promise(resolve => {
      urlbar.controller.addListener({
        onViewOpen() {
          urlbar.controller.removeListener(this);
          resolve();
        },
      });
    });
    this.info("Urlbar view opened");
  }

  /**
   * Waits for the popup to be hidden.
   *
   * @param {ChromeWindow} win The window containing the urlbar
   * @param {Function} [closeFn] Function to be used to close the popup, if not
   *        supplied it will default to a closing the popup directly.
   * @returns {Promise} resolved once the popup is closed
   */
  async promisePopupClose(win, closeFn = null) {
    let urlbar = this.#urlbar(win);
    let closePromise = new Promise(resolve => {
      if (!urlbar.view.isOpen) {
        resolve();
        return;
      }
      urlbar.controller.addListener({
        onViewClose() {
          urlbar.controller.removeListener(this);
          resolve();
        },
      });
    });
    if (closeFn) {
      this.info("Awaiting custom close function");
      await closeFn();
      this.info("Done awaiting custom close function");
    } else {
      this.info("Closing the view directly");
      urlbar.view.close();
    }
    this.info("Waiting for the view to close");
    await closePromise;
    this.info("Urlbar view closed");
  }

  /**
   * Open the input field context menu and run a task on it.
   *
   * @param {ChromeWindow} win the current window
   * @param {(popup: MozMenuPopup) => Promise<void>|void} task
   *   A task function to run. Gets the contextmenu popup as argument.
   */
  async withContextMenu(win, task) {
    let textBox = this.#urlbar(win).querySelector("moz-input-box");
    let cxmenu = textBox.menupopup;
    let openPromise = lazy.BrowserTestUtils.waitForEvent(cxmenu, "popupshown");
    this.EventUtils.synthesizeMouseAtCenter(
      this.#urlbar(win).inputField,
      {
        type: "contextmenu",
        button: 2,
      },
      win
    );
    await openPromise;
    // On Mac sometimes the menuitems are not ready.
    await new Promise(win.requestAnimationFrame);
    try {
      await task(cxmenu);
    } finally {
      // Close the context menu if the task didn't pick anything.
      if (cxmenu.state == "open" || cxmenu.state == "showing") {
        let closePromise = lazy.BrowserTestUtils.waitForEvent(
          cxmenu,
          "popuphidden"
        );
        cxmenu.hidePopup();
        await closePromise;
      }
    }
  }

  /**
   * Opens the moz-urlbar context menu by synthesizing a click.
   * Activates a menu item that is specified by an id.
   *
   * @param {ChromeWindow} win
   *   The current window.
   * @param {string} anonid
   *   Identifier of a menu item of the url bar context menu.
   * @returns {Promise<void>}
   *   The menuitem that has the corresponding identifier.
   */
  async activateContextMenuItem(win, anonid) {
    await this.withContextMenu(win, popup => {
      let mozInputBox = popup.parentNode;
      let menuitem = mozInputBox.getMenuItem(anonid);
      this.Assert.ok(
        lazy.BrowserTestUtils.isVisible(menuitem),
        "Menu item is visible"
      );
      this.Assert.ok(
        lazy.BrowserTestUtils.isVisible(menuitem),
        "Menu item is visible"
      );
      this.Assert.ok(!menuitem.disabled, "Menu item enabled");
      menuitem.closest("menupopup").activateItem(menuitem);
    });
  }

  /**
   * Opens the moz-urlbar context menu by synthesizing a click.
   * Returns a menu item that is specified by an id.
   *
   * @param {ChromeWindow} win
   *   The current window.
   * @param {string} anonid
   *   Identifier of a menu item of the url bar context menu.
   * @returns {Promise<MozMenuItem>}
   *   The menuitem that has the corresponding identifier.
   */
  async getContextMenuItem(win, anonid) {
    let menuitem;
    await this.withContextMenu(win, popup => {
      let mozInputBox = popup.parentNode;
      menuitem = mozInputBox.getMenuItem(anonid);
    });
    return menuitem;
  }

  /**
   * @param {ChromeWindow} win The browser window
   * @returns {boolean} Whether the popup is open
   */
  isPopupOpen(win) {
    return this.#urlbar(win).view.isOpen;
  }

  /**
   * Asserts that the input is in a given search mode, or no search mode. Can
   * only be used if UrlbarTestUtils has been initialized with init().
   *
   * @param {ChromeWindow} window
   *   The browser window.
   * @param {object} expectedSearchMode
   *   The expected search mode object.
   */
  async assertSearchMode(window, expectedSearchMode) {
    this.Assert.equal(
      !!this.#urlbar(window).searchMode,
      this.#urlbar(window).hasAttribute("searchmode"),
      "Urlbar should never be in search mode without the corresponding attribute."
    );

    this.Assert.equal(
      !!this.#urlbar(window).searchMode,
      !!expectedSearchMode,
      "searchMode should exist on moz-urlbar"
    );

    let results = this.#urlbar(window).querySelector(".urlbarView-results");
    await lazy.BrowserTestUtils.waitForCondition(
      () =>
        results.hasAttribute("actionmode") ==
        (this.#urlbar(window).searchMode?.source ==
          UrlbarUtils.RESULT_SOURCE.ACTIONS)
    );
    this.Assert.ok(true, "Urlbar results have proper actionmode attribute");

    if (!expectedSearchMode) {
      // Check the input's placeholder.
      const prefName =
        "browser.urlbar.placeholderName" +
        (lazy.PrivateBrowsingUtils.isWindowPrivate(window) ? ".private" : "");
      let engineName = Services.prefs.getStringPref(prefName, "");
      let keywordEnabled = Services.prefs.getBoolPref("keyword.enabled");

      let expectedPlaceholder;
      if (this.#urlbar(window).sapName == "searchbar") {
        expectedPlaceholder = { id: "searchbar-input" };
      } else if (keywordEnabled && engineName) {
        expectedPlaceholder = {
          id: "urlbar-placeholder-with-name",
          args: { name: engineName },
        };
      } else if (keywordEnabled && !engineName) {
        expectedPlaceholder = { id: "urlbar-placeholder" };
      } else {
        expectedPlaceholder = { id: "urlbar-placeholder-keyword-disabled" };
      }

      await lazy.BrowserTestUtils.waitForCondition(() => {
        let l10nAttributes = window.document.l10n.getAttributes(
          this.#urlbar(window).inputField
        );
        return (
          l10nAttributes.id == expectedPlaceholder.id &&
          l10nAttributes.args?.name == expectedPlaceholder.args?.name
        );
      });
      this.Assert.ok(
        true,
        "Expected placeholder l10n when search mode is inactive"
      );
      return;
    }

    // Default to full search mode for less verbose tests.
    expectedSearchMode = { ...expectedSearchMode };
    if (!expectedSearchMode.hasOwnProperty("isPreview")) {
      expectedSearchMode.isPreview = false;
    }

    let isGeneralPurposeEngine = false;
    if (expectedSearchMode.engineName) {
      let engine = lazy.SearchService.getEngineByName(
        expectedSearchMode.engineName
      );
      isGeneralPurposeEngine = engine.isGeneralPurposeEngine;
      expectedSearchMode.isGeneralPurposeEngine = isGeneralPurposeEngine;
    }

    // expectedSearchMode may come from UrlbarUtils.LOCAL_SEARCH_MODES.  The
    // objects in that array include useful metadata like icon URIs and pref
    // names that are not usually included in actual search mode objects.  For
    // convenience, ignore those properties if they aren't also present in the
    // urlbar's actual search mode object.
    let ignoreProperties = [
      "icon",
      "pref",
      "restrict",
      "telemetryLabel",
      "uiLabel",
    ];
    for (let prop of ignoreProperties) {
      if (
        prop in expectedSearchMode &&
        !(prop in this.#urlbar(window).searchMode)
      ) {
        this.info(
          `Ignoring unimportant property '${prop}' in expected search mode`
        );
        delete expectedSearchMode[prop];
      }
    }

    this.Assert.deepEqual(
      this.#urlbar(window).searchMode,
      expectedSearchMode,
      "Expected searchMode"
    );

    // Only the addressbar still has the legacy search mode indicator.
    if (this.#urlbar(window).sapName == "urlbar") {
      // Check the textContent and l10n attributes of the indicator and label.
      let expectedTextContent = "";
      let expectedL10n = { id: null, args: null };
      if (expectedSearchMode.engineName) {
        expectedTextContent = expectedSearchMode.engineName;
      } else if (expectedSearchMode.source) {
        let name = UrlbarUtils.getResultSourceName(expectedSearchMode.source);
        this.Assert.ok(name, "Expected result source should have a name");
        expectedL10n = { id: `urlbar-search-mode-${name}`, args: null };
      } else {
        this.Assert.ok(false, "Unexpected searchMode");
      }

      if (expectedTextContent) {
        this.Assert.equal(
          this.#urlbar(window)._searchModeIndicatorTitle.textContent,
          expectedTextContent,
          "Expected textContent"
        );
      }
      this.Assert.deepEqual(
        window.document.l10n.getAttributes(
          this.#urlbar(window)._searchModeIndicatorTitle
        ),
        expectedL10n,
        "Expected l10n"
      );
    }

    // Check the input's placeholder.
    let expectedPlaceholderL10n;
    if (this.#urlbar(window).sapName == "searchbar") {
      // Placeholder stays constant in searchbar.
      expectedPlaceholderL10n = {
        id: "searchbar-input",
        args: null,
      };
    } else if (expectedSearchMode.engineName) {
      expectedPlaceholderL10n = {
        id: isGeneralPurposeEngine
          ? "urlbar-placeholder-search-mode-web-2"
          : "urlbar-placeholder-search-mode-other-engine",
        args: { name: expectedSearchMode.engineName },
      };
    } else if (expectedSearchMode.source) {
      let name = UrlbarUtils.getResultSourceName(expectedSearchMode.source);
      expectedPlaceholderL10n = {
        id: `urlbar-placeholder-search-mode-other-${name}`,
        args: null,
      };
    }
    this.Assert.deepEqual(
      window.document.l10n.getAttributes(this.#urlbar(window).inputField),
      expectedPlaceholderL10n,
      "Expected placeholder l10n when search mode is active"
    );

    // If this is an engine search mode, check that all results are either
    // search results with the same engine or have the same host as the engine.
    // Search mode preview can show other results since it is not supposed to
    // start a query.
    if (
      expectedSearchMode.engineName &&
      !expectedSearchMode.isPreview &&
      this.isPopupOpen(window)
    ) {
      let resultCount = this.getResultCount(window);
      for (let i = 0; i < resultCount; i++) {
        let result = await this.getDetailsOfResultAt(window, i);
        if (result.source == UrlbarUtils.RESULT_SOURCE.SEARCH) {
          this.Assert.equal(
            expectedSearchMode.engineName,
            result.searchParams.engine,
            "Search mode result matches engine name."
          );
        } else {
          let engine = lazy.SearchService.getEngineByName(
            expectedSearchMode.engineName
          );
          let engineRootDomain =
            lazy.UrlbarSearchUtils.getRootDomainFromEngine(engine);
          let resultUrl = new URL(result.url);
          this.Assert.ok(
            resultUrl.hostname.includes(engineRootDomain),
            "Search mode result matches engine host."
          );
        }
      }
    }
  }

  /**
   * Enters search mode by clicking a one-off.  The view must already be open
   * before you call this. Can only be used if UrlbarTestUtils has been
   * initialized with init().
   *
   * @param {ChromeWindow} window
   *   The window to operate on.
   * @param {object} searchMode
   *   If given, the one-off matching this search mode will be clicked; it
   *   should be a full search mode object as described in
   *   UrlbarInput.setSearchMode.  If not given, the first one-off is clicked.
   */
  async enterSearchMode(window, searchMode = null) {
    this.info(`Enter Search Mode ${JSON.stringify(searchMode)}`);

    // Ensure any pending query is complete.
    await this.promiseSearchComplete(window);

    // Ensure the the one-offs are finished rebuilding and visible.
    let oneOffs = this.getOneOffSearchButtons(window);
    await lazy.TestUtils.waitForCondition(
      () => !oneOffs._rebuilding,
      "Waiting for one-offs to finish rebuilding"
    );
    this.Assert.equal(
      UrlbarTestUtils.getOneOffSearchButtonsVisible(window),
      true,
      "One-offs are visible"
    );

    let buttons = oneOffs.getSelectableButtons(true);
    if (!searchMode) {
      searchMode = { engineName: buttons[0].engine.name };
      let engine = lazy.SearchService.getEngineByName(searchMode.engineName);
      if (engine.isGeneralPurposeEngine) {
        searchMode.source = UrlbarUtils.RESULT_SOURCE.SEARCH;
      }
    }

    if (!searchMode.entry) {
      searchMode.entry = "oneoff";
    }

    let oneOff = buttons.find(o =>
      searchMode.engineName
        ? o.engine.name == searchMode.engineName
        : o.source == searchMode.source
    );
    this.Assert.ok(oneOff, "Found one-off button for search mode");
    this.EventUtils.synthesizeMouseAtCenter(oneOff, {}, window);
    await this.promiseSearchComplete(window);
    this.Assert.ok(this.isPopupOpen(window), "Urlbar view is still open.");
    await this.assertSearchMode(window, searchMode);
  }

  /**
   * Removes the scheme from an url according to user prefs.
   *
   * @param {string} url
   *  The url that is supposed to be trimmed.
   * @param {object} [options]
   *  Options for the trimming.
   * @param {boolean} [options.removeSingleTrailingSlash]
   *    Remove trailing slash, when trimming enabled.
   * @returns {string}
   *  The sanitized URL.
   */
  trimURL(url, { removeSingleTrailingSlash = true } = {}) {
    if (!lazy.UrlbarPrefs.get("trimURLs")) {
      return url;
    }

    let sanitizedURL = url;
    if (removeSingleTrailingSlash) {
      sanitizedURL =
        lazy.BrowserUIUtils.removeSingleTrailingSlashFromURL(sanitizedURL);
    }

    // Also remove emphasis markers if present.
    if (lazy.UrlbarPrefs.getScotchBonnetPref("trimHttps")) {
      sanitizedURL = sanitizedURL.replace(/^<?https:\/\/>?/, "");
    } else {
      sanitizedURL = sanitizedURL.replace(/^<?http:\/\/>?/, "");
    }

    return sanitizedURL;
  }

  /**
   * Returns the trimmed protocol with slashes.
   *
   * @returns {string} The trimmed protocol including slashes. Returns an empty
   *                   string, when the protocol trimming is disabled.
   */
  getTrimmedProtocolWithSlashes() {
    if (Services.prefs.getBoolPref("browser.urlbar.trimURLs")) {
      return lazy.UrlbarPrefs.getScotchBonnetPref("trimHttps")
        ? "https://"
        : "http://"; // eslint-disable-line @microsoft/sdl/no-insecure-url
    }
    return "";
  }

  /**
   * Exits search mode. If neither `backspace` nor `clickClose` is given, we'll
   * default to backspacing. Can only be used if UrlbarTestUtils has been
   * initialized with init().
   *
   * @param {ChromeWindow} window
   *   The window to operate on.
   * @param {object} options
   *   Options object
   * @param {boolean} [options.backspace]
   *   Exits search mode by backspacing at the beginning of the search string.
   * @param {boolean} [options.clickClose]
   *   Exits search mode by clicking the close button on the search mode
   *   indicator.
   * @param {boolean} [options.waitForSearch]
   *   Whether the test should wait for a search after exiting search mode.
   *   Defaults to true.
   */
  async exitSearchMode(
    window,
    { backspace, clickClose, waitForSearch = true } = {}
  ) {
    let urlbar = this.#urlbar(window);
    if (!backspace && !clickClose) {
      backspace = true;
    }

    if (backspace) {
      urlbar.focus();
      let urlbarValue = urlbar.value;
      urlbar.selectionStart = urlbar.selectionEnd = 0;
      if (waitForSearch) {
        let searchPromise = this.promiseSearchComplete(window);
        this.EventUtils.synthesizeKey("KEY_Backspace", {}, window);
        await searchPromise;
      } else {
        this.EventUtils.synthesizeKey("KEY_Backspace", {}, window);
      }
      this.Assert.equal(
        urlbar.value,
        urlbarValue,
        "Urlbar value hasn't changed."
      );
      await this.assertSearchMode(window, null);
    } else if (clickClose) {
      // We need to hover the indicator to make the close button clickable in the
      // test.
      let indicator = urlbar.querySelector("#urlbar-search-mode-indicator");
      this.EventUtils.synthesizeMouseAtCenter(
        indicator,
        { type: "mouseover" },
        window
      );
      let closeButton = urlbar.querySelector(
        "#urlbar-search-mode-indicator-close"
      );
      if (waitForSearch) {
        let searchPromise = this.promiseSearchComplete(window);
        this.EventUtils.synthesizeMouseAtCenter(closeButton, {}, window);
        await searchPromise;
      } else {
        this.EventUtils.synthesizeMouseAtCenter(closeButton, {}, window);
      }
      await this.assertSearchMode(window, null);
    }
  }

  /**
   * Returns the userContextId (container id) for the last search.
   *
   * @param {ChromeWindow} win The browser window
   * @returns {Promise<number>}
   *   resolved when fetching is complete. Its value is a userContextId
   */
  async promiseUserContextId(win) {
    const defaultId = Ci.nsIScriptSecurityManager.DEFAULT_USER_CONTEXT_ID;
    let context = await this.#urlbar(win).lastQueryContextPromise;
    return context.userContextId || defaultId;
  }

  /**
   * Dispatches an input event to the input field.
   *
   * @param {ChromeWindow} win The browser window
   */
  fireInputEvent(win) {
    // Set event.data to the last character in the input, for a couple of
    // reasons: It simulates the user typing, and it's necessary for autofill.
    let event = new InputEvent("input", {
      data: this.#urlbar(win).value[this.#urlbar(win).value.length - 1] || null,
    });
    this.#urlbar(win).inputField.dispatchEvent(event);
  }

  /**
   * Returns a new mock controller.  This is useful for xpcshell tests.
   *
   * @param {object} options Additional options to pass to the UrlbarController
   *        constructor.
   * @returns {UrlbarController} A new controller.
   */
  newMockController(options = {}) {
    let sapName = options.sapName || "urlbar";
    // Ensure a sapName is defined, as otherwise we'd not get the same
    // ProvidersManager instance across tests.
    if (options.input && !options.input.sapName) {
      Object.defineProperty(options.input, "sapName", {
        get() {
          return sapName;
        },
        configurable: true,
      });
    }
    return new lazy.UrlbarController(
      Object.assign(
        {
          input: {
            isPrivate: false,
            get sapName() {
              return sapName;
            },
            onFirstResult() {
              return false;
            },
            getSearchSource() {
              return "dummy-search-source";
            },
            window: {
              location: {
                href: AppConstants.BROWSER_CHROME_URL,
              },
            },
          },
        },
        options
      )
    );
  }

  /**
   * Initializes some external components used by the urlbar.  This is necessary
   * in xpcshell tests but not in browser tests.
   */
  async initXPCShellDependencies() {
    // The FormHistoryStartup component must be initialized since urlbar uses
    // form history.
    Cc["@mozilla.org/satchel/form-history-startup;1"]
      .getService(Ci.nsIObserver)
      .observe(null, "profile-after-change", null);
  }

  /**
   * Enrolls in a mock Nimbus feature.
   *
   * @param {object} value
   *   Define any desired Nimbus variables in this object.
   * @param {string} [feature]
   *   The feature to init.
   * @param {string} [enrollmentType]
   *   The enrollment type, either "rollout" (default) or "config".
   * @returns {Promise<() => Promise<void>>}
   *   A cleanup function that will unenroll the feature, returns a promise.
   */
  async initNimbusFeature(
    value = {},
    feature = "urlbar",
    enrollmentType = "rollout"
  ) {
    this.info("initNimbusFeature awaiting ExperimentAPI.init");
    const initializedExperimentAPI = await lazy.ExperimentAPI.init();

    this.info("initNimbusFeature awaiting ExperimentAPI.ready");
    await lazy.ExperimentAPI.ready();

    this.info(
      `initNimbusFeature awaiting NimbusTestUtils.enrollWithFeatureConfig`
    );
    const doExperimentCleanup =
      await lazy.NimbusTestUtils.enrollWithFeatureConfig(
        {
          featureId: lazy.NimbusFeatures[feature].featureId,
          value,
        },
        {
          isRollout: enrollmentType === "rollout",
        }
      );

    this.info("initNimbusFeature done");

    const cleanup = async () => {
      await doExperimentCleanup();
      if (initializedExperimentAPI) {
        // Only reset if we're in an xpcshell-test and actually initialized the
        // ExperimentAPI.
        lazy.ExperimentAPI._resetForTests();
      }
    };

    this.registerCleanupFunction?.(async () => {
      // If `cleanup()` has already been called (i.e., by the caller), it will
      // throw an error here.
      try {
        await cleanup();
      } catch (error) {}
    });

    return cleanup;
  }

  /**
   * Simulate that user clicks moz-urlbar and inputs text into it.
   *
   * @param {ChromeWindow} win
   *   The browser window containing target moz-urlbar.
   * @param {string} text
   *   The text to be input.
   */
  async inputIntoURLBar(win, text) {
    if (this.#urlbar(win).focused) {
      this.#urlbar(win).select();
    } else {
      this.EventUtils.synthesizeMouseAtCenter(
        this.#urlbar(win).inputField,
        {},
        win
      );
      await lazy.TestUtils.waitForCondition(() => this.#urlbar(win).focused);
    }
    if (text.length > 1) {
      // Set most of the string directly instead of going through sendString,
      // so that we don't make life unnecessarily hard for consumers by
      // possibly starting multiple searches.
      this.#urlbar(win)._setValue(text.substr(0, text.length - 1));
    }
    this.EventUtils.sendString(text.substr(-1, 1), win);
  }

  /**
   * Checks the urlbar value fomatting for a given URL.
   *
   * @param {ChromeWindow} win
   *   The input in this window will be tested.
   * @param {string} urlFormatString
   *   The URL to test. The parts the are expected to be de-emphasized should be
   *   wrapped in "<" and ">" chars.
   * @param {object} [options]
   *   Options object.
   * @param {string} [options.clobberedURLString]
   *      Normally the URL is de-emphasized in-place, thus it's enough to pass
   *      urlString. In some cases however the formatter may decide to replace
   *      the URL with a fixed one, because it can't properly guess a host. In
   *      that case clobberedURLString is the expected de-emphasized value. The
   *      parts the are expected to be de-emphasized should be wrapped in "<"
   *      and ">" chars.
   * @param {string} [options.additionalMsg]
   *   Additional message to use for Assert.equal.
   * @param {number} [options.selectionType]
   *   The selectionType for which the input should be checked.
   */
  async checkFormatting(
    win,
    urlFormatString,
    {
      clobberedURLString = null,
      additionalMsg = null,
      selectionType = Ci.nsISelectionController.SELECTION_URLSECONDARY,
    } = {}
  ) {
    await new Promise(resolve => win.requestAnimationFrame(resolve));
    let selectionController = this.#urlbar(win).editor.selectionController;
    let selection = selectionController.getSelection(selectionType);
    let value = this.#urlbar(win).editor.rootElement.textContent;
    let result = "";
    for (let i = 0; i < selection.rangeCount; i++) {
      let range = selection.getRangeAt(i).toString();
      let pos = value.indexOf(range);
      result += value.substring(0, pos) + "<" + range + ">";
      value = value.substring(pos + range.length);
    }
    result += value;
    this.Assert.equal(
      result,
      clobberedURLString || urlFormatString,
      "Correct part of the URL is de-emphasized" +
        (additionalMsg ? ` (${additionalMsg})` : "")
    );
  }

  /**
   * @param {ChromeWindow} win
   *   The search mode switcher's window.
   * @returns {PanelList}
   *   The search mode switcher popup.
   */
  searchModeSwitcherPopup(win) {
    return this.#urlbar(win).querySelector(".searchmode-switcher-panel-list");
  }

  /**
   * Opens the search mode switcher and returns the popup.
   *
   * @param {ChromeWindow} win
   *   The search mode switcher's window.
   * @param {?Function} [openFn]
   * Function to be used to open the popup. If not supplied,
   * it will default to a opening the popup directly.
   * @returns {Promise<PanelList>}
   *   The search mode switcher popup.
   */
  async openSearchModeSwitcher(win, openFn = null) {
    let popup = this.searchModeSwitcherPopup(win);
    let button = this.#urlbar(win).querySelector(".searchmode-switcher");
    this.Assert.ok(lazy.BrowserTestUtils.isVisible(button));
    await this.EventUtils.promiseElementReadyForUserInput(button, win);

    let promisePanelOpen = lazy.BrowserTestUtils.waitForEvent(popup, "shown");
    let rebuildPromise = lazy.BrowserTestUtils.waitForEvent(popup, "rebuild");
    if (openFn) {
      await openFn();
    } else {
      button.focus();
      await lazy.BrowserTestUtils.waitForCondition(
        () => !button.hasAttribute("aria-hidden")
      );
      button.click();
    }
    await Promise.all([promisePanelOpen, rebuildPromise]);

    return popup;
  }

  /**
   * @param {ChromeWindow} win
   *   The search mode switcher's window.
   * @returns {Promise<void>}
   *   Resolved when the search mode switcher popup is hidden.
   */
  searchModeSwitcherPopupClosed(win) {
    return lazy.BrowserTestUtils.waitForEvent(
      this.searchModeSwitcherPopup(win),
      "hidden"
    );
  }

  /**
   * @param {ChromeWindow} win
   *   The search mode switcher's window.
   * @param {string} selector
   *   A CSS selector for the panel-item that should be activated.
   * @returns {Promise<void>}
   *   Resolved when the search mode switcher popup is hidden.
   */
  async activateSearchModeSwitcherItem(win, selector) {
    this.info("Opening search mode switcher.");
    let panelList = await this.openSearchModeSwitcher(win);
    let panelItem = /**@type {PanelItem}*/ (panelList.querySelector(selector));
    if (!panelItem || panelItem.localName != "panel-item") {
      throw new Error("No matches for selector");
    }
    this.info("Clicking panel-item.");
    let popupHidden = this.searchModeSwitcherPopupClosed(win);
    panelItem.click();
    await popupHidden;
    this.info("Search mode switcher closed.");
  }

  /**
   * Gets the icon url of the search mode switcher icon.
   *
   * @param {ChromeWindow} win
   * @returns {?string}
   */
  getSearchModeSwitcherIcon(win) {
    let searchModeSwitcherButton = this.#urlbar(win).querySelector(
      ".searchmode-switcher"
    );
    return searchModeSwitcherButton.getAttribute("iconsrc");
  }

  async openTrustPanel(win) {
    let btn = win.document.getElementById("trust-icon");
    if (!btn.checkVisibility()) {
      btn = win.document.getElementById("identity-icon-box");
    }
    let popupShown = lazy.BrowserTestUtils.waitForEvent(
      win.document,
      "popupshown"
    );
    this.EventUtils.synthesizeMouseAtCenter(btn, {}, win);
    await popupShown;
  }

  async openTrustPanelSubview(win, viewId) {
    let view = win.document.getElementById(viewId);
    let shown = lazy.BrowserTestUtils.waitForEvent(view, "ViewShown");
    this.EventUtils.synthesizeMouseAtCenter(
      win.document.getElementById("trustpanel-popup-connection"),
      {},
      win
    );
    await shown;
  }

  async closeTrustPanel(win) {
    let popupHidden = lazy.BrowserTestUtils.waitForEvent(
      win.document,
      "popuphidden"
    );
    this.EventUtils.synthesizeKey("VK_ESCAPE", {}, win);
    await popupHidden;
  }

  async selectMenuItem(menupopup, targetSelector) {
    let target = menupopup.querySelector(targetSelector);
    let selected;
    for (let i = 0; i < menupopup.children.length; i++) {
      this.EventUtils.synthesizeKey(
        "KEY_ArrowDown",
        {},
        menupopup.documentGlobal
      );
      await lazy.BrowserTestUtils.waitForCondition(() => {
        let current = menupopup.querySelector("[_moz-menuactive]");
        if (selected != current) {
          selected = current;
          return true;
        }
        return false;
      });
      if (selected == target) {
        break;
      }
    }
  }

  /**
   * Selects the urlbar input and pastes the string into it.
   *
   * @param {string} str
   *   The string to paste.
   * @param {ChromeWindow} win
   */
  async selectAndPaste(str, win) {
    await this.SimpleTest.promiseClipboardChange(str, () => {
      lazy.clipboardHelper.copyString(str);
    });
    this.#urlbar(win).select();
    win.document.commandDispatcher
      .getControllerForCommand("cmd_paste")
      .doCommand("cmd_paste");
  }

  /**
   * Simulates selecting by dragging within the urlbar input.
   *
   * @param {number} fromX
   * @param {number} toX
   * @param {ChromeWindow} win
   * @returns {Promise<Event>}
   *   Resolves to the mouseup event.
   */
  selectWithMouseDrag(fromX, toX, win) {
    let target = this.#urlbar(win).inputField;
    let rect = target.getBoundingClientRect();
    let promise = lazy.BrowserTestUtils.waitForEvent(target, "mouseup");
    this.EventUtils.synthesizeMouse(
      target,
      fromX,
      rect.height / 2,
      { type: "mousemove" },
      target.documentGlobal
    );
    this.EventUtils.synthesizeMouse(
      target,
      fromX,
      rect.height / 2,
      { type: "mousedown" },
      target.documentGlobal
    );
    this.EventUtils.synthesizeMouse(
      target,
      toX,
      rect.height / 2,
      { type: "mousemove" },
      target.documentGlobal
    );
    this.EventUtils.synthesizeMouse(
      target,
      toX,
      rect.height / 2,
      { type: "mouseup" },
      target.documentGlobal
    );
    return promise;
  }

  /**
   * Simulates selecting by double-clicking within the urlbar input.
   *
   * @param {number} offsetX
   *   The x based location within the input field to double-click.
   * @param {ChromeWindow} win
   * @returns {Promise<Event>}
   *   Resolves to the dblclick event.
   */
  selectWithDoubleClick(offsetX, win) {
    let target = this.#urlbar(win).inputField;
    let rect = target.getBoundingClientRect();
    let promise = lazy.BrowserTestUtils.waitForEvent(target, "dblclick");
    this.EventUtils.synthesizeMouse(target, offsetX, rect.height / 2, {
      clickCount: 1,
    });
    this.EventUtils.synthesizeMouse(target, offsetX, rect.height / 2, {
      clickCount: 2,
    });
    return promise;
  }

  /**
   * Stubs `UrlbarUtils._zonedDateTimeISO()`. Helpful for tests that use
   * `UrlbarUtils.formatDate()`.
   *
   * Browser tests should call this again with a falsey value during cleanup to
   * remove the stub.
   *
   * @param {?string} nowStr
   *   A string that will be passed to `Temporal.ZonedDateTime.from()`. It should
   *   include a time zone offset. e.g.: "2025-05-11T00:00:00-07:00[-07:00]"
   *   A falsey value removes the stub.
   * @returns {typeof Temporal.ZonedDateTime}
   *   The fake "now" date as a `ZonedDateTime`.
   */
  stubNowZonedDateTime(nowStr) {
    if (!nowStr) {
      this.#zonedDateTimeISOStub?.restore();
      this.#zonedDateTimeISOStub = null;
      return null;
    }

    if (!this.#zonedDateTimeISOStub) {
      this.#zonedDateTimeISOStub = lazy.sinon.stub(
        UrlbarUtils,
        "_zonedDateTimeISO"
      );
    }

    let global = Cu.getGlobalForObject(UrlbarUtils);
    let zonedNow = global.Temporal.ZonedDateTime.from(nowStr);
    this.#zonedDateTimeISOStub.returns(zonedNow);

    return zonedNow;
  }

  #urlbar;
  #zonedDateTimeISOStub;
}

UrlbarInputTestUtils.prototype.formHistory = {
  /**
   * Adds values to the urlbar's form history.
   *
   * @param {Array} values
   *   The form history entries to remove.
   * @returns {Promise} resolved once the operation is complete.
   */
  add(values = []) {
    return lazy.FormHistoryTestUtils.add(
      lazy.DEFAULT_FORM_HISTORY_PARAM,
      values
    );
  },

  /**
   * Removes values from the urlbar's form history.  If you want to remove all
   * history, use clearFormHistory.
   *
   * @param {Array} values
   *   The form history entries to remove.
   * @returns {Promise} resolved once the operation is complete.
   */
  remove(values = []) {
    return lazy.FormHistoryTestUtils.remove(
      lazy.DEFAULT_FORM_HISTORY_PARAM,
      values
    );
  },

  /**
   * Removes all values from the urlbar's form history.  If you want to remove
   * individual values, use removeFormHistory.
   *
   * @returns {Promise} resolved once the operation is complete.
   */
  clear() {
    return lazy.FormHistoryTestUtils.clear(lazy.DEFAULT_FORM_HISTORY_PARAM);
  },

  /**
   * Searches the urlbar's form history.
   *
   * @param {object} criteria
   *   Criteria to narrow the search.  See FormHistory.search.
   * @returns {Promise}
   *   A promise resolved with an array of found form history entries.
   */
  search(criteria = {}) {
    return lazy.FormHistoryTestUtils.search(
      lazy.DEFAULT_FORM_HISTORY_PARAM,
      criteria
    );
  },

  /**
   * Returns a promise that's resolved on the next form history change.
   *
   * @param {string} change
   *   Null to listen for any change, or one of: add, remove, update
   * @returns {Promise}
   *   Resolved on the next specified form history change.
   */
  promiseChanged(change = null) {
    return lazy.TestUtils.topicObserved(
      "satchel-storage-changed",
      (subject, data) => !change || data == "formhistory-" + change
    );
  },
};

/**
 * A test provider.  If you need a test provider whose behavior is different
 * from this, then consider modifying the implementation below if you think the
 * new behavior would be useful for other tests.  Otherwise, you can create a
 * new TestProvider instance and then override its methods.
 */
class TestProvider extends UrlbarProvider {
  /**
   * Constructor.
   *
   * @param {object} options
   *   Constructor options
   * @param {Array} [options.results]
   *   An array of UrlbarResult objects that will be the provider's results.
   * @param {string} [options.name]
   *   The provider's name.  Provider names should be unique.
   * @param {Values<typeof UrlbarUtils.PROVIDER_TYPE>} [options.type]
   *   The provider's type.
   * @param {number} [options.priority]
   *   The provider's priority.  Built-in providers have a priority of zero.
   * @param {number} [options.addTimeout]
   *   If non-zero, each result will be added on this timeout.  If zero, all
   *   results will be added immediately and synchronously.
   *   If there's no results, the query will be completed after this timeout.
   * @param {Function} [options.getViewTemplate]
   *   If given, override the UrlbarProvider.getViewTemplate().
   * @param {Function} [options.getViewUpdate]
   *   If given, override the UrlbarProvider.getViewUpdate().
   * @param {Function} [options.onCancel]
   *   If given, a function that will be called when the provider's cancelQuery
   *   method is called.
   * @param {Function} [options.onSelection]
   *   If given, a function that will be called when
   *   {@link UrlbarView.#selectElement} method is called.
   * @param {Function} [options.onEngagement]
   *   If given, a function that will be called when engagement.
   * @param {Function} [options.onAbandonment]
   *   If given, a function that will be called when abandonment.
   * @param {Function} [options.onImpression]
   *   If given, a function that will be called when an engagement or
   *   abandonment has occurred.
   * @param {Function} [options.onSearchSessionEnd]
   *   If given, a function that will be called when a search session
   *   concludes.
   * @param {Function} [options.delayResultsPromise]
   *   If given, we'll await on this before returning results.
   */
  constructor({
    results = [],
    name = "TestProvider" + Services.uuid.generateUUID(),
    type = UrlbarUtils.PROVIDER_TYPE.PROFILE,
    priority = 0,
    addTimeout = 0,
    getViewTemplate = null,
    getViewUpdate = null,
    onCancel = null,
    onSelection = null,
    onEngagement = null,
    onAbandonment = null,
    onImpression = null,
    onSearchSessionEnd = null,
    delayResultsPromise = null,
  } = {}) {
    if (delayResultsPromise && addTimeout) {
      throw new Error(
        "Can't provide both `addTimeout` and `delayResultsPromise`"
      );
    }
    super();
    this.results = results;
    this.priority = priority;
    this.addTimeout = addTimeout;
    this.delayResultsPromise = delayResultsPromise;
    this._name = name;
    this._type = type;
    this._onCancel = onCancel;
    this._onSelection = onSelection;

    // As this has been a common source of mistakes, auto-upgrade the provider
    // type to heuristic if any result is heuristic.
    if (!type && this.results?.some(r => r.heuristic)) {
      this._type = UrlbarUtils.PROVIDER_TYPE.HEURISTIC;
    }

    if (getViewTemplate) {
      this.getViewTemplate = getViewTemplate.bind(this);
    }

    if (getViewUpdate) {
      this.getViewUpdate = getViewUpdate.bind(this);
    }

    if (onEngagement) {
      this.onEngagement = onEngagement.bind(this);
    }

    if (onAbandonment) {
      this.onAbandonment = onAbandonment.bind(this);
    }

    if (onImpression) {
      this.onImpression = onAbandonment.bind(this);
    }

    if (onSearchSessionEnd) {
      this.onSearchSessionEnd = onSearchSessionEnd.bind(this);
    }
  }

  get name() {
    return this._name;
  }

  get type() {
    return this._type;
  }

  getPriority(_context) {
    return this.priority;
  }

  async isActive(_context) {
    return true;
  }

  async startQuery(context, addCallback) {
    if (!this.results.length && this.addTimeout) {
      await new Promise(resolve => lazy.setTimeout(resolve, this.addTimeout));
    }
    if (this.delayResultsPromise) {
      await this.delayResultsPromise;
    }
    for (let result of this.results) {
      if (!this.addTimeout) {
        addCallback(this, result);
      } else {
        await new Promise(resolve => {
          lazy.setTimeout(() => {
            addCallback(this, result);
            resolve();
          }, this.addTimeout);
        });
      }
    }
  }

  cancelQuery(_context) {
    this._onCancel?.();
  }

  onSelection(result, element) {
    this._onSelection?.(result, element);
  }
}

UrlbarInputTestUtils.prototype.TestProvider = TestProvider;

export var UrlbarTestUtils = new UrlbarInputTestUtils(window => window.gURLBar);
export var SearchbarTestUtils = new UrlbarInputTestUtils(window =>
  window.document.getElementById("searchbar-new")
);
