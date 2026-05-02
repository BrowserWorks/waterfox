const EXPORTED_SYMBOLS = ["AdaptiveUIListener"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const AdaptiveUIListener = {
  init() {
    Services.obs.addObserver(this, "tab-select", false);
  },

  uninit() {
    Services.obs.removeObserver(this, "tab-select");
  },

  observe(subject, topic, data) {
    if (topic === "tab-select") {
      this.updateThemeColorFromTab(subject);
    }
  },

  updateThemeColorFromTab(tab) {
    const browserWindow = tab.ownerGlobal;
    if (!browserWindow) return;

    const themeColor = "#ff9900"; // Foxxite Orange
    const doc = browserWindow.document;
    doc.documentElement.style.setProperty('--toolbar-bgcolor', themeColor);
  }
};
