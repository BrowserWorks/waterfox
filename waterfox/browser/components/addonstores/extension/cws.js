/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* globals browser */

"use-strict";

function uninit() {
  removeStyleSheet();
  removeInstallClickHandlers(document.body);
  unwatchAddingInstallHandlers();
}

function init() {
  addStyleSheet();
  (function initInstallHandlers() {
    if (document.body) {
      addInstallClickHandlers(document.body);
      watchForAddingInstallHandlers();
      return;
    }
    window.requestAnimationFrame(initInstallHandlers);
  })();
}

let gObserver;
init();

function addStyleSheet() {
  const styleSheet = document.createElement("style");
  styleSheet.setAttribute("id", "wf-addons-store-style");
  styleSheet.textContent = `
    div[role=dialog][aria-labelledby="promo-header"]
    {
      visibility: hidden;
    }
		div[role=button][aria-label*="CHROME"],
		div[role=button][aria-label*="Chrome"]
		{
			background-color: rgb(124, 191, 54);
			background-image: linear-gradient(to bottom, rgb(124, 191, 54), rgb(101, 173, 40));
			border-color:rgb(78, 155, 25);
		}
		div[role=button][aria-label*="CHROME"] .webstore-test-button-label,
		div[role=button][aria-label*="Chrome"] .webstore-test-button-label
		{
			font-size: 0;
		}
		div[role=button][aria-label*="CHROME"] .webstore-test-button-label::before,
		div[role=button][aria-label*="Chrome"] .webstore-test-button-label::before
		{
			display: flex;
			content: "Add To Waterfox";
			justify-content: center;
			align-items: center;
			font-size: 14px;
		}
		/* targeting download div */
		body > div:last-of-type > div:nth-of-type(2),
		/* alt target download div */
		.h-Yb-wa.Yb-wa
		{
			display: none;
		}
	`;

  document.documentElement.insertBefore(
    styleSheet,
    document.documentElement.firstChild
  );
}

function removeStyleSheet() {
  const styleSheet = document.getElementById("wf-addons-store-style");
  if (styleSheet) {
    styleSheet.remove(styleSheet);
  }
}

/**
 * If return is truthy, the return value is returned.
 *
 */
function parentNodeUntil(node, maxDepth, predicate) {
  let curNode = node;
  let rez;
  let depth = 0;
  while (!rez && depth++ < maxDepth) {
    rez = predicate(curNode);
    if (!rez) {
      curNode = curNode.parentNode;
    }
  }
  return rez;
}

function handleInstall(e) {
  e.preventDefault();
  e.stopPropagation();

  // start figure out id
  // Thanks to @Rob--W the id is accurately obtained: "It is the first 32 characters of the public key's sha256 hash, with the 0-9a-f replaced with a-p"
  const extIdPatt = /[^a-p]([a-p]{32})[^a-p]/i;
  const extId = parentNodeUntil(e.target, 100, node => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const [, extId] = extIdPatt.exec(node.innerHTML) || [];
      console.log("extId:", extId);
      return extId;
    }
  });
  if (!extId) {
    alert(
      "Addon Stores Compatibility enecountered an error. Failed to determine extension ID."
    );
  } else {
    let downloadURL = buildDownloadURL(extId);
    // Send downloadURL to background script
    browser.runtime.sendMessage({
      downloadURL,
    });
  }
}

function addInstallClickHandlers(node) {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const buttons = [
      ...node.querySelectorAll('div[role=button][aria-label*="Chrome"]'),
      ...node.querySelectorAll('div[role=button][aria-label*="CHROME"]'),
    ];

    for (const button of buttons) {
      button.addEventListener("click", handleInstall, true);
    }
  }
}

function removeInstallClickHandlers(node) {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const buttons = [
      ...node.querySelectorAll('div[role=button][aria-label*="Chrome"]'),
      ...node.querySelectorAll('div[role=button][aria-label*="CHROME"]'),
    ];

    for (const button of buttons) {
      button.removeEventListener("click", handleInstall, true);
    }
  }
}

function watchForAddingInstallHandlers() {
  gObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          addInstallClickHandlers(node);
        }
      }
    }
  });

  gObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function unwatchAddingInstallHandlers() {
  gObserver.disconnect();
}

function buildDownloadURL(extId) {
  let baseUrl =
    "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=49.0&acceptformat=crx3&x=id%3D***%26installsource%3Dondemand%26uc";
  return baseUrl.replace("***", extId);
}

browser.runtime.onMessage.addListener(request => {
  const ID = "waterfox-extension-test";
  if (!document.getElementById(ID)) {
    let el = document.createElement("div");
    el.setAttribute("id", ID);
    document.body.appendChild(el);
  }
});
