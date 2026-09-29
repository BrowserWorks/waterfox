/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function handleRequest(request, response) {
  const [kind, format, option] = request.queryString.split("-");
  const types = {
    plain: "text/plain",
    html: "text/html",
    rss: "application/rss+xml",
    atom: "application/atom+xml",
  };
  response.setHeader("Cache-Control", "no-store", false);
  response.setHeader(
    "Content-Type",
    `${types[format] || "application/xml"}; charset=utf-8`,
    false
  );
  if (option === "attachment") {
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="feed.xml"',
      false
    );
  } else if (option === "coop") {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin", false);
  }
  const description = "&lt;b&gt;Safe description&lt;/b&gt;";
  const rss = `<rss version="2.0"><channel><title>Direct feed</title>
    <description>${description}</description><link>https://example.com/</link>
    <item><title>Entry</title><link>https://example.com/entry</link>
      <description>${description}</description></item>
    <item><title>Unsafe entry</title><link>javascript:alert(1)</link></item>
    </channel></rss>`;
  let xml;
  switch (kind) {
    case "atom1":
      xml = `<feed xmlns="http://www.w3.org/2005/Atom">
        <title>Direct feed</title><link rel="alternate" href="https://example.com/"/>
        <entry><id>entry</id><title>Entry</title>
          <link rel="alternate" href="https://example.com/entry"/>
          <summary type="html">${description}</summary>
        </entry></feed>`;
      break;
    case "dtd":
      xml = '<!DOCTYPE rss [<!ENTITY title "Entity">]>' + rss;
      break;
    case "malformed":
      xml = rss + "<unclosed>";
      break;
    case "multibyte":
      // response.write takes bytes: this is U+20AC encoded as UTF-8.
      xml = rss.replace("Direct feed", "\xe2\x82\xac".repeat(750000));
      break;
    case "notfeed":
      xml = "<document>Not a feed</document>";
      break;
    default:
      xml = rss;
  }
  response.write(xml);
}
