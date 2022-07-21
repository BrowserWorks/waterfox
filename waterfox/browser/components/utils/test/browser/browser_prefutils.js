"use strict";

// Test setting and getting different types of pref
add_task(async function testGetSetPrefs() {
  // String pref
  PrefUtils.set(STRING_PREF, "some string");
  let strPref = PrefUtils.get(STRING_PREF);
  is(typeof strPref, "string", "String pref is string");
  is(strPref, "some string", "String pref is set");

  // Int pref
  PrefUtils.set(INT_PREF, 999);
  let intPref = PrefUtils.get(INT_PREF);
  is(typeof intPref, "number", "Int pref is int");
  is(intPref, 999, "Int pref is set");

  // Bool pref
  PrefUtils.set(BOOL_PREF, false);
  let boolPref = PrefUtils.get(BOOL_PREF);
  is(typeof boolPref, "boolean", "Bool pref is bool");
  is(boolPref, false, "Bool pref is set");

  // Cleanup
  Services.prefs.clearUserPref(STRING_PREF);
  Services.prefs.clearUserPref(INT_PREF);
  Services.prefs.clearUserPref(BOOL_PREF);
});

// Test observing a pref
add_task(async function testObservePref() {
  let msg = "Callback succeeded";

  // Set up the observer
  async function callback(pref, path) {
    Services.prefs.setCharPref(STRING_PREF, msg);
  }
  let obs = PrefUtils.addObserver(BOOL_PREF, callback);

  // Trigger the obs callback
  is(
    Services.prefs.getCharPref(STRING_PREF, ""),
    "",
    "String pref initially blank"
  );
  Services.prefs.setBoolPref(BOOL_PREF, true);
  is(
    Services.prefs.getCharPref(STRING_PREF),
    msg,
    "Pref observer executes callback"
  );

  //Cleanup
  Services.prefs.clearUserPref(STRING_PREF);
  Services.prefs.clearUserPref(BOOL_PREF);
  PrefUtils.removeObserver(obs);
});
// Test locking a pref and setting a locked pref
add_task(async function testLockPref() {
  // Lock pref
  PrefUtils.lock(BOOL_PREF, true);
  is(Services.prefs.getBoolPref(BOOL_PREF), true, "Lock sets pref value");

  // Update locked pref
  PrefUtils.lock(BOOL_PREF, false);
  is(
    Services.prefs.getBoolPref(BOOL_PREF),
    false,
    "Lock can update pref value"
  );

  // Attempt to change locked pref with Services.prefs
  Services.prefs.setBoolPref(BOOL_PREF, true);
  is(Services.prefs.getBoolPref(BOOL_PREF), false, "Can't set locked pref");

  // Cleanup
  Services.prefs.clearUserPref(BOOL_PREF);
});

add_task(async function testUnlockPref() {
  // Lock pref
  PrefUtils.lock(BOOL_PREF, true);
  is(Services.prefs.getBoolPref(BOOL_PREF), true, "Lock sets pref value");

  // Attempt to change locked pref with Services.prefs
  Services.prefs.setBoolPref(BOOL_PREF, false);
  is(Services.prefs.getBoolPref(BOOL_PREF), true, "Can't set locked pref");

  // Unlock and set
  PrefUtils.unlock(BOOL_PREF);
  Services.prefs.setBoolPref(BOOL_PREF, false);
  is(Services.prefs.getBoolPref(BOOL_PREF), false, "Pref unlocked");

  // Cleanup
  Services.prefs.clearUserPref(BOOL_PREF);
});
