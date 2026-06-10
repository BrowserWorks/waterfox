// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

// This object implements the JS parts of nsIWebNavigation.
export class RemoteWebNavigation {
  constructor(aBrowser) {
    this._browser = aBrowser;
    this._cancelContentJSEpoch = 1;
    this._currentURI = null;
    this._canGoBack = false;
    this._canGoBackIgnoringUserInteraction = false;
    this._canGoForward = false;
    this.referringURI = null;
  }

  swapBrowser(aBrowser) {
    this._browser = aBrowser;
  }

  maybeCancelContentJSExecution(aNavigationType, aOptions = {}) {
    const epoch = this._cancelContentJSEpoch++;
    this._browser.frameLoader.remoteTab.maybeCancelContentJSExecution(
      aNavigationType,
      { ...aOptions, epoch }
    );
    return epoch;
  }

  get canGoBack() {
    const sessionHistory = this._browser.browsingContext.sessionHistory;
    return sessionHistory?.canGoBackFromEntryAtIndex(sessionHistory?.index);
  }

  get canGoBackIgnoringUserInteraction() {
    const sessionHistory = this._browser.browsingContext.sessionHistory;
    return sessionHistory?.index > 0;
  }

  get canGoForward() {
    let sessionHistory = this._browser.browsingContext.sessionHistory;
    return sessionHistory?.index < sessionHistory?.count - 1;
  }

  goBack(requireUserInteraction = false) {
    let cancelContentJSEpoch = this.maybeCancelContentJSExecution(
      Ci.nsIRemoteTab.NAVIGATE_BACK
    );
    this._browser.browsingContext.goBack(
      cancelContentJSEpoch,
      requireUserInteraction,
      true
    );
  }
  goForward(requireUserInteraction = false) {
    let cancelContentJSEpoch = this.maybeCancelContentJSExecution(
      Ci.nsIRemoteTab.NAVIGATE_FORWARD
    );
    this._browser.browsingContext.goForward(
      cancelContentJSEpoch,
      requireUserInteraction,
      true
    );
  }
  gotoIndex(aIndex) {
    let cancelContentJSEpoch = this.maybeCancelContentJSExecution(
      Ci.nsIRemoteTab.NAVIGATE_INDEX,
      { index: aIndex }
    );
    this._browser.browsingContext.goToIndex(aIndex, cancelContentJSEpoch, true);
  }

  loadURI(uri, loadURIOptions) {
    let cancelContentJSEpoch = this.maybeCancelContentJSExecution(
      Ci.nsIRemoteTab.NAVIGATE_URL,
      { uri }
    );
    this._browser.browsingContext.loadURI(uri, {
      ...loadURIOptions,
      cancelContentJSEpoch,
    });
  }

  fixupAndLoadURIString(uriString, loadURIOptions) {
    let uri;
    try {
      let fixupFlags = Services.uriFixup.webNavigationFlagsToFixupFlags(
        uriString,
        loadURIOptions.loadFlags
      );
      let isBrowserPrivate = lazy.PrivateBrowsingUtils.isBrowserPrivate(
        this._browser
      );
      if (isBrowserPrivate) {
        fixupFlags |= Services.uriFixup.FIXUP_FLAG_PRIVATE_CONTEXT;
      }

      uri = Services.uriFixup.getFixupURIInfo(
        uriString,
        fixupFlags
      ).preferredURI;
    } catch (ex) {
      // In rare cases `uriFixup` can throw. We ignore this here, but it's
      // likely that the fixupAndLoadURIString call below will still throw,
      // hopefully with more details.
    }

    let cancelContentJSEpoch = this.maybeCancelContentJSExecution(
      Ci.nsIRemoteTab.NAVIGATE_URL,
      { uri }
    );
    // For now, continue to use fixup here, but note that ideally we should be
    // doing fixup only once and reusing the URI we created above. Addressing
    // this is bug 1815509.
    this._browser.browsingContext.fixupAndLoadURIString(uriString, {
      ...loadURIOptions,
      cancelContentJSEpoch,
    });
  }

  reload(aReloadFlags) {
    this._browser.browsingContext.reload(aReloadFlags);
  }
  stop(aStopFlags) {
    this._browser.browsingContext.stop(aStopFlags);
  }

  get document() {
    return this._browser.contentDocument;
  }

  get currentURI() {
    if (!this._currentURI) {
      this._currentURI = Services.io.newURI("about:blank");
    }
    return this._currentURI;
  }
  set currentURI(aURI) {
    // Bug 1498600 verify usages of systemPrincipal here
    let loadURIOptions = {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    };
    this.loadURI(aURI.spec, loadURIOptions);
  }

  // Bug 1233803 - accessing the sessionHistory of remote browsers should be
  // done in content scripts.
  get sessionHistory() {
    throw new Components.Exception(
      "Not implemented",
      Cr.NS_ERROR_NOT_IMPLEMENTED
    );
  }
  set sessionHistory(aValue) {
    throw new Components.Exception(
      "Not implemented",
      Cr.NS_ERROR_NOT_IMPLEMENTED
    );
  }

  _sendMessage(aMessage, aData) {
    try {
      this._browser.sendMessageToActor(aMessage, aData, "WebNavigation");
    } catch (e) {
      console.error(e);
    }
  }
}
