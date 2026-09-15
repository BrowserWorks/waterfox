/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { parseFeed } = ChromeUtils.importESModule(
  "resource:///modules/FeedParser.sys.mjs"
);

const FEED_URL = "https://example.com/feeds/index.xml";
const ATOM_NS = "http://www.w3.org/2005/Atom";
const ATOM03_NS = "http://purl.org/atom/ns#";
const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RSS1_NS = "http://purl.org/rss/1.0/";
const MAX_XML_BYTES = 2 * 1024 * 1024;

function rss(items = "", metadata = "<title>News</title>") {
  return `<rss version="2.0"><channel>${metadata}${items}</channel></rss>`;
}

function atom(entries = "", metadata = "<title>News</title>", attributes = "") {
  return `<feed xmlns="${ATOM_NS}" ${attributes}>${metadata}${entries}</feed>`;
}

function entry(id, link, title = "Entry") {
  return `<entry><id>${id}</id><title>${title}</title>${link}</entry>`;
}

function checkContract(feed) {
  for (const field of ["title", "siteURL", "description"]) {
    Assert.equal(typeof feed[field], "string", `${field} is a string`);
  }
  Assert.lessOrEqual(feed.title.length, 1000);
  Assert.lessOrEqual(feed.description.length, 1000);
  Assert.lessOrEqual(feed.items.length, 200);
  for (const item of feed.items) {
    Assert.deepEqual(Object.keys(item).sort(), ["id", "title", "url"]);
    for (const value of Object.values(item)) {
      Assert.equal(typeof value, "string");
    }
    Assert.lessOrEqual(item.title.length, 1000);
    Assert.lessOrEqual(item.id.length, 1000);
  }
  for (const value of [feed.siteURL, ...feed.items.map(item => item.url)]) {
    if (!value) {
      continue;
    }
    const url = new URL(value);
    Assert.ok(["http:", "https:"].includes(url.protocol));
    Assert.equal(url.username, "");
    Assert.equal(url.password, "");
    Assert.equal(url.href, value, "URLs are absolute and normalized");
  }
}

add_task(function test_rss2_relative_links_and_text() {
  const feed = parseFeed(
    `<rss version="2.0" xml:base="../">
      <channel xml:base="news/">
        <title><![CDATA[<b>News</b> &amp; views]]></title>
        <description><![CDATA[<p>First</p><p>Second &copy;</p>]]></description>
        <link xml:base="../">home</link>
        <item xml:base="../posts/">
          <guid isPermaLink="false">urn:entry:one</guid>
          <title><![CDATA[<b>Hello</b> &amp; goodbye]]></title>
          <link xml:base="2026/">hello</link>
        </item>
        <item>
          <link>summary</link>
          <description><![CDATA[<style>hidden</style><script>hidden</script>
            <p>Summary<br>only &eacute;</p>]]></description>
        </item>
      </channel>
    </rss>`,
    FEED_URL
  );
  Assert.equal(feed.title, "News & views");
  Assert.equal(feed.description, "First Second ©");
  Assert.equal(feed.siteURL, "https://example.com/home");
  Assert.deepEqual(feed.items, [
    {
      id: "urn:entry:one",
      title: "Hello & goodbye",
      url: "https://example.com/posts/2026/hello",
    },
    {
      id: "https://example.com/news/summary",
      title: "Summary only é",
      url: "https://example.com/news/summary",
    },
  ]);
  checkContract(feed);
});

add_task(function test_rss2_guid_and_feedburner_precedence() {
  const feed = parseFeed(
    rss(`
      <item><title>Implicit permalink</title><guid>https://example.com/guid</guid>
        <link>/ignored</link></item>
      <item><title>Explicit relative permalink</title>
        <guid isPermaLink="true" xml:base="../">relative</guid></item>
      <item><title>Opaque ID</title><guid>not-a-url</guid><link>/opaque</link></item>
      <item><title>False permalink</title>
        <guid isPermaLink="false">https://example.com/id</guid><link>/false</link></item>
      <item><title>Case sensitive</title>
        <guid isPermaLink="TRuE">https://example.com/id</guid><link>/case</link></item>
      <item><title>Original</title><guid isPermaLink="false">original</guid>
        <f:origLink xmlns:f="http://rssnamespace.org/feedburner/ext/1.0">/original</f:origLink>
        <link>/tracking</link></item>
      <item><title>No navigable URL</title><guid>opaque-only</guid></item>
      <item><title>Unsafe GUID fallback</title><guid>javascript:alert(1)</guid>
        <link>/safe-fallback</link></item>`),
    FEED_URL
  );
  Assert.deepEqual(
    feed.items.map(item => item.url),
    [
      "guid",
      "relative",
      "opaque",
      "false",
      "case",
      "original",
      "safe-fallback",
    ].map(path => `https://example.com/${path}`)
  );
  Assert.equal(feed.items[2].id, "not-a-url");
  Assert.equal(feed.items[3].id, "https://example.com/id");
  checkContract(feed);
});

add_task(function test_rss1_rdf_about_and_dublin_core() {
  const feed = parseFeed(
    `<r:RDF xmlns:r="${RDF_NS}" xmlns="${RSS1_NS}"
       xmlns:dc="http://purl.org/dc/elements/1.1/" xml:base="../rdf/">
      <channel r:about="feed">
        <title>RDF News</title><link>./</link>
        <description>RDF &amp; RSS</description>
        <items><r:Seq><r:li r:resource="second"/><r:li r:resource="first"/></r:Seq></items>
      </channel>
      <item r:about="first"><title>First</title><link>preferred</link></item>
      <item r:about="second" xml:base="nested/"><dc:subject>Subject</dc:subject></item>
      <item r:about="third"><description>&lt;b&gt;Description&lt;/b&gt;</description></item>
      <item xmlns:f="urn:foreign" f:about="forged"><title>Wrong attribute</title></item>
      <item r:about="urn:not-navigable"><title>Not navigable</title></item>
    </r:RDF>`,
    FEED_URL
  );
  Assert.equal(feed.title, "RDF News");
  Assert.equal(feed.siteURL, "https://example.com/rdf/");
  Assert.equal(feed.description, "RDF & RSS");
  Assert.deepEqual(feed.items, [
    {
      id: "preferred",
      title: "First",
      url: "https://example.com/rdf/preferred",
    },
    {
      id: "second",
      title: "Subject",
      url: "https://example.com/rdf/nested/second",
    },
    { id: "third", title: "Description", url: "https://example.com/rdf/third" },
  ]);
  checkContract(feed);
});

add_task(function test_rss1_prefixed_elements_and_legacy_about() {
  const feed = parseFeed(
    `<rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:rss="${RSS1_NS}"
       xmlns:f="urn:foreign" xml:base="../rdf/">
      <rss:channel xml:base="channel/">
        <rss:title>Prefixed RSS</rss:title><rss:link>home</rss:link>
      </rss:channel>
      <rss:item about="legacy" xml:base="items/">
        <rss:title>Legacy about</rss:title>
      </rss:item>
      <rss:item rdf:about="standard" about="ignored">
        <rss:title>Namespaced about wins</rss:title>
      </rss:item>
      <rss:item f:about="forged"><rss:title>Foreign about</rss:title></rss:item>
      <item about="unnamespaced"><title>Not RSS1</title></item>
      <f:item rdf:about="foreign"><rss:title>Foreign item</rss:title></f:item>
    </rdf:RDF>`,
    FEED_URL
  );
  Assert.equal(feed.siteURL, "https://example.com/rdf/channel/home");
  Assert.deepEqual(feed.items, [
    {
      id: "legacy",
      title: "Legacy about",
      url: "https://example.com/rdf/items/legacy",
    },
    {
      id: "standard",
      title: "Namespaced about wins",
      url: "https://example.com/rdf/standard",
    },
  ]);
  checkContract(feed);
});

add_task(function test_atom1_text_constructs_and_alternate_links() {
  const feed = parseFeed(
    atom(
      `${entry("urn:plain", '<link href="plain"/>', "Plain &amp; simple")}
       <entry><id>urn:html</id>
         <title type="html">&lt;b&gt;HTML&lt;/b&gt; &amp;amp; &amp;copy;</title>
         <link href="ignored.xml" type="application/atom+xml"/>
         <link href="html" type="text/html; charset=utf-8"/>
       </entry>
       <entry><id>urn:xhtml</id><title type="xhtml">
         <x:div xmlns:x="http://www.w3.org/1999/xhtml"><x:b>XHTML</x:b> &amp; text
           <x:script>hidden</x:script><x:style>hidden</x:style></x:div>
         </title><link href="xhtml" type="application/xhtml+xml"/>
       </entry>
       <entry><id>urn:summary</id><summary type="html"><![CDATA[<b>Summary</b> only]]></summary>
         <link href="summary"/></entry>
       <entry><id>urn:source</id><source><title>Source title</title></source>
         <link href="source"/></entry>
       <entry><id>urn:literal</id><title><![CDATA[<b>literal</b> &amp;]]></title>
         <link href="literal"/></entry>
       <entry><title>No ID</title><link href="no-id"/></entry>
       <entry><id>urn:no-link</id><title>No link</title><content>Inline content</content></entry>`,
      `<title type="html">&lt;b&gt;Atom&lt;/b&gt; &amp;amp; news</title>
       <subtitle type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">A <b>subtitle</b></div></subtitle>
       <link rel="self" href="index.xml"/>
       <link rel="alternate" href="../home"/>`
    ),
    FEED_URL
  );
  Assert.equal(feed.title, "Atom & news");
  Assert.equal(feed.description, "A subtitle");
  Assert.equal(feed.siteURL, "https://example.com/home");
  Assert.deepEqual(
    feed.items.map(item => item.title),
    [
      "Plain & simple",
      "HTML & ©",
      "XHTML & text",
      "Summary only",
      "Source title",
      "<b>literal</b> &amp;",
    ]
  );
  Assert.equal(feed.items[0].id, "urn:plain");
  Assert.equal(feed.items[0].url, "https://example.com/feeds/plain");
  checkContract(feed);
});

add_task(function test_atom_html_and_xhtml_text_boundaries() {
  const feed = parseFeed(
    atom(
      `<entry><id>escaped</id><title type="html">&lt;b&gt;Before&lt;/b&gt;&lt;div&gt;After&lt;/div&gt;</title>
         <link href="escaped"/></entry>
       <entry><id>cdata-html</id><title type="html"><![CDATA[<b>CDATA</b> &amp; HTML]]></title>
         <link href="cdata-html"/></entry>
       <entry><id>xml-comment</id><title type="html">&lt;b<!-- ignored -->&gt;Comment&lt;/b&gt;</title>
         <link href="xml-comment"/></entry>
       <entry><id>xml-pi</id><title type="html">&lt;b<?ignored value?>&gt;Instruction&lt;/b&gt;</title>
         <link href="xml-pi"/></entry>
       <entry><id>xhtml-cdata</id><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><![CDATA[CDATA <literal> & text]]></div></title>
         <link href="xhtml-cdata"/></entry>
       <entry><id>xhtml-prefix</id><title type="xhtml"><x:div xmlns:x="http://www.w3.org/1999/xhtml">Before<x:br/>After<x:div>Block</x:div><x:script>hidden</x:script></x:div></title>
         <link href="xhtml-prefix"/></entry>
       <entry><id>escaped-literal</id><title type="html">&amp;lt;literal&amp;gt; &amp;amp;</title>
         <link href="escaped-literal"/></entry>`,
      '<title type="html">&lt;em&gt;Feed&lt;/em&gt;&lt;div&gt;title&lt;/div&gt;</title>'
    ),
    FEED_URL
  );
  Assert.equal(feed.title, "Feed title");
  Assert.deepEqual(
    feed.items.map(item => item.title),
    [
      "Before After",
      "CDATA & HTML",
      "Comment",
      "Instruction",
      "CDATA <literal> & text",
      "Before After Block",
      "<literal> &",
    ]
  );
  checkContract(feed);
});

add_task(function test_atom1_nested_base_does_not_leak_to_siblings() {
  const feed = parseFeed(
    atom(
      `<entry xml:base="first/"><id>first</id><title>First</title>
         <link xml:base="../links/" href="one"/></entry>
       ${entry("second", '<link href="two"/>')}
       <entry xml:base="third/">
         <id>third</id><title>Third</title><link href="../three"/></entry>
       <entry><id>original</id><title>Original</title>
         <f:origLink xmlns:f="http://rssnamespace.org/feedburner/ext/1.0"
           xml:base="../original/">four</f:origLink><link href="tracking"/></entry>`,
      '<title>Base test</title><link href="home"/>',
      'xml:base="../articles/"'
    ),
    FEED_URL
  );
  Assert.equal(feed.siteURL, "https://example.com/articles/home");
  Assert.deepEqual(
    feed.items.map(item => item.url),
    [
      "https://example.com/articles/links/one",
      "https://example.com/articles/two",
      "https://example.com/articles/three",
      "https://example.com/original/four",
    ]
  );
  checkContract(feed);
});

add_task(function test_xml_base_empty_values_and_absolute_recovery() {
  const feed = parseFeed(
    atom(
      `<entry xml:base=""><id>empty</id><title>Empty base inherits</title>
         <link xml:base="" href="one"/></entry>
       <entry xml:base="https://other.example/nested/"><id>absolute</id><title>Absolute base</title>
         <link xml:base="../" href="two"/></entry>
       <entry xml:base="https://[invalid"><id>recovered</id><title>Recovered base</title>
         <link xml:base="https://recovered.example/" href="three"/></entry>
       ${entry("sibling", '<link href="four"/>')}`,
      '<title>Base test</title><link href="https://site.example/unrelated/"/>',
      'xml:base="../root/"'
    ),
    FEED_URL
  );
  Assert.equal(feed.siteURL, "https://site.example/unrelated/");
  Assert.deepEqual(
    feed.items.map(item => item.url),
    [
      "https://example.com/root/one",
      "https://other.example/two",
      "https://recovered.example/three",
      "https://example.com/root/four",
    ]
  );
  checkContract(feed);
});

add_task(function test_atom03() {
  const feed = parseFeed(
    `<feed xmlns="${ATOM03_NS}" xml:base="../old/">
      <title type="text/html" mode="escaped">&lt;b&gt;Old Atom&lt;/b&gt;</title>
      <tagline type="text/plain">Old &amp; useful</tagline>
      <link rel="alternate" href="./"/>
      <entry><id>urn:old</id><title type="text/html" mode="escaped">&lt;i&gt;Escaped&lt;/i&gt;</title>
        <link rel="alternate" href="one"/></entry>
      <entry><id>urn:xml</id><title type="application/xhtml+xml" mode="xml">
        <div xmlns="http://www.w3.org/1999/xhtml">XML <b>title</b></div></title>
        <link href="two"/></entry>
      <entry><id>urn:summary</id><summary>Summary fallback</summary><link href="three"/></entry>
      <entry><id>urn:binary</id><title mode="base64">VGl0bGU=</title><link href="four"/></entry>
      <entry><title>No ID</title><link href="five"/></entry>
      <entry><id>urn:xml-cdata</id><title type="application/xhtml+xml" mode="xml"><x:div xmlns:x="http://www.w3.org/1999/xhtml">Before<x:br/><![CDATA[After <literal>]]></x:div></title>
        <link href="six"/></entry>
    </feed>`,
    FEED_URL
  );
  Assert.equal(feed.title, "Old Atom");
  Assert.equal(feed.description, "Old & useful");
  Assert.equal(feed.siteURL, "https://example.com/old/");
  Assert.deepEqual(
    feed.items.map(item => item.title),
    ["Escaped", "XML title", "Summary fallback", "Before After <literal>"]
  );
  Assert.deepEqual(
    feed.items.map(item => item.url),
    [
      "https://example.com/old/one",
      "https://example.com/old/two",
      "https://example.com/old/three",
      "https://example.com/old/six",
    ]
  );
  checkContract(feed);
});

add_task(function test_namespace_and_nested_element_confusion() {
  const feed = parseFeed(
    rss(
      `<f:item xmlns:f="urn:foreign"><title>Foreign</title><link>/foreign</link></f:item>
       <wrapper><item><title>Nested</title><link>/nested</link></item></wrapper>
       <item xmlns:f="urn:foreign"><f:title>Forged title</f:title><f:link>/forged</f:link></item>
       <item xmlns:f="urn:foreign"><title>Real</title><f:link>/forged</f:link>
         <wrapper><link>/nested-link</link></wrapper><link f:base="https://evil.example/">real</link></item>`
    ),
    FEED_URL
  );
  Assert.deepEqual(feed.items, [
    {
      id: "https://example.com/feeds/real",
      title: "Real",
      url: "https://example.com/feeds/real",
    },
  ]);

  const atomFeed = parseFeed(
    atom(
      `<entry xmlns="urn:foreign"><id>foreign</id><title>Foreign</title><link href="foreign"/></entry>
       <wrapper>${entry("nested", '<link href="nested"/>')}</wrapper>
       <entry><id>wrong-div</id><title type="xhtml"><div xmlns="urn:foreign">Wrong</div></title><link href="wrong"/></entry>
       <entry><id>unknown-type</id><title type="image/png">Title</title><link href="unknown"/></entry>
       <entry><id>nested-title</id><wrapper><title>Nested</title></wrapper><link href="nested-title"/></entry>
       <entry><id>mixed-text</id><title type="text"><b>Not a text construct</b></title><link href="mixed"/></entry>
       <entry><id>foreign-link</id><title>Foreign link</title><link xmlns="urn:foreign" href="foreign-link"/></entry>
       ${entry("real", '<link href="real"/>')}`
    ),
    FEED_URL
  );
  Assert.equal(atomFeed.items.length, 1);
  Assert.equal(atomFeed.items[0].id, "real");
  checkContract(feed);
  checkContract(atomFeed);
});

add_task(function test_unsafe_urls_and_credentials() {
  const unsafe = [
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///tmp/feed",
    "chrome://browser/content/",
    "resource:///modules/",
    "about:config",
    "ftp://example.com/file",
    "magnet:?xt=urn:test",
    "mailto:user@example.com",
    "https://user:password@example.com/",
    "//user@example.com/",
    "https://[invalid",
    "http://",
    "java&#x09;script:alert(1)",
  ];
  for (const link of unsafe) {
    const feed = parseFeed(
      rss(
        `<item><title>Unsafe</title><link>${link}</link></item>`,
        `<title>Unsafe site</title><link>${link}</link>`
      ),
      FEED_URL
    );
    Assert.equal(feed.siteURL, "", `Reject RSS site ${link}`);
    Assert.equal(feed.items.length, 0, `Reject RSS item ${link}`);
    const atomFeed = parseFeed(
      atom(
        entry("unsafe", `<link href="${link}"/>`),
        `<title>Unsafe site</title><link href="${link}"/>`
      ),
      FEED_URL
    );
    Assert.equal(atomFeed.siteURL, "", `Reject Atom site ${link}`);
    Assert.equal(atomFeed.items.length, 0, `Reject Atom item ${link}`);
  }
  const feed = parseFeed(
    atom(
      entry(
        "safe",
        '<link href="javascript:alert(1)"/><link href="//EXAMPLE.com:443/safe"/>'
      )
    ),
    FEED_URL
  );
  Assert.equal(feed.items[0].url, "https://example.com/safe");
  checkContract(feed);
});

add_task(function test_unsafe_and_malformed_xml_base() {
  for (const base of [
    "javascript:alert(1)",
    "https://user:secret@example.com/",
    "https://[invalid",
  ]) {
    const feed = parseFeed(
      atom(
        `${entry("relative", '<link href="relative"/>')}
         ${entry("absolute", '<link href="https://example.com/absolute"/>')}`,
        '<title>Bad base</title><link href="relative-site"/>',
        `xml:base="${base}"`
      ),
      FEED_URL
    );
    Assert.equal(feed.siteURL, "");
    Assert.deepEqual(
      feed.items.map(item => item.id),
      ["absolute"]
    );
  }
  const feed = parseFeed(
    atom(
      `<entry xml:base="https://user@example.com/"><id>bad</id><title>Bad</title><link href="bad"/></entry>
       ${entry("good", '<link href="good"/>')}
       ${entry("bad-link-base", '<link xml:base="file:///tmp/" href="bad"/>')}`
    ),
    FEED_URL
  );
  Assert.deepEqual(
    feed.items.map(item => item.id),
    ["good"]
  );
});

add_task(function test_malformed_and_unsupported_feeds() {
  const invalid = [
    "",
    " \n\t",
    "not XML",
    "<rss>",
    "<rss><channel></rss>",
    "<rss/><rss/>",
    "<rss/>",
    "<rss><channel/></rss>",
    rss("<item><title>&undefined;</title></item>"),
    rss("\u0000"),
    "<html><channel><title>Not RSS</title></channel></html>",
    "<wrapper><rss><channel><title>Nested RSS</title></channel></rss></wrapper>",
    '<rss xmlns="urn:foreign"><channel><title>Wrong namespace</title></channel></rss>',
    '<rss><channel xmlns="urn:foreign"><title>Wrong channel</title></channel></rss>',
    `<entry xmlns="${ATOM_NS}"><title>Not a feed</title></entry>`,
    `<feed xmlns="urn:foreign"><title>Not Atom</title></feed>`,
    `<feed xmlns="${ATOM_NS}"/>`,
    `<feed xmlns="${ATOM03_NS}"/>`,
    `<r:RDF xmlns:r="${RDF_NS}"/>`,
    `<r:wrong xmlns:r="${RDF_NS}" xmlns="${RSS1_NS}"><channel/></r:wrong>`,
    '<parsererror xmlns="http://www.mozilla.org/newlayout/xml/parsererror.xml"/>',
  ];
  for (const xml of invalid) {
    Assert.throws(() => parseFeed(xml, FEED_URL), /./, `Reject ${xml}`);
  }
  for (const xml of [null, undefined, {}, new Uint8Array()]) {
    Assert.throws(() => parseFeed(xml, FEED_URL), /nonempty string/);
  }
  for (const url of [
    "",
    "/relative",
    "file:///feed",
    "https://user@example.com/",
    null,
  ]) {
    Assert.throws(() => parseFeed(rss(), url), /absolute HTTP\(S\) URL/);
  }
});

add_task(function test_doctype_rejected_before_parsing() {
  for (const declaration of [
    '<!DOCTYPE rss SYSTEM "https://example.invalid/external.dtd">',
    '<!DOCTYPE rss SYSTEM "file:///etc/passwd">',
    '<!DOCTYPE rss [<!ENTITY content "expanded">]>',
    '<!DOCTYPE rss [<!ENTITY external SYSTEM "file:///etc/passwd">]>',
    '<!DOCTYPE rss [<!ENTITY % external SYSTEM "https://example.invalid/external.dtd">%external;]>',
    '\uFEFF<?xml version="1.0"?>\n<!DOCTYPE rss SYSTEM "https://example.invalid/external.dtd">',
    '<!DOCTYPE rss [<!ENTITY a "1234567890"><!ENTITY b "&a;&a;&a;&a;">]>',
    "<!DOCTYPE rss>",
  ]) {
    Assert.throws(
      () => parseFeed(`${declaration}${rss()}`, FEED_URL),
      /DOCTYPE or entity declaration/,
      "DTD rejected by the pre-parse guard"
    );
  }
  Assert.throws(
    () =>
      parseFeed(
        rss("", "<title><![CDATA[<!DOCTYPE html>]]></title>"),
        FEED_URL
      ),
    /DOCTYPE/,
    "The declaration guard is deliberately conservative, even in CDATA"
  );
  Assert.throws(
    () => parseFeed(`<!-- <!DOCTYPE rss> -->${rss()}`, FEED_URL),
    /DOCTYPE/,
    "The declaration guard also rejects declarations inside comments"
  );
});

add_task(function test_valid_empty_feeds_and_missing_site() {
  for (const xml of [
    rss(),
    atom(),
    `<feed xmlns="${ATOM03_NS}"><title>News</title></feed>`,
    `<r:RDF xmlns:r="${RDF_NS}" xmlns="${RSS1_NS}"><channel><title>News</title></channel></r:RDF>`,
  ]) {
    const feed = parseFeed(xml, FEED_URL);
    Assert.equal(feed.title, "News");
    Assert.equal(feed.siteURL, "");
    Assert.deepEqual(feed.items, []);
    checkContract(feed);
  }
  Assert.equal(
    parseFeed(rss("", "<link>/home</link>"), FEED_URL).title,
    "example.com - /home"
  );
  Assert.equal(
    parseFeed(rss("", "<description>Description only</description>"), FEED_URL)
      .description,
    "Description only"
  );
  Assert.equal(
    parseFeed(
      atom("", '<title>News</title><link rel="self" href="index.xml"/>'),
      FEED_URL
    ).siteURL,
    ""
  );
});

add_task(function test_deduplication_and_item_limit() {
  const items = [
    "<item><title>Unsafe</title><link>javascript:alert(1)</link></item>",
    "<item><title>First</title><link>https://EXAMPLE.com:443/article#first</link></item>",
    "<item><title>Duplicate</title><link>https://example.com/article#second</link></item>",
    '<item><title>Same ID, different URL</title><guid isPermaLink="false">same</guid><link>/other</link></item>',
    '<item><title>Same ID, different URL again</title><guid isPermaLink="false">same</guid><link>/another</link></item>',
  ];
  for (let i = 0; i < 205; i++) {
    items.push(`<item><title>Item ${i}</title><link>/item/${i}</link></item>`);
  }
  const feed = parseFeed(rss(items.join("")), FEED_URL);
  Assert.equal(feed.items.length, 200);
  Assert.equal(feed.items[0].title, "First");
  Assert.equal(feed.items[0].url, "https://example.com/article#first");
  Assert.equal(feed.items.at(-1).url, "https://example.com/item/196");
  Assert.deepEqual(
    parseFeed(rss(items.join("")), FEED_URL),
    feed,
    "No parser state leaks between calls"
  );
  checkContract(feed);

  const entries = Array.from({ length: 205 }, (_, i) =>
    entry(`urn:${i}`, `<link href="item/${i}"/>`)
  );
  Assert.equal(parseFeed(atom(entries.join("")), FEED_URL).items.length, 200);
  Assert.equal(
    parseFeed(
      `<feed xmlns="${ATOM03_NS}"><title>News</title>${entries.join("")}</feed>`,
      FEED_URL
    ).items.length,
    200
  );
  Assert.equal(
    parseFeed(
      `<r:RDF xmlns:r="${RDF_NS}" xmlns="${RSS1_NS}"><channel><title>News</title></channel>${items.join("")}</r:RDF>`,
      FEED_URL
    ).items.length,
    200
  );
});

add_task(function test_text_limits_and_unicode() {
  const longText = "x".repeat(1200);
  const feed = parseFeed(
    atom(
      entry(longText, '<link href="long"/>', longText) +
        entry(
          "unicode",
          '<link href="unicode"/>',
          "x".repeat(999) + "\uD834\uDD1E"
        ),
      `<title>${longText}</title><subtitle>${longText}</subtitle>`
    ),
    FEED_URL
  );
  Assert.equal(feed.title.length, 1000);
  Assert.equal(feed.description.length, 1000);
  Assert.equal(feed.items[0].title.length, 1000);
  Assert.equal(feed.items[0].id.length, 1000);
  Assert.equal(
    feed.items[1].title,
    "x".repeat(999),
    "Do not split a surrogate pair"
  );
  checkContract(feed);
});

add_task(function test_xml_size_limit_in_utf8_bytes() {
  const empty = rss();
  const exactLimit =
    empty + "<!--" + "x".repeat(MAX_XML_BYTES - empty.length - 7) + "-->";
  Assert.equal(new TextEncoder().encode(exactLimit).length, MAX_XML_BYTES);
  Assert.deepEqual(
    parseFeed(exactLimit, FEED_URL).items,
    [],
    "Exactly 2 MiB is accepted"
  );
  Assert.throws(() => parseFeed(exactLimit + " ", FEED_URL), /exceeds 2 MiB/);
  const multibyte = rss("", `<title>${"é".repeat(MAX_XML_BYTES / 2)}</title>`);
  Assert.less(
    multibyte.length,
    MAX_XML_BYTES,
    "UTF-16 length alone is insufficient"
  );
  Assert.throws(() => parseFeed(multibyte, FEED_URL), /exceeds 2 MiB/);
});
