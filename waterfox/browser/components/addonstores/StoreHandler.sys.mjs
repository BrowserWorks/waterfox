/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "PopupNotifications", () => {
  // eslint-disable-next-line no-shadow
  const { PopupNotifications } = ChromeUtils.importESModule(
    "resource://gre/modules/PopupNotifications.sys.mjs"
  );
  try {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    const gBrowser = win.gBrowser;
    const document = win.document;
    const gURLBar = win.gURLBar;
    const shouldSuppress = () => {
      return (
        win.windowState === win.STATE_MINIMIZED ||
        (gURLBar.getAttribute("pageproxystate") !== "valid" &&
          gURLBar.focused) ||
        gBrowser?.selectedBrowser.hasAttribute("tabmodalChromePromptShowing") ||
        gBrowser?.selectedBrowser.hasAttribute("tabDialogShowing")
      );
    };
    return new PopupNotifications(
      gBrowser,
      document.getElementById("notification-popup"),
      document.getElementById("notification-popup-box"),
      { shouldSuppress }
    );
  } catch (ex) {
    console.error(ex);
    return null;
  }
});

const ZipReader = Components.Constructor(
  "@mozilla.org/libjar/zip-reader;1",
  "nsIZipReader",
  "open"
);

const zw = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);

const ReusableStreamInstance = Components.Constructor(
  "@mozilla.org/scriptableinputstream;1",
  "nsIScriptableInputStream",
  "init"
);

const uuidGenerator = Services.uuid;

export class StoreHandler {
  // init vars
  constructor() {
    this.uuidString = this._getUUID().slice(1, -1);
    const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile).path;
    this.xpiPath = PathUtils.join(
      profileDir,
      "extensions",
      "tmp",
      this.uuidString,
      "extension.xpi"
    );
    this.manifestPath = PathUtils.join(
      profileDir,
      "extensions",
      "tmp",
      this.uuidString,
      "new_manifest.json"
    );
    this.nsiFileXpi = this._getNsiFile(this.xpiPath);
    this.nsiManifest = this._getNsiFile(this.manifestPath);
  }

  /**
   * Remove dir if it exists
   *
   * @param dir string absolute path to directory to remove
   */
  flushDir(dir) {
    return new Promise((resolve) => {
      const nsiDir = this._getNsiFile(dir);
      if (nsiDir.exists()) {
        // remove all files
        nsiDir.remove(true);
      }
      resolve();
    });
  }

  /**
   * Return extension UUID, set and return if not already set
   */
  _getUUID() {
    if (!this._extensionUUID) {
      this._setUUID();
    }
    return this._extensionUUID;
  }

  /**
   * Set extension UUID
   */
  _setUUID() {
    const uuid = uuidGenerator.generateUUID();
    const uuidString = uuid.toString();
    this._extensionUUID = uuidString;
  }

  /**
   * Reset extension UUID
   */
  _resetUUID() {
    return new Promise((resolve) => {
      this._extensionUUID = undefined;
      resolve();
    });
  }

  /**
   * Display prompt in event of failed installation
   *
   * @param msg string message to display
   */
  _installFailedMsg(
    msg = "Encountered an error during extension installation"
  ) {
    const anchorID = "addons-notification-icon";
    const win = lazy.BrowserWindowTracker.getTopWindow();
    const browser = win.gBrowser.selectedBrowser;
    const action = {
      label: "OK",
      accessKey: "failed_accessKey",
      callback: () => {},
    };
    const options = {
      persistent: true,
      hideClose: true,
    };
    lazy.PopupNotifications.show(
      browser,
      "addon-install-failed",
      msg,
      anchorID,
      action,
      null,
      options
    );
  }

  /**
   * Get an nsiFile object from a given path
   *
   * @param path string path to file
   */
  _getNsiFile(path) {
    const nsiFile = new lazy.FileUtils.File(path);
    return nsiFile;
  }

  /**
   * Attempt to install a crx extension
   *
   * @param uri object uri of request
   * @param retry bool is this a retry attempt or not
   */
  attemptInstall(uri, retry = false) {
    const channel = lazy.NetUtil.newChannel({
      uri: uri.spec,
      loadUsingSystemPrincipal: true,
    });
    lazy.NetUtil.asyncFetch(channel, (aInputStream, aResult) => {
      // Check that we had success.
      if (!Components.isSuccessCode(aResult)) {
        if (!retry) {
          this.attemptInstall(uri, true);
          return false;
        }
        this._installFailedMsg(
          "The add-on could not be downloaded because of a connection failure."
        );
        return false;
      }
      // write nsiInputStream to nsiOutputStream
      // this was originally in a separate function but had error
      // passing input stream between funcs
      const aOutputStream = lazy.FileUtils.openAtomicFileOutputStream(
        this.nsiFileXpi
      );
      lazy.NetUtil.asyncCopy(
        aInputStream,
        aOutputStream,
        async (aResultInner) => {
          // Check that we had success.
          if (!Components.isSuccessCode(aResultInner)) {
            // delete any tmp files
            this._cleanup(this.nsiFileXpi);
            this._installFailedMsg(
              "This add-on could not be installed because of a filesystem error."
            );
            return false;
          }
          try {
            await this._removeChromeHeaders(this.xpiPath);
            const manifest = this._amendManifest(this.nsiFileXpi);
            // Notify tests
            Services.obs.notifyObservers(null, "waterfox-test-stores");
            if (Array.isArray(manifest)) {
              this._cleanup(this.nsiFileXpi);
              this._installFailedMsg(
                "This add-on could not be installed because not all of its features are supported."
              );
              Services.console.logStringMessage(
                `CRX: Unsupported APIs: ${manifest.join(",")}`
              );
              return false;
            }
            this._writeTmpManifest(this.nsiManifest, manifest);
            this._replaceManifestInXpi(this.nsiFileXpi, this.nsiManifest);
            await this._installXpi(this.nsiFileXpi);
            // this._cleanup(this.nsiFileXpi);
            this._resetUUID();
          } catch (e) {
            // delete any tmp files
            this._cleanup(this.nsiFileXpi);
            this._installFailedMsg(
              "There was an issue while attempting to install the add-on."
            );
            Services.console.logStringMessage(
              `CRX: Error installing add-on: ${e}`
            );
            return false;
          }
        }
      );
    });
  }

  /**
   * Remove Chrome headers from crx addon
   *
   * @param path string path to downloaded extension file
   */
   async _removeChromeHeaders(path) {
       let i; // Declare i at the root of the function scope to be used in the loop and after.
       try {
         // read using IOUtils to enable data manipulation
         const arrayBuffer = await IOUtils.read(path);
         // determine Chrome ext headers
         let locOfPk = arrayBuffer.slice(0, 3000);
         for (i = 0; i < locOfPk.length; i++) { // Initialize and use the function-scoped i
           if (
             locOfPk[i] === 80 &&
             locOfPk[i + 1] === 75 &&
             locOfPk[i + 2] === 3 &&
             locOfPk[i + 3] === 4
           ) {
             locOfPk = null;
             break;
           }
         }
         if (i === 3000) {
           Services.console.logStringMessage("CRX: Magic not found");
           return false;
         }
         // remove Chrome ext headers
         const zipBuffer = arrayBuffer.slice(i);
         // overwrite .zip with headers removed as ZipReader only compatible with nsiFile type, not Uint8Array
         await IOUtils.write(path, zipBuffer);
         return true;
       } catch (_e) {
         Services.console.logStringMessage("CRX: Error removing Chrome headers");
         return false;
       }
     }

  /**
   * Check API compatibility and maybe add id and remove update_url from manifest
   *
   * @param file nsiFile tmp extension file
   */
   _amendManifest(file) {
       try {
         // unzip nsiFile object
         const zr = new ZipReader(file);
         let manifest = this._parseManifest(zr);
         // only manifest version 2 currently supported
         if (manifest.manifest_version !== 2 || !manifest.manifest_version) {
           this._installFailedMsg(
             "Manifest version not supported, must be manifest_version: 2"
           );
           return false;
         }
         // ensure locale properties set correctly
         manifest = this._localeCheck(manifest, zr);
         // check API compatibility
         const unsupportedApis = this._manifestCompatCheck(manifest);
         if (unsupportedApis.length) {
           return unsupportedApis;
         }
         manifest.applications = {
           gecko: {
             id: this._getUUID(),
           },
         };
         // cannot allow auto update of crx extensions
         manifest.update_url = undefined;
         manifest = JSON.stringify(manifest);
         // close zipReader
         zr.close();
         return manifest;
       } catch (e) {
         Services.console.logStringMessage(`CRX: Error updating manifest: ${e}`);
         return false;
       }
     }

  /**
   * Parse manifest file into JS Object
   *
   * @param zr nsiZipReader ZipReader object
   */
  _parseManifest(zr) {
    const entryPointer = "manifest.json";
    let manifest;
    if (zr.hasEntry(entryPointer)) {
      const entry = zr.getEntry(entryPointer);
      const inputStream = zr.getInputStream(entryPointer);
      const rsi = new ReusableStreamInstance(inputStream);
      const fileContents = rsi.read(entry.realSize);
      manifest = JSON.parse(fileContents);
    }
    return manifest;
  }

  /**
   * Check support for APIs in manifest
   *
   * @param manifest Object manifest to compatibility check
   */
   _manifestCompatCheck(manifest) {
       const unsupported = {
         externally_connectable: "",
         storage: "",
         chrome_settings_overrides: {
           search_provider: {
             alternate_urls: "",
             image_url: "",
             image_url_post_params: "",
             instant_url: "",
             instant_url_post_params: "",
             prepopulated_id: "",
           },
           startup_pages: "",
         },
         chrome_url_overrides: {
           bookmarks: "",
           history: "",
         },
         commands: {
           global: "",
         },
         incognito: "split",
         offline_enabled: "",
         optional_permissions: [
           "background",
           "contentSettings",
           "contextMenus",
           "debugger",
           "pageCapture",
           "tabCapture",
         ],
         options_page: "",
         permissions: [
           "background",
           "contentSettings",
           "debugger",
           "pageCapture",
           "tabCapture",
         ],
         version_name: "",
       };
       const unsupportedInManifest = [];

       for (const arr of Object.entries(manifest)) {
         const manifestKey = arr[0];
         const manifestValue = arr[1];

         if (
           Object.keys(unsupported).includes(manifestKey) &&
           unsupported[manifestKey] === ""
         ) {
           // if manifest key is in unsupported list and
           // no value associated with unsupported key
           // we know it's unsupported in it's entirety
           unsupportedInManifest.push(manifestKey);
         } else if (
           Object.keys(unsupported).includes(manifestKey) &&
           typeof unsupported[manifestKey] === "string" &&
           unsupported[manifestKey] === manifestValue
         ) {
           // if key is unsupported and value matches
           // value in unsupported, we know the kv pair
           // only is unsupported
           unsupportedInManifest.push(`${manifestKey}: ${manifestValue}`);
         } else if (
           Object.keys(unsupported).includes(manifestKey) &&
           Array.isArray(unsupported[manifestKey]) &&
           Array.isArray(manifestValue)
         ) {
           // if value in unsupported is an array, we know
           // key is permissions related so we need to check
           // each permission against the unsupported array
           const permissionArr = []; // Changed var to let, scoped within this block
           for (const value of manifestValue) {
             if (unsupported[manifestKey].includes(value)) {
               permissionArr.push(`${manifestKey}.${value}`);
             }
           }
           if (permissionArr.length) {
             unsupportedInManifest.push(...permissionArr);
           }
         } else if (
           Object.keys(unsupported).includes(manifestKey) &&
           typeof unsupported[manifestKey] === "object" &&
           unsupported[manifestKey] !== null &&
           !Array.isArray(unsupported[manifestKey]) &&
           typeof manifestValue === "object" &&
           manifestValue !== null &&
           !Array.isArray(manifestValue)
         ) {
           // if value in unsupported is object we need to
           // identify if this is the final layer or if there
           // is another object for one of the keys here
           for (const key of Object.keys(manifestValue)) {
             if (
               Object.keys(unsupported[manifestKey]).includes(key) &&
               typeof unsupported[manifestKey][key] === "string"
             ) {
               // if object value in unsupported is string we know that
               // it is unsupported in it's entirety
               unsupportedInManifest.push(`${manifestKey}.${key}`);
               // TODO: need to rewrite this to be recursive so we don't have to go down the nesting
             } else if (
               Object.keys(unsupported[manifestKey]).includes(key) &&
               typeof unsupported[manifestKey][key] === "object" &&
               unsupported[manifestKey][key] !== null &&
               !Array.isArray(unsupported[manifestKey][key]) &&
               typeof manifestValue[key] === "object" &&
               manifestValue[key] !== null &&
               !Array.isArray(manifestValue[key])
             ) {
               // if object value in unsupported is another object
               // we have to dig through the extra layer
               for (const value of Object.keys(manifestValue[key])) {
                 if (
                   Object.keys(unsupported[manifestKey][key]).includes(value)
                 ) {
                   unsupportedInManifest.push(
                     `${manifestKey}.${key}.${value}`
                   );
                 }
               }
             }
           }
         }
       }
       return unsupportedInManifest;
     }

  /**
   * Ensure manifest compliance based on extension contents
   *
   * @param manifest
   * @param zr
   */
   _localeCheck(manifest, zr) {
       const entryPointer = "_locales/";
       if (zr.hasEntry(entryPointer)) {
         if (!manifest.default_locale) {
           if (zr.hasEntry("_locales/en/")) {
             manifest.default_locale = "en";
           } else {
             manifest.default_locale = "en-US";
           }
         }
       } else if (manifest.default_locale) {
         manifest.default_locale = undefined;
       }
       return manifest;
     }

  /**
   * Write amended manifest to temporary manifest.json
   *
   * @param file nsiFile tmp manifest.json
   * @param manifest string JSON string of amended manifest
   */
  _writeTmpManifest(file, manifest) {
    const manifestOutputStream =
      lazy.FileUtils.openAtomicFileOutputStream(file);
    manifestOutputStream.write(manifest, manifest.length);
  }

  /**
   * Replace the manifest in the tmp extension file with the amended version
   *
   * @param xpiFile nsiFile tmp extension file
   * @param manifestFile nsiFile tmp manifest.json
   */
  _replaceManifestInXpi(xpiFile, manifestFile) {
    try {
      const pr = {
        PR_RDONLY: 0x01,
        PR_WRONLY: 0x02,
        PR_RDWR: 0x04,
        PR_CREATE_FILE: 0x08,
        PR_APPEND: 0x10,
        PR_TRUNCATE: 0x20,
        PR_SYNC: 0x40,
        PR_EXCL: 0x80,
      };
      zw.open(xpiFile, pr.PR_RDWR);
      zw.removeEntry("manifest.json", false);
      zw.addEntryFile(
        "manifest.json",
        Ci.nsIZipWriter.COMPRESSION_NONE,
        manifestFile,
        false
      );
      zw.close();
      return true;
    } catch (_e) {
      Services.console.logStringMessage("CRX: Error replacing manifest");
      return false;
    }
  }

  /**
   * Silently install extension
   *
   * @param xpiFile nsiFile tmp extension file to install
   */
  async _installXpi(xpiFile) {
    const install = await lazy.AddonManager.getInstallForFile(xpiFile);
    const win = lazy.BrowserWindowTracker.getTopWindow();
    const browser = win.gBrowser.selectedBrowser;
    const document = win.document;
    await lazy.AddonManager.installAddonFromAOM(
      browser,
      document.documentURI,
      install
    );
  }

  /**
   * Remove tmp files
   *
   * @param zipFile nsiFile tmp extension file
   */
  _cleanup(zipFile) {
    return new Promise((resolve) => {
      const parent = zipFile.parent;
      parent.remove(true);
      resolve();
    });
  }
}
