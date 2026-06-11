const { StyleSheetUtils } = ChromeUtils.importESModule(
  "resource:///modules/StyleSheetUtils.sys.mjs"
);

const TEST_SHEET = "data:text/css,#stylesheetutils-test { color: red; }";

add_task(async function test_register_unregister_cycle() {
  ok(!StyleSheetUtils.sheetRegistered(TEST_SHEET), "Sheet starts unregistered");

  StyleSheetUtils.registerStylesheet(TEST_SHEET);
  ok(StyleSheetUtils.sheetRegistered(TEST_SHEET), "Sheet is registered");

  StyleSheetUtils.registerStylesheet(TEST_SHEET);
  ok(
    StyleSheetUtils.sheetRegistered(TEST_SHEET),
    "Registering twice is harmless"
  );

  StyleSheetUtils.unregisterStylesheet(TEST_SHEET);
  ok(!StyleSheetUtils.sheetRegistered(TEST_SHEET), "Sheet is unregistered");

  StyleSheetUtils.unregisterStylesheet(TEST_SHEET);
  ok(
    !StyleSheetUtils.sheetRegistered(TEST_SHEET),
    "Unregistering twice is harmless"
  );
});
