/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
    "binary XPCOM components are not supported; use a JavaScript component",
  ],
  [
    "interfaces",
    "XPT interface registration is not supported; use WebIDL or JavaScript",
  ],
  [
    "type-library",
    "XPT interface registration is not supported; use WebIDL or JavaScript",
  ],
]);
const CONDITIONAL_BOOLEAN_MODIFIERS = ["backgroundtask", "tablet"];
const OBSOLETE_CONTENT_MODIFIERS = ["remoteenabled", "remoterequired"];
const STRING_CONDITIONS = new Set(["abi", "application", "os", "process"]);
const VERSION_CONDITIONS = new Set([
  "appversion",
  "osversion",
  "platformversion",
]);
const DEFAULT_SKIN_PROVIDER = "classic/1.0";
const ABSOLUTE_URI = /^[a-z][a-z0-9+.-]*:/i;
const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

class DefaultMap extends Map {
  constructor(createDefault, iterable) {
    super(iterable);
    this.createDefault = createDefault;
  }

  get(key, create = true) {
    if (this.has(key)) {
      return super.get(key);
    }
    const value = this.createDefault();
    if (create) {
      this.set(key, value);
    }
    return value;
  }
}

function stripComment(line) {
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function normalizeRelativePath(value) {
  const suffixIndex = value.search(/[?#]/);
  const suffix = suffixIndex === -1 ? "" : value.slice(suffixIndex);
  const path = suffixIndex === -1 ? value : value.slice(0, suffixIndex);
  const absolute = path.startsWith("/");
  const trailingSlash = path.endsWith("/");
  const segments = [];

  for (const segment of path.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  let result = `${absolute ? "/" : ""}${segments.join("/")}`;
  if (trailingSlash && result && !result.endsWith("/")) {
    result += "/";
  }
  if (!result && absolute) {
    result = "/";
  }
  return result + suffix;
}

function resolveLocation(value, base) {
  if (ABSOLUTE_URI.test(value)) {
    return Services.io.newURI(value).spec;
  }
  if (ABSOLUTE_URI.test(base)) {
    const directory = base.endsWith("/") ? base : `${base}/`;
    return Services.io.newURI(value, null, Services.io.newURI(directory)).spec;
  }
  if (value.startsWith("/")) {
    return normalizeRelativePath(value);
  }
  const directory = base.replace(/\/+$/, "");
  return normalizeRelativePath(directory ? `${directory}/${value}` : value);
}

function getDirectory(location) {
  if (ABSOLUTE_URI.test(location)) {
    return Services.io.newURI(".", null, Services.io.newURI(location)).spec;
  }
  const suffixIndex = location.search(/[?#]/);
  const path = suffixIndex === -1 ? location : location.slice(0, suffixIndex);
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function parseBooleanModifier(token, name, location) {
  const lowerToken = token.toLowerCase();
  if (lowerToken === name) {
    return true;
  }
  if (!lowerToken.startsWith(`${name}=`)) {
    return null;
  }

  const value = lowerToken.slice(name.length + 1);
  if (!value) {
    return false;
  }
  if (["1", "t", "y"].includes(value[0])) {
    return true;
  }
  if (["0", "f", "n"].includes(value[0])) {
    return false;
  }
  throw new Error(`Malformed ${name} modifier at ${location}`);
}

function getBooleanConditionValue(name, options) {
  if (hasOwn(options, name)) {
    const value = options[name];
    return typeof value === "string"
      ? ["1", "true", "yes"].includes(value.toLowerCase())
      : Boolean(value);
  }

  if (name === "backgroundtask") {
    try {
      const service = Cc["@mozilla.org/backgroundtasks;1"]?.getService(
        Ci.nsIBackgroundTasks
      );
      return service ? service.isBackgroundTaskMode : null;
    } catch {
      return null;
    }
  }

  if (name === "tablet") {
    if (Services.appinfo.OS !== "Android") {
      return null;
    }
    try {
      return Services.sysinfo.getProperty("tablet");
    } catch {
      return false;
    }
  }
  return null;
}

function getConditionValues(name, options) {
  let value;
  if (hasOwn(options, name)) {
    value = options[name];
  } else {
    try {
      switch (name) {
        case "application":
          value = Services.appinfo.ID;
          break;
        case "appversion":
          value = Services.appinfo.version;
          break;
        case "platformversion":
          value = Services.appinfo.platformVersion;
          break;
        case "os":
          value = Services.appinfo.OS;
          break;
        case "osversion":
          value = Services.sysinfo.getProperty("version");
          break;
        case "abi":
          value = `${Services.appinfo.OS}_${Services.appinfo.XPCOMABI}`;
          break;
        case "process":
          value = "main";
          break;
      }
    } catch {
      value = undefined;
    }
  }

  let values;
  if (value instanceof Set || Array.isArray(value)) {
    values = [...value];
  } else {
    values = value == null ? [] : [value];
  }

  if (name === "os") {
    const osValues = values.map(current => String(current).toLowerCase());
    if (
      osValues.some(current =>
        [
          "dragonfly",
          "freebsd",
          "linux",
          "netbsd",
          "openbsd",
          "sunos",
        ].includes(current)
      )
    ) {
      values.push("likeunix");
    }
  } else if (name === "abi" && hasOwn(options, "abi")) {
    const osValues = getConditionValues("os", options).filter(
      current => String(current).toLowerCase() !== "likeunix"
    );
    for (const os of osValues) {
      for (const abi of [...values]) {
        const prefix = `${String(os).toLowerCase()}_`;
        if (!String(abi).toLowerCase().startsWith(prefix)) {
          values.push(`${os}_${abi}`);
        }
      }
    }
  }

  return values;
}

function conditionMatches({ name, operator, value }, options) {
  const values = getConditionValues(name, options);
  if (STRING_CONDITIONS.has(name)) {
    return values.some(current => {
      const equal = String(current).toLowerCase() === value;
      return operator === "=" ? equal : !equal;
    });
  }

  if (!values.length || values[0] === "") {
    return false;
  }
  const comparison = Services.vc.compare(String(values[0]), value);
  switch (operator) {
    case "=":
      return comparison === 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
  }
  return false;
}

export function parseManifestModifiers(
  tokens,
  { directive = null, location = "<manifest>", options = {} } = {}
) {
  const booleanConditions = new Map();
  const conditions = new Map();
  let contentAccessible = false;

  for (const token of tokens) {
    const accessible = parseBooleanModifier(
      token,
      "contentaccessible",
      location
    );
    if (accessible !== null) {
      if (directive && directive !== "content" && directive !== "resource") {
        throw new Error(
          `contentaccessible is only valid for content and resource entries at ${location}`
        );
      }
      contentAccessible ||= accessible;
      continue;
    }

    let handled = false;
    for (const name of CONDITIONAL_BOOLEAN_MODIFIERS) {
      const expected = parseBooleanModifier(token, name, location);
      if (expected !== null) {
        booleanConditions.set(name, expected);
        handled = true;
        break;
      }
    }
    if (handled) {
      continue;
    }

    for (const name of OBSOLETE_CONTENT_MODIFIERS) {
      if (parseBooleanModifier(token, name, location) !== null) {
        if (directive && directive !== "content" && directive !== "resource") {
          throw new Error(
            `${name} is only valid for content and resource entries at ${location}`
          );
        }
        handled = true;
        break;
      }
    }
    if (
      handled ||
      parseBooleanModifier(token, "xpcnativewrappers", location) !== null
    ) {
      continue;
    }

    const match =
      /^(application|appversion|platformversion|os|osversion|abi|process)(!=|<=|>=|=|<|>)(.*)$/i.exec(
        token
      );
    if (!match || !match[3]) {
      throw new Error(
        `Unknown or malformed chrome.manifest modifier "${token}" at ${location}`
      );
    }

    const name = match[1].toLowerCase();
    const operator = match[2];
    if (
      (STRING_CONDITIONS.has(name) && !["=", "!="].includes(operator)) ||
      (VERSION_CONDITIONS.has(name) && operator === "!=")
    ) {
      throw new Error(
        `Unsupported operator "${operator}" for ${name} at ${location}`
      );
    }

    if (!conditions.has(name)) {
      conditions.set(name, []);
    }
    conditions.get(name).push({
      name,
      operator,
      value: match[3].toLowerCase(),
    });
  }

  const booleansMatch = [...booleanConditions].every(([name, expected]) => {
    const current = getBooleanConditionValue(name, options);
    if (current === null) {
      return name === "backgroundtask";
    }
    return expected === current;
  });
  const backgroundTask = getBooleanConditionValue("backgroundtask", options);
  const categoryMatches =
    directive !== "category" ||
    backgroundTask !== true ||
    booleanConditions.has("backgroundtask");
  const conditionsMatch = [...conditions.values()].every(group =>
    group.some(condition => conditionMatches(condition, options))
  );
  return {
    contentAccessible,
    matches: booleansMatch && categoryMatches && conditionsMatch,
  };
}

export function selectSkinProvider(providers) {
  if (providers.has(DEFAULT_SKIN_PROVIDER)) {
    return providers.get(DEFAULT_SKIN_PROVIDER);
  }
  return providers.values().next().value;
}

export class ChromeManifest {
  constructor(loader, options) {
    this.loader = loader;
    this.options = options ?? {};

    this.overlay = new DefaultMap(() => []);
    this.style = new DefaultMap(() => new Set());
    this.category = new DefaultMap(() => new Map());
    this.component = new Map();
    this.contract = new Map();
    this.content = new Map();
    this.locales = new DefaultMap(() => new Map());
    this.skin = new Map();
    this._skinProviders = new DefaultMap(() => new Map());
    this.resource = new Map();
    this.override = new Map();

    this._activeManifests = new Set();
    this._parsedManifests = new Set();
  }

  async parse(filename = "chrome.manifest", base = "") {
    if (typeof this.loader !== "function") {
      throw new TypeError("ChromeManifest loader must be a function");
    }
    if (typeof filename !== "string" || !filename) {
      throw new TypeError("Manifest filename must be a non-empty string");
    }
    if (typeof base !== "string") {
      throw new TypeError("Manifest base must be a string");
    }

    let manifest;
    try {
      manifest = resolveLocation(filename, base);
    } catch (error) {
      throw new Error(
        `Malformed manifest location "${filename}": ${error.message}`,
        {
          cause: error,
        }
      );
    }

    if (
      this._parsedManifests.has(manifest) ||
      this._activeManifests.has(manifest)
    ) {
      return;
    }

    this._activeManifests.add(manifest);
    try {
      let data;
      try {
        data = await this.loader(manifest);
      } catch (error) {
        throw new Error(
          `Unable to load manifest "${manifest}": ${error.message}`,
          {
            cause: error,
          }
        );
      }
      await this._parseString(data, getDirectory(manifest), manifest);
      this._parsedManifests.add(manifest);
    } finally {
      this._activeManifests.delete(manifest);
    }
  }

  async parseString(data, base = "") {
    if (typeof base !== "string") {
      throw new TypeError("Manifest base must be a string");
    }
    await this._parseString(data, base, base || "<string>");
  }

  async _parseString(data, base, source) {
    if (typeof data !== "string") {
      throw new TypeError(`Manifest data for ${source} must be a string`);
    }
    if (data.includes("\0")) {
      throw new Error(`Manifest ${source} contains a NUL byte`);
    }

    const lines = data.split(/\r\n?|\n/);
    for (let index = 0; index < lines.length; index++) {
      let line = lines[index];
      if (index === 0 && line.startsWith("\uFEFF")) {
        line = line.slice(1);
      }
      const tokens = stripComment(line).trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) {
        continue;
      }

      const location = `${source}:${index + 1}`;
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
      if (!this._parseFlags(tokens, location, directive)) {
        continue;
      }
      await this._handleDirective(directive, args, base, location);
    }
  }

  _parseFlags(flags, location = "<manifest>", directive = null) {
    return parseManifestModifiers(flags, {
      directive,
      location,
      options: this.options,
    }).matches;
  }

  async _handleDirective(directive, args, base, location) {
    switch (directive) {
      case "manifest":
        await this.parse(args[0], base);
        break;
      case "category":
        this.category.get(args[0]).set(args[1], args[2]);
        break;
      case "component":
        this._validateCID(args[0], location);
        this.component.set(
          args[0],
          this._resolveArgument(args[1], base, location)
        );
        break;
      case "contract":
        this._validateCID(args[1], location);
        this.contract.set(args[0], args[1]);
        break;
      case "content":
        this.content.set(
          args[0],
          this._resolveArgument(args[1], base, location)
        );
        break;
      case "locale":
        this.locales
          .get(args[0])
          .set(args[1], this._resolveArgument(args[2], base, location));
        break;
      case "skin": {
        const providers = this._skinProviders.get(args[0]);
        providers.set(args[1], this._resolveArgument(args[2], base, location));
        this.skin.set(args[0], selectSkinProvider(providers));
        break;
      }
      case "resource":
        this.resource.set(
          args[0],
          this._resolveArgument(args[1], base, location)
        );
        break;
      case "overlay":
        this.overlay
          .get(this._resolveArgument(args[0], base, location))
          .push(this._resolveArgument(args[1], base, location));
        break;
      case "style":
        this.style
          .get(this._resolveArgument(args[0], base, location))
          .add(this._resolveArgument(args[1], base, location));
        break;
      case "override":
        this.override.set(
          this._resolveArgument(args[0], base, location),
          this._resolveArgument(args[1], base, location)
        );
        break;
    }
  }

  _resolveArgument(value, base, location) {
    try {
      return resolveLocation(value, base);
    } catch (error) {
      throw new Error(
        `Malformed location "${value}" at ${location}: ${error.message}`,
        {
          cause: error,
        }
      );
    }
  }

  _validateCID(value, location) {
    try {
      Components.ID(value);
    } catch {
      throw new Error(`Malformed component CID "${value}" at ${location}`);
    }
  }
}
