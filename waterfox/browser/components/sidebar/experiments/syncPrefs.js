this.syncPrefs = class extends ExtensionAPI {
  getAPI(context) {
    const extensionIDBase = context.extension.id.split("@")[0];
    const extensionPrefNameBase = `extensions.${extensionIDBase}.`;

    return {
      syncPrefs: {
        getBoolValue(name, defaultValue = false) {
          try {
            return Services.prefs.getBoolPref(
              `${extensionPrefNameBase}${name}`,
              defaultValue
            );
          } catch (_error) {
            return defaultValue;
          }
        },
        getStringValue(name, defaultValue = "") {
          try {
            return Services.prefs.getStringPref(
              `${extensionPrefNameBase}${name}`,
              defaultValue
            );
          } catch (_error) {
            return defaultValue;
          }
        },
        getIntValue(name, defaultValue = 0) {
          try {
            return Services.prefs.getIntPref(
              `${extensionPrefNameBase}${name}`,
              defaultValue
            );
          } catch (_error) {
            return defaultValue;
          }
        },
      },
    };
  }
};
