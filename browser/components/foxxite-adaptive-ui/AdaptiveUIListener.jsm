const EXPORTED_SYMBOLS = ["AdaptiveUIListener"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

/**
 * AdaptiveUIListener dynamically changes the browser chrome (UI) colors
 * based on the active tab's <meta name="theme-color"> tag.
 */
const AdaptiveUIListener = {
  init() {
    Services.obs.addObserver(this, "tab-select", false);
    Services.obs.addObserver(this, "content-document-global-created", false);
  },

  uninit() {
    Services.obs.removeObserver(this, "tab-select");
    Services.obs.removeObserver(this, "content-document-global-created");
  },

  observe(subject, topic, data) {
    if (topic === "tab-select") {
      this.updateThemeColorFromTab(subject);
    } else if (topic === "content-document-global-created") {
      // Listen for message from content script regarding theme color changes
    }
  },

  updateThemeColorFromTab(tab) {
    // In a full implementation, this would communicate with the content process
    // via a message manager or JS window actor to get the document's theme-color.

    // Example of injecting CSS dynamically into the browser chrome window:
    const browserWindow = tab.ownerGlobal;
    if (!browserWindow) return;

    // Dummy logic to simulate receiving the color #ff9900
    const themeColor = "#ff9900"; // Foxxite Orange

    // Injecting CSS variables to root to theme the UI
    const doc = browserWindow.document;
    doc.documentElement.style.setProperty('--toolbar-bgcolor', themeColor);
    doc.documentElement.style.setProperty('--tab-line-color', themeColor);
  }
};
