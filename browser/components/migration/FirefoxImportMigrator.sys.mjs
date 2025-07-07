/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Migrates from external Firefox profiles to Waterfox. This is different from
 * the FirefoxProfileMigrator which is used for profile refresh within Firefox.
 * This migrator can import data from Firefox installations on the system.
 *
 * Supported platforms: Windows, macOS, Linux (including Flatpak and Snap)
 * Supported data types: Bookmarks, History, Passwords, Form Data, Cookies
 */

import { MigrationUtils } from "resource:///modules/MigrationUtils.sys.mjs";
import { MigratorBase } from "resource:///modules/MigratorBase.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  FormHistory: "resource://gre/modules/FormHistory.sys.mjs",
  LoginHelper: "resource://gre/modules/LoginHelper.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  ProfileAge: "resource://gre/modules/ProfileAge.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

/**
 * Firefox profile migrator for importing from external Firefox profiles.
 * This handles importing data from Firefox installations on the system.
 */
export class FirefoxImportMigrator extends MigratorBase {
  static get key() {
    return "firefox-import";
  }

  static get displayNameL10nID() {
    return "migration-wizard-migrator-display-name-firefox";
  }

  static get brandImage() {
    return "chrome://browser/content/migration/brands/firefox.png";
  }

  get enabled() {
    return true;
  }

  /**
   * Get the Firefox profile directory paths for different platforms.
   * Supports standard installations as well as Flatpak and Snap on Linux.
   *
   * @returns {string[]} Array of Firefox profile directory paths
   */
  _getFirefoxProfilePaths() {
    const paths = [];

    try {
      if (AppConstants.platform == "win") {
        // Windows: %APPDATA%/Mozilla/Firefox
        try {
          let appData = Services.dirsvc.get("AppData", Ci.nsIFile);
          let firefoxDir = appData.clone();
          firefoxDir.append("Mozilla");
          firefoxDir.append("Firefox");
          if (firefoxDir.exists() && firefoxDir.isDirectory()) {
            paths.push(firefoxDir.path);
          }
        } catch (ex) {
          console.warn("Failed to check Windows Firefox path:", ex);
        }
      } else if (AppConstants.platform == "macosx") {
        // macOS: ~/Library/Application Support/Firefox
        try {
          let homeDir = Services.dirsvc.get("Home", Ci.nsIFile);
          let firefoxDir = homeDir.clone();
          firefoxDir.appendRelativePath("Library/Application Support/Firefox");
          if (firefoxDir.exists() && firefoxDir.isDirectory()) {
            paths.push(firefoxDir.path);
          }
        } catch (ex) {
          console.warn("Failed to check macOS Firefox path:", ex);
        }
      } else if (AppConstants.platform == "linux") {
        // Linux: ~/.mozilla/firefox
        try {
          let homeDir = Services.dirsvc.get("Home", Ci.nsIFile);
          let firefoxDir = homeDir.clone();
          firefoxDir.appendRelativePath(".mozilla/firefox");
          if (firefoxDir.exists() && firefoxDir.isDirectory()) {
            paths.push(firefoxDir.path);
          }
        } catch (ex) {
          console.warn("Failed to check Linux Firefox path:", ex);
        }

        // Also check for Flatpak installation
        try {
          let homeDir = Services.dirsvc.get("Home", Ci.nsIFile);
          let flatpakDir = homeDir.clone();
          flatpakDir.appendRelativePath(".var/app/org.mozilla.firefox/.mozilla/firefox");
          if (flatpakDir.exists() && flatpakDir.isDirectory()) {
            paths.push(flatpakDir.path);
          }
        } catch (ex) {
          console.warn("Failed to check Flatpak Firefox path:", ex);
        }

        // Check for Snap installation
        try {
          let homeDir = Services.dirsvc.get("Home", Ci.nsIFile);
          let snapDir = homeDir.clone();
          snapDir.appendRelativePath("snap/firefox/common/.mozilla/firefox");
          if (snapDir.exists() && snapDir.isDirectory()) {
            paths.push(snapDir.path);
          }
        } catch (ex) {
          console.warn("Failed to check Snap Firefox path:", ex);
        }
      }
    } catch (ex) {
      console.error("Error getting Firefox profile paths:", ex);
    }

    return paths;
  }

  /**
   * Parse Firefox profiles.ini file to get profile information.
   *
   * @param {string} firefoxDir - Path to Firefox installation directory
   * @returns {Promise<Array>} Array of profile objects with name, path, and existence info
   */
  async _parseProfilesIni(firefoxDir) {
    let profiles = [];
    let profilesIniPath;

    try {
      profilesIniPath = PathUtils.join(firefoxDir, "profiles.ini");
    } catch (ex) {
      console.error(`Failed to construct profiles.ini path for Firefox directory "${firefoxDir}":`, ex);
      return [];
    }

    try {
      let exists = await IOUtils.exists(profilesIniPath);

      if (exists) {
        let content = await IOUtils.readUTF8(profilesIniPath);

        let lines = content.split(/\r?\n/);
        let currentProfile = null;

        for (let line of lines) {
          line = line.trim();
          if (line.startsWith("[Profile")) {
            if (currentProfile && currentProfile.name && currentProfile.path) {
              profiles.push(currentProfile);
            }
            currentProfile = {};
          } else if (line.startsWith("Name=")) {
            let name = line.substring(5).trim();
            if (name) {
              currentProfile.name = name;
            }
          } else if (line.startsWith("Path=")) {
            let path = line.substring(5).trim();
            // Clean up path separators and invalid characters
            if (path) {
              // Remove any quotes that might be around the path
              path = path.replace(/^["']|["']$/g, "");
              // Normalize path separators
              currentProfile.path = path.replace(/\\/g, "/");
            }
          } else if (line.startsWith("IsRelative=")) {
            currentProfile.isRelative = line.substring(11).trim() === "1";
          }
        }

        // Add the last profile if valid
        if (currentProfile && currentProfile.name && currentProfile.path) {
          profiles.push(currentProfile);
        }

        // Resolve paths and validate profiles
        for (let profile of profiles) {
          if (!profile.path || !profile.name) {
            console.warn(`Profile ${profile.name || 'unnamed'} has missing name or path, skipping`);
            profile.exists = false;
            profile.fullPath = "";
            continue;
          }

          // Skip profiles with obviously invalid characters
          if (profile.path.includes('\0') || profile.name.includes('\0')) {
            console.warn(`Profile ${profile.name} contains null characters, skipping`);
            profile.exists = false;
            profile.fullPath = "";
            continue;
          }

          try {
            const pathSegments = profile.path.split(/[\\/]+/).filter(Boolean);
            let resolvedPath;

            if (profile.isRelative !== false) {
              try {
                resolvedPath = PathUtils.join(firefoxDir, ...pathSegments);
              } catch (joinEx) {
                console.warn(`Failed to join relative path for profile ${profile.name}: ${profile.path}`, joinEx);
              }
            } else {
              try {
                resolvedPath = PathUtils.normalize(profile.path);
              } catch (pathEx) {
                console.warn(`Invalid absolute path for profile ${profile.name}: ${profile.path}`, pathEx);
                try {
                  resolvedPath = PathUtils.join(firefoxDir, ...pathSegments);
                } catch (joinEx) {
                  console.warn(`Failed to join fallback relative path for profile ${profile.name}: ${profile.path}`, joinEx);
                }
              }
            }

            if (!resolvedPath) {
              console.warn(`Could not resolve profile path for ${profile.name}: ${profile.path}`);
              profile.exists = false;
              profile.fullPath = profile.path;
              continue;
            }

            profile.fullPath = resolvedPath;

            // Check if profile directory exists
            try {
              profile.exists = await IOUtils.exists(profile.fullPath);
            } catch (ex) {
              console.warn(`Cannot check existence of profile path ${profile.fullPath}:`, ex);
              profile.exists = false;
            }
          } catch (ex) {
            console.error(`Failed to resolve profile path for ${profile.name} (${profile.path}):`, ex);
            profile.exists = false;
            profile.fullPath = profile.path;
          }
        }
      }
    } catch (ex) {
      console.error(`Error parsing profiles.ini at "${profilesIniPath}":`, ex);
      console.error("This might indicate a corrupted or inaccessible profiles.ini file");
    }

    let validProfiles = profiles.filter(p => p.exists);
    return validProfiles;
  }

  /**
   * Get all available Firefox profiles from all Firefox installations.
   * Combines profiles from all detected Firefox installations.
   *
   * @returns {Promise<Array>} Array of all available Firefox profiles
   */
  async _getAllFirefoxProfiles() {
    let allProfiles = [];
    let firefoxPaths = this._getFirefoxProfilePaths();

    if (firefoxPaths.length === 0) {
      console.info("No Firefox installations found on this system");
    }

    for (let firefoxPath of firefoxPaths) {
      let profiles = await this._parseProfilesIni(firefoxPath);

      // Add source path info to each profile
      for (let profile of profiles) {
        profile.firefoxPath = firefoxPath;
        profile.id = `${firefoxPath}::${profile.name}`;
        allProfiles.push(profile);
      }
    }

    return allProfiles;
  }

  async getSourceProfiles() {
    let profiles = await this._getAllFirefoxProfiles();

    // Filter out the current profile to avoid importing from ourselves.
    let currentProfilePath = null;
    try {
      if (MigrationUtils.profileStartup?.directory) {
        currentProfilePath = MigrationUtils.profileStartup.directory.path;
      } else {
        let profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
        currentProfilePath = profileDir.path;
      }
    } catch (ex) {
      console.warn("Could not determine current profile path for filtering:", ex);
    }

    if (currentProfilePath) {
      let normalizedCurrentPath = null;
      try {
        normalizedCurrentPath = PathUtils.normalize(currentProfilePath);
      } catch (ex) {
        console.warn("Failed to normalize current profile path for filtering:", ex);
      }

      if (normalizedCurrentPath) {
        profiles = profiles.filter(profile => {
          try {
            let normalizedProfilePath = PathUtils.normalize(profile.fullPath);
            return normalizedProfilePath !== normalizedCurrentPath;
          } catch (ex) {
            console.warn(`Path comparison failed for profile ${profile.name}:`, ex);
            return true; // Include profile if path comparison fails
          }
        });
      }
    }

    // Hide profiles that don't contain any migratable data files (e.g. empty placeholder profiles).
    profiles = await this._filterProfilesWithMigratableData(profiles);

    let result = profiles.map(profile => ({
      id: profile.id,
      name: profile.name,
      path: profile.fullPath
    })).sort((a, b) => a.name.localeCompare(b.name));

    return result;
  }

  async _filterProfilesWithMigratableData(profiles) {
    if (!profiles || profiles.length === 0) {
      return [];
    }

    let filtered = [];
    for (let profile of profiles) {
      let profilePath = profile.fullPath;
      if (!profilePath) {
        continue;
      }

      try {
        if (await this._profileHasMigratableData(profilePath)) {
          filtered.push(profile);
        }
      } catch (ex) {
        console.warn(`Failed to check migratable data for profile ${profile.name}:`, ex);
        // If we can't inspect the profile, keep it visible rather than hiding it.
        filtered.push(profile);
      }
    }

    return filtered;
  }

  async _profileHasMigratableData(profilePath) {
    // Keep this check cheap: it runs for every detected profile.
    // We only need to know whether the profile contains *any* data files that this
    // migrator can import from (opening SQLite DBs here is unnecessarily expensive).
    const candidateFiles = ["places.sqlite", "cookies.sqlite", "formhistory.sqlite"];

    for (let fileName of candidateFiles) {
      try {
        let candidatePath = PathUtils.join(profilePath, fileName);
        if (await IOUtils.exists(candidatePath)) {
          return true;
        }
      } catch (ex) {
        console.warn(`Failed to check ${fileName} in profile ${profilePath}:`, ex);
        // If we can't inspect the profile (permissions, transient IO errors), keep it
        // visible rather than hiding it.
        return true;
      }
    }

    return false;
  }

  /**
   * Helper method to get a file object if it exists and is readable.
   *
   * @param {string} dir - Directory path
   * @param {string} fileName - File name
   * @returns {nsIFile|null} File object or null if not accessible
   */
  _getFileObject(dir, fileName) {
    let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(dir);
    file.append(fileName);
    return file.exists() && file.isReadable() ? file : null;
  }

  async _getFiles(aProfile, aFileName) {
    const files = [];
    let file = aProfile.clone();
    file.append(aFileName);

    if (await IOUtils.exists(file.path)) {
      files.push(file.path);
    } else {
      return [];
    }

    // Also look for SQLite temporary files.
    for (const suffix of ["-wal", "-shm"]) {
      file = aProfile.clone();
      file.append(aFileName + suffix);
      if (await IOUtils.exists(file.path)) {
        files.push(file.path);
      }
    }
    return files;
  }

  async getResources(aProfile) {
    if (!aProfile) {
      console.warn("No profile provided to getResources");
      return [];
    }

    let profilePath = aProfile.path;

    if (!profilePath || !(await IOUtils.exists(profilePath))) {
      console.warn("Profile path does not exist:", profilePath);
      return [];
    }

    let resources = [];

    // Bookmarks and History (Places database)
    let placesResource = await this._getPlacesResource(profilePath);
    if (placesResource) {
      resources.push(placesResource);
    }

    // Passwords
    let passwordsResource = await this._getPasswordsResource(profilePath);
    if (passwordsResource) {
      resources.push(passwordsResource);
    }

    // Form data
    let formDataResource = await this._getFormDataResource(profilePath);
    if (formDataResource) {
      resources.push(formDataResource);
    }

    // Cookies
    let cookiesResource = await this._getCookiesResource(profilePath);
    if (cookiesResource) {
      resources.push(cookiesResource);
    }

    // Bookmarks (separate from Places)
    let bookmarksResource = await this._getBookmarksResource(profilePath);
    if (bookmarksResource) {
      resources.push(bookmarksResource);
    }

    return resources;
  }

  async _getPlacesResource(profilePath) {
    let placesPath = PathUtils.join(profilePath, "places.sqlite");
    if (!(await IOUtils.exists(placesPath))) {
      return null;
    }

    return {
      type: MigrationUtils.resourceTypes.HISTORY,
      migrate: async (callback) => {
        try {
          await this._migratePlaces(placesPath);
          callback(true);
        } catch (ex) {
          console.error("Failed to migrate places:", ex);
          callback(false);
        }
      }
    };
  }

  async _migratePlaces(placesPath) {
    const sourceDB = await lazy.Sqlite.openConnection({ path: placesPath });
    try {
      const historyRows = await sourceDB.execute(`
        SELECT p.url, p.title, v.visit_date, v.visit_type
        FROM moz_historyvisits AS v
        JOIN moz_places AS p ON v.place_id = p.id
        WHERE p.url NOT LIKE ? AND p.url NOT LIKE ? AND p.visit_count > 0
      `, ["place:%", "moz-anno:%"]);

      const pageInfos = new Map();
      const maxAge = Date.now() - MigrationUtils.HISTORY_MAX_AGE_IN_MILLISECONDS;

      for (const row of historyRows) {
        const url = row.getResultByName("url");
        const visitDate = new Date(row.getResultByName("visit_date") / 1000);
        if (!URL.canParse(url) || visitDate.getTime() < maxAge) {
          continue;
        }

        const visit = {
          date: visitDate,
          transition: row.getResultByName("visit_type"),
        };

        if (pageInfos.has(url)) {
          pageInfos.get(url).visits.push(visit);
        } else {
          pageInfos.set(url, {
            url: new URL(url),
            title: row.getResultByName("title") || url,
            visits: [visit],
          });
        }
      }
      if (pageInfos.size > 0) {
        await MigrationUtils.insertVisitsWrapper([...pageInfos.values()]);
      }
    } finally {
      await sourceDB.close();
    }
  }

  async _getPasswordsResource(profilePath) {
    // Temporarily disable Firefox password migration until NSS-based import
    // is fixed. Returning null hides the PASSWORDS resource for this migrator.
    return null;
  }

  async _getBookmarksResource(profilePath) {
    let placesPath = PathUtils.join(profilePath, "places.sqlite");
    if (!(await IOUtils.exists(placesPath))) {
      return null;
    }

    return {
      type: MigrationUtils.resourceTypes.BOOKMARKS,
      migrate: async (callback) => {
        try {
          await this._migrateBookmarks(placesPath);
          callback(true);
        } catch (ex) {
          console.error("Failed to migrate bookmarks:", ex);
          callback(false);
        }
      }
    };
  }

  async _migrateBookmarks(placesPath) {
    const sourceDB = await lazy.Sqlite.openConnection({ path: placesPath });
    try {
      // Get all folders first
      const folders = await sourceDB.execute(`
        SELECT id, parent, title, guid, type, position FROM moz_bookmarks
        WHERE type = 2
        ORDER BY parent, position
      `);

      // Get all bookmarks
      const bookmarks = await sourceDB.execute(`
        SELECT b.id, b.parent, b.title, p.url, b.dateAdded, b.lastModified, b.guid, b.position
        FROM moz_bookmarks AS b
        JOIN moz_places AS p ON b.fk = p.id
        WHERE b.type = 1
        ORDER BY b.parent, b.position
      `);

      // Create mapping of source folder IDs to target GUIDs
      const folderGuidMap = new Map();

      // Map root folders
      for (const folder of folders) {
        const guid = folder.getResultByName("guid");
        const id = folder.getResultByName("id");

        if (guid === "menu________") {
          folderGuidMap.set(id, lazy.PlacesUtils.bookmarks.menuGuid);
        } else if (guid === "toolbar_______") {
          folderGuidMap.set(id, lazy.PlacesUtils.bookmarks.toolbarGuid);
        } else if (guid === "unfiled_____") {
          folderGuidMap.set(id, lazy.PlacesUtils.bookmarks.unfiledGuid);
        } else if (guid === "mobile______") {
          folderGuidMap.set(id, lazy.PlacesUtils.bookmarks.mobileGuid);
        }
      }

      // Create custom folders in hierarchy order
      let processedFolders = new Set([...folderGuidMap.keys()]);
      let lastProcessedCount = -1;

      while (processedFolders.size < folders.length && processedFolders.size !== lastProcessedCount) {
        lastProcessedCount = processedFolders.size;

        for (const folder of folders) {
          const id = folder.getResultByName("id");
          const parentId = folder.getResultByName("parent");
          const title = folder.getResultByName("title");
          const guid = folder.getResultByName("guid");

          // Skip if already processed or is a root folder
          if (processedFolders.has(id)) continue;
          if (["menu________", "toolbar_______", "unfiled_____", "mobile______", "tags________", "root________"].includes(guid)) {
            processedFolders.add(id);
            continue;
          }

          // Skip tag folders (parent ID 4 is tags folder)
          if (parentId === 4) {
            processedFolders.add(id);
            continue;
          }

          // Check if parent has been processed
          const parentGuid = folderGuidMap.get(parentId);
          if (parentGuid) {
            try {
              const folderSpec = {
                parentGuid,
                type: lazy.PlacesUtils.bookmarks.TYPE_FOLDER,
                title: title || "Untitled Folder",
                dateAdded: new Date(),
              };
              const newFolder = await MigrationUtils.insertBookmarkWrapper(folderSpec);
              folderGuidMap.set(id, newFolder.guid);
              processedFolders.add(id);
            } catch (ex) {
              console.error("Failed to create folder:", title, ex);
            }
          }
        }
      }

      // Collect bookmarks by folder for batch insertion
      const bookmarksByFolder = new Map();

      for (const bookmark of bookmarks) {
        const parentId = bookmark.getResultByName("parent");
        const url = bookmark.getResultByName("url");
        const title = bookmark.getResultByName("title");
        const dateAdded = new Date(bookmark.getResultByName("dateAdded") / 1000);

        if (!url || !URL.canParse(url)) {
          continue;
        }

        const parentGuid = folderGuidMap.get(parentId);
        if (parentGuid) {
          if (!bookmarksByFolder.has(parentGuid)) {
            bookmarksByFolder.set(parentGuid, []);
          }
          bookmarksByFolder.get(parentGuid).push({
            url,
            title: title || url,
            dateAdded,
          });
        } else {
          // Check if this is a tagged bookmark (parent is a tag folder)
          const isTaggedBookmark = folders.some(f =>
            f.getResultByName("id") === parentId &&
            f.getResultByName("parent") === 4
          );
        }
      }

      // Insert bookmarks using MigrationUtils wrapper for proper counting
      let totalImported = 0;
      for (const [parentGuid, bookmarks] of bookmarksByFolder) {
        try {
          await MigrationUtils.insertManyBookmarksWrapper(bookmarks, parentGuid);
          totalImported += bookmarks.length;
        } catch (ex) {
          console.error("Failed to insert bookmarks for folder:", parentGuid, ex);
        }
      }
    } finally {
      await sourceDB.close();
    }
  }

  async _getFormDataResource(profilePath) {
    let formHistoryPath = PathUtils.join(profilePath, "formhistory.sqlite");
    if (!(await IOUtils.exists(formHistoryPath))) {
      return null;
    }

    return {
      type: MigrationUtils.resourceTypes.FORMDATA,
      migrate: async (callback) => {
        try {
          await this._migrateFormData(formHistoryPath);
          callback(true);
        } catch (ex) {
          console.error("Failed to migrate form data:", ex);
          callback(false);
        }
      }
    };
  }

  /**
   * Migrate form history data from Firefox formhistory.sqlite database.
   *
   * @param {string} formHistoryPath - Path to formhistory.sqlite file
   */
  async _migrateFormData(formHistoryPath) {
    let db = await lazy.Sqlite.openConnection({ path: formHistoryPath });

    try {
      let rows = await db.execute(`
        SELECT fieldname, value, timesUsed, firstUsed, lastUsed
        FROM moz_formhistory
        WHERE fieldname IS NOT NULL AND value IS NOT NULL
        ORDER BY lastUsed DESC
      `);

      let addOps = [];
      for (let row of rows) {
        let fieldname = row.getResultByName("fieldname");
        let value = row.getResultByName("value");
        let timesUsed = row.getResultByName("timesUsed") || 1;
        let firstUsed = row.getResultByName("firstUsed") || 0;
        let lastUsed = row.getResultByName("lastUsed") || 0;

        if (fieldname && value) {
          addOps.push({
            op: "add",
            fieldname,
            value,
            timesUsed,
            firstUsed: firstUsed / 1000, // Convert from microseconds to milliseconds
            lastUsed: lastUsed / 1000,   // Convert from microseconds to milliseconds
          });
        }
      }

      if (addOps.length > 0) {
        await lazy.FormHistory.update(addOps);
     }
    } finally {
      await db.close();
    }
  }

  async _getCookiesResource(profilePath) {
    let cookiesPath = PathUtils.join(profilePath, "cookies.sqlite");

    if (!(await IOUtils.exists(cookiesPath))) {
      return null;
    }

    return {
      type: MigrationUtils.resourceTypes.COOKIES,
      migrate: async (callback) => {
        try {
          await this._migrateCookies(cookiesPath);
          callback(true);
        } catch (ex) {
          console.error("Failed to migrate cookies:", ex);
          callback(false);
        }
      }
    };
  }

  /**
   * Migrate cookies from Firefox cookies.sqlite database.
   * Only imports cookies that haven't expired.
   *
   * @param {string} cookiesPath - Path to cookies.sqlite file
   */
  async _migrateCookies(cookiesPath) {
    let db;

    try {
      db = await lazy.Sqlite.openConnection({ path: cookiesPath });
    } catch (ex) {
      console.error("Failed to open cookies database:", ex);
      throw ex;
    }

    try {
      // First, let's see what's in the database
      let allRows = await db.execute(`
        SELECT COUNT(*) as total FROM moz_cookies
      `);

      let rows = await db.execute(`
        SELECT host, path, name, value, expiry, isSecure, isHttpOnly, sameSite
        FROM moz_cookies
        WHERE expiry > ${Math.floor(Date.now() / 1000)}
        ORDER BY lastAccessed DESC
        LIMIT 1000
      `);

      if (rows.length === 0) {
        // Let's try without the expiry filter to see if there are any cookies at all
        let allCookies = await db.execute(`
          SELECT host, path, name, value, expiry, isSecure, isHttpOnly, sameSite
          FROM moz_cookies
          ORDER BY lastAccessed DESC
          LIMIT 100
        `);
      }

      let successCount = 0;
      let failCount = 0;

      for (let row of rows) {
        try {
          let host = row.getResultByName("host");
          let path = row.getResultByName("path");
          let name = row.getResultByName("name");
          let value = row.getResultByName("value");
          let expiry = row.getResultByName("expiry");
          let isSecure = Boolean(row.getResultByName("isSecure"));
          let isHttpOnly = Boolean(row.getResultByName("isHttpOnly"));
          let sameSite = row.getResultByName("sameSite") || Ci.nsICookie.SAMESITE_NONE;

          // Skip invalid cookies
          if (!host || !name) {
            failCount++;
            continue;
          }

          Services.cookies.add(
            host,
            path || "/",
            name,
            value || "",
            isSecure,
            isHttpOnly,
            false, // isSession
            expiry,
            {}, // originAttributes
            sameSite,
            isSecure ? Ci.nsICookie.SCHEME_HTTPS : Ci.nsICookie.SCHEME_HTTP
          );
          successCount++;
        } catch (ex) {
          console.error("Failed to add cookie:", ex);
          failCount++;
        }
      }
    } finally {
      await db.close();
    }
  }



  async getLastUsedDate() {
    let profiles = await this._getAllFirefoxProfiles();
    let dates = [];

    for (let profile of profiles) {
      try {
        let stat = await IOUtils.stat(profile.fullPath);
        dates.push(stat.lastModified);

        // Also check places.sqlite modification time
        let placesPath = PathUtils.join(profile.fullPath, "places.sqlite");
        if (await IOUtils.exists(placesPath)) {
          let placesStat = await IOUtils.stat(placesPath);
          dates.push(placesStat.lastModified);
        }
      } catch (ex) {
        // Ignore errors for individual profiles
      }
    }

    return dates.length > 0 ? new Date(Math.max(...dates)) : new Date(0);
  }
}
