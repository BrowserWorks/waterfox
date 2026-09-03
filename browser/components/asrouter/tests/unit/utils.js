/**
 * GlobalOverrider - Utility that allows you to override properties on the global object.
 *                   See unit-entry.js for example usage.
 */
export class GlobalOverrider {
  constructor() {
    this.originalGlobals = new Map();
    this.sandbox = sinon.createSandbox();
  }

  /**
   * _override - Internal method to override properties on the global object.
   *             The first time a given key is overridden, we cache the original
   *             value in this.originalGlobals so that later it can be restored.
   *
   * @param  {string} key The identifier of the property
   * @param  {any} value The value to which the property should be reassigned
   */
  _override(key, value) {
    if (!this.originalGlobals.has(key)) {
      this.originalGlobals.set(key, global[key]);
    }
    global[key] = value;
  }

  /**
   * set - Override a given property, or all properties on an object
   *
   * @param  {string|object} key If a string, the identifier of the property
   *                             If an object, a number of properties and values to which they should be reassigned.
   * @param  {any} value The value to which the property should be reassigned
   * @return {type}       description
   */
  set(key, value) {
    if (!value && typeof key === "object") {
      const overrides = key;
      Object.keys(overrides).forEach(k => this._override(k, overrides[k]));
    } else {
      this._override(key, value);
    }
    return value;
  }

  /**
   * reset - Reset the global sandbox, so all state on spies, stubs etc. is cleared.
   *         You probably want to call this after each test.
   */
  reset() {
    this.sandbox.reset();
  }

  /**
   * restore - Restore the global sandbox and reset all overridden properties to
   *           their original values. You should call this after all tests have completed.
   */
  restore() {
    this.sandbox.restore();
    this.originalGlobals.forEach((value, key) => {
      global[key] = value;
    });
  }
}

/**
 * A map of mocked preference names and values, used by `FakensIPrefBranch`,
 * `FakensIPrefService`, and `FakePrefs`.
 *
 * Tests should add entries to this map for any preferences they'd like to set,
 * and remove any entries during teardown for preferences that shouldn't be
 * shared between tests.
 */
export const FAKE_GLOBAL_PREFS = new Map();

/**
 * Very simple fake for the most basic semantics of nsIPrefBranch. Lots of
 * things aren't yet supported.  Feel free to add them in.
 *
 * @param {object} args - optional arguments
 * @param {Function} args.initHook - if present, will be called back
 *                   inside the constructor. Typically used from tests
 *                   to save off a pointer to the created instance so that
 *                   stubs and spies can be inspected by the test code.
 */
export class FakensIPrefBranch {
  PREF_INVALID = "invalid";
  PREF_INT = "integer";
  PREF_BOOL = "boolean";
  PREF_STRING = "string";

  constructor(args) {
    if (args) {
      if ("initHook" in args) {
        args.initHook.call(this);
      }
      if (args.defaultBranch) {
        this.prefs = new Map();
      } else {
        this.prefs = FAKE_GLOBAL_PREFS;
      }
    } else {
      this.prefs = FAKE_GLOBAL_PREFS;
    }
    this._prefBranch = {};
    this.observers = new Map();
  }
  addObserver(prefix, callback) {
    this.observers.set(prefix, callback);
  }
  removeObserver(prefix, callback) {
    this.observers.delete(prefix, callback);
  }
  setStringPref(prefName, value) {
    this.set(prefName, value);
  }
  getStringPref(prefName, defaultValue) {
    return this.get(prefName, defaultValue);
  }
  setBoolPref(prefName, value) {
    this.set(prefName, value);
  }
  getBoolPref(prefName) {
    return this.get(prefName);
  }
  setIntPref(prefName, value) {
    this.set(prefName, value);
  }
  getIntPref(prefName) {
    return this.get(prefName);
  }
  setCharPref(prefName, value) {
    this.set(prefName, value);
  }
  getCharPref(prefName) {
    return this.get(prefName);
  }
  clearUserPref(prefName) {
    this.prefs.delete(prefName);
  }
  get(prefName, defaultValue) {
    let value = this.prefs.get(prefName);
    return typeof value === "undefined" ? defaultValue : value;
  }
  getPrefType(prefName) {
    let value = this.prefs.get(prefName);
    switch (typeof value) {
      case "number":
        return this.PREF_INT;

      case "boolean":
        return this.PREF_BOOL;

      case "string":
        return this.PREF_STRING;

      default:
        return this.PREF_INVALID;
    }
  }
  set(prefName, value) {
    this.prefs.set(prefName, value);

    // Trigger all observers for prefixes of the changed pref name. This matches
    // the semantics of `nsIPrefBranch`.
    let observerPrefixes = [...this.observers.keys()].filter(prefix =>
      prefName.startsWith(prefix)
    );
    for (let observerPrefix of observerPrefixes) {
      this.observers.get(observerPrefix)("", "", prefName);
    }
  }
  getChildList(prefix) {
    return [...this.prefs.keys()].filter(prefName =>
      prefName.startsWith(prefix)
    );
  }
  prefHasUserValue(prefName) {
    return this.prefs.has(prefName);
  }
  prefIsLocked(_prefName) {
    return false;
  }
}

/**
 * A fake `Services.prefs` implementation that extends `FakensIPrefBranch`
 * with methods specific to `nsIPrefService`.
 */
export class FakensIPrefService extends FakensIPrefBranch {
  getBranch() {}
  getDefaultBranch(_prefix) {
    return {
      setBoolPref() {},
      setIntPref() {},
      setStringPref() {},
      clearUserPref() {},
    };
  }
}

/**
 * Very simple fake for the most basic semantics of Preferences.sys.mjs.
 * Extends FakensIPrefBranch.
 */
export class FakePrefs extends FakensIPrefBranch {
  observe(prefName, callback) {
    super.addObserver(prefName, callback);
  }
  ignore(prefName, callback) {
    super.removeObserver(prefName, callback);
  }
  observeBranch(_listener) {}
  ignoreBranch(_listener) {}
  set(prefName, value) {
    this.prefs.set(prefName, value);

    // Trigger observers for just the changed pref name, not any of its
    // prefixes. This matches the semantics of `Preferences.sys.mjs`.
    if (this.observers.has(prefName)) {
      this.observers.get(prefName)(value);
    }
  }
}

export class FakeConsoleAPI {
  static LOG_LEVELS = {
    all: Number.MIN_VALUE,
    debug: 2,
    log: 3,
    info: 3,
    clear: 3,
    trace: 3,
    timeEnd: 3,
    time: 3,
    assert: 3,
    group: 3,
    groupEnd: 3,
    profile: 3,
    profileEnd: 3,
    dir: 3,
    dirxml: 3,
    warn: 4,
    error: 5,
    off: Number.MAX_VALUE,
  };

  constructor({ prefix = "", maxLogLevel = "all" } = {}) {
    this.prefix = prefix;
    this.prefixStr = prefix ? `${prefix}: ` : "";
    this.maxLogLevel = maxLogLevel;

    for (const level of Object.keys(FakeConsoleAPI.LOG_LEVELS)) {
      // eslint-disable-next-line no-console
      if (typeof console[level] === "function") {
        this[level] = this.shouldLog(level)
          ? this._log.bind(this, level)
          : () => {};
      }
    }
  }
  shouldLog(level) {
    return (
      FakeConsoleAPI.LOG_LEVELS[this.maxLogLevel] <=
      FakeConsoleAPI.LOG_LEVELS[level]
    );
  }
  _log(level, ...args) {
    console[level](this.prefixStr, ...args); // eslint-disable-line no-console
  }
}

export function FakeNimbusFeature() {
  return {
    getEnrollmentMetadata() {},
    getVariable() {},
    getAllVariables() {},
    getAllEnrollments() {},
    getAllEnrollmentMetadata() {},
    onUpdate() {},
    offUpdate() {},
    recordExposureEvent() {},
  };
}

export const FakeNimbusFeatures = new Proxy(
  {},
  {
    get(target, prop) {
      // Ignore some built-in props like Symbol.toStringTag, etc.
      if (typeof prop === "symbol") {
        return target[prop];
      }
      if (!(prop in target)) {
        target[prop] = FakeNimbusFeature();
      }
      return target[prop];
    },
  }
);

export class FakeLogger extends FakeConsoleAPI {
  constructor() {
    super({
      // Don't use a prefix because the first instance gets cached and reused by
      // other consumers that would otherwise pass their own identifying prefix.
      maxLogLevel: "off", // Change this to "debug" or "all" to get more logging in tests
    });
  }
}
