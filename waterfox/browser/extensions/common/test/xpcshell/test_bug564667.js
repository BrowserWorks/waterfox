/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const UNPACKAGED_ADDON = do_get_file("data/test_bug564667");
const PACKAGED_ADDON = do_get_file("data/test_bug564667.xpi");

const { updateAppInfo } = ChromeUtils.importESModule(
  "resource://testing-common/AppInfo.sys.mjs"
);
updateAppInfo({
  name: "XPCShell",
  ID: "xpcshell@tests.mozilla.org",
  version: "1",
  platformVersion: "1",
});

const gChromeRegistry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(
  Ci.nsIChromeRegistry
);
const gResourceProtocol = Services.io
  .getProtocolHandler("resource")
  .QueryInterface(Ci.nsIResProtocolHandler);

function assertMapping(chromeURL, target) {
  const uri = Services.io.newURI(chromeURL);
  Assert.equal(
    gChromeRegistry.convertChromeURL(uri).spec,
    target,
    `${chromeURL} should be registered`
  );
}

function assertNoMapping(chromeURL) {
  const uri = Services.io.newURI(chromeURL);
  let error;
  try {
    gChromeRegistry.convertChromeURL(uri);
  } catch (caught) {
    error = caught;
  }
  Assert.ok(error, `${chromeURL} should not be registered`);
}

function checkCommonMappings(baseURI) {
  assertMapping("chrome://test1/content", `${baseURI}test/test1.xul`);
  assertMapping("chrome://test1/locale", `${baseURI}test/test1.dtd`);
  assertMapping("chrome://test1/skin", `${baseURI}test/test1.css`);
  assertMapping("chrome://test2/content", `${baseURI}test/test2.xul`);
  assertMapping("chrome://test2/locale", `${baseURI}test/test2.dtd`);
  assertMapping("chrome://testoverride/content", "file:///test1/override");
}

function checkCommonMappingsRemoved() {
  assertNoMapping("chrome://test1/content");
  assertNoMapping("chrome://test1/locale");
  assertNoMapping("chrome://test1/skin");
  assertNoMapping("chrome://test2/content");
  assertNoMapping("chrome://test2/locale");
  assertNoMapping("chrome://testoverride/content");
}

function checkUnpackedMappings(baseURI) {
  assertMapping("chrome://test2/skin", `${baseURI}test/test2.css`);
  assertMapping(
    "chrome://testnestedoverride/content",
    "file:///test2/override"
  );
  assertMapping(
    "chrome://testconditionmain/content",
    `${baseURI}test/testconditionmain.xul`
  );
  assertNoMapping("chrome://testconditioncontent/content");
  assertMapping(
    "chrome://testremoteenabled/content",
    `${baseURI}test/testremoteenabled.xul`
  );
  assertMapping(
    "chrome://testremoterequired/content",
    `${baseURI}test/testremoterequired.xul`
  );
  Assert.ok(
    !gResourceProtocol.hasSubstitution("testbootstrappedforbidden"),
    "Bootstrapped native manifests must not register resource directives"
  );
  assertNoMapping("chrome://testignored/content");
}

function checkUnpackedMappingsRemoved() {
  assertNoMapping("chrome://test2/skin");
  assertNoMapping("chrome://testnestedoverride/content");
  assertNoMapping("chrome://testconditionmain/content");
  assertNoMapping("chrome://testremoteenabled/content");
  assertNoMapping("chrome://testremoterequired/content");
  Assert.ok(!gResourceProtocol.hasSubstitution("testbootstrappedforbidden"));
}

function getManifestLocationSpec(location, isUnpacked) {
  if (!isUnpacked) {
    return `jar:${Services.io.newFileURI(location).spec}!/chrome.manifest`;
  }

  const manifest = location.clone();
  manifest.append("chrome.manifest");
  return Services.io.newFileURI(manifest).spec;
}

function countManifestLocations(spec) {
  const locations = Components.manager.getManifestLocations();
  let count = 0;
  for (let i = 0; i < locations.length; i++) {
    if (locations.queryElementAt(i, Ci.nsIURI).spec === spec) {
      count++;
    }
  }
  return count;
}

function testManifest(location, baseURI, isUnpacked = false) {
  const manifestSpec = getManifestLocationSpec(location, isUnpacked);
  Assert.equal(countManifestLocations(manifestSpec), 0);

  Components.manager.addBootstrappedManifestLocation(location);
  Components.manager.addBootstrappedManifestLocation(location);

  Assert.equal(countManifestLocations(manifestSpec), 1);
  checkCommonMappings(baseURI);
  if (isUnpacked) {
    checkUnpackedMappings(baseURI);
  }

  Components.manager.removeBootstrappedManifestLocation(location);

  Assert.equal(countManifestLocations(manifestSpec), 1);
  checkCommonMappings(baseURI);
  if (isUnpacked) {
    checkUnpackedMappings(baseURI);
  }

  Components.manager.removeBootstrappedManifestLocation(location);

  Assert.equal(countManifestLocations(manifestSpec), 0);
  checkCommonMappingsRemoved();
  if (isUnpacked) {
    checkUnpackedMappingsRemoved();
  }
}

add_task(function test_registered_manifests() {
  testManifest(
    UNPACKAGED_ADDON,
    Services.io.newFileURI(UNPACKAGED_ADDON).spec,
    true
  );
  testManifest(
    PACKAGED_ADDON,
    `jar:${Services.io.newFileURI(PACKAGED_ADDON).spec}!/`
  );
});

add_task(async function test_failed_registration_retry_and_deleted_root() {
  const location = do_get_tempdir();
  location.append("test_bug564667_retry");
  location.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);

  let registered = false;
  registerCleanupFunction(() => {
    if (registered) {
      Components.manager.removeBootstrappedManifestLocation(location);
    }
    if (location.exists()) {
      location.remove(true);
    }
  });

  const manifest = location.clone();
  manifest.append("chrome.manifest");
  const manifestSpec = Services.io.newFileURI(manifest).spec;

  let error;
  try {
    Components.manager.addBootstrappedManifestLocation(location);
    registered = true;
  } catch (caught) {
    error = caught;
  }
  Assert.ok(error, "An unreadable root manifest should reject registration");
  Assert.equal(countManifestLocations(manifestSpec), 0);

  await IOUtils.writeUTF8(manifest.path, "content testretry test/\n");

  const baseURI = Services.io.newFileURI(location).spec;
  Components.manager.addBootstrappedManifestLocation(location);
  registered = true;

  Assert.equal(countManifestLocations(manifestSpec), 1);
  assertMapping("chrome://testretry/content", `${baseURI}test/testretry.xul`);

  location.remove(true);
  Components.manager.removeBootstrappedManifestLocation(location);
  registered = false;

  Assert.equal(countManifestLocations(manifestSpec), 0);
  assertNoMapping("chrome://testretry/content");
});

add_task(async function test_duplicate_registration_reparses_nested_manifest() {
  const location = do_get_tempdir();
  location.append("test_bug564667_nested_retry");
  location.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);

  const manifest = location.clone();
  manifest.append("chrome.manifest");
  const nestedManifest = location.clone();
  nestedManifest.append("nested.manifest");
  const manifestSpec = Services.io.newFileURI(manifest).spec;
  const baseURI = Services.io.newFileURI(location).spec;
  let registrations = 0;

  const cleanup = () => {
    let cleanupError;
    while (registrations > 0) {
      registrations--;
      try {
        Components.manager.removeBootstrappedManifestLocation(location);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      if (location.exists()) {
        location.remove(true);
      }
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      throw cleanupError;
    }
  };
  registerCleanupFunction(cleanup);

  await IOUtils.writeUTF8(manifest.path, "manifest nested.manifest\n");
  Components.manager.addBootstrappedManifestLocation(location);
  registrations++;

  Assert.equal(countManifestLocations(manifestSpec), 1);
  assertNoMapping("chrome://testnestedretry/content");

  await IOUtils.writeUTF8(
    nestedManifest.path,
    "content testnestedretry nested/\n"
  );
  Components.manager.addBootstrappedManifestLocation(location);
  registrations++;

  Assert.equal(countManifestLocations(manifestSpec), 1);
  assertMapping(
    "chrome://testnestedretry/content",
    `${baseURI}nested/testnestedretry.xul`
  );

  Components.manager.removeBootstrappedManifestLocation(location);
  registrations--;
  Assert.equal(countManifestLocations(manifestSpec), 1);
  assertMapping(
    "chrome://testnestedretry/content",
    `${baseURI}nested/testnestedretry.xul`
  );

  Components.manager.removeBootstrappedManifestLocation(location);
  registrations--;
  Assert.equal(countManifestLocations(manifestSpec), 0);
  assertNoMapping("chrome://testnestedretry/content");

  cleanup();
});

add_task(async function test_modern_override_precedence_survives_rebuilds() {
  const overrideURL = "chrome://testmodernprecedence/content/value";
  const firstTarget = "file:///bootstrapped-first/override";
  const secondTarget = "file:///bootstrapped-second/override";
  const modernTarget = "file:///modern/override";
  const firstLocation = do_get_tempdir();
  firstLocation.append("test_bug564667_precedence_first");
  firstLocation.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  const secondLocation = do_get_tempdir();
  secondLocation.append("test_bug564667_precedence_second");
  secondLocation.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  const firstManifest = firstLocation.clone();
  firstManifest.append("chrome.manifest");
  const secondManifest = secondLocation.clone();
  secondManifest.append("chrome.manifest");
  let firstRegistered = false;
  let secondRegistered = false;
  let modernRegistration;

  const cleanup = () => {
    let cleanupError;
    if (modernRegistration) {
      try {
        modernRegistration.destruct();
        modernRegistration = null;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (secondRegistered) {
      try {
        Components.manager.removeBootstrappedManifestLocation(secondLocation);
        secondRegistered = false;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (firstRegistered) {
      try {
        Components.manager.removeBootstrappedManifestLocation(firstLocation);
        firstRegistered = false;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    for (const location of [secondLocation, firstLocation]) {
      try {
        if (location.exists()) {
          location.remove(true);
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  };
  registerCleanupFunction(cleanup);

  await IOUtils.writeUTF8(
    firstManifest.path,
    `override ${overrideURL} ${firstTarget}\n`
  );
  await IOUtils.writeUTF8(
    secondManifest.path,
    `override ${overrideURL} ${secondTarget}\n`
  );

  Components.manager.addBootstrappedManifestLocation(firstLocation);
  firstRegistered = true;
  assertMapping(overrideURL, firstTarget);

  const addonManagerStartup = Cc[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Ci.amIAddonManagerStartup);
  modernRegistration = addonManagerStartup.registerChrome(
    Services.io.newFileURI(firstManifest),
    [["override", overrideURL, modernTarget]]
  );
  assertMapping(overrideURL, modernTarget);

  Components.manager.addBootstrappedManifestLocation(secondLocation);
  secondRegistered = true;
  assertMapping(overrideURL, modernTarget);

  Components.manager.removeBootstrappedManifestLocation(secondLocation);
  secondRegistered = false;
  assertMapping(overrideURL, modernTarget);

  modernRegistration.destruct();
  modernRegistration = null;
  assertMapping(overrideURL, firstTarget);

  Components.manager.removeBootstrappedManifestLocation(firstLocation);
  firstRegistered = false;
  assertNoMapping(overrideURL);

  cleanup();
});

function makeTestDirectory(name) {
  const directory = do_get_tempdir();
  directory.append(name);
  directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  return directory;
}

function ensureTestDirectory(root, relativePath) {
  const directory = root.clone();
  for (const segment of relativePath.split("/").filter(Boolean)) {
    directory.append(segment);
    if (!directory.exists()) {
      directory.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
    }
  }
  return directory;
}

async function writeTestFile(root, relativePath, contents) {
  const segments = relativePath.split("/");
  const leafName = segments.pop();
  const parent = ensureTestDirectory(root, segments.join("/"));
  const file = parent.clone();
  file.append(leafName);
  await IOUtils.writeUTF8(file.path, contents);
  return file;
}

add_task(function test_rdf_reference_api_and_graph_parity() {
  const {
    RDFBlankNode,
    RDFDataSource,
    RDFDateLiteral,
    RDFIntLiteral,
    RDFLiteral,
    RDFResource,
  } = ChromeUtils.importESModule("resource:///modules/RDFDataSource.sys.mjs");
  const { InstallRDF } = ChromeUtils.importESModule(
    "resource:///modules/RDFManifestConverter.sys.mjs"
  );
  const rdf = `
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:em="http://www.mozilla.org/2004/em-rdf#"
         xmlns:NC="http://home.netscape.com/NC-rdf#">
  <rdf:Description rdf:about="urn:mozilla:install-manifest"
                   em:id="rdf-reference@test.invalid"
                   em:version="1">
    <em:targetApplication rdf:resource="#target"/>
    <em:targetPlatform>
      <rdf:Seq>
        <rdf:li>Linux</rdf:li>
        <rdf:li>Darwin</rdf:li>
      </rdf:Seq>
    </em:targetPlatform>
    <em:dependency>
      <rdf:Bag>
        <rdf:li rdf:nodeID="dependency"/>
      </rdf:Bag>
    </em:dependency>
    <em:localized rdf:parseType="Resource">
      <em:locale>en-US</em:locale>
      <em:name>Reference graph</em:name>
    </em:localized>
    <em:testInteger NC:parseType="Integer">7</em:testInteger>
    <em:testDate NC:parseType="Date">1000</em:testDate>
  </rdf:Description>
  <rdf:Description rdf:ID="target">
    <em:id>xpcshell@tests.mozilla.org</em:id>
    <em:minVersion>1</em:minVersion>
    <em:maxVersion>*</em:maxVersion>
  </rdf:Description>
  <rdf:Description rdf:about="#target">
    <em:name>Merged target</em:name>
  </rdf:Description>
  <rdf:Description rdf:nodeID="dependency">
    <em:id>dependency@test.invalid</em:id>
  </rdf:Description>
</rdf:RDF>`;
  const em = property => `http://www.mozilla.org/2004/em-rdf#${property}`;
  const dataSource = RDFDataSource.loadFromString(rdf);
  const root = dataSource.getResource("urn:mozilla:install-manifest");
  const target = root.getProperty(em("targetApplication"));
  const dependencyContainer = root.getProperty(em("dependency"));

  Assert.ok(dataSource instanceof RDFDataSource);
  Assert.ok(root instanceof RDFResource);
  Assert.ok(root.getProperty(em("id")) instanceof RDFLiteral);
  Assert.equal(
    root.getProperty(em("id")).getValue(),
    "rdf-reference@test.invalid"
  );
  Assert.ok(target instanceof RDFResource);
  Assert.strictEqual(dataSource.getResource("#target"), target);
  Assert.equal(target.getProperty(em("name")).getValue(), "Merged target");
  Assert.ok(dependencyContainer instanceof RDFBlankNode);
  Assert.equal(
    dependencyContainer.getChildren()[0].getProperty(em("id")).getValue(),
    "dependency@test.invalid"
  );
  Assert.ok(root.getProperty(em("testInteger")) instanceof RDFIntLiteral);
  Assert.equal(root.getProperty(em("testInteger")).getValue(), 7);
  Assert.ok(root.getProperty(em("testDate")) instanceof RDFDateLiteral);
  Assert.equal(root.getProperty(em("testDate")).getValue().getTime(), 1000);
  Assert.equal(new RDFIntLiteral("7").getValue(), 7);
  Assert.equal(new RDFDateLiteral(new Date(1000)).getValue().getTime(), 1000);

  const installRDF = InstallRDF.loadFromString(rdf);
  Assert.ok(installRDF.ds instanceof RDFDataSource);
  Assert.strictEqual(installRDF.graph, installRDF.ds);
  Assert.deepEqual(installRDF.decode(), {
    id: "rdf-reference@test.invalid",
    version: "1",
    targetApplications: [
      { id: "xpcshell@tests.mozilla.org", minVersion: "1", maxVersion: "*" },
    ],
    targetPlatforms: ["Linux", "Darwin"],
    localized: [{ locales: ["en-US"], name: "Reference graph" }],
    dependencies: ["dependency@test.invalid"],
  });

  const generated = new RDFDataSource();
  generated
    .getResource("urn:test:generated")
    .setProperty(em("id"), new RDFLiteral("generated@test.invalid"));
  const reparsed = RDFDataSource.loadFromString(generated.serializeToString());
  Assert.equal(
    reparsed.getResource("urn:test:generated").getProperty(em("id")).getValue(),
    "generated@test.invalid"
  );

  Assert.throws(
    () =>
      RDFDataSource.loadFromString(`
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                 xmlns:em="http://www.mozilla.org/2004/em-rdf#">
          <rdf:Description rdf:about="urn:test:invalid">
            <em:value rdf:resource="#target" rdf:nodeID="target"/>
          </rdf:Description>
        </rdf:RDF>`),
    /only one object form/
  );
});
