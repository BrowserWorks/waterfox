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
const RDF_CONTAINERS = new Set([
  `${RDF_NAMESPACE}Alt`,
  `${RDF_NAMESPACE}Bag`,
  `${RDF_NAMESPACE}Seq`,
]);

function EM_R(property) {
  return `${EM_NAMESPACE}${property}`;
}

function getValue(node) {
  return node?.getValue?.();
}

function getObjects(source, property) {
  return source.getObjects(EM_R(property)).flatMap(object => {
    if (RDF_CONTAINERS.has(object.getType?.())) {
      return object.getChildren();
    }
    return [object];
  });
}

function getProperty(source, property) {
  return getValue(getObjects(source, property)[0]);
}

function readProperties(source, target, properties) {
  for (const property of properties) {
    const value = getProperty(source, property);
    if (value !== undefined) {
      target[property] = value;
    }
  }
}

function readArrayProperty(
  source,
  target,
  property,
  targetProperty,
  decode = getValue
) {
  const values = getObjects(source, property)
    .map(decode)
    .filter(value => value !== undefined);
  if (values.length) {
    target[targetProperty] = values;
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
    readArrayProperty(source, locale, property, target);
  }
  return locale;
}

class Manifest {
  constructor(dataSource) {
    this.ds = dataSource;
    this.graph = dataSource;
    this.document = dataSource.document;
  }

  static loadFromString(text) {
    return new this(lazy.RDFDataSource.loadFromString(text));
  }

  static loadFromBuffer(buffer) {
    return new this(lazy.RDFDataSource.loadFromBuffer(buffer));
  }

  static async loadFromFile(uri) {
    return new this(await lazy.RDFDataSource.loadFromFile(uri));
  }
}

export class InstallRDF extends Manifest {
  static loadFromString(text) {
    return new InstallRDF(lazy.RDFDataSource.loadFromString(text));
  }

  static loadFromBuffer(buffer) {
    return new InstallRDF(lazy.RDFDataSource.loadFromBuffer(buffer));
  }

  static async loadFromFile(uri) {
    return new InstallRDF(await lazy.RDFDataSource.loadFromFile(uri));
  }

  decode() {
    if (!this.ds.hasResource(INSTALL_MANIFEST_ROOT)) {
      throw new Error("Install manifest root is missing");
    }
    const root = this.ds.getResource(INSTALL_MANIFEST_ROOT);
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
      "unpack",
      "strictCompatibility",
    ]);

    readArrayProperty(
      root,
      result,
      "targetApplication",
      "targetApplications",
      source => {
        const application = {};
        readProperties(source, application, ["id", "minVersion", "maxVersion"]);
        return application;
      }
    );
    readArrayProperty(root, result, "targetPlatform", "targetPlatforms");
    readArrayProperty(root, result, "localized", "localized", readLocale);
    readArrayProperty(root, result, "dependency", "dependencies", source =>
      getProperty(source, "id")
    );

    return result;
  }
}
