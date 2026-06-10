add_task(async function testGetSetPrefs() {
  PrefUtils.set(STRING_PREF, "some string");
  const strPref = PrefUtils.get(STRING_PREF);
  is(typeof strPref, "string", "String pref is string");
  is(strPref, "some string", "String pref is set");

  PrefUtils.set(INT_PREF, 999);
  const intPref = PrefUtils.get(INT_PREF);
  is(typeof intPref, "number", "Int pref is int");
  is(intPref, 999, "Int pref is set");

  PrefUtils.set(BOOL_PREF, false);
  const boolPref = PrefUtils.get(BOOL_PREF);
  is(typeof boolPref, "boolean", "Bool pref is bool");
  is(boolPref, false, "Bool pref is set");

  Services.prefs.clearUserPref(STRING_PREF);
  Services.prefs.clearUserPref(INT_PREF);
  Services.prefs.clearUserPref(BOOL_PREF);
});

add_task(async function testObservePref() {
  const msg = "Callback succeeded";

  async function callback(_pref, _path) {
    Services.prefs.setCharPref(STRING_PREF, msg);
  }
  const obs = PrefUtils.addObserver(BOOL_PREF, callback);

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

  Services.prefs.clearUserPref(STRING_PREF);
  Services.prefs.clearUserPref(BOOL_PREF);
  PrefUtils.removeObserver(obs);
});

add_task(async function testLockPref() {
  PrefUtils.lock(BOOL_PREF, true);
  is(Services.prefs.getBoolPref(BOOL_PREF), true, "Lock sets pref value");

  PrefUtils.lock(BOOL_PREF, false);
  is(
    Services.prefs.getBoolPref(BOOL_PREF),
    false,
    "Lock can update pref value"
  );

  Services.prefs.setBoolPref(BOOL_PREF, true);
  is(Services.prefs.getBoolPref(BOOL_PREF), false, "Can't set locked pref");

  Services.prefs.clearUserPref(BOOL_PREF);
});

add_task(async function testUnlockPref() {
  PrefUtils.lock(BOOL_PREF, true);
  is(Services.prefs.getBoolPref(BOOL_PREF), true, "Lock sets pref value");

  Services.prefs.setBoolPref(BOOL_PREF, false);
  is(Services.prefs.getBoolPref(BOOL_PREF), true, "Can't set locked pref");

  PrefUtils.unlock(BOOL_PREF);
  Services.prefs.setBoolPref(BOOL_PREF, false);
  is(Services.prefs.getBoolPref(BOOL_PREF), false, "Pref unlocked");

  Services.prefs.clearUserPref(BOOL_PREF);
});
