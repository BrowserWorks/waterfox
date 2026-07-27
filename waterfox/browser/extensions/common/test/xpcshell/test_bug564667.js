/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
