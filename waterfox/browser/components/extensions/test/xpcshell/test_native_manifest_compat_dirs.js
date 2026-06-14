"use strict";

/* import-globals-from ../../../../../../toolkit/components/extensions/test/xpcshell/head.js */

const { NativeManifests } = ChromeUtils.importESModule(
  "resource://gre/modules/NativeManifests.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { Schemas } = ChromeUtils.importESModule(
  "resource://gre/modules/Schemas.sys.mjs"
);

const BASE_SCHEMA = "chrome://extensions/content/schemas/manifest.json";
const MOZILLA_DIR_NAME = "mozilla";
const DOT_MOZILLA_DIR_NAME = `.${MOZILLA_DIR_NAME}`;

const TYPE_SLUG =
  AppConstants.platform === "linux"
    ? "native-messaging-hosts"
    : "NativeMessagingHosts";

const USER_APP_DIR_NAME =
  AppConstants.platform === "linux" ? ".waterfox" : "Waterfox";
const USER_COMPAT_DIR_NAME =
  AppConstants.platform === "linux" ? DOT_MOZILLA_DIR_NAME : "Mozilla";
const GLOBAL_APP_DIR_NAME =
  AppConstants.platform === "linux" ? "waterfox" : "Waterfox";
const GLOBAL_COMPAT_DIR_NAME =
  AppConstants.platform === "linux" ? MOZILLA_DIR_NAME : "Mozilla";

let dir = FileUtils.getDir("TmpD", ["NativeManifestsWaterfox"]);
dir.createUnique(Ci.nsIFile.DIRECTORY_TYPE, FileUtils.PERMS_DIRECTORY);

let userRoot = dir.clone();
userRoot.append("user");
userRoot.create(Ci.nsIFile.DIRECTORY_TYPE, FileUtils.PERMS_DIRECTORY);

let userDir = userRoot.clone();
userDir.append(USER_APP_DIR_NAME);
userDir.create(Ci.nsIFile.DIRECTORY_TYPE, FileUtils.PERMS_DIRECTORY);

let userCompatDir = userRoot.clone();
userCompatDir.append(USER_COMPAT_DIR_NAME);
userCompatDir.create(Ci.nsIFile.DIRECTORY_TYPE, FileUtils.PERMS_DIRECTORY);

let globalRoot = dir.clone();
globalRoot.append("global");
globalRoot.create(Ci.nsIFile.DIRECTORY_TYPE, FileUtils.PERMS_DIRECTORY);

let globalDir = globalRoot.clone();
globalDir.append(GLOBAL_APP_DIR_NAME);
globalDir.create(Ci.nsIFile.DIRECTORY_TYPE, FileUtils.PERMS_DIRECTORY);

let globalCompatDir = globalRoot.clone();
globalCompatDir.append(GLOBAL_COMPAT_DIR_NAME);
globalCompatDir.create(Ci.nsIFile.DIRECTORY_TYPE, FileUtils.PERMS_DIRECTORY);

add_setup(async function setup() {
  await Schemas.load(BASE_SCHEMA);

  for (let manifestDir of [
    userDir,
    userCompatDir,
    globalDir,
    globalCompatDir,
  ]) {
    await IOUtils.makeDirectory(PathUtils.join(manifestDir.path, TYPE_SLUG));
  }
});

let dirProvider = {
  getFile(property) {
    if (property == "XREUserNativeManifests") {
      return userDir.clone();
    }
    if (property == "XRESysNativeManifests") {
      return globalDir.clone();
    }
    return null;
  },
};

Services.dirsvc.registerProvider(dirProvider);

registerCleanupFunction(() => {
  Services.dirsvc.unregisterProvider(dirProvider);
  dir.remove(true);
});

let global = this;

let context = {
  extension: {
    id: "extension@tests.mozilla.org",
  },
  manifestVersion: 2,
  envType: "addon_parent",
  url: null,
  jsonStringify(...args) {
    return JSON.stringify(...args);
  },
  cloneScope: global,
  logError() {},
  preprocessors: {},
  callOnClose: () => {},
  forgetOnClose: () => {},
};

let templateManifest = {
  name: "test",
  description: "this is only a test",
  path: "/bin/cat",
  type: "stdio",
  allowed_extensions: ["extension@tests.mozilla.org"],
};

function writeManifest(path, manifest) {
  return IOUtils.writeUTF8(path, JSON.stringify(manifest));
}

function lookupApplication(app) {
  return NativeManifests.lookupManifest("stdio", app, context);
}

async function writeApplicationManifest(rootDir, name, description) {
  let manifest = { ...templateManifest, name, description };
  let path = PathUtils.join(rootDir.path, TYPE_SLUG, `${name}.json`);
  await writeManifest(path, manifest);
  return { manifest, path };
}

add_task(async function test_mozilla_compat_manifest_dirs() {
  let user = await writeApplicationManifest(
    userCompatDir,
    "compat_user",
    "This manifest is from the Mozilla user directory"
  );

  let result = await lookupApplication("compat_user");
  notEqual(result, null, "lookupApplication finds a Mozilla user manifest");
  equal(
    result.path,
    user.path,
    "lookupApplication returns the Mozilla user manifest path"
  );
  deepEqual(
    result.manifest,
    user.manifest,
    "lookupApplication returns the Mozilla user manifest contents"
  );

  let system = await writeApplicationManifest(
    globalCompatDir,
    "compat_system",
    "This manifest is from the Mozilla system directory"
  );

  result = await lookupApplication("compat_system");
  notEqual(result, null, "lookupApplication finds a Mozilla system manifest");
  equal(
    result.path,
    system.path,
    "lookupApplication returns the Mozilla system manifest path"
  );
  deepEqual(
    result.manifest,
    system.manifest,
    "lookupApplication returns the Mozilla system manifest contents"
  );
});

add_task(async function test_mozilla_user_dir_precedence() {
  let user = await writeApplicationManifest(
    userCompatDir,
    "compat_precedence",
    "This manifest is from the Mozilla user directory"
  );
  await writeApplicationManifest(
    globalDir,
    "compat_precedence",
    "This manifest is from the Waterfox system directory"
  );

  let result = await lookupApplication("compat_precedence");
  notEqual(
    result,
    null,
    "lookupApplication finds a user manifest before a system manifest"
  );
  equal(
    result.path,
    user.path,
    "lookupApplication returns the Mozilla user path before the Waterfox system path"
  );
  deepEqual(
    result.manifest,
    user.manifest,
    "lookupApplication returns the Mozilla user manifest contents"
  );
});

add_task(async function test_waterfox_user_dir_precedence() {
  let waterfox = await writeApplicationManifest(
    userDir,
    "waterfox_precedence",
    "This manifest is from the Waterfox user directory"
  );
  await writeApplicationManifest(
    userCompatDir,
    "waterfox_precedence",
    "This manifest is from the Mozilla user directory"
  );

  let result = await lookupApplication("waterfox_precedence");
  notEqual(
    result,
    null,
    "lookupApplication finds a Waterfox manifest before a Mozilla manifest"
  );
  equal(
    result.path,
    waterfox.path,
    "lookupApplication returns the Waterfox user path before the Mozilla user path"
  );
  deepEqual(
    result.manifest,
    waterfox.manifest,
    "lookupApplication returns the Waterfox user manifest contents"
  );
});
