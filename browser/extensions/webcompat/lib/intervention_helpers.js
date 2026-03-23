/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals browser, UAHelpers */

const GOOGLE_TLDS = [
  "com",
  "ac",
  "ad",
  "ae",
  "com.af",
  "com.ag",
  "com.ai",
  "al",
  "am",
  "co.ao",
  "com.ar",
  "as",
  "at",
  "com.au",
  "az",
  "ba",
  "com.bd",
  "be",
  "bf",
  "bg",
  "com.bh",
  "bi",
  "bj",
  "com.bn",
  "com.bo",
  "com.br",
  "bs",
  "bt",
  "co.bw",
  "by",
  "com.bz",
  "ca",
  "com.kh",
  "cc",
  "cd",
  "cf",
  "cat",
  "cg",
  "ch",
  "ci",
  "co.ck",
  "cl",
  "cm",
  "cn",
  "com.co",
  "co.cr",
  "com.cu",
  "cv",
  "com.cy",
  "cz",
  "de",
  "dj",
  "dk",
  "dm",
  "com.do",
  "dz",
  "com.ec",
  "ee",
  "com.eg",
  "es",
  "com.et",
  "fi",
  "com.fj",
  "fm",
  "fr",
  "ga",
  "ge",
  "gf",
  "gg",
  "com.gh",
  "com.gi",
  "gl",
  "gm",
  "gp",
  "gr",
  "com.gt",
  "gy",
  "com.hk",
  "hn",
  "hr",
  "ht",
  "hu",
  "co.id",
  "iq",
  "ie",
  "co.il",
  "im",
  "co.in",
  "io",
  "is",
  "it",
  "je",
  "com.jm",
  "jo",
  "co.jp",
  "co.ke",
  "ki",
  "kg",
  "co.kr",
  "com.kw",
  "kz",
  "la",
  "com.lb",
  "com.lc",
  "li",
  "lk",
  "co.ls",
  "lt",
  "lu",
  "lv",
  "com.ly",
  "co.ma",
  "md",
  "me",
  "mg",
  "mk",
  "ml",
  "com.mm",
  "mn",
  "ms",
  "com.mt",
  "mu",
  "mv",
  "mw",
  "com.mx",
  "com.my",
  "co.mz",
  "com.na",
  "ne",
  "com.nf",
  "com.ng",
  "com.ni",
  "nl",
  "no",
  "com.np",
  "nr",
  "nu",
  "co.nz",
  "com.om",
  "com.pk",
  "com.pa",
  "com.pe",
  "com.ph",
  "pl",
  "com.pg",
  "pn",
  "com.pr",
  "ps",
  "pt",
  "com.py",
  "com.qa",
  "ro",
  "rs",
  "ru",
  "rw",
  "com.sa",
  "com.sb",
  "sc",
  "se",
  "com.sg",
  "sh",
  "si",
  "sk",
  "com.sl",
  "sn",
  "sm",
  "so",
  "st",
  "sr",
  "com.sv",
  "td",
  "tg",
  "co.th",
  "com.tj",
  "tk",
  "tl",
  "tm",
  "to",
  "tn",
  "com.tr",
  "tt",
  "com.tw",
  "co.tz",
  "com.ua",
  "co.ug",
  "co.uk",
  "com",
  "com.uy",
  "co.uz",
  "com.vc",
  "co.ve",
  "vg",
  "co.vi",
  "com.vn",
  "vu",
  "ws",
  "co.za",
  "co.zm",
  "co.zw",
];

var InterventionHelpers = {
  skip_if_functions: {
    InstallTrigger_defined: () => {
      return "InstallTrigger" in window;
    },
    InstallTrigger_undefined: () => {
      return !("InstallTrigger" in window);
    },
    text_event_supported: () => {
      return !!window.TextEvent;
    },
  },

  ua_change_functions: {
    add_Chrome: (ua, config) => {
      return UAHelpers.addChrome(ua, config.version);
    },
    add_Firefox_as_Gecko: (ua, config) => {
      return UAHelpers.addGecko(ua, config.version);
    },
    add_Samsung_for_Samsung_devices: ua => {
      return UAHelpers.addSamsungForSamsungDevices(ua);
    },
    add_Version_segment: ua => {
      return `${ua} Version/0`;
    },
    cap_Version_to_99: ua => {
      return UAHelpers.capVersionTo99(ua);
    },
    change_Firefox_to_FireFox: ua => {
      return UAHelpers.changeFirefoxToFireFox(ua);
    },
    change_Gecko_to_like_Gecko: ua => {
      return ua.replace("Gecko", "like Gecko");
    },
    change_OS_to_MacOSX: (ua, config) => {
      return UAHelpers.getMacOSXUA(ua, config.arch, config.version);
    },
    change_OS_to_Windows: ua => {
      return UAHelpers.windows(ua);
    },
    Chrome: (ua, config) => {
      config.ua = ua;
      config.noFxQuantum = true;
      return UAHelpers.getDeviceAppropriateChromeUA(config);
    },
    Chrome_with_FxQuantum: (ua, config) => {
      config.ua = ua;
      return UAHelpers.getDeviceAppropriateChromeUA(config);
    },
    desktop_not_mobile: () => {
      return UAHelpers.desktopUA();
    },
    mimic_Android_Hotspot2_device: ua => {
      return UAHelpers.androidHotspot2Device(ua);
    },
    reduce_firefox_version_by_one: ua => {
      const [head, fx, tail] = ua.split(/(firefox\/)/i);
      if (!fx || !tail) {
        return ua;
      }
      const major = parseInt(tail);
      if (!major) {
        return ua;
      }
      return `${head}${fx}${major - 1}${tail.slice(major.toString().length)}`;
    },
    mimic_Firefox_UA: (ua, config) => {
      const version = config.version || UAHelpers.getRunningFirefoxVersion();
      return ua
        .replace(/rv:[0-9.]+/i, `rv:${version}`)
        .replace(/Firefox\/[0-9.]+/i, `Firefox/${version}`)
        .replace(/\s{2,}/g, " ")
        .trim();
    },
    Safari: (ua, config) => {
      return UAHelpers.safari(config);
    },
  },

  valid_platforms: [
    "all",
    "android",
    "desktop",
    "fenix",
    "linux",
    "mac",
    "windows",
  ],
  valid_channels: ["beta", "esr", "nightly", "stable"],

  shouldSkip(intervention, firefoxVersion, firefoxChannel) {
    const {
      bug,
      max_version,
      min_version,
      not_channels,
      only_channels,
      skip_if,
    } = intervention;
    if (firefoxChannel) {
      if (only_channels && !only_channels.includes(firefoxChannel)) {
        return true;
      }
      if (not_channels?.includes(firefoxChannel)) {
        return true;
      }
    }
    if (min_version && firefoxVersion < min_version) {
      return true;
    }
    if (max_version) {
      // Make sure to handle the case where only the major version matters,
      // for instance if we want 138 and the version number is 138.1.
      if (String(max_version).includes(".")) {
        if (firefoxVersion > max_version) {
          return true;
        }
      } else if (Math.floor(firefoxVersion) > max_version) {
        return true;
      }
    }
    if (skip_if) {
      try {
        if (this.skip_if_functions[skip_if]?.()) {
          return true;
        }
      } catch (e) {
        console.trace(
          `Error while checking skip-if condition ${skip_if} for bug ${bug}:`,
          e
        );
      }
    }
    return false;
  },

  async getPlatformMatches() {
    if (!InterventionHelpers._platformMatches) {
      const platformInfo = await browser.runtime.getPlatformInfo();
      InterventionHelpers._platformMatches = [
        "all",
        platformInfo.os,
        platformInfo.os == "android" ? "android" : "desktop",
      ];
      if (platformInfo.os == "android") {
        const packageName = await browser.appConstants.getAndroidPackageName();
        if (packageName.includes("fenix") || packageName.includes("firefox")) {
          InterventionHelpers._platformMatches.push("fenix");
        }
      }
    }
    return InterventionHelpers._platformMatches;
  },

  async checkPlatformMatches(intervention) {
    let desired = intervention.platforms;
    let undesired = intervention.not_platforms;
    if (!desired && !undesired) {
      return true;
    }

    const actual = await InterventionHelpers.getPlatformMatches();
    if (undesired) {
      if (!Array.isArray(undesired)) {
        undesired = [undesired];
      }
      if (
        undesired.includes("all") ||
        actual.filter(x => undesired.includes(x)).length
      ) {
        return false;
      }
    }

    if (!desired) {
      return true;
    }
    if (!Array.isArray(desired)) {
      desired = [desired];
    }
    return (
      desired.includes("all") ||
      !!actual.filter(x => desired.includes(x)).length
    );
  },

  applyUAChanges(ua, changes) {
    if (!Array.isArray(changes)) {
      changes = [changes];
    }
    for (let config of changes) {
      if (typeof config === "string") {
        config = { change: config, enabled: true };
      }
      if (!config.enabled) {
        continue;
      }
      let finalChanges = config.change;
      if (!Array.isArray(finalChanges)) {
        finalChanges = [finalChanges];
      }
      for (const change of finalChanges) {
        try {
          ua = InterventionHelpers.ua_change_functions[change](ua, config);
        } catch (e) {
          console.trace(
            `Error while calling UA change function ${change} for bug ${config.bug}:`,
            e
          );
          return ua;
        }
      }
    }
    return ua;
  },

  /**
   * Useful helper to generate a list of domains with a fixed base domain and
   * multiple country-TLDs or other cases with various TLDs.
   *
   * Example:
   *   matchPatternsForTLDs("*://mozilla.", "/*", ["com", "org"])
   *     => ["*://mozilla.com/*", "*://mozilla.org/*"]
   */
  matchPatternsForTLDs(base, suffix, tlds) {
    return tlds.map(tld => base + tld + suffix);
  },

  /**
   * A modified version of matchPatternsForTLDs that always returns the match
   * list for all known Google country TLDs.
   */
  matchPatternsForGoogle(base, suffix = "/*") {
    return InterventionHelpers.matchPatternsForTLDs(base, suffix, GOOGLE_TLDS);
  },
};
