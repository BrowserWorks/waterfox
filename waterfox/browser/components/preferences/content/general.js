const _gMainPaneOverlay = {
  init() {
    // Initialize prefs
    window.Preferences.addAll(this.preferences);

    // Delayed initialization for Overlay dependent code
    this.delayedInit();
  },

  get preferences() {
    return [
      // Tab Toolbar Position
      { id: "browser.tabs.toolbarposition", type: "wstring" },

      // Tab Context Menu
      { id: "browser.tabs.duplicateTab", type: "bool" },
      { id: "browser.tabs.copyurl", type: "bool" },
      { id: "browser.tabs.activetab", type: "bool" },
      { id: "browser.tabs.copyallurls", type: "bool" },
      { id: "browser.tabs.unloadTab", type: "bool" },

      // Additional Tab Prefs
      { id: "browser.tabs.pinnedIconOnly", type: "bool" },
      { id: "browser.tabs.insertAfterCurrent", type: "bool" },
      { id: "browser.tabs.insertRelatedAfterCurrent", type: "bool" },

      // Dark Theme
      { id: "ui.systemUsesDarkTheme", type: "int" },

      // Restart Menu Item
      { id: "browser.restart_menu.purgecache", type: "bool" },
      { id: "browser.restart_menu.requireconfirm", type: "bool" },
      { id: "browser.restart_menu.showpanelmenubtn", type: "bool" },

      // Status Bar
      { id: "browser.statusbar.enabled", type: "bool" },
      { id: "browser.statusbar.appendStatusText", type: "bool" },

      // Bookmarks Toolbar Position
      { id: "browser.bookmarks.toolbarposition", type: "wstring" },

      // Geolocation API
      { id: "geo.provider.network.url", type: "wstring" },

      // Referer
      { id: "network.http.sendRefererHeader", type: "int" },

      // WebRTC P2P
      { id: "media.peerconnection.enabled", type: "bool" },

      // Images
      { id: "permissions.default.image", type: "int" },

      // Scripts
      { id: "javascript.enabled", type: "bool" },
    ];
  },

  delayedInit() {
    if (!window.initialized) {
      setTimeout(() => {
        this.delayedInit();
      }, 500);
    } else if (!document.initialized) {
      // Select the correct radio button based on current pref value
      this.showRelevantElements();
      this.setDynamicThemeGroupValue();
      this.setEventListener("dynamicThemeGroup", "command", (event) => {
        this.updateDynamicThemePref(event.target.value);
      });
      if (document.readyState === "complete") {
        this.tocGenerate();
      } else {
        document.addEventListener("readystatechange", () => {
          if (document.readyState === "complete") {
            this.tocGenerate();
          }
        });
      }
      document.initialized = true;
    }
  },

  tocGenerate() {
      const contentSelector = "#mainPrefPane";
      const headingSelector =
        "#mainPrefPane > hbox:not([hidden]) > h1, #mainPrefPane > groupbox:not([hidden]) > h2, #mainPrefPane > groupbox:not([hidden]) label:not([hidden]) > h2";
      const headerTarget = headingSelector.replaceAll(":not([hidden])", "");
      const specialCharRegex = /[!@#$%^&*():]/gi;
      const createHeadingId = () => {
        const content = document.querySelector(contentSelector);
        const headings = content?.querySelectorAll(headerTarget);
        const headingMap = {};

        let count = 0;
        /**
         * @param {Element} heading
         * @returns {string}
         */
        const getHeadingId = (heading) => {
          const id = heading.id;
          if (id) {
            return id;
          }

          if (heading instanceof HTMLElement) {
            const i18nId = heading.dataset.l10nId;
            if (i18nId) {
              return i18nId;
            }
          }

          return (
            heading.textContent
              ?.trim()
              .toLowerCase()
              .split(" ")
              .join("-")
              .replace(specialCharRegex, "") ?? `${count++}`
          );
        };
        /**
         * @param {string} headingText
         * @param {number} count
         * @returns {string}
         */
        const createId = (headingText, count) =>
          `${headingText}${count > 0 ? `-${count}` : ""}`;
        if (headings) {
          for (const heading of headings) {
            const id = getHeadingId(heading);
            headingMap[id] = !Number.isNaN(headingMap[id]) ? ++headingMap[id] : 0;
            heading.id = createId(id, headingMap[id]);
          }
        }
      };

      createHeadingId();
      tocbot.init({
        tocSelector: ".toc",
        contentSelector,
        headingSelector,
        scrollContainer: ".main-content",
        headingsOffset: 100, // 90 + margins
        hasInnerContainers: false,

        /**
         * @param {MouseEvent} e
         */
        onClick(e) {
          e.preventDefault();

          /** @type {HTMLLinkElement} */
          const link = e.target;
          const targetSelector = link?.getAttribute("href");
          if (targetSelector) {
            const target = document.querySelector(targetSelector);
            if (target) {
              target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }
        },
      });
      const tocRefresh = () => {
        createHeadingId();
        tocbot.refresh();
      };
      window.addEventListener("hashchange", tocRefresh);
    },

  showRelevantElements() {
    const idsGeneral = [
      "dynamicThemeGroup",
      "restartGroup",
      "statusBarGroup",
      "bookmarksBarPositionGroup",
      "geolocationGroup",
    ];

    const idsPrivacy = ["webrtc", "refheader", "dohBox"];
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const uri = win.gBrowser.currentURI.spec;
    if (
      (uri === "about:preferences" || uri === "about:preferences#general") &&
      document.visibilityState === "visible"
    ) {
      for (const id of idsGeneral) {
        const el = document.getElementById(id);
        if (el) {
          el.removeAttribute("hidden");
        }
      }
    } else if (
      uri === "about:preferences#privacy" &&
      document.visibilityState === "visible"
    ) {
      for (const id of idsPrivacy) {
        const el = document.getElementById(id);
        if (el) {
          el.removeAttribute("hidden");
        }
      }
    }
  },

  setEventListener(aId, aEventType, aCallback) {
    document
      .getElementById(aId)
      ?.addEventListener(aEventType, aCallback.bind(_gMainPaneOverlay));
  },

  async setDynamicThemeGroupValue() {
    const radiogroup = document.getElementById("dynamicThemeRadioGroup");
    radiogroup.disabled = true;

    radiogroup.value = Services.prefs.getIntPref("ui.systemUsesDarkTheme", -1);

    radiogroup.disabled = false;
  },

  async updateDynamicThemePref(value) {
    switch (value) {
      case "1":
        Services.prefs.setIntPref("ui.systemUsesDarkTheme", 1);
        break;
      case "0":
        Services.prefs.setIntPref("ui.systemUsesDarkTheme", 0);
        break;
      case "-1":
        Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
        break;
    }
  },
};
