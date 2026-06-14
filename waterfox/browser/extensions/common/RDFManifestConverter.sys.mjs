/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  RDFDataSource: "resource:///modules/RDFDataSource.sys.mjs",
});

const RDF_NAMESPACE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const EM_NAMESPACE = "http://www.mozilla.org/2004/em-rdf#";
const INSTALL_MANIFEST_ROOT = "urn:mozilla:install-manifest";

function getChildren(source, namespaceURI, localName) {
  return Array.from(source.children).filter(
    child =>
      child.namespaceURI === namespaceURI && child.localName === localName
  );
}

function getProperty(source, property) {
  if (source.hasAttributeNS(EM_NAMESPACE, property)) {
    return source.getAttributeNS(EM_NAMESPACE, property).trim();
  }

  const element = getChildren(source, EM_NAMESPACE, property)[0];
  return element?.textContent.trim();
}

function getArrayProperty(source, property) {
  const values = [];
  if (source.hasAttributeNS(EM_NAMESPACE, property)) {
    values.push(source.getAttributeNS(EM_NAMESPACE, property).trim());
  }
  values.push(
    ...getChildren(source, EM_NAMESPACE, property).map(element =>
      element.textContent.trim()
    )
  );
  return values;
}

function getNestedResources(source, property) {
  return getChildren(source, EM_NAMESPACE, property)
    .map(element => element.firstElementChild)
    .filter(Boolean);
}

function readProperties(source, target, properties) {
  for (const property of properties) {
    const value = getProperty(source, property);
    if (value !== undefined) {
      target[property] = value;
    }
  }
}

function readLocale(source) {
  const locale = {};
  readProperties(source, locale, [
    "name",
    "description",
    "creator",
    "homepageURL",
  ]);

  for (const [property, target] of [
    ["locale", "locales"],
    ["developer", "developers"],
    ["translator", "translators"],
    ["contributor", "contributors"],
  ]) {
    const values = getArrayProperty(source, property);
    if (values.length) {
      locale[target] = values;
    }
  }

  return locale;
}

/**
 * Decodes legacy install.rdf manifests.
 */
export class InstallRDF {
  constructor(document) {
    this.document = document;
  }

  static loadFromString(text) {
    return new InstallRDF(lazy.RDFDataSource.loadFromString(text));
  }

  decode() {
    const root = Array.from(
      this.document.getElementsByTagNameNS(RDF_NAMESPACE, "Description")
    ).find(
      element =>
        (element.getAttributeNS(RDF_NAMESPACE, "about") ||
          element.getAttribute("about")) === INSTALL_MANIFEST_ROOT
    );

    if (!root) {
      throw new Error("Install manifest root is missing");
    }

    const result = readLocale(root);
    readProperties(root, result, [
      "id",
      "version",
      "type",
      "internalName",
      "updateURL",
      "optionsURL",
      "optionsType",
      "aboutURL",
      "iconURL",
      "bootstrap",
      "strictCompatibility",
    ]);

    const targetApplications = getNestedResources(root, "targetApplication").map(
      source => {
        const application = {};
        readProperties(source, application, ["id", "minVersion", "maxVersion"]);
        return application;
      }
    );
    if (targetApplications.length) {
      result.targetApplications = targetApplications;
    }

    const targetPlatforms = getArrayProperty(root, "targetPlatform");
    if (targetPlatforms.length) {
      result.targetPlatforms = targetPlatforms;
    }

    const localized = getNestedResources(root, "localized").map(readLocale);
    if (localized.length) {
      result.localized = localized;
    }

    const dependencies = getNestedResources(root, "dependency")
      .map(source => getProperty(source, "id"))
      .filter(Boolean);
    if (dependencies.length) {
      result.dependencies = dependencies;
    }

    return result;
  }
}
