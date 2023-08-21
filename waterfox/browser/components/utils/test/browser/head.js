"use strict";

const { PrefUtils } = ChromeUtils.importESModule(
  "resource:///modules/PrefUtils.sys.mjs"
);

const STRING_PREF = "browser.test.stringPref";
const INT_PREF = "browser.test.intPref";
const BOOL_PREF = "browser.test.boolPref";
