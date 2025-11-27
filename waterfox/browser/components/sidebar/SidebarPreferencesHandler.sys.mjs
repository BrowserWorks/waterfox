/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
});

const SIDEBAR_ADDON_ID = "sidebar@waterfox.net";
const SIDEBAR_ADDON_URI = "resource://builtin-addons/sidebar/";

const SIDEBAR_COMPONENT_PREF = "browser.sidebar.enabled";
const CONTAINERS_CONTROLLER_PREF = "privacy.userContext.extension";

export const SidebarPreferencesHandler = {
  _initialized: false,
  _sidebarPrefObserver: null,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    // Watch for about:preferences being loaded so we can patch the UI.
    Services.obs.addObserver(this, "main-pane-loaded");

    // Monitor the sidebar component pref and sync the built-in add-on state.
    this._monitorSidebarPref();
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;

    try {
      Services.obs.removeObserver(this, "main-pane-loaded");
    } catch (_) {}

    if (this._sidebarPrefObserver) {
      try {
        Services.prefs.removeObserver(SIDEBAR_COMPONENT_PREF, this._sidebarPrefObserver);
      } catch (_) {}
      this._sidebarPrefObserver = null;
    }
  },

  observe(subject, topic, _data) {
    switch (topic) {
      case "main-pane-loaded": {
        // subject is the about:preferences content window
        this._ensureTreeCategory(subject);
        this._patchPreferences(subject);
        break;
      }
    }
  },

  async _monitorSidebarPref() {
    let addon = await lazy.AddonManager.getAddonByID(SIDEBAR_ADDON_ID);

    const syncAddonStateWithPref = async () => {
      try {
        const enabled = Services.prefs.getBoolPref(SIDEBAR_COMPONENT_PREF, false);
        if (!enabled) {
          if (addon?.isActive) {
            await addon.disable({ allowSystemAddons: true });
          }
        } else {
          if (addon && !addon.isActive) {
            await addon.enable({ allowSystemAddons: true });
          }
        }
      } catch (_) {
        // Ignore transient failures.
      }
    };

    // Initial sync and observer
    await syncAddonStateWithPref();
    this._sidebarPrefObserver = syncAddonStateWithPref;
    Services.prefs.addObserver(SIDEBAR_COMPONENT_PREF, syncAddonStateWithPref);
  },

  _ensureTreeCategory(prefsWin) {
    const doc = prefsWin.document;
    const categories = doc.getElementById("categories");
    if (!categories) {
      return;
    }
    // Bail out if already present
    if (doc.getElementById("category-tree")) {
      return;
    }
    // Insert before search category (like previous overlay did)
    const before = doc.getElementById("category-search");
    const item = doc.createXULElement("richlistitem");
    item.id = "category-tree";
    item.className = "category";
    item.setAttribute("data-l10n-id", "category-tree");
    item.setAttribute("data-l10n-attrs", "tooltiptext");
    item.setAttribute("value", "paneTree");
    item.setAttribute("align", "center");
    if (before && before.parentNode === categories) {
      categories.insertBefore(item, before);
    } else {
      categories.appendChild(item);
    }
    const img = doc.createXULElement("image");
    img.className = "category-icon";
    const label = doc.createXULElement("label");
    label.className = "category-name";
    label.setAttribute("flex", "1");
    doc.l10n.setAttributes(label, "pane-tree-title");
    item.appendChild(img);
    item.appendChild(label);

    // Ensure the preferences framework knows about our pane so gotoPref works.
    if (!prefsWin.gCategoryModules?.has("paneTree")) {
      prefsWin.register_module("paneTree", {
        init() {
          // No-op: our pane is already injected and bound via data-category="paneTree".
        },
      });
      console.log("[SidebarPrefs] paneTree registered with preferences");
    }

    // Wire category selection to navigate to our pane
    categories.addEventListener("select", () => {
      const sel = categories.selectedItem;
      if (sel && sel.getAttribute("value") === "paneTree") {
        prefsWin.gotoPref("paneTree");
      }
    }, { capture: true });
  },

  _patchPreferences(prefsWin) {
    // Wait until the Containers UI has been constructed in about:preferences.
    const startedAt = Date.now();
    const timer = prefsWin.setInterval(() => {
      if (Date.now() - startedAt > 5000) {
        prefsWin.clearInterval(timer);
        // Still attempt to inject pane even if containers box wasn't found
        this._injectTreePreferences(prefsWin);
        return;
      }
      const doc = prefsWin.document;
      if (!doc || doc.readyState === "uninitialized") {
        return;
      }
      const containersBox = doc.getElementById("browserContainersbox");
      if (!containersBox) {
        return;
      }
      prefsWin.clearInterval(timer);
      this._hideContainersControlledBannerForBuiltin(prefsWin);
      this._injectTreePreferences(prefsWin);

      // Handle initial navigation: allow about:preferences#tree to go to our pane.
      const hash = String(doc.location.hash || "").replace(/^#/, "");
      if (hash === "tree" || hash === "paneTree") {
        prefsWin.gotoPref("paneTree");
      }
    }, 100);
  },

  _hideContainersControlledBannerForBuiltin(prefsWin) {
    try {
      const controller = Services.prefs.getCharPref(CONTAINERS_CONTROLLER_PREF, "");
      if (controller !== SIDEBAR_ADDON_ID) {
        // Some other extension controls containers; do not modify UI.
        return;
      }

      const doc = prefsWin.document;
      const banner = doc.getElementById("browserContainersExtensionContent");
      const checkbox = doc.getElementById("browserContainersCheckbox");

      // Hide the “controlled by extension” info row.
      if (banner) {
        banner.hidden = true;
      }

      // Optional UX: Ensure the checkbox is enabled so it doesn't look disabled
      // without an explanation banner.
      if (checkbox) {
        checkbox.disabled = false;
      }

      // Keep the state enforced if prefs code tries to flip it back.
      const target = doc.getElementById("browserContainersbox") || doc;
      const mo = new prefsWin.MutationObserver(() => {
        const b = doc.getElementById("browserContainersExtensionContent");
        const c = doc.getElementById("browserContainersCheckbox");
        if (b && !b.hidden) {
          b.hidden = true;
        }
        if (c && c.disabled) {
          c.disabled = false;
        }
      });
      mo.observe(target, { childList: true, subtree: true, attributes: true });
    } catch (_) {
      // Ignore unexpected contexts.
    }
  },

  _injectTreePreferences(prefsWin) {
    const doc = prefsWin.document;

    // Avoid duplicating UI if called more than once
    if (doc.getElementById("treePreferencesInjected")) {
      return;
    }

    // Insert our pane elements into the main pane container. We rely on data-category="paneTree"
    // so the preferences framework shows/hides it appropriately.
    const mainPane = doc.getElementById("mainPrefPane");
    if (!mainPane) {
      return;
    }

    // Helper to create XUL nodes
    const xul = (name, attrs = {}) => {
      const el = doc.createXULElement(name);
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined && v !== null) {
          el.setAttribute(k, v);
        }
      }
      return el;
    };

    // Root container
    const group = xul("groupbox", {
      id: "treePreferencesInjected",
      "data-category": "paneTree",
      hidden: "true",
    });

    const label = xul("label");
    const h2 = doc.createElementNS("http://www.w3.org/1999/xhtml", "h2");
    label.appendChild(h2);
    group.appendChild(label);
    doc.l10n.setAttributes(h2, "tree-header");

    // A small helper to add checkbox bound to a pref with l10n id.
    const addCheckbox = (parent, id, pref, l10nId) => {
      const box = xul("vbox", { id });
      const cb = xul("checkbox", { id: `${id}-checkbox`, preference: pref });
      doc.l10n.setAttributes(cb, l10nId);
      box.appendChild(cb);
      parent.appendChild(box);
    };

    // Appearance section
    const appearance = xul("groupbox", {
      id: "treeAppearanceGroup",
      "data-category": "paneTree",
      hidden: "true",
    });
    {
      const l = xul("label");
      const h = doc.createElementNS("http://www.w3.org/1999/xhtml", "h2");
      l.appendChild(h);
      doc.l10n.setAttributes(h, "tree-appearance-header");
      appearance.appendChild(l);
      addCheckbox(
        appearance,
        "tree_faviconizePinnedTabsBox",
        "browser.sidebar.faviconizePinnedTabs",
        "tree-faviconize-pinned-tabs"
      );
    }
    group.appendChild(appearance);

    // Auto-sticky section
    const sticky = xul("groupbox", {
      id: "treeAutoStickyGroup",
      "data-category": "paneTree",
      hidden: "true",
    });
    {
      const l = xul("label");
      const h = doc.createElementNS("http://www.w3.org/1999/xhtml", "h2");
      l.appendChild(h);
      doc.l10n.setAttributes(h, "tree-auto-sticky-header");
      sticky.appendChild(l);

      addCheckbox(
        sticky,
        "tree_stickyActiveTabBox",
        "browser.sidebar.stickyActiveTab",
        "tree-sticky-active-tab"
      );
      addCheckbox(
        sticky,
        "tree_stickySoundPlayingTabBox",
        "browser.sidebar.stickySoundPlayingTab",
        "tree-sticky-sound-playing-tab"
      );
      addCheckbox(
        sticky,
        "tree_stickySharingTabBox",
        "browser.sidebar.stickySharingTab",
        "tree-sticky-sharing-tab"
      );
    }
    group.appendChild(sticky);

    // Behavior section
    const behavior = xul("groupbox", {
      id: "treeBehaviorGroup",
      "data-category": "paneTree",
      hidden: "true",
    });
    {
      const l = xul("label");
      const h = doc.createElementNS("http://www.w3.org/1999/xhtml", "h2");
      l.appendChild(h);
      doc.l10n.setAttributes(h, "tree-behavior-header");
      behavior.appendChild(l);

      addCheckbox(
        behavior,
        "tree_autoCollapseExpandSubtreeOnAttachBox",
        "browser.sidebar.autoCollapseExpandSubtreeOnAttach",
        "tree-auto-collapse-expand-subtree-on-attach"
      );
      addCheckbox(
        behavior,
        "tree_autoCollapseExpandSubtreeOnSelecthBox",
        "browser.sidebar.autoCollapseExpandSubtreeOnSelect",
        "tree-auto-collapse-expand-subtree-on-select"
      );

      // Double-click behavior menulist
      const dbl = xul("hbox", {
        id: "tree_treeDoubleClickBehaviorBox",
        align: "center",
      });
      const dblCaption = xul("label", {
        id: "tree_treeDoubleClickBehaviorCaption",
        control: "tree_treeDoubleClickBehavior",
      });
      doc.l10n.setAttributes(dblCaption, "tree-tree-double-click-behavior-caption");
      dbl.appendChild(dblCaption);

      const dblList = xul("menulist", {
        id: "tree_treeDoubleClickBehavior",
        preference: "browser.sidebar.treeDoubleClickBehavior",
      });
      const dblPopup = xul("menupopup", { class: "in-menulist" });
      const dblOptions = [
        ["1", "tree-tree-double-click-behavior-toggle-collapsed"],
        ["4", "tree-tree-double-click-behavior-toggle-sticky"],
        ["3", "tree-tree-double-click-behavior-toggle-close"],
        ["0", "tree-tree-double-click-behavior-toggle-none"],
      ];
      for (const [value, l10nId] of dblOptions) {
        const item = xul("menuitem", { value });
        doc.l10n.setAttributes(item, l10nId);
        dblPopup.appendChild(item);
      }
      dblList.appendChild(dblPopup);
      dbl.appendChild(dblList);
      behavior.appendChild(dbl);

      // Successor control menulist
      const suc = xul("hbox", {
        id: "tree_successorTabControlLevelBox",
        align: "center",
      });
      const sucCaption = xul("label", {
        id: "tree_successorTabControlLevelCaption",
        control: "tree_successorTabControlLevel",
      });
      doc.l10n.setAttributes(sucCaption, "tree-successor-tab-control-level-caption");
      suc.appendChild(sucCaption);

      const sucList = xul("menulist", {
        id: "tree_successorTabControlLevel",
        preference: "browser.sidebar.successorTabControlLevel",
      });
      const sucPopup = xul("menupopup", { class: "in-menulist" });
      const sucOptions = [
        ["2", "tree-successor-tab-control-level-in-tree"],
        ["1", "tree-successor-tab-control-level-simulate-default"],
        ["0", "tree-successor-tab-control-level-never"],
      ];
      for (const [value, l10nId] of sucOptions) {
        const item = xul("menuitem", { value });
        doc.l10n.setAttributes(item, l10nId);
        sucPopup.appendChild(item);
      }
      sucList.appendChild(sucPopup);
      suc.appendChild(sucList);
      behavior.appendChild(suc);

      // Drop links behavior menulist
      const drop = xul("hbox", {
        id: "tree_dropLinksOnTabBehaviorBox",
        align: "center",
      });
      const dropCaption = xul("label", {
        id: "tree_dropLinksOnTabBehaviorCaption",
        control: "tree_dropLinksOnTabBehavior",
      });
      doc.l10n.setAttributes(dropCaption, "tree-drop-links-on-tab-behavior-caption");
      drop.appendChild(dropCaption);

      const dropList = xul("menulist", {
        id: "tree_dropLinksOnTabBehavior",
        preference: "browser.sidebar.dropLinksOnTabBehavior",
      });
      const dropPopup = xul("menupopup", { class: "in-menulist" });
      const dropOptions = [
        ["0", "tree-drop-links-on-tab-behavior-ask"],
        ["1", "tree-drop-links-on-tab-behavior-load"],
        ["2", "tree-drop-links-on-tab-behavior-newtab"],
      ];
      for (const [value, l10nId] of dropOptions) {
        const item = xul("menuitem", { value });
        doc.l10n.setAttributes(item, l10nId);
        dropPopup.appendChild(item);
      }
      dropList.appendChild(dropPopup);
      drop.appendChild(dropList);
      behavior.appendChild(drop);
    }
    group.appendChild(behavior);

    // Auto-attach section
    const autoAttach = xul("groupbox", {
      id: "treeAutoAttachGroup",
      "data-category": "paneTree",
      hidden: "true",
    });
    {
      const l = xul("label");
      const h = doc.createElementNS("http://www.w3.org/1999/xhtml", "h2");
      l.appendChild(h);
      doc.l10n.setAttributes(h, "tree-auto-attach-header");
      autoAttach.appendChild(l);

      const addMenu = (rootId, captionL10n, pref, options) => {
        const box = xul("vbox", { id: rootId });
        const cap = xul("label", { id: `${rootId}Caption`, control: `${rootId}Menu` });
        doc.l10n.setAttributes(cap, captionL10n);
        box.appendChild(cap);
        const hb = xul("hbox", { id: `${rootId}MenulistBox`, align: "center", class: "sub" });
        const list = xul("menulist", { id: `${rootId.replace(/Box$/, "")}`, preference: pref });
        const popup = xul("menupopup", { class: "in-menulist" });
        for (const [value, l10nId] of options) {
          const item = xul("menuitem", { value });
          doc.l10n.setAttributes(item, l10nId);
          popup.appendChild(item);
        }
        list.appendChild(popup);
        hb.appendChild(list);
        box.appendChild(hb);
        autoAttach.appendChild(box);
      };

      addMenu(
        "tree_autoAttachOnOpenedWithOwnerBox",
        "tree-auto-attach-on-opened-with-owner-caption",
        "browser.sidebar.autoAttachOnOpenedWithOwner",
        [
          ["-1", "tree-auto-attach-no-control"],
          ["0", "tree-auto-attach-independent"],
          ["6", "tree-auto-attach-child-top"],
          ["7", "tree-auto-attach-child-end"],
          ["5", "tree-auto-attach-child-next-to-last-related-tab"],
          ["2", "tree-auto-attach-sibling"],
          ["3", "tree-auto-attach-next-sibling"],
        ]
      );
      addMenu(
        "tree_insertNewTabFromPinnedTabAtBox",
        "tree-insert-new-tab-from-pinned-tab-at-caption",
        "browser.sidebar.insertNewTabFromPinnedTabAt",
        [
          ["-1", "tree-insert-new-tab-from-pinned-tab-at-no-control"],
          ["3", "tree-insert-new-tab-from-pinned-tab-at-next-to-last-related-tab"],
          ["0", "tree-insert-new-tab-from-pinned-tab-at-top"],
          ["1", "tree-insert-new-tab-from-pinned-tab-at-end"],
        ]
      );
      addMenu(
        "tree_autoAttachOnNewTabCommandBox",
        "tree-auto-attach-on-new-tab-command-caption",
        "browser.sidebar.autoAttachOnNewTabCommand",
        [
          ["-1", "tree-auto-attach-no-control"],
          ["0", "tree-auto-attach-independent"],
          ["6", "tree-auto-attach-child-top"],
          ["7", "tree-auto-attach-child-end"],
          ["2", "tree-auto-attach-sibling"],
          ["3", "tree-auto-attach-next-sibling"],
        ]
      );
      addMenu(
        "tree_autoAttachOnNewTabButtonMiddleClickBox",
        "tree-auto-attach-on-new-tab-button-middle-click-caption",
        "browser.sidebar.autoAttachOnNewTabButtonMiddleClick",
        [
          ["-1", "tree-auto-attach-no-control"],
          ["0", "tree-auto-attach-independent"],
          ["6", "tree-auto-attach-child-top"],
          ["7", "tree-auto-attach-child-end"],
          ["2", "tree-auto-attach-sibling"],
          ["3", "tree-auto-attach-next-sibling"],
        ]
      );
      addMenu(
        "tree_autoAttachOnDuplicatedBox",
        "tree-auto-attach-on-duplicated-caption",
        "browser.sidebar.autoAttachOnDuplicated",
        [
          ["-1", "tree-auto-attach-no-control"],
          ["0", "tree-auto-attach-independent"],
          ["6", "tree-auto-attach-child-top"],
          ["7", "tree-auto-attach-child-end"],
          ["2", "tree-auto-attach-sibling"],
          ["3", "tree-auto-attach-next-sibling"],
        ]
      );
      addMenu(
        "tree_autoAttachSameSiteOrphanBox",
        "tree-auto-attach-same-site-orphan-caption",
        "browser.sidebar.autoAttachSameSiteOrphan",
        [
          ["-1", "tree-auto-attach-no-control"],
          ["0", "tree-auto-attach-independent"],
          ["6", "tree-auto-attach-child-top"],
          ["7", "tree-auto-attach-child-end"],
          ["2", "tree-auto-attach-sibling"],
          ["3", "tree-auto-attach-next-sibling"],
        ]
      );
      addMenu(
        "tree_autoAttachOnOpenedFromExternalBox",
        "tree-auto-attach-on-opened-from-external-caption",
        "browser.sidebar.autoAttachOnOpenedFromExternal",
        [
          ["-1", "tree-auto-attach-no-control"],
          ["0", "tree-auto-attach-independent"],
          ["6", "tree-auto-attach-child-top"],
          ["7", "tree-auto-attach-child-end"],
          ["2", "tree-auto-attach-sibling"],
          ["3", "tree-auto-attach-next-sibling"],
        ]
      );
      addMenu(
        "tree_autoAttachOnAnyOtherTriggerBox",
        "tree-auto-attach-on-any-other-trigger-caption",
        "browser.sidebar.autoAttachOnAnyOtherTrigger",
        [
          ["-1", "tree-auto-attach-no-control"],
          ["0", "tree-auto-attach-independent"],
          ["6", "tree-auto-attach-child-top"],
          ["7", "tree-auto-attach-child-end"],
          ["2", "tree-auto-attach-sibling"],
          ["3", "tree-auto-attach-next-sibling"],
        ]
      );
    }
    group.appendChild(autoAttach);
 
    // Insert into DOM as a top-level pane element
    mainPane.appendChild(group);
 
    // Register preferences with the Preferences binding so widgets reflect pref values
    const toRegister = [
      ["browser.sidebar.faviconizePinnedTabs", "bool"],
      ["browser.sidebar.stickyActiveTab", "bool"],
      ["browser.sidebar.stickySoundPlayingTab", "bool"],
      ["browser.sidebar.stickySharingTab", "bool"],
      ["browser.sidebar.autoCollapseExpandSubtreeOnAttach", "bool"],
      ["browser.sidebar.autoCollapseExpandSubtreeOnSelect", "bool"],
      ["browser.sidebar.treeDoubleClickBehavior", "unichar"],
      ["browser.sidebar.successorTabControlLevel", "unichar"],
      ["browser.sidebar.dropLinksOnTabBehavior", "unichar"],
      ["browser.sidebar.autoAttachOnOpenedWithOwner", "unichar"],
      ["browser.sidebar.insertNewTabFromPinnedTabAt", "unichar"],
      ["browser.sidebar.autoAttachOnNewTabCommand", "unichar"],
      ["browser.sidebar.autoAttachOnNewTabButtonMiddleClick", "unichar"],
      ["browser.sidebar.autoAttachOnDuplicated", "unichar"],
      ["browser.sidebar.autoAttachSameSiteOrphan", "unichar"],
      ["browser.sidebar.autoAttachOnOpenedFromExternal", "unichar"],
      ["browser.sidebar.autoAttachOnAnyOtherTrigger", "unichar"],
    ];
    for (const [id, type] of toRegister) {
      prefsWin.Preferences.add({ id, type });
    }
 
    // Reveal inner sections for our dedicated category.
    // The root group visibility is controlled by about:preferences
    // category gating (search() on data-category), so we intentionally
    // leave its "hidden" state unchanged here.
    appearance.hidden = false;
    sticky.hidden = false;
    behavior.hidden = false;
    autoAttach.hidden = false;
  },
};