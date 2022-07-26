/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use-strict";

function init() {
  const style = document.createElement("style");
  style.setAttribute("id", "wf-addons-store-style");
  style.textContent = `
		a.btn-install.btn-with-plus
		{
			border-radius: 2px;
			box-shadow: 1px 1px 5px rgba(0,0,0,0.3);
			background: linear-gradient(top,#28bd00 0%,#21a100 100%);
			width: 150px;
			/* to get "Add to Waterfox" to be over "Add to Opera" */
			display: flex;
			color: transparent;
		}
		a.btn-install.btn-with-plus::before {
			border-right: 1px solid #71BD4C; /* override btn-gray border-right */
			color: white; /* override color:transparent i set above */
		}
		a.btn-install.btn-with-plus::after
		{
			display: block;
			content: "Add To Waterfox";
			color: white; /* override color:transparent i set above */
			position: absolute; /* so it overlaps Add to opera */
		}
		.site-message.site-message--top
		{
			display: none;
		}
	`;

  document.documentElement.insertBefore(
    style,
    document.documentElement.firstChild
  );
}

function uninit() {
  var style = document.getElementById("wf-addons-store-style");
  if (style) {
    style.remove(style);
  }
}

init();
