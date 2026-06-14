/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/* import-globals-from ../../../../../../browser/components/migration/tests/unit/head_migration.js */

"use strict";

const { FirefoxImportMigrator } = ChromeUtils.importESModule(
  "resource:///modules/FirefoxImportMigrator.sys.mjs"
);
const { FormHistory } = ChromeUtils.importESModule(
  "resource://gre/modules/FormHistory.sys.mjs"
);

const EXPECTED_RESOURCE_TYPES =
  MigrationUtils.resourceTypes.BOOKMARKS |
  MigrationUtils.resourceTypes.HISTORY |
  MigrationUtils.resourceTypes.FORMDATA |
  MigrationUtils.resourceTypes.COOKIES |
  MigrationUtils.resourceTypes.PASSWORDS;

let gDefaultSourceProfile;

add_setup(async function setup() {
  Services.prefs.setBoolPref("browser.migrate.firefox-import.enabled", true);

  let firefoxRoot = await createFirefoxProfileRoot();
  let absoluteProfilePath = PathUtils.join(
    gProfD.path,
    "firefox-absolute-profile"
  );
  let currentProfilePath = Services.dirsvc.get("ProfD", Ci.nsIFile).path;

  await createFirefoxProfile(
    PathUtils.join(firefoxRoot, "Profiles/default"),
    "default"
  );
  await createFirefoxProfile(
    PathUtils.join(firefoxRoot, "Profiles/duplicate"),
    "duplicate"
  );
  await createFirefoxProfile(absoluteProfilePath, "absolute");
  await IOUtils.makeDirectory(PathUtils.join(firefoxRoot, "Profiles/empty"), {
    createAncestor: true,
    ignoreExisting: true,
  });

  await writeProfilesIni(firefoxRoot, [
    {
      name: "default",
      path: "Profiles/default",
      isRelative: true,
    },
    {
      name: "default",
      path: "Profiles/duplicate",
      isRelative: true,
    },
    {
      name: "absolute",
      path: absoluteProfilePath,
      isRelative: false,
    },
    {
      name: "current",
      path: currentProfilePath,
      isRelative: false,
    },
    {
      name: "empty",
      path: "Profiles/empty",
      isRelative: true,
    },
  ]);

  registerCleanupFunction(async () => {
    await PlacesUtils.bookmarks.eraseEverything();
    await PlacesUtils.history.clear();
    await FormHistory.update({ op: "remove" });
    Services.cookies.removeAll();
    await Services.logins.removeAllUserFacingLoginsAsync();
  });
});

add_task(async function test_profile_discovery() {
  let migrator = await MigrationUtils.getMigrator(FirefoxImportMigrator.key);
  Assert.ok(migrator, "The Firefox import migrator should be available");

  let profiles = await migrator.getSourceProfiles();
  Assert.equal(
    profiles.length,
    3,
    "Only profiles with importable data are shown"
  );
  Assert.deepEqual(
    profiles.map(profile => profile.name).sort(),
    ["absolute", "default", "default (2)"],
    "Duplicate names are disambiguated"
  );
  Assert.ok(
    !profiles.some(profile => profile.name == "current"),
    "The current profile is not listed"
  );
  Assert.ok(
    !profiles.some(profile => profile.name == "empty"),
    "Profiles with no importable resources are not listed"
  );
  Assert.equal(
    MigrationUtils.getSourceIdForTelemetry(FirefoxImportMigrator.key),
    MigrationUtils.getSourceIdForTelemetry("firefox"),
    "Firefox import reuses the Firefox source ID"
  );

  gDefaultSourceProfile = profiles.find(profile => profile.name == "default");
});

add_task(async function test_available_resource_types() {
  let migrator = await MigrationUtils.getMigrator(FirefoxImportMigrator.key);
  let migrateData = await migrator.getMigrateData(gDefaultSourceProfile);

  Assert.equal(
    migrateData & EXPECTED_RESOURCE_TYPES,
    EXPECTED_RESOURCE_TYPES,
    "Bookmarks, history, form data, cookies, and passwords are available"
  );
});

add_task(async function test_import_profile_resources() {
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesUtils.history.clear();
  await FormHistory.update({ op: "remove" });
  Services.cookies.removeAll();
  await Services.logins.removeAllUserFacingLoginsAsync();

  let migrator = await MigrationUtils.getMigrator(FirefoxImportMigrator.key);
  await promiseMigration(
    migrator,
    MigrationUtils.resourceTypes.BOOKMARKS,
    gDefaultSourceProfile,
    true
  );
  await promiseMigration(
    migrator,
    MigrationUtils.resourceTypes.HISTORY,
    gDefaultSourceProfile,
    true
  );
  await promiseMigration(
    migrator,
    MigrationUtils.resourceTypes.FORMDATA,
    gDefaultSourceProfile,
    true
  );
  await promiseMigration(
    migrator,
    MigrationUtils.resourceTypes.COOKIES,
    gDefaultSourceProfile,
    true
  );
  await promiseMigration(
    migrator,
    MigrationUtils.resourceTypes.PASSWORDS,
    gDefaultSourceProfile,
    true
  );

  let toolbarBookmark = await PlacesUtils.bookmarks.fetch({
    url: "https://example.com/default/bookmark",
  });
  Assert.ok(toolbarBookmark, "The toolbar bookmark was imported");

  let menuBookmark = await PlacesUtils.bookmarks.fetch({
    url: "https://example.com/default/menu-bookmark",
  });
  Assert.ok(menuBookmark, "The menu bookmark was imported");

  let mobileBookmark = await PlacesUtils.bookmarks.fetch({
    url: "https://example.com/default/mobile-bookmark",
  });
  Assert.ok(mobileBookmark, "The mobile bookmark was imported");

  let historyEntry = await PlacesUtils.history.fetch(
    "https://example.com/default/history",
    { includeVisits: true }
  );
  Assert.ok(historyEntry, "The history entry was imported");
  Assert.equal(
    historyEntry.title,
    "History default",
    "The history title matches"
  );
  Assert.equal(historyEntry.visits.length, 1, "The history visit was imported");
  Assert.equal(
    historyEntry.visits[0].transition,
    PlacesUtils.history.TRANSITIONS.TYPED,
    "The visit transition was preserved"
  );

  let formEntries = await FormHistory.search(["fieldname", "value"], {
    fieldname: "field-default",
    value: "value-default",
  });
  Assert.equal(formEntries.length, 1, "The form history entry was imported");

  let cookie = Services.cookies.cookies.find(
    candidate =>
      candidate.host == "example.com" && candidate.name == "cookie-default"
  );
  Assert.ok(cookie, "The cookie was imported");
  Assert.equal(cookie.value, "value-default", "The cookie value matches");

  let logins = await Services.logins.searchLoginsAsync({
    origin: "https://example.com/default",
  });
  Assert.equal(logins.length, 1, "The login was imported");
  Assert.equal(logins[0].username, "username-default", "The username matches");
  Assert.equal(logins[0].password, "password-default", "The password matches");
  Assert.equal(
    logins[0].formActionOrigin,
    "https://example.com/default",
    "The form action origin matches"
  );
});

async function createFirefoxProfileRoot() {
  let fakeBase = gProfD.clone();
  fakeBase.append("firefox-import-roots");
  fakeBase.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);

  let root = fakeBase.clone();
  if (AppConstants.platform == "win") {
    registerFakePath("AppData", fakeBase);
    root.appendRelativePath("Mozilla/Firefox");
  } else if (AppConstants.platform == "macosx") {
    registerFakePath("ULibDir", fakeBase);
    root.appendRelativePath("Application Support/Firefox");
  } else {
    registerFakePath("Home", fakeBase);
    root.appendRelativePath(".mozilla/firefox");
  }

  await IOUtils.makeDirectory(root.path, {
    createAncestor: true,
    ignoreExisting: true,
  });
  return root.path;
}

async function writeProfilesIni(rootPath, profiles) {
  let lines = [];
  for (let [index, profile] of profiles.entries()) {
    lines.push(
      `[Profile${index}]`,
      `Name=${profile.name}`,
      `IsRelative=${profile.isRelative ? 1 : 0}`,
      `Path=${profile.path}`,
      ""
    );
  }

  await IOUtils.writeUTF8(
    PathUtils.join(rootPath, "profiles.ini"),
    lines.join("\n")
  );
}

async function createFirefoxProfile(profilePath, suffix) {
  await IOUtils.makeDirectory(profilePath, {
    createAncestor: true,
    ignoreExisting: true,
  });
  await createPlacesDatabase(profilePath, suffix);
  await createFormHistoryDatabase(profilePath, suffix);
  await createCookiesDatabase(profilePath, suffix);
  await createLoginsFile(profilePath, suffix);
}

async function createPlacesDatabase(profilePath, suffix) {
  let db = await Sqlite.openConnection({
    path: PathUtils.join(profilePath, "places.sqlite"),
  });

  try {
    await db.execute(
      `CREATE TABLE moz_places (
        id INTEGER PRIMARY KEY,
        url LONGVARCHAR,
        title LONGVARCHAR,
        hidden INTEGER DEFAULT 0
      )`
    );
    await db.execute(
      `CREATE TABLE moz_historyvisits (
        id INTEGER PRIMARY KEY,
        place_id INTEGER,
        visit_date INTEGER,
        visit_type INTEGER
      )`
    );
    await db.execute(
      `CREATE TABLE moz_bookmarks (
        id INTEGER PRIMARY KEY,
        type INTEGER,
        fk INTEGER,
        parent INTEGER,
        position INTEGER,
        title LONGVARCHAR,
        guid TEXT
      )`
    );

    await insertRows(db, "moz_places", [
      {
        id: 1,
        url: `https://example.com/${suffix}/bookmark`,
        title: `Bookmark ${suffix}`,
        hidden: 0,
      },
      {
        id: 2,
        url: `https://example.com/${suffix}/history`,
        title: `History ${suffix}`,
        hidden: 0,
      },
      {
        id: 3,
        url: `https://example.com/${suffix}/menu-bookmark`,
        title: `Menu ${suffix}`,
        hidden: 0,
      },
      {
        id: 4,
        url: `https://example.com/${suffix}/mobile-bookmark`,
        title: `Mobile ${suffix}`,
        hidden: 0,
      },
    ]);

    await insertRows(db, "moz_historyvisits", [
      {
        id: 1,
        place_id: 2,
        visit_date: PlacesUtils.toPRTime(Date.now() - 24 * 60 * 60 * 1000),
        visit_type: PlacesUtils.history.TRANSITIONS.TYPED,
      },
    ]);

    let bookmarkTypes = PlacesUtils.bookmarks;
    await insertRows(db, "moz_bookmarks", [
      rootRow(1, null, 0, "root", "root________"),
      rootRow(2, 1, 0, "menu", "menu________"),
      rootRow(3, 1, 1, "toolbar", "toolbar_____"),
      rootRow(4, 1, 2, "unfiled", "unfiled_____"),
      rootRow(5, 1, 3, "mobile", "mobile______"),
      rootRow(6, 1, 4, "tags", "tags________"),
      {
        id: 7,
        type: bookmarkTypes.TYPE_BOOKMARK,
        fk: 1,
        parent: 3,
        position: 0,
        title: `Bookmark ${suffix}`,
        guid: `${suffix}bm1`,
      },
      {
        id: 8,
        type: bookmarkTypes.TYPE_FOLDER,
        fk: null,
        parent: 2,
        position: 0,
        title: `Menu Folder ${suffix}`,
        guid: `${suffix}fd1`,
      },
      {
        id: 9,
        type: bookmarkTypes.TYPE_BOOKMARK,
        fk: 3,
        parent: 8,
        position: 0,
        title: `Menu ${suffix}`,
        guid: `${suffix}bm2`,
      },
      {
        id: 10,
        type: bookmarkTypes.TYPE_BOOKMARK,
        fk: 4,
        parent: 5,
        position: 0,
        title: `Mobile ${suffix}`,
        guid: `${suffix}bm3`,
      },
      {
        id: 11,
        type: bookmarkTypes.TYPE_BOOKMARK,
        fk: 1,
        parent: 6,
        position: 0,
        title: `Tagged ${suffix}`,
        guid: `${suffix}bm4`,
      },
    ]);
  } finally {
    await db.close();
  }
}

async function createFormHistoryDatabase(profilePath, suffix) {
  let db = await Sqlite.openConnection({
    path: PathUtils.join(profilePath, "formhistory.sqlite"),
  });

  try {
    await db.execute(
      `CREATE TABLE moz_formhistory (
        id INTEGER PRIMARY KEY,
        fieldname TEXT,
        value TEXT,
        timesUsed INTEGER,
        firstUsed INTEGER,
        lastUsed INTEGER,
        guid TEXT
      )`
    );
    await insertRows(db, "moz_formhistory", [
      {
        id: 1,
        fieldname: `field-${suffix}`,
        value: `value-${suffix}`,
        timesUsed: 3,
        firstUsed: PlacesUtils.toPRTime(Date.now() - 7 * 24 * 60 * 60 * 1000),
        lastUsed: PlacesUtils.toPRTime(Date.now()),
        guid: `${suffix}form1`,
      },
    ]);
  } finally {
    await db.close();
  }
}

async function createCookiesDatabase(profilePath, suffix) {
  let db = await Sqlite.openConnection({
    path: PathUtils.join(profilePath, "cookies.sqlite"),
  });

  try {
    await db.execute("PRAGMA user_version = 17");
    await db.execute(
      `CREATE TABLE moz_cookies (
        id INTEGER PRIMARY KEY,
        originAttributes TEXT NOT NULL DEFAULT '',
        name TEXT,
        value TEXT,
        host TEXT,
        path TEXT,
        expiry INTEGER,
        lastAccessed INTEGER,
        creationTime INTEGER,
        isSecure INTEGER,
        isHttpOnly INTEGER,
        inBrowserElement INTEGER DEFAULT 0,
        sameSite INTEGER DEFAULT 0,
        schemeMap INTEGER DEFAULT 0,
        isPartitionedAttributeSet INTEGER DEFAULT 0,
        updateTime INTEGER,
        CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes)
      )`
    );
    await insertRows(db, "moz_cookies", [
      {
        id: 1,
        originAttributes: "",
        name: `cookie-${suffix}`,
        value: `value-${suffix}`,
        host: "example.com",
        path: "/",
        expiry: Date.now() + 7 * 24 * 60 * 60 * 1000,
        lastAccessed: PlacesUtils.toPRTime(Date.now()),
        creationTime: PlacesUtils.toPRTime(Date.now()),
        isSecure: 1,
        isHttpOnly: 1,
        inBrowserElement: 0,
        sameSite: Ci.nsICookie.SAMESITE_LAX,
        schemeMap: Ci.nsICookie.SCHEME_HTTPS,
        isPartitionedAttributeSet: 0,
        updateTime: PlacesUtils.toPRTime(Date.now()),
      },
    ]);
  } finally {
    await db.close();
  }
}

async function createLoginsFile(profilePath, suffix) {
  await IOUtils.writeJSON(PathUtils.join(profilePath, "logins.json"), {
    version: 3,
    logins: [
      {
        id: 1,
        hostname: `https://example.com/${suffix}`,
        httpRealm: null,
        formSubmitURL: `https://example.com/${suffix}`,
        usernameField: "username",
        passwordField: "password",
        encryptedUsername: `username-${suffix}`,
        encryptedPassword: `password-${suffix}`,
        guid: Services.uuid.generateUUID().toString(),
        encType: Ci.nsILoginManagerCrypto.ENCTYPE_BASE64,
        timeCreated: Date.now(),
        timeLastUsed: Date.now(),
        timePasswordChanged: Date.now(),
        timesUsed: 1,
      },
    ],
  });
}

function rootRow(id, parent, position, title, guid) {
  return {
    id,
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    fk: null,
    parent,
    position,
    title,
    guid,
  };
}

async function insertRows(db, table, rows) {
  for (let row of rows) {
    let columns = Object.keys(row);
    let columnList = columns.join(", ");
    let parameterList = columns.map(column => `:${column}`).join(", ");
    await db.execute(
      `INSERT INTO ${table} (${columnList}) VALUES (${parameterList})`,
      row
    );
  }
}
