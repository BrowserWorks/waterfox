const { PrefUtils } = ChromeUtils.importESModule(
  "resource:///modules/PrefUtils.sys.mjs"
);

const _STRING_PREF = "browser.test.stringPref";
const _INT_PREF = "browser.test.intPref";
const _BOOL_PREF = "browser.test.boolPref";
