/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

function initializePINDialog() {
  let args = window.arguments[0].QueryInterface(Ci.nsIWritablePropertyBag);
  let input = document.getElementById("pin");
  let error = document.getElementById("pin-error");
  document.title = args.getProperty("title");
  document.getElementById("pin-title").textContent = document.title;
  document.getElementById("pin-label").textContent = args.getProperty("text");

  document.addEventListener("dialogaccept", event => {
    if (input.value.length != 6 || /[^0-9]/.test(input.value)) {
      event.preventDefault();
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", "pin-error");
      input.focus();
      return;
    }
    args.setProperty("pin", input.value);
    input.value = "";
  });
  document.addEventListener("dialogcancel", () => {
    args.setProperty("pin", null);
    input.value = "";
  });
  input.addEventListener("input", () => {
    error.hidden = true;
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  });
  window.addEventListener("load", () => input.focus(), { once: true });
  window.addEventListener(
    "unload",
    () => {
      input.value = "";
    },
    { once: true }
  );
}

window.addEventListener("DOMContentLoaded", initializePINDialog, {
  once: true,
});
