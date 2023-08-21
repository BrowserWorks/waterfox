/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

/**
 * A parser for chrome.manifest files. Implements a subset of
 * https://developer.mozilla.org/en-US/docs/Mozilla/Chrome_Registration
 */
export class ChromeManifest {
  /**
   * Constructs the chrome.manifest parser
   *
   * @param {Function} loader           An asynchronous function that will load further files, e.g.
   *                                      those included via the |manifest| instruction. The
   *                                      function will take the file as an argument and should
   *                                      resolve with the string contents of that file
   * @param {object} options            Object describing the current system. The keys are manifest
   *                                      instructions
   */
  constructor(loader, options) {
    this.loader = loader;
    this.options = options;

    this.overlay = new DefaultMap(() => []);
    this.locales = new DefaultMap(() => new Map());
    this.style = new DefaultMap(() => new Set());
    this.category = new DefaultMap(() => new Map());

    this.component = new Map();
    this.contract = new Map();

    this.content = new Map();
    this.skin = new Map();
    this.resource = new Map();
    this.override = new Map();
  }

  /**
   * Parse the given file.
   *
   * @param {string} filename           The filename to load
   * @param {string} base               The relative directory this file is expected to be in.
   * @returns {Promise}                  Resolved when loading completes
   */
  async parse(filename = "chrome.manifest", base = "") {
    await this.parseString(await this.loader(filename), base);
  }

  /**
   * Parse the given string.
   *
   * @param {string} data               The file data to load
   * @param {string} base               The relative directory this file is expected to be in.
   * @returns {Promise}                  Resolved when loading completes
   */
  async parseString(data, base = "") {
    let lines = data.split("\n");
    let extraManifests = [];
    for (let line of lines) {
      let parts = line.trim().split(/\s+/);
      let directive = parts.shift();
      switch (directive) {
        case "manifest":
          extraManifests.push(this._parseManifest(base, ...parts));
          break;
        case "component":
          this._parseComponent(...parts);
          break;
        case "contract":
          this._parseContract(...parts);
          break;

        case "category":
          this._parseCategory(...parts);
          break;
        case "content":
          this._parseContent(...parts);
          break;
        case "locale":
          this._parseLocale(...parts);
          break;
        case "skin":
          this._parseSkin(...parts);
          break;
        case "resource":
          this._parseResource(...parts);
          break;

        case "overlay":
          this._parseOverlay(...parts);
          break;
        case "style":
          this._parseStyle(...parts);
          break;
        case "override":
          this._parseOverride(...parts);
          break;
      }
    }

    await Promise.all(extraManifests);
  }

  /**
   * Ensure the flags provided for the instruction match our options
   *
   * @param {string[]} flags        An array of raw flag values in the form key=value.
   * @returns {boolean}              True, if the flags match the options provided in the constructor
   */
  _parseFlags(flags) {
    if (!flags.length) {
      return true;
    }

    let matchString = (a, sign, b) => {
      if (sign != "=") {
        console.warn(
          `Invalid sign ${sign} in ${a}${sign}${b}, dropping manifest instruction`
        );
        return false;
      }
      return a == b;
    };

    let matchVersion = (a, sign, b) => {
      switch (sign) {
        case "=":
          return Services.vc.compare(a, b) == 0;
        case ">":
          return Services.vc.compare(a, b) > 0;
        case "<":
          return Services.vc.compare(a, b) < 0;
        case ">=":
          return Services.vc.compare(a, b) >= 0;
        case "<=":
          return Services.vc.compare(a, b) <= 0;
        default:
          console.warn(
            `Invalid sign ${sign} in ${a}${sign}${b}, dropping manifest instruction`
          );
          return false;
      }
    };

    let flagMatches = (key, typeMatch) => {
      return (
        !flagdata.has(key) ||
        flagdata.get(key).some(val => typeMatch(this.options[key], ...val))
      );
    };

    let flagdata = new DefaultMap(() => []);

    for (let flag of flags) {
      let match = flag.match(/(\w+)(>=|<=|<|>|=)(.*)/);
      if (match) {
        flagdata.get(match[1]).push([match[2], match[3]]);
      } else {
        console.warn(`Invalid flag ${flag}, dropping manifest instruction`);
      }
    }

    return (
      flagMatches("application", matchString) &&
      flagMatches("appversion", matchVersion) &&
      flagMatches("platformversion", matchVersion) &&
      flagMatches("os", matchString) &&
      flagMatches("osversion", matchVersion) &&
      flagMatches("abi", matchString)
    );
  }

  /**
   * Parse the manifest instruction, to load other files
   *
   * @param {string} base       The base directory the manifest file is in
   * @param {string} filename   The file and path to load
   * @param {...string} flags   The flags for this instruction
   * @returns {Promise}          Promise resolved when the manifest is loaded
   */
  async _parseManifest(base, filename, ...flags) {
    if (this._parseFlags(flags)) {
      let dirparts = filename.split("/");
      dirparts.pop();

      try {
        await this.parse(filename, base + "/" + dirparts.join("/"));
      } catch (e) {
        console.log(`Could not read manifest '${base}/${filename}'.`);
      }
    }
    return null;
  }

  /**
   * Parse the component instruction, to load xpcom components
   *
   * @param {string} classid        The xpcom class id to load
   * @param {string} loction        The file location of this component
   * @param {...string} flags       The flags for this instruction
   */
  _parseComponent(classid, location, ...flags) {
    if (this._parseFlags(flags)) {
      this.component.set(classid, location);
    }
  }

  /**
   * Parse the contract instruction, to load xpcom contract ids
   *
   * @param {string} contractid     The xpcom contract id to load
   * @param {string} location       The file location of this component
   * @param {...string} flags       The flags for this instruction
   */
  _parseContract(contractid, location, ...flags) {
    if (this._parseFlags(flags)) {
      this.contract.set(contractid, location);
    }
  }

  /**
   * Parse the category instruction, to set up xpcom categories
   *
   * @param {string} category       The name of the category
   * @param {string} entryName      The category entry name
   * @param {string} value          The category entry value
   * @param {...string} flags       The flags for this instruction
   */
  _parseCategory(category, entryName, value, ...flags) {
    if (this._parseFlags(flags)) {
      this.category.get(category).set(entryName, value);
    }
  }

  /**
   * Parse the content instruction, to set chrome content locations
   *
   * @param {string} shortname      The content short name, e.g. chrome://shortname/content/
   * @param {string} location       The location for this content registration
   * @param {...string} flags       The flags for this instruction
   */
  _parseContent(shortname, location, ...flags) {
    if (this._parseFlags(flags)) {
      this.content.set(shortname, location);
    }
  }

  /**
   * Parse the locale instruction, to set chrome locale locations
   *
   * @param {string} shortname      The locale short name, e.g. chrome://shortname/locale/
   * @param {string} location       The location for this locale registration
   * @param {...string} flags       The flags for this instruction
   */
  _parseLocale(shortname, locale, location, ...flags) {
    if (this._parseFlags(flags)) {
      this.locales.get(shortname).set(locale, location);
    }
  }

  /**
   * Parse the skin instruction, to set chrome skin locations
   *
   * @param {string} shortname      The skin short name, e.g. chrome://shortname/skin/
   * @param {string} location       The location for this skin registration
   * @param {...string} flags       The flags for this instruction
   */
  _parseSkin(packagename, skinname, location, ...flags) {
    if (this._parseFlags(flags)) {
      this.skin.set(packagename, location);
    }
  }

  /**
   * Parse the resource instruction, to set up resource uri substitutions
   *
   * @param {string} packagename    The resource package name, e.g. resource://packagename/
   * @param {string} url            The location for this content registration
   * @param {...string} flags       The flags for this instruction
   */
  _parseResource(packagename, location, ...flags) {
    if (this._parseFlags(flags)) {
      this.resource.set(packagename, location);
    }
  }

  /**
   * Parse the overlay instruction, to set up xul overlays
   *
   * @param {string} targetUrl      The chrome target url
   * @param {string} overlayUrl     The url of the xul overlay
   * @param {...string} flags       The flags for this instruction
   */
  _parseOverlay(targetUrl, overlayUrl, ...flags) {
    if (this._parseFlags(flags)) {
      this.overlay.get(targetUrl).push(overlayUrl);
    }
  }

  /**
   * Parse the style instruction, to add stylesheets into chrome windows
   *
   * @param {string} uri            The uri of the chrome window
   * @param {string} sheet          The uri of the css sheet
   * @param {...string} flags       The flags for this instruction
   */
  _parseStyle(uri, sheet, ...flags) {
    if (this._parseFlags(flags)) {
      this.style.get(uri).add(sheet);
    }
  }

  /**
   * Parse the override instruction, to set chrome uri overrides
   *
   * @param {string} uri            The uri being overridden
   * @param {string} newuri         The replacement uri for the original location
   * @param {...string} flags       The flags for this instruction
   */
  _parseOverride(uri, newuri, ...flags) {
    if (this._parseFlags(flags)) {
      this.override.set(uri, newuri);
    }
  }
}

/**
 * A default map, which assumes a default value on get() if the key doesn't exist
 */
class DefaultMap extends Map {
  /**
   * Constructs the default map
   *
   * @param {Function} _default     A function that returns the default value for this map
   * @param {*} iterable            An iterable to initialize the map with
   */
  constructor(_default, iterable) {
    super(iterable);
    this._default = _default;
  }

  /**
   * Get the given key, creating if necessary
   *
   * @param {string} key            The key of the map to get
   * @param {boolean} create        True, if the key should be created in case it doesn't exist.
   */
  get(key, create = true) {
    if (this.has(key)) {
      return super.get(key);
    } else if (create) {
      this.set(key, this._default());
      return super.get(key);
    }

    return this._default();
  }
}
