/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { MigrationUtils } from "resource:///modules/MigrationUtils.sys.mjs";
import { MigratorBase } from "resource:///modules/MigratorBase.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FirefoxProfileLoginCrypto:
    "resource:///modules/FirefoxProfileLoginCrypto.sys.mjs",
  FormHistory: "resource://gre/modules/FormHistory.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

const FIREFOX_BOOKMARK_ROOTS = [
  ["toolbar_____", "toolbarGuid"],
  ["menu________", "menuGuid"],
  ["unfiled_____", "unfiledGuid"],
  ["mobile______", "mobileGuid"],
];

/**
 * Imports selected data from Firefox profiles outside the current Waterfox profile.
 */
export class FirefoxImportMigrator extends MigratorBase {
  static get key() {
    return "firefox-import";
  }

  static get displayNameL10nID() {
    return "migration-wizard-migrator-display-name-firefox";
  }

  _getFirefoxProfileRootDirs() {
    let roots = [];
    let seen = new Set();
    let addRoot = root => {
      if (!root || seen.has(root.path)) {
        return;
      }
      seen.add(root.path);
      roots.push(root);
    };

    if (AppConstants.platform == "win") {
      addRoot(this._getExistingProfileRoot("AppData", "Mozilla/Firefox"));
    } else if (AppConstants.platform == "macosx") {
      addRoot(
        this._getExistingProfileRoot("ULibDir", "Application Support/Firefox")
      );
    } else if (AppConstants.platform == "linux") {
      addRoot(this._getExistingProfileRoot("Home", ".mozilla/firefox"));
      addRoot(
        this._getExistingProfileRoot(
          "Home",
          ".var/app/org.mozilla.firefox/.mozilla/firefox"
        )
      );
      addRoot(
        this._getExistingProfileRoot(
          "Home",
          "snap/firefox/common/.mozilla/firefox"
        )
      );
    }

    return roots;
  }

  _getExistingProfileRoot(dirKey, relativePath) {
    try {
      let root = Services.dirsvc.get(dirKey, Ci.nsIFile);
      root.appendRelativePath(relativePath);
      if (root.exists() && root.isDirectory() && root.isReadable()) {
        return root;
      }
    } catch (ex) {}
    return null;
  }

  _resolveProfileDir(rootDir, path, isRelative) {
    let profileDir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    if (isRelative) {
      profileDir.setRelativeDescriptor(rootDir, path);
    } else {
      profileDir.initWithPath(path);
    }
    return profileDir;
  }

  _getCurrentProfileDir() {
    try {
      return Services.dirsvc.get("ProfD", Ci.nsIFile);
    } catch (ex) {}
    return MigrationUtils.profileStartup?.directory ?? null;
  }

  async _readProfilesFromRoot(rootDir) {
    let profilesIni = rootDir.clone();
    profilesIni.append("profiles.ini");
    if (!profilesIni.exists() || !profilesIni.isReadable()) {
      return [];
    }

    let parser = Cc["@mozilla.org/xpcom/ini-parser-factory;1"]
      .getService(Ci.nsIINIParserFactory)
      .createINIParser();
    parser.initFromString(await IOUtils.readUTF8(profilesIni.path));

    let currentProfileDir = this._getCurrentProfileDir();
    let profiles = [];
    let sections = parser.getSections();
    while (sections.hasMore()) {
      let section = sections.getNext();
      if (!section.startsWith("Profile")) {
        continue;
      }

      let name;
      let path;
      try {
        name = parser.getString(section, "Name");
        path = parser.getString(section, "Path");
      } catch (ex) {
        continue;
      }

      if (!name || !path || name.includes("\0") || path.includes("\0")) {
        continue;
      }

      let isRelative = true;
      try {
        isRelative = parser.getString(section, "IsRelative") != "0";
      } catch (ex) {}

      let profileDir;
      try {
        profileDir = this._resolveProfileDir(rootDir, path, isRelative);
      } catch (ex) {
        console.error(ex);
        continue;
      }

      if (
        !profileDir.exists() ||
        !profileDir.isDirectory() ||
        !profileDir.isReadable() ||
        currentProfileDir?.equals(profileDir)
      ) {
        continue;
      }

      profiles.push({
        id: profileDir.path,
        name,
      });
    }

    return profiles;
  }

  _withUniqueProfileNames(profiles) {
    let counts = new Map();
    for (let profile of profiles) {
      counts.set(profile.name, (counts.get(profile.name) ?? 0) + 1);
    }

    let seen = new Map();
    return profiles.map(profile => {
      if (counts.get(profile.name) == 1) {
        return profile;
      }

      let seenCount = seen.get(profile.name) ?? 0;
      seen.set(profile.name, seenCount + 1);
      if (!seenCount) {
        return profile;
      }

      return {
        ...profile,
        name: `${profile.name} (${seenCount + 1})`,
      };
    });
  }

  async getSourceProfiles() {
    if ("__sourceProfiles" in this) {
      return this.__sourceProfiles;
    }

    let profiles = [];
    let seenProfilePaths = new Set();
    for (let rootDir of this._getFirefoxProfileRootDirs()) {
      for (let profile of await this._readProfilesFromRoot(rootDir)) {
        if (!seenProfilePaths.has(profile.id)) {
          seenProfilePaths.add(profile.id);
          profiles.push(profile);
        }
      }
    }

    let profileResources = await Promise.all(
      profiles.map(async profile => ({
        profile,
        resources: await this.getResources(profile),
      }))
    );

    let sorter = (a, b) => {
      return a.name
        .toLocaleLowerCase()
        .localeCompare(b.name.toLocaleLowerCase());
    };

    this.__sourceProfiles = this._withUniqueProfileNames(
      profileResources
        .filter(({ resources }) => resources?.length)
        .map(({ profile }) => profile)
    ).sort(sorter);

    return this.__sourceProfiles;
  }

  async getResources(aProfile) {
    if (!aProfile?.id) {
      return [];
    }

    let sourceProfileDir = Cc["@mozilla.org/file/local;1"].createInstance(
      Ci.nsIFile
    );
    sourceProfileDir.initWithPath(aProfile.id);
    let currentProfileDir = this._getCurrentProfileDir();
    if (
      !sourceProfileDir.exists() ||
      !sourceProfileDir.isDirectory() ||
      !sourceProfileDir.isReadable() ||
      currentProfileDir?.equals(sourceProfileDir)
    ) {
      return [];
    }

    let possibleResources = await Promise.allSettled([
      GetBookmarksResource(sourceProfileDir.path),
      GetHistoryResource(sourceProfileDir.path),
      GetFormDataResource(sourceProfileDir.path),
      GetCookiesResource(sourceProfileDir.path),
      GetPasswordsResource(sourceProfileDir.path),
    ]);

    return possibleResources
      .filter(promise => promise.status == "fulfilled" && promise.value)
      .map(promise => promise.value);
  }

  async getLastUsedDate() {
    let profiles = await this.getSourceProfiles();
    let lastUsedTimes = await Promise.all(
      profiles.map(profile => this._getProfileLastUsedTime(profile.id))
    );
    lastUsedTimes.push(0);
    return new Date(Math.max(...lastUsedTimes));
  }

  async _getProfileLastUsedTime(profilePath) {
    let times = await Promise.all(
      [
        "places.sqlite",
        "formhistory.sqlite",
        "cookies.sqlite",
        "logins.json",
      ].map(async leafName => {
        let filePath = PathUtils.join(profilePath, leafName);
        let info = await IOUtils.stat(filePath).catch(() => null);
        return info?.lastModified ?? 0;
      })
    );
    return Math.max(...times);
  }
}

async function getProfileFilePath(profilePath, leafName) {
  let filePath = PathUtils.join(profilePath, leafName);
  return (await IOUtils.exists(filePath)) ? filePath : null;
}

async function GetPasswordsResource(profilePath) {
  let loginsPath = await getProfileFilePath(profilePath, "logins.json");
  if (!loginsPath) {
    return null;
  }

  let loginsFile;
  try {
    loginsFile = await IOUtils.readJSON(loginsPath);
  } catch (ex) {
    console.error(ex);
    return null;
  }

  let sourceLogins = loginsFile?.logins?.filter(login => !login.deleted) ?? [];
  if (!sourceLogins.length) {
    return null;
  }

  let hasEncryptedLogins = sourceLogins.some(
    login => login.encType == Ci.nsILoginManagerCrypto.ENCTYPE_SDR
  );
  if (
    hasEncryptedLogins &&
    !(await getProfileFilePath(profilePath, "key4.db")) &&
    !(await getProfileFilePath(profilePath, "key3.db"))
  ) {
    return null;
  }

  return {
    type: MigrationUtils.resourceTypes.PASSWORDS,

    async migrate(aCallback) {
      let loginCrypto = null;
      try {
        if (hasEncryptedLogins) {
          loginCrypto = new lazy.FirefoxProfileLoginCrypto(profilePath);
        }

        let logins = [];
        for (let sourceLogin of sourceLogins) {
          try {
            let login = decryptFirefoxLogin(sourceLogin, loginCrypto);
            if (login) {
              logins.push(login);
            }
          } catch (ex) {
            console.error(ex);
          }
        }

        if (!logins.length) {
          aCallback(false);
          return;
        }

        await MigrationUtils.insertLoginsWrapper(logins);
        aCallback(true);
      } catch (ex) {
        console.error(ex);
        aCallback(false);
      } finally {
        loginCrypto?.close();
      }
    },
  };
}

function decryptFirefoxLogin(sourceLogin, loginCrypto) {
  let username = sourceLogin.encryptedUsername;
  let password = sourceLogin.encryptedPassword;
  if (sourceLogin.encType == Ci.nsILoginManagerCrypto.ENCTYPE_SDR) {
    username = loginCrypto.decrypt(username);
    password = loginCrypto.decrypt(password);
  }

  if (!sourceLogin.hostname || !password) {
    return null;
  }

  return {
    username,
    password,
    origin: sourceLogin.hostname,
    formActionOrigin:
      sourceLogin.httpRealm === null ? (sourceLogin.formSubmitURL ?? "") : null,
    httpRealm: sourceLogin.httpRealm,
    usernameElement: sourceLogin.usernameField ?? "",
    passwordElement: sourceLogin.passwordField ?? "",
    guid: sourceLogin.guid,
    timeCreated: sourceLogin.timeCreated,
    timeLastUsed: sourceLogin.timeLastUsed,
    timePasswordChanged: sourceLogin.timePasswordChanged,
    timesUsed: sourceLogin.timesUsed,
  };
}

async function GetBookmarksResource(profilePath) {
  let placesPath = await getProfileFilePath(profilePath, "places.sqlite");
  if (!placesPath) {
    return null;
  }

  let bookmarkTargets = await readBookmarkTargets(placesPath);
  if (!bookmarkTargets.length) {
    return null;
  }

  return {
    type: MigrationUtils.resourceTypes.BOOKMARKS,

    migrate(aCallback) {
      (async function () {
        for (let { children, parentGuid } of bookmarkTargets) {
          await MigrationUtils.insertManyBookmarksWrapper(children, parentGuid);
        }
      })().then(
        () => aCallback(true),
        ex => {
          console.error(ex);
          aCallback(false);
        }
      );
    },
  };
}

async function readBookmarkTargets(placesPath) {
  let rows = await MigrationUtils.getRowsFromDBWithoutLocks(
    placesPath,
    "Firefox bookmarks",
    `SELECT b.id, b.type, b.parent, b.position, b.title, b.guid, p.url
     FROM moz_bookmarks b
     LEFT JOIN moz_places p ON b.fk = p.id
     ORDER BY b.parent ASC, b.position ASC`
  );

  let rowsByGuid = new Map();
  let rowsByParent = new Map();
  for (let row of rows) {
    let item = {
      id: row.getResultByName("id"),
      type: row.getResultByName("type"),
      parent: row.getResultByName("parent"),
      title: row.getResultByName("title") || "",
      guid: row.getResultByName("guid"),
      url: row.getResultByName("url"),
    };

    rowsByGuid.set(item.guid, item);
    if (item.parent) {
      if (!rowsByParent.has(item.parent)) {
        rowsByParent.set(item.parent, []);
      }
      rowsByParent.get(item.parent).push(item);
    }
  }

  function convertChildren(parentId) {
    let children = rowsByParent.get(parentId) ?? [];
    return children.map(convertItem).filter(item => item);
  }

  function convertItem(item) {
    let bookmarkTypes = lazy.PlacesUtils.bookmarks;
    switch (item.type) {
      case bookmarkTypes.TYPE_BOOKMARK:
        if (!item.url) {
          return null;
        }
        return {
          url: item.url,
          title: item.title,
        };
      case bookmarkTypes.TYPE_FOLDER:
        return {
          type: bookmarkTypes.TYPE_FOLDER,
          title: item.title,
          children: convertChildren(item.id),
        };
      case bookmarkTypes.TYPE_SEPARATOR:
        return {
          type: bookmarkTypes.TYPE_SEPARATOR,
        };
      default:
        return null;
    }
  }

  let targets = [];
  for (let [sourceRootGuid, targetRootName] of FIREFOX_BOOKMARK_ROOTS) {
    let root = rowsByGuid.get(sourceRootGuid);
    if (!root) {
      continue;
    }

    let children = convertChildren(root.id);
    if (children.length) {
      targets.push({
        parentGuid: lazy.PlacesUtils.bookmarks[targetRootName],
        children,
      });
    }
  }

  return targets;
}

async function GetHistoryResource(profilePath) {
  let placesPath = await getProfileFilePath(profilePath, "places.sqlite");
  if (!placesPath) {
    return null;
  }

  let minimumVisitDate = lazy.PlacesUtils.toPRTime(
    Date.now() - MigrationUtils.HISTORY_MAX_AGE_IN_MILLISECONDS
  );
  let countRows = await MigrationUtils.getRowsFromDBWithoutLocks(
    placesPath,
    "Firefox history",
    `SELECT COUNT(*) FROM moz_places p
     JOIN moz_historyvisits h ON h.place_id = p.id
     WHERE p.hidden = 0 AND h.visit_date > ${minimumVisitDate}`
  );

  if (!countRows[0].getResultByName("COUNT(*)")) {
    return null;
  }

  return {
    type: MigrationUtils.resourceTypes.HISTORY,

    migrate(aCallback) {
      (async function () {
        let rows = await MigrationUtils.getRowsFromDBWithoutLocks(
          placesPath,
          "Firefox history",
          `SELECT p.url, p.title, h.visit_date, h.visit_type
           FROM moz_places p
           JOIN moz_historyvisits h ON h.place_id = p.id
           WHERE p.hidden = 0 AND h.visit_date > ${minimumVisitDate}
           ORDER BY p.url ASC, h.visit_date ASC`
        );

        let validTransitions = new Set(
          Object.values(lazy.PlacesUtils.history.TRANSITIONS)
        );
        let pageInfoByURL = new Map();
        for (let row of rows) {
          try {
            let url = row.getResultByName("url");
            let uri = Services.io.newURI(url);
            if (!lazy.PlacesUtils.history.canAddURI(uri)) {
              continue;
            }

            let pageInfo = pageInfoByURL.get(url);
            if (!pageInfo) {
              pageInfo = {
                title: row.getResultByName("title") || "",
                url: new URL(url),
                visits: [],
              };
              pageInfoByURL.set(url, pageInfo);
            }

            let transition = row.getResultByName("visit_type");
            if (!validTransitions.has(transition)) {
              transition = lazy.PlacesUtils.history.TRANSITIONS.LINK;
            }

            pageInfo.visits.push({
              transition,
              date: lazy.PlacesUtils.toDate(row.getResultByName("visit_date")),
            });
          } catch (ex) {
            console.error(ex);
          }
        }

        let pageInfos = Array.from(pageInfoByURL.values()).filter(
          pageInfo => pageInfo.visits.length
        );
        if (pageInfos.length) {
          await MigrationUtils.insertVisitsWrapper(pageInfos);
        }
      })().then(
        () => aCallback(true),
        ex => {
          console.error(ex);
          aCallback(false);
        }
      );
    },
  };
}

async function GetCookiesResource(profilePath) {
  let cookiesPath = await getProfileFilePath(profilePath, "cookies.sqlite");
  if (!cookiesPath) {
    return null;
  }

  let countRows = await MigrationUtils.getRowsFromDBWithoutLocks(
    cookiesPath,
    "Firefox cookies",
    `SELECT COUNT(*) FROM moz_cookies
     WHERE expiry > ${Math.floor(Date.now() / 1000)}`
  );
  if (!countRows[0].getResultByName("COUNT(*)")) {
    return null;
  }

  return {
    type: MigrationUtils.resourceTypes.COOKIES,

    migrate(aCallback) {
      (async function () {
        let columns = await getTableColumnNames(cookiesPath, "moz_cookies");
        let rows = await MigrationUtils.getRowsFromDBWithoutLocks(
          cookiesPath,
          "Firefox cookies",
          `SELECT host, path, name, value, expiry, isSecure, isHttpOnly,
                  ${selectColumn(columns, "originAttributes", "''")},
                  ${selectColumn(columns, "sameSite", Ci.nsICookie.SAMESITE_NONE)},
                  ${selectColumn(columns, "schemeMap", Ci.nsICookie.SCHEME_UNSET)},
                  ${selectColumn(columns, "isPartitionedAttributeSet", 0)}
           FROM moz_cookies
           WHERE expiry > ${Math.floor(Date.now() / 1000)}`
        );

        for (let row of rows) {
          try {
            let host = row.getResultByName("host");
            if (!host) {
              continue;
            }

            let originAttributes = parseOriginAttributes(
              row.getResultByName("originAttributes")
            );
            let isSecure = !!row.getResultByName("isSecure");
            let schemeMap = row.getResultByName("schemeMap");
            if (!schemeMap) {
              schemeMap = isSecure
                ? Ci.nsICookie.SCHEME_HTTPS
                : Ci.nsICookie.SCHEME_HTTP;
            }

            Services.cookies.add(
              host,
              row.getResultByName("path") || "/",
              row.getResultByName("name") || "",
              row.getResultByName("value") || "",
              isSecure,
              !!row.getResultByName("isHttpOnly"),
              false,
              normalizeCookieExpiry(row.getResultByName("expiry")),
              originAttributes,
              row.getResultByName("sameSite"),
              schemeMap,
              !!row.getResultByName("isPartitionedAttributeSet") ||
                !!originAttributes.partitionKey
            );
          } catch (ex) {
            console.error(ex);
          }
        }
      })().then(
        () => aCallback(true),
        ex => {
          console.error(ex);
          aCallback(false);
        }
      );
    },
  };
}

async function getTableColumnNames(dbPath, tableName) {
  let rows = await MigrationUtils.getRowsFromDBWithoutLocks(
    dbPath,
    `${tableName} schema`,
    `PRAGMA table_info(${tableName})`
  );
  return new Set(rows.map(row => row.getResultByName("name")));
}

function selectColumn(columns, columnName, fallbackValue) {
  if (columns.has(columnName)) {
    return columnName;
  }
  return `${fallbackValue} AS ${columnName}`;
}

function parseOriginAttributes(originAttributes) {
  if (!originAttributes) {
    return {};
  }

  try {
    return ChromeUtils.createOriginAttributesFromOrigin(
      `https://example.com${originAttributes}`
    );
  } catch (ex) {
    console.error(ex);
    return {};
  }
}

function normalizeCookieExpiry(expiry) {
  return expiry < 10000000000 ? expiry * 1000 : expiry;
}

async function GetFormDataResource(profilePath) {
  let formHistoryPath = await getProfileFilePath(
    profilePath,
    "formhistory.sqlite"
  );
  if (!formHistoryPath) {
    return null;
  }

  let countRows = await MigrationUtils.getRowsFromDBWithoutLocks(
    formHistoryPath,
    "Firefox form history",
    "SELECT COUNT(*) FROM moz_formhistory"
  );
  if (!countRows[0].getResultByName("COUNT(*)")) {
    return null;
  }

  return {
    type: MigrationUtils.resourceTypes.FORMDATA,

    async migrate(aCallback) {
      let rows;
      try {
        rows = await MigrationUtils.getRowsFromDBWithoutLocks(
          formHistoryPath,
          "Firefox form history",
          `SELECT fieldname, value, timesUsed, firstUsed, lastUsed
           FROM moz_formhistory`
        );
      } catch (ex) {
        console.error(ex);
        aCallback(false);
        return;
      }

      let addOps = [];
      for (let row of rows) {
        let fieldname = row.getResultByName("fieldname");
        let value = row.getResultByName("value");
        if (!fieldname || !value) {
          continue;
        }

        addOps.push({
          op: "add",
          fieldname,
          value,
          timesUsed: row.getResultByName("timesUsed") || 1,
          firstUsed: row.getResultByName("firstUsed") || 0,
          lastUsed: row.getResultByName("lastUsed") || 0,
        });
      }

      try {
        if (addOps.length) {
          await lazy.FormHistory.update(addOps);
        }
      } catch (ex) {
        console.error(ex);
        aCallback(false);
        return;
      }

      aCallback(true);
    },
  };
}
