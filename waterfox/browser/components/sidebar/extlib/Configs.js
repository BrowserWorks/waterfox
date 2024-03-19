/*
 license: The MIT License, Copyright (c) 2016-2023 YUKI "Piro" Hiroshi
 original:
   http://github.com/piroor/webextensions-lib-configs
*/

'use strict';

/*
There are multiple level values:

(higher priority)
 * [default] locked managed values (given via GPO or policies.json)
 * [default] locked default values (given to the constructor)
 * [user] locked user values (given via API)
   => [default] it should fallback to the default value if there is no user value
 * [user] user values (local storage)
 * [default] non-locked managed values (given via GPO or policies.json)
 * [default] overridden default values (given via API)
 * [default] built-in default values (given to the constructor)
(lower priority)

Only values different from [default] are stored and synchronized.
*/

// eslint-disable-next-line no-unused-vars
class Configs {
  constructor(
    defaults,
    { logging, logger, localKeys, syncKeys, sync } = { syncKeys: [], logger: null }
  ) {
    this._defaultValues = {
      ...this._clone(defaults),
      __ConfigsMigration__userValeusSameToDefaultAreCleared: false,
    };
    this._lockedDefaultKeys = new Set();

    this._managedValues = {};
    this._lockedManagedKeys = new Set();

    this._userValues = {};
    this._lockedUserKeys = new Set();

    this._fetchedValues = {};

    this.$default = {};
    this.$all = {};

    for (const key of Object.keys(this._defaultValues)) {
      Object.defineProperty(this.$default, key, {
        get: () => this._getDefaultValue(key),
        set: (value) => this._setDefaultValue(key, value),
        enumerable: true,
      });
      const description = {
        get: () => this._getValue(key),
        set: (value) => this._setValue(key, value),
        enumerable: true,
      };
      Object.defineProperty(this, key, description);
      Object.defineProperty(this.$all, key, description);
    }

    for (const [key, locked] of Object.entries(defaults)) {
      if (!key.endsWith(':locked'))
        continue;
      if (locked)
        this._lockedDefaultKeys.add(key.replace(/:locked$/, ''));
      delete defaults[key];
    }

    this.$logging = logging || false;
    this.$logs = [];
    this.$logger = logger;
    this.sync = sync === undefined ? true : !!sync;
    this._updating = new Map();
    this._observers = new Set();
    this._changedObservers = new Set();
    this._localLoadedObservers = new Set();
    this._syncKeys = [
      ...(localKeys ?
        Object.keys(defaults).filter(x => !localKeys.includes(x)) :
        (syncKeys || [])),
      '__ConfigsMigration__userValeusSameToDefaultAreCleared',
    ];
    this.$loaded = this._load();

    this.$preReceivedChanges = [];
    this.$listeningChanges = false;
    browser.storage.onChanged.addListener(this._onChanged.bind(this));

    this.$preReceivedMessages = [];
    this.$listeningMessages = false;
    browser.runtime.onMessage.addListener(this._onMessage.bind(this));
  }

  $reset(key, { broadcast } = {}) {
    if (!key) {
      for (const key of Object.keys(this._defaultValues)) {
        this.$reset(key);
      }
      return;
    }

    if (!this._defaultValues.hasOwnProperty(key))
      throw new Error(`failed to reset unknown key: ${key}`);

    this._setValue(key, this._getDefaultValue(key), true, { broadcast });
  }

  $cleanUp({ broadcast } = {}) {
    for (const [key, defaultValue] of Object.entries(this.$default)) {
      if (!this._userValues.hasOwnProperty(key))
        continue;
      const value = JSON.stringify(this._getNonDefaultValue(key));
      if (value == JSON.stringify(defaultValue) ||
          (this._managedValues.hasOwnProperty(key) &&
           value == JSON.stringify(this._managedValues[key])))
        this.$reset(key, { broadcast });
    }
  }

  _getDefaultValue(key) {
    if (this._managedValues.hasOwnProperty(key))
      return this._managedValues[key];
    return this._defaultValues[key];
  }

  _setDefaultValue(key, value, { broadcast } = {}) {
    if (!key)
      throw new Error(`missing key for default value ${value}`);

    if (!this._defaultValues.hasOwnProperty(key))
      throw new Error(`failed to set default value for unknown key: ${key}`);

    const currentValue = this[key];
    const currentDefaultValue = this._getDefaultValue(key);

    this._defaultValues[key] = this._clone(value);
    const defaultValue = this._getDefaultValue(key);
    if (JSON.stringify(defaultValue) == JSON.stringify(this._getNonDefaultValue[key]))
      this.$reset(key, { broadcast });

    const newDefaultValue = this._getDefaultValue(key);
    if (currentValue == currentDefaultValue &&
        currentValue != newDefaultValue &&
        this[key] == newDefaultValue) {
      const observers = [...this._observers, ...this._changedObservers];
      this.$notifyToObservers(key, value, observers, 'onChangeConfig');
    }

    if (broadcast === false)
      return;

    try {
      browser.runtime.sendMessage({
        type:  'Configs:updateDefaultValue',
        key:   key,
        value: defaultValue,
      }).catch(_error => {});
    }
    catch(_error) {
    }
  }

  _getNonDefaultValue(key) {
    if (this._userValues.hasOwnProperty(key))
      return this._userValues[key];
    if (this._managedValues.hasOwnProperty(key) &&
        !this._lockedManagedKeys.has(key))
      return this._managedValues[key];
    return undefined;
  }

  $addLocalLoadedObserver(observer) {
    if (!this._localLoadedObservers.has(observer))
      this._localLoadedObservers.add(observer);
  }
  $removeLocalLoadedObserver(observer) {
    this._localLoadedObservers.delete(observer);
  }

  $addChangedObserver(observer) {
    if (!this._changedObservers.has(observer))
      this._changedObservers.add(observer);
  }
  $removeChangedObserver(observer) {
    this._changedObservers.delete(observer);
  }

  $addObserver(observer) {
    // for backward compatibility
    if (typeof observer == 'function')
      this.$addChangedObserver(observer);
    else if (!this._observers.has(observer))
      this._observers.add(observer);
  }
  $removeObserver(observer) {
    // for backward compatibility
    if (typeof observer == 'function')
      this.$removeChangedObserver(observer);
    else
      this._observers.delete(observer);
  }

  _log(message, ...args) {
    message = `Configs[${location.href}] ${message}`;
    this.$logs = this.$logs.slice(-1000);

    if (!this.$logging)
      return;

    if (typeof this.$logger === 'function')
      this.$logger(message, ...args);
    else
      console.log(message, ...args);
  }

  _load() {
    return this.$_promisedLoad ||
             (this.$_promisedLoad = this._tryLoad());
  }

  async _tryLoad() {
    this._log('load');
    try {
      this._log(`load: try load from storage on ${location.href}`);
      const [localValues, managedValues, lockedKeys] = await Promise.all([
        (async () => {
          try {
            const localValues = await browser.storage.local.get(null); // keys must be "null" to get only stored values
            this._log('load: successfully loaded local storage');
            const observers = [...this._observers, ...this._localLoadedObservers];
            for (const [key, value] of Object.entries(localValues)) {
              this.$notifyToObservers(key, value, observers, 'onLocalLoaded');
            }
            return localValues;
          }
          catch(e) {
            this._log('load: failed to load local storage: ', String(e));
          }
          return {};
        })(),
        (async () => {
          if (!browser.storage.managed) {
            this._log('load: skip managed storage');
            return null;
          }
          return new Promise(async (resolve, _reject) => {
            const loadManagedStorage = () => {
              let resolved = false;
              return new Promise((resolve, reject) => {
                browser.storage.managed.get().then(managedValues => {
                  if (resolved)
                    return;
                  resolved = true;
                  this._log('load: successfully loaded managed storage');
                  resolve(managedValues || null);
                }).catch(error => {
                  if (resolved)
                    return;
                  resolved = true;
                  this._log('load: failed to load managed storage: ', String(error));
                  reject(error);
                });

                // storage.managed.get() fails on options page in Thunderbird.
                // The problem should be fixed by Thunderbird side.
                setTimeout(() => {
                  if (resolved)
                    return;
                  resolved = true;
                  this._log('load: failed to load managed storage: timeout');
                  reject(new Error('timeout'));
                }, 250);
              });
            };

            for (let i = 0, maxi = 10; i < maxi; i++) {
              try {
                const result = await loadManagedStorage();
                // On old versions Firefox and Thunderbird, a value with
                // REG_MULTI_SZ type is always delivered as a simple string,
                // thus we need to parse it by self.
                for (const [key, value] of Object.entries(result)) {
                  const defaultValue = this._defaultValues[key];
                  if (typeof value != 'string')
                    continue;

                  const trimmed = value.trim();
                  if (Array.isArray(defaultValue)) {
                    result[key] = (trimmed.startsWith('[') && trimmed.endsWith(']')) ?
                      JSON.parse(value) :
                      trimmed.includes('\n') ?
                        trimmed.split('\n') :
                        trimmed.split(',');
                  }
                  else if (defaultValue &&
                           typeof defaultValue == 'object' &&
                           trimmed.startsWith('{') &&
                           trimmed.endsWith('}')) {
                    result[key] = JSON.parse(trimmed);
                  }
                }
                resolve(result);
                return;
              }
              catch(error) {
                if (error.message != 'timeout') {
                  console.log('managed storage is not provided');
                  resolve(null);
                  return;
                }
                console.log('failed to load managed storage ', error);
              }
              await new Promise(resolve => setTimeout(resolve, 250));
            }
            console.log('failed to load managed storage with 10 times retly');
            resolve(null);
          });
        })(),
        (async () => {
          try {
            const lockedKeys = await browser.runtime.sendMessage({
              type: 'Configs:getLockedKeys'
            });
            this._log('load: successfully synchronized locked state');
            return lockedKeys || [];
          }
          catch(e) {
            this._log('load: failed to synchronize locked state: ', String(e));
          }
          return [];
        })()
      ]);
      this._log(`load: loaded:`, { localValues, managedValues, lockedKeys });

      lockedKeys.push(...this._lockedDefaultKeys);

      if (managedValues) {
        for (const [key, value] of Object.entries(managedValues)) {
          if (key.endsWith(':locked'))
            continue;
          const locked = managedValues[`${key}:locked`] !== false;
          this._managedValues[key] = value;
          if (locked)
            this._lockedManagedKeys.add(key);
        }
      }

      this._userValues = this._clone({ ...(localValues || {}) });
      this._log('load: values are applied');

      for (const key of new Set(lockedKeys)) {
        this._updateLocked(key, true);
      }
      this._log('load: locked state is applied');
      this.$listeningChanges = true;
      if (this.sync &&
          (this._syncKeys ||
           this._syncKeys.length > 0)) {
        try {
          browser.storage.sync.get(this._syncKeys).then(syncedValues => {
            this._log('load: successfully loaded sync storage');
            if (!syncedValues)
              return;
            for (const key of Object.keys(syncedValues)) {
              this[key] = syncedValues[key];
            }
          });
        }
        catch(e) {
          this._log('load: failed to read sync storage: ', String(e));
          return null;
        }
      }
      this.$listeningMessages = true;

      if (!this.__ConfigsMigration__userValeusSameToDefaultAreCleared) {
        this.$cleanUp();
        this.__ConfigsMigration__userValeusSameToDefaultAreCleared = true;
      }

      this.$_promisedLoad = this.$_promisedLoad.then(() => {
        if (this.$preReceivedChanges.length > 0) {
          const changes = [...this.$preReceivedChanges];
          this.$preReceivedChanges = [];
          for (const change of changes) {
            this._onChanged(change);
          }
        }
        if (this.$preReceivedMessages.length > 0) {
          const messages = [...this.$preReceivedMessages];
          this.$preReceivedMessages = [];
          for (const message of messages) {
            this._onMessage(message.message, message.sender);
          }
        }
      });

      return this.$all;
    }
    catch(e) {
      this._log('load: fatal error: ', e, e.stack);
      throw e;
    }
  }

  _getValue(key) {
    if (this._lockedManagedKeys.has(key))
      return this._managedValues[key];
    if (this._lockedDefaultKeys.has(key))
      return this._defaultValues[key];
    if (this._lockedUserKeys.has(key))
      return this._userValues[key] || this._getDefaultValue(key);
    if (this._userValues.hasOwnProperty(key))
      return this._userValues[key];
    if (this._managedValues.hasOwnProperty(key))
      return this._managedValues[key];
    if (this._defaultValues.hasOwnProperty(key))
      return this._defaultValues[key];
    throw new Error(`invalid access: unknown key ${key}`);
  }

  _setValue(key, value, force = false, { broadcast } = {}) {
    const newValue = this._clone(value);

    if (this._lockedDefaultKeys.has(key) ||
        this._lockedManagedKeys.has(key) ||
        this._lockedUserKeys.has(key)) {
      this._log(`warning: ${key} is locked and not updated`);
      return newValue;
    }

    const stringified = JSON.stringify(value);
    if (stringified == JSON.stringify(this._userValues[key]) && !force) {
      this._log(`skip: ${key} is not changed`);
      return newValue;
    }

    const oldValue = this._getValue(key);

    const shouldReset = stringified == JSON.stringify(this._getDefaultValue(key));
    this._log(`set: ${key} = ${value}${shouldReset ? ' (reset to default)' : ''}`);
    if (shouldReset)
      delete this._userValues[key];
    else
      this._userValues[key] = newValue;

    if (broadcast === false)
      return newValue;

    const update = {};
    update[key] = newValue;
    try {
      const updatingValues = this._updating.get(key) || [];
      updatingValues.push(newValue);
      this._updating.set(key, updatingValues);
      const updated = shouldReset ?
        browser.storage.local.remove([key]).then(() => {
          this._log('local: successfully removed ', key);
        }) :
        browser.storage.local.set(update).then(() => {
          this._log('local: successfully saved ', update);
        });
      updated
        .then(() => {
          setTimeout(() => {
            const updatingValues = this._updating.get(key);
            if (!updatingValues ||
                !updatingValues.includes(newValue))
              return;
            // failsafe: on Thunderbird updates sometimes won't be notified to the page itself.
            const changes = {};
            changes[key] = {
              oldValue,
              newValue,
            };
            this._onChanged(changes);
          }, 250);
        });
    }
    catch(e) {
      this._log('save: failed', e);
    }
    try {
      if (this.sync && this._syncKeys.includes(key)) {
        if (shouldReset)
          browser.storage.sync.remove([key]).then(() => {
            this._log('sync: successfully removed', update);
          });
        else
          browser.storage.sync.set(update).then(() => {
            this._log('sync: successfully synced', update);
          });
      }
    }
    catch(e) {
      this._log('sync: failed', e);
    }
    return newValue;
  }

  $lock(key) {
    this._log('locking: ' + key);
    this._updateLocked(key, true);
  }

  $unlock(key) {
    this._log('unlocking: ' + key);
    this._updateLocked(key, false);
  }

  $isLocked(key) {
    return this._lockedUserKeys.has(key);
  }

  _updateLocked(key, locked, { broadcast } = {}) {
    if (locked)
      this._lockedUserKeys.add(key);
    else
      this._lockedUserKeys.delete(key);

    if (browser.runtime &&
        broadcast !== false) {
      try {
        browser.runtime.sendMessage({
          type:   'Configs:updateLocked',
          key:    key,
          locked: this._lockedUserKeys.has(key),
        }).catch(_error => {});
      }
      catch(_error) {
      }
    }
  }

  _onMessage(message, sender) {
    if (!message ||
        typeof message.type != 'string')
      return;

    if (!this.$listeningMessages) {
      this.$preReceivedMessages.push({ message, sender });
      return;
    }

    this._log(`onMessage: ${message.type}`, message, sender);
    switch (message.type) {
      case 'Configs:getLockedKeys':
        return Promise.resolve(Array.from(this._lockedUserKeys));

      case 'Configs:updateLocked':
        this._updateLocked(message.key, message.locked, { broadcast: false });
        break;

      case 'Configs:updateDefaultValue':
        this._setDefaultValue(message.key, message.value, { broadcast: false });
        break;
    }
  }

  _onChanged(changes) {
    if (!this.$listeningChanges) {
      this.$preReceivedChanges.push(changes);
      return;
    }

    this._log('_onChanged', changes);
    const observers = [...this._observers, ...this._changedObservers];
    for (const [key, change] of Object.entries(changes)) {
      // storage.local.onChanged is sometimes notified with delay, and it
      // unexpctedly reverts stored user value after it is changed multiple
      // times in short time range, and it may produce "ghost value" problem, like:
      // 1. setting to "true" (updates the stored value to "true" immediately)
      // 2. setting to "false" (updates the stored value to "false" immediately)
      // 3. "true" is notified (updates the stored value to "true" with delay)
      // 4. getting the value - it gots "true" instead of "false"!
      // To avoid such problems, we need to skip applying notified new value
      // if the notification is from a local change.
      const updatingValues = this._updating.get(key);
      if (updatingValues &&
          updatingValues[0] == change.newValue) {
        updatingValues.shift();
      }
      else {
        if ('newValue' in change)
          this._userValues[key] = this._clone(change.newValue);
        else
          delete this._userValues[key];
      }

      if (!updatingValues || updatingValues.length == 0)
        this._updating.delete(key);
      else
        this._updating.set(key, updatingValues);

      const value = this._getNonDefaultValue(key);

      if (JSON.stringify(value) == JSON.stringify(this._getDefaultValue(key)))
        return;

      this.$notifyToObservers(key, value, observers, 'onChangeConfig');
    }
  }

  $notifyToObservers(key, value, observers, observerMethod) {
    for (const observer of observers) {
      if (typeof observer === 'function')
        observer(key, value);
      else if (observer && typeof observer[observerMethod] === 'function')
        observer[observerMethod](key, value);
    }
  }

  _clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
};
export default Configs;
