/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const PRIVACY_POLICY_URL = "https://www.waterfox.com/docs/policies/privacy/";

Preferences.addSetting({ id: "waterfox-data-collection" });
Preferences.addSetting({ id: "waterfox-data-collection-notice" });

SettingGroupManager.registerGroups({
  waterfoxDataCollection: {
    items: [
      {
        id: "waterfox-data-collection",
        l10nId: "waterfox-data-collection-group",
        control: "moz-fieldset",
        iconSrc: "chrome://global/skin/icons/trending.svg",
        controlAttrs: {
          headinglevel: 2,
          badge: "waterfox-exclusive",
          "data-l10n-attrs": "searchkeywords",
        },
        items: [
          {
            id: "waterfox-data-collection-notice",
            control: "a",
            l10nId: "waterfox-data-collection-link",
            slot: "support-link",
            controlAttrs: {
              id: "waterfoxDataCollectionPrivacyNotice",
              href: PRIVACY_POLICY_URL,
              target: "_blank",
            },
          },
        ],
      },
    ],
  },
});
