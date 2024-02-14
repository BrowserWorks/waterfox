/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* globals browser */

"use-strict";

function uninit() {
  updateInstallClickHandlers(document.body, false);
  unwatchAddingInstallHandlers();
}

function init() {
  (function initInstallHandlers() {
    if (document.body) {
      updateInstallClickHandlers(document.body, true);
      watchForAddingInstallHandlers();
      replaceButtonText();
      return;
    }
    window.requestAnimationFrame(initInstallHandlers);
  })();
}

let gObserver;
init();

function hideElements() {
  const elementsToHide = Array.from(document.querySelectorAll('[aria-labelledby="promo-header"], [aria-label="info"]'));

  for (const element of elementsToHide) {
    element.style.display = 'none';
  }
}

function replaceButtonText() {
  const buttons = Array.from(document.querySelectorAll('button')).filter(button => button.textContent.includes('Add to Chrome'));

  for (const button of buttons) {
    button.textContent = button.textContent.replace('Add to Chrome', 'Add to Waterfox');
    button.style.color = 'white'; // Add this line
  }
}

function updateInstallClickHandlers(node, addHandlers) {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const buttons = Array.from(node.querySelectorAll('button')).filter(button => button.textContent.includes('Add to Chrome'));

    for (const button of buttons) {
      if (addHandlers) {
        button.removeAttribute('disabled');
        button.addEventListener("click", handleInstall, true);
      } else {
        button.setAttribute('disabled', '');
        button.removeEventListener("click", handleInstall, true);
      }
    }
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

  // Extract the extension ID from the URL of the page
  const urlParts = window.location.pathname.split('/');
  const extId = urlParts[urlParts.length - 1];

  if (!extId) {
    alert(
      "Addon Stores Compatibility encountered an error. Failed to determine extension ID."
    );
  } else {
    let downloadURL = buildDownloadURL(extId);
    browser.runtime.sendMessage({
      downloadURL,
    });
  }
}

function watchForAddingInstallHandlers() {
  gObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          updateInstallClickHandlers(node, true);
          hideElements();
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
