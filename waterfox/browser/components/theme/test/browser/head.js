/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

async function readWaterfoxStyleSheets(url, seen = new Set()) {
  if (seen.has(url)) {
    return "";
  }
  seen.add(url);
  const css = await (await fetch(url)).text();
  const sheets = [css];
  for (const match of css.matchAll(
    /@import\s+url\(\s*["']([^"']+)["']\s*\)\s*;/g
  )) {
    const importedURL = Services.io.newURI(
      match[1],
      null,
      Services.io.newURI(url)
    ).spec;
    sheets.push(await readWaterfoxStyleSheets(importedURL, seen));
  }
  return sheets.join("\n");
}
