/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  parseManifestModifiers,
  selectSkinProvider,
} from "resource:///modules/ChromeManifest.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

const addonManagerStartup = Cc[
  "@mozilla.org/addons/addon-manager-startup;1"
].getService(Ci.amIAddonManagerStartup);
const chromeRegistry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(
  Ci.nsIChromeRegistry
);
const resourceProtocol = Services.io
  .getProtocolHandler("resource")
  .QueryInterface(Ci.nsIResProtocolHandler);

const DIRECTIVE_ARGUMENTS = new Map([
  ["category", 3],
  ["component", 2],
  ["content", 2],
  ["contract", 2],
  ["locale", 3],
  ["manifest", 1],
  ["overlay", 2],
  ["override", 2],
  ["resource", 2],
  ["skin", 3],
  ["style", 2],
]);
const REJECTED_DIRECTIVES = new Map([
  [
    "binary-component",
    'binary XPCOM components are not supported; replace it with a package-local "component <CID> <path.js>" directive',
  ],
  [
    "interfaces",
    "XPT interface/type-library registration is not supported; migrate the interface to WebIDL or JavaScript",
  ],
  [
    "type-library",
    "XPT interface/type-library registration is not supported; migrate the interface to WebIDL or JavaScript",
  ],
]);
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const ABSOLUTE_URI_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function addMapValue(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function setNestedMapValue(map, key, nestedKey, value) {
  if (!map.has(key)) {
    map.set(key, new Map());
  }
  map.get(key).set(nestedKey, value);
}

function encodeRelativePath(path) {
  const segments = path.split("/");
  if (
    !segments.length ||
    segments.some(segment => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe path in skin package: ${path}`);
  }
  return segments.map(encodeURIComponent).join("/");
}

function normalizeSkinAliasPath(path, location) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error(`Malformed skin alias path at ${location}: ${path}`);
  }

  if (decoded.startsWith("/") || /[\\?#\0]/.test(decoded)) {
    throw new Error(`Unsafe skin alias path at ${location}: ${path}`);
  }

  const segments = decoded.split("/").filter(Boolean);
  if (segments.some(segment => segment === "." || segment === "..")) {
    throw new Error(`Unsafe skin alias path at ${location}: ${path}`);
  }
  return segments.length
    ? `${segments.map(encodeURIComponent).join("/")}/`
    : "";
}

function getLineTokens(line) {
  const tokens = line.trim().split(/\s+/);
  const comment = tokens.findIndex(token => token.startsWith("#"));
  if (comment !== -1) {
    tokens.length = comment;
  }
  return tokens.filter(Boolean);
}

// Access is confined to the extension root for JAR and directory packages.
export class LegacyExtensionPackage {
  constructor(rootURI) {
    this.rootURI = rootURI;
    this.rootFile = null;
    this.rootJarFile = null;
    this.rootJarEntry = null;
    this._jarDirectoryEntries = new Map();

    if (rootURI instanceof Ci.nsIFileURL) {
      this.rootFile = rootURI.file.clone();
      this.rootFile.normalize();
      if (!this.rootFile.isDirectory()) {
        throw new Error(`Extension root is not a directory: ${rootURI.spec}`);
      }
    } else if (rootURI instanceof Ci.nsIJARURI) {
      this.rootJarFile = rootURI.JARFile;
      this.rootJarEntry = rootURI.JAREntry.replace(/^\/+/, "");
      if (this.rootJarEntry && !this.rootJarEntry.endsWith("/")) {
        this.rootJarEntry += "/";
      }
    } else {
      throw new Error(`Unsupported extension root: ${rootURI.spec}`);
    }
  }

  _canonicalFile(file) {
    const canonical = file.clone();
    canonical.normalize();
    return canonical;
  }

  _containsFile(file) {
    return this.rootFile.equals(file) || this.rootFile.contains(file);
  }

  _isLocalJarURI(uri) {
    if (!(uri instanceof Ci.nsIJARURI) || !this.rootJarFile) {
      return false;
    }
    const entry = uri.JAREntry.replace(/^\/+/, "");
    return (
      uri.JARFile.equals(this.rootJarFile) &&
      entry.startsWith(this.rootJarEntry)
    );
  }

  normalizeLocalURI(uri, directory = false) {
    if (this.rootFile) {
      if (!(uri instanceof Ci.nsIFileURL)) {
        throw new Error(`URI is outside the unpacked extension: ${uri.spec}`);
      }
      const file = this._canonicalFile(uri.file);
      if (!this._containsFile(file)) {
        throw new Error(`URI escapes the extension root: ${uri.spec}`);
      }
      if (directory && !file.isDirectory()) {
        throw new Error(`Package location is not a directory: ${uri.spec}`);
      }
      return Services.io.newFileURI(file);
    }

    if (!this._isLocalJarURI(uri)) {
      throw new Error(`URI escapes the extension root: ${uri.spec}`);
    }
    if (directory && !uri.spec.endsWith("/")) {
      uri = Services.io.newURI(`${uri.spec}/`);
    }
    return uri;
  }

  isLocalURI(uri) {
    if (typeof uri === "string") {
      try {
        uri = Services.io.newURI(uri);
      } catch {
        return false;
      }
    }

    try {
      this.normalizeLocalURI(uri);
      return true;
    } catch {
      return false;
    }
  }

  resolveLocalURI(value, baseURI = this.rootURI, directory = false) {
    let uri;
    try {
      uri = Services.io.newURI(value, null, baseURI);
      if (directory && !uri.spec.endsWith("/")) {
        uri = Services.io.newURI(`${uri.spec}/`);
      }
    } catch (error) {
      throw new Error(`Malformed package URI "${value}": ${error.message}`);
    }
    return this.normalizeLocalURI(uri, directory);
  }

  resolveLocalFile(value, baseURI = this.rootURI) {
    const uri = this.resolveLocalURI(value, baseURI);
    let isFile = false;

    if (uri instanceof Ci.nsIFileURL) {
      try {
        isFile = uri.file.isFile();
      } catch {}
    } else {
      const entry = uri.JAREntry.replace(/^\/+/, "");
      const directoryURI = Services.io.newURI(".", null, uri);
      let entries = this._jarDirectoryEntries.get(directoryURI.spec);
      if (!entries) {
        try {
          entries = new Set(
            addonManagerStartup.enumerateJARSubtree(directoryURI)
          );
        } catch {
          entries = new Set();
        }
        this._jarDirectoryEntries.set(directoryURI.spec, entries);
      }
      isFile = !entry.endsWith("/") && entries.has(entry);
    }

    if (!isFile) {
      throw new Error(`Package path is not a file: ${uri.spec}`);
    }
    return uri;
  }

  resolveRegisteredURI(value) {
    let uri;
    try {
      uri = Services.io.newURI(value);
      const seen = new Set();
      while (uri.schemeIs("chrome")) {
        if (seen.has(uri.spec)) {
          return null;
        }
        seen.add(uri.spec);
        uri = chromeRegistry.convertChromeURL(uri);
      }
      if (uri.schemeIs("resource")) {
        uri = Services.io.newURI(resourceProtocol.resolveURI(uri));
      }
    } catch {
      return null;
    }
    return this.isLocalURI(uri) ? uri : null;
  }

  readText(uri) {
    return new Promise((resolve, reject) => {
      lazy.NetUtil.asyncFetch(
        { uri, loadUsingSystemPrincipal: true },
        (stream, status) => {
          if (!Components.isSuccessCode(status)) {
            reject(
              new Error(
                `Unable to read ${uri.spec}: ${Components.Exception("", status).name}`
              )
            );
            return;
          }

          try {
            resolve(
              lazy.NetUtil.readInputStreamToString(stream, stream.available(), {
                charset: "UTF-8",
              })
            );
          } catch (error) {
            reject(error);
          }
        }
      );
    });
  }

  async listFiles(directoryURI) {
    if (directoryURI instanceof Ci.nsIFileURL) {
      return this._listDirectoryFiles(directoryURI);
    }
    if (directoryURI instanceof Ci.nsIJARURI) {
      return this._listJarFiles(directoryURI);
    }
    throw new Error(`Unsupported package directory: ${directoryURI.spec}`);
  }

  _listDirectoryFiles(directoryURI) {
    const files = [];
    const visited = new Set();

    const visit = (directory, relativePath) => {
      const canonicalDirectory = this._canonicalFile(directory);
      if (!this._containsFile(canonicalDirectory)) {
        throw new Error(
          `Skin directory escapes the extension root: ${directory.path}`
        );
      }
      if (visited.has(canonicalDirectory.path)) {
        throw new Error(`Cyclic skin directory: ${canonicalDirectory.path}`);
      }
      visited.add(canonicalDirectory.path);

      const entries = [];
      const enumerator = canonicalDirectory.directoryEntries;
      while (enumerator.hasMoreElements()) {
        entries.push(enumerator.getNext().QueryInterface(Ci.nsIFile));
      }
      entries.sort((a, b) => a.leafName.localeCompare(b.leafName));

      for (const entry of entries) {
        const childRelativePath = relativePath
          ? `${relativePath}/${entry.leafName}`
          : entry.leafName;
        const isSymlink = entry.isSymlink();
        let canonicalEntry;
        try {
          canonicalEntry = this._canonicalFile(entry);
        } catch {
          throw new Error(`Broken symlink in skin directory: ${entry.path}`);
        }
        if (!this._containsFile(canonicalEntry)) {
          throw new Error(
            `Skin entry escapes the extension root: ${entry.path}`
          );
        }

        if (canonicalEntry.isDirectory()) {
          if (isSymlink) {
            throw new Error(
              `Symlinked skin directories are not supported: ${entry.path}`
            );
          }
          visit(canonicalEntry, childRelativePath);
        } else if (canonicalEntry.isFile()) {
          files.push({
            relativePath: encodeRelativePath(childRelativePath),
            uri: Services.io.newFileURI(canonicalEntry),
          });
        }
      }
    };

    visit(directoryURI.file, "");
    return files;
  }

  _listJarFiles(directoryURI) {
    let entry = directoryURI.JAREntry.replace(/^\/+/, "");
    if (!entry.endsWith("/")) {
      entry += "/";
    }

    const files = [];
    const names = addonManagerStartup.enumerateJARSubtree(directoryURI).sort();
    for (const name of names) {
      if (!name.startsWith(entry)) {
        throw new Error(
          `Unexpected entry while enumerating ${directoryURI.spec}`
        );
      }
      if (name.endsWith("/")) {
        continue;
      }

      const relativePath = name.slice(entry.length);
      if (!relativePath) {
        continue;
      }
      const encodedPath = encodeRelativePath(relativePath);
      const uri = Services.io.newURI(encodedPath, null, directoryURI);
      if (!this.isLocalURI(uri)) {
        throw new Error(`Skin entry escapes the extension root: ${name}`);
      }
      files.push({ relativePath: encodedPath, uri });
    }
    return files;
  }
}

export class LegacyResourceSubstitutions {
  constructor(entries, logger) {
    this.entries = entries;
    this.logger = logger;
    this.registered = [];
  }

  register() {
    for (const entry of this.entries) {
      if (resourceProtocol.hasSubstitution(entry.name)) {
        throw new Error(
          `Refusing to replace existing resource substitution "${entry.name}"`
        );
      }
    }

    try {
      for (const entry of this.entries) {
        let flags = entry.contentAccessible
          ? Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS
          : 0;
        if (entry.uri instanceof Ci.nsIJARURI) {
          flags |= Ci.nsISubstitutingProtocolHandler.RESOLVE_JAR_URI;
        }
        resourceProtocol.setSubstitutionWithFlags(entry.name, entry.uri, flags);
        this.registered.push(entry);
      }
    } catch (error) {
      this.unregister();
      throw error;
    }
  }

  unregister() {
    for (const entry of this.registered.reverse()) {
      try {
        if (
          resourceProtocol.hasSubstitution(entry.name) &&
          resourceProtocol.getSubstitution(entry.name).equals(entry.uri)
        ) {
          resourceProtocol.setSubstitution(entry.name, null);
        } else {
          this.logger.warn(
            `Resource substitution "${entry.name}" changed before legacy bridge shutdown`
          );
        }
      } catch (error) {
        this.logger.warn(
          `Unable to remove resource substitution "${entry.name}"`,
          error
        );
      }
    }
    this.registered.length = 0;
  }
}

export class LegacyChromeManifest {
  constructor(extension, logger) {
    this.extension = extension;
    this.logger = logger;
    this.package = new LegacyExtensionPackage(extension.rootURI);
    this.manifestURI = this.package.resolveLocalURI("chrome.manifest");
    this.chromeEntries = [];
    this.compatibilityChromeEntries = [];
    this.resourceEntries = [];
    this.componentEntries = [];
    this.contractEntries = [];
    this.categoryEntries = [];
    this.component = new Map();
    this.contract = new Map();
    this.category = new Map();
    this.content = new Map();
    this.locales = new Map();
    this.locale = this.locales;
    this.skin = new Map();
    this.resource = new Map();
    this.override = new Map();
    this.overlays = new Map();
    this.overlay = this.overlays;
    this.styles = new Map();
    this.style = this.styles;
    this._parsedManifests = new Set();
    this._resourceNames = new Set();
    this._skinEntries = [];
  }

  get hasDocumentEntries() {
    return this.overlays.size > 0 || this.styles.size > 0;
  }

  async parse() {
    await this._parseManifest(this.manifestURI);
    await this._createSkinOverrides();
    return this;
  }

  async _parseManifest(manifestURI) {
    if (this._parsedManifests.has(manifestURI.spec)) {
      return;
    }
    this._parsedManifests.add(manifestURI.spec);

    const source = await this.package.readText(manifestURI);
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const tokens = getLineTokens(line);
      if (!tokens.length) {
        continue;
      }

      const lineNumber = index + 1;
      const location = `${manifestURI.spec}:${lineNumber}`;
      const directive = tokens.shift();
      const rejection = REJECTED_DIRECTIVES.get(directive);
      if (rejection) {
        throw new Error(
          `Unsupported chrome.manifest directive "${directive}" at ${location}: ${rejection}`
        );
      }

      const argumentCount = DIRECTIVE_ARGUMENTS.get(directive);
      if (argumentCount === undefined) {
        throw new Error(
          `Unknown chrome.manifest directive "${directive}" at ${location}`
        );
      }
      if (tokens.length < argumentCount) {
        throw new Error(
          `Malformed ${directive} directive at ${location}: expected ${argumentCount} arguments`
        );
      }

      const args = tokens.splice(0, argumentCount);
      const modifiers = parseManifestModifiers(tokens, {
        directive,
        location,
      });
      if (!modifiers.matches) {
        continue;
      }

      await this._handleDirective(
        directive,
        args,
        modifiers.contentAccessible,
        manifestURI,
        location
      );
    }
  }

  async _handleDirective(
    directive,
    args,
    contentAccessible,
    manifestURI,
    location
  ) {
    switch (directive) {
      case "category":
        this._addCategory(args);
        break;
      case "component":
        this._addComponent(args, manifestURI, location);
        break;
      case "content":
        this._addContent(args, contentAccessible, manifestURI, location);
        break;
      case "contract":
        this._addContract(args, location);
        break;
      case "locale":
        this._addLocale(args, manifestURI, location);
        break;
      case "manifest": {
        const nestedManifest = this.package.resolveLocalURI(
          args[0],
          manifestURI
        );
        try {
          await this._parseManifest(nestedManifest);
        } catch (error) {
          if (!error.message.startsWith("Unable to read ")) {
            throw error;
          }
          this.logger.warn(
            `Unable to load nested legacy manifest ${nestedManifest.spec}`,
            error
          );
        }
        break;
      }
      case "overlay":
        this._addDocumentEntry(this.overlays, args, manifestURI, location);
        break;
      case "override":
        this._addOverride(args, manifestURI, location);
        break;
      case "resource":
        this._addResource(args, contentAccessible, manifestURI, location);
        break;
      case "skin":
        this._addSkin(args, manifestURI, location);
        break;
      case "style":
        this._addDocumentEntry(this.styles, args, manifestURI, location);
        break;
    }
  }

  _checkPackageName(name, location) {
    if (!PACKAGE_NAME_PATTERN.test(name)) {
      throw new Error(`Malformed chrome package "${name}" at ${location}`);
    }
  }

  _normalizeCID(value, location) {
    try {
      return Components.ID(value).toString();
    } catch {
      throw new Error(`Malformed CID "${value}" at ${location}`);
    }
  }

  _addComponent(args, manifestURI, location) {
    const cid = this._normalizeCID(args[0], location);
    let uri;
    try {
      uri = this.package.resolveLocalFile(args[1], manifestURI);
    } catch (error) {
      throw new Error(
        `Invalid component path "${args[1]}" at ${location}: ${error.message}`
      );
    }

    const path =
      uri instanceof Ci.nsIFileURL ? uri.file.leafName : uri.JAREntry;
    if (!/\.js$/i.test(path)) {
      throw new Error(
        `Component path must reference a package-local JavaScript file at ${location}: ${args[1]}`
      );
    }

    const entry = { cid, path: uri.spec, uri };
    this.componentEntries.push(entry);
    this.component.set(cid, uri.spec);
  }

  _addContract(args, location) {
    const entry = {
      contractId: args[0],
      cid: this._normalizeCID(args[1], location),
    };
    this.contractEntries.push(entry);
    this.contract.set(entry.contractId, entry.cid);
  }

  _addCategory(args) {
    const entry = {
      category: args[0],
      entry: args[1],
      value: args[2],
    };
    this.categoryEntries.push(entry);
    setNestedMapValue(this.category, entry.category, entry.entry, entry.value);
  }

  _addContent(args, contentAccessible, manifestURI, location) {
    this._checkPackageName(args[0], location);
    const uri = this.package.resolveLocalURI(args[1], manifestURI, true);
    const entry = ["content", args[0], uri.spec];
    if (contentAccessible) {
      entry.push("contentaccessible=yes");
    }
    this.chromeEntries.push(entry);
    this.content.set(args[0].toLowerCase(), uri.spec);
  }

  _addLocale(args, manifestURI, location) {
    this._checkPackageName(args[0], location);
    if (!args[1]) {
      throw new Error(`Malformed locale name at ${location}`);
    }
    const uri = this.package.resolveLocalURI(args[2], manifestURI, true);
    this.chromeEntries.push(["locale", args[0], args[1], uri.spec]);
    setNestedMapValue(this.locales, args[0].toLowerCase(), args[1], uri.spec);
  }

  _resolveManifestURL(value, manifestURI, location) {
    let uri;
    try {
      uri = Services.io.newURI(value, null, manifestURI);
    } catch (error) {
      throw new Error(
        `Malformed URI "${value}" at ${location}: ${error.message}`
      );
    }

    if (uri.schemeIs("file") || uri.schemeIs("jar")) {
      try {
        return this.package.normalizeLocalURI(uri);
      } catch {
        throw new Error(
          `URI escapes the extension root at ${location}: ${value}`
        );
      }
    }
    return uri;
  }

  _addOverride(args, manifestURI, location) {
    let source;
    try {
      source = Services.io.newURI(args[0]);
    } catch (error) {
      throw new Error(
        `Malformed override source "${args[0]}" at ${location}: ${error.message}`
      );
    }
    if (!source.schemeIs("chrome")) {
      throw new Error(`Override source must be a chrome URI at ${location}`);
    }

    const destination = this._resolveManifestURL(
      args[1],
      manifestURI,
      location
    );
    if (
      !["chrome", "file", "jar", "resource"].some(scheme =>
        destination.schemeIs(scheme)
      )
    ) {
      throw new Error(
        `Unsupported override destination at ${location}: ${args[1]}`
      );
    }
    this.chromeEntries.push(["override", source.spec, destination.spec]);
    this.override.set(source.spec, destination.spec);
  }

  _addResource(args, contentAccessible, manifestURI, location) {
    this._checkPackageName(args[0], location);
    const name = args[0].toLowerCase();
    if (this._resourceNames.has(name)) {
      throw new Error(`Duplicate resource package "${name}" at ${location}`);
    }
    this._resourceNames.add(name);
    const entry = {
      contentAccessible,
      name,
      uri: this.package.resolveLocalURI(args[1], manifestURI, true),
    };
    this.resourceEntries.push(entry);
    this.resource.set(name, entry.uri.spec);
  }

  _addSkin(args, manifestURI, location) {
    this._checkPackageName(args[0], location);
    if (!args[1]) {
      throw new Error(`Malformed skin name at ${location}`);
    }
    const entry = {
      location,
      manifestURI,
      packageName: args[0].toLowerCase(),
      skinName: args[1],
      source: args[2],
    };
    entry.parsedSource = this._parseSkinSource(entry);
    this._skinEntries.push(entry);

    const source = entry.parsedSource.directoryURI
      ? entry.parsedSource.directoryURI.spec
      : `chrome://${entry.parsedSource.packageName}/skin/${entry.parsedSource.path}`;
    setNestedMapValue(this.skin, entry.packageName, entry.skinName, source);
  }

  _parseSkinSource(entry) {
    const alias = /^chrome:\/\/([^/?#]+)\/skin(?:\/([^?#]*))?$/i.exec(
      entry.source
    );
    if (alias) {
      this._checkPackageName(alias[1], entry.location);
      return {
        packageName: alias[1].toLowerCase(),
        path: normalizeSkinAliasPath(alias[2] ?? "", entry.location),
      };
    }
    if (ABSOLUTE_URI_PATTERN.test(entry.source)) {
      throw new Error(
        `Unsupported skin source at ${entry.location}: ${entry.source}`
      );
    }
    return {
      directoryURI: this.package.resolveLocalURI(
        entry.source,
        entry.manifestURI,
        true
      ),
    };
  }

  async _createSkinOverrides() {
    const packages = new Map();
    for (const entry of this._skinEntries) {
      if (!packages.has(entry.packageName)) {
        packages.set(entry.packageName, new Map());
      }
      packages.get(entry.packageName).set(entry.skinName, entry);
    }

    const selectedEntries = new Map();
    for (const [packageName, providers] of packages) {
      selectedEntries.set(packageName, selectSkinProvider(providers));
    }

    const resolvedPackages = new Map();
    const resolving = [];
    const resolvePackage = async (packageName, referringEntry = null) => {
      if (resolvedPackages.has(packageName)) {
        return resolvedPackages.get(packageName);
      }

      const cycleStart = resolving.indexOf(packageName);
      if (cycleStart !== -1) {
        const cycle = [...resolving.slice(cycleStart), packageName].join(
          " -> "
        );
        throw new Error(
          `Cyclic skin alias at ${referringEntry.location}: ${cycle}`
        );
      }

      const entry = selectedEntries.get(packageName);
      if (!entry) {
        throw new Error(
          `Skin alias at ${referringEntry.location} references missing package "${packageName}"`
        );
      }

      resolving.push(packageName);
      const mappings = new Map();
      if (entry.parsedSource.packageName) {
        const sourceMappings = await resolvePackage(
          entry.parsedSource.packageName,
          entry
        );
        for (const [relativePath, uri] of sourceMappings) {
          if (relativePath.startsWith(entry.parsedSource.path)) {
            mappings.set(
              relativePath.slice(entry.parsedSource.path.length),
              uri
            );
          }
        }
      } else {
        const files = await this.package.listFiles(
          entry.parsedSource.directoryURI
        );
        for (const file of files) {
          mappings.set(file.relativePath, file.uri.spec);
        }
      }
      resolving.pop();
      resolvedPackages.set(packageName, mappings);
      return mappings;
    };

    for (const packageName of packages.keys()) {
      const skinRoot = Services.io.newURI(`chrome://${packageName}/skin/`);
      for (const [relativePath, target] of await resolvePackage(packageName)) {
        const source = Services.io.newURI(relativePath, null, skinRoot).spec;
        const entry = ["override", source, target];
        this.chromeEntries.push(entry);
        this.compatibilityChromeEntries.push(entry);
        this.override.set(source, target);
      }
    }
  }

  _addDocumentEntry(map, args, manifestURI, location) {
    let target;
    try {
      target = Services.io.newURI(args[0]);
    } catch (error) {
      throw new Error(
        `Malformed document target "${args[0]}" at ${location}: ${error.message}`
      );
    }

    const kind = map === this.overlays ? "overlay" : "style";
    if (!target.schemeIs("chrome") && !target.schemeIs("about")) {
      this.logger.warn(
        `Skipping unsupported ${kind} target ${target.spec}; only parent-process chrome: and about: documents are supported`
      );
      return;
    }

    const source = this._resolveManifestURL(args[1], manifestURI, location);
    if (
      !source.schemeIs("chrome") &&
      !source.schemeIs("resource") &&
      !this.package.isLocalURI(source)
    ) {
      throw new Error(
        `${kind} source must resolve inside the extension at ${location}`
      );
    }
    addMapValue(map, target.spec, source.spec);
  }
}
