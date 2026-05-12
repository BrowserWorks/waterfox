/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ListCatalog: "resource:///modules/internal/ListCatalog.sys.mjs",
  ListStore: "resource:///modules/internal/ListStore.sys.mjs",
});

async function fetchList(descriptor, metadataEntry, conditional) {
  const headers = new Headers();

  if (conditional && metadataEntry?.etag) {
    headers.set("If-None-Match", metadataEntry.etag);
  }
  if (conditional && metadataEntry?.lastModified) {
    headers.set("If-Modified-Since", metadataEntry.lastModified);
  }

  const response = await fetch(descriptor.url, {
    cache: "no-store",
    headers,
  });

  if (response.status === 304) {
    return { notModified: true };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const text = await response.text();
  if (!text || !text.trim()) {
    throw new Error("Fetched list was empty");
  }

  return {
    etag: response.headers.get("ETag") || "",
    lastModified: response.headers.get("Last-Modified") || "",
    notModified: false,
    text,
  };
}

export class ListUpdatesState {
  constructor() {
    this._updateInProgress = false;
  }

  async updateIfNeeded() {
    if (this._updateInProgress) {
      return null;
    }

    this._updateInProgress = true;
    try {
      const descriptors = await lazy.ListCatalog.getListDescriptors();
      const metadataPath = lazy.ListStore.listsMetadataPath();

      await lazy.ListStore.ensureListsDir();

      const meta = await lazy.ListStore.readJSON(metadataPath, { lists: [] });
      const oldByUrl = new Map(
        (meta?.lists || []).map(entry => [String(entry.url), entry])
      );

      const now = Date.now();
      let metadataChanged = false;
      let anyUpdated = false;
      const nextEntries = [];

      for (const descriptor of descriptors) {
        if (lazy.ListCatalog.isCustomFiltersDescriptor(descriptor)) {
          continue;
        }

        const oldEntry = oldByUrl.get(descriptor.url) || null;
        const listPath = lazy.ListStore.listPath(descriptor.filename);

        const nextEntry = oldEntry
          ? {
              ...oldEntry,
              filename: descriptor.filename,
              lastAttempt: now,
              lastError: "",
              url: descriptor.url,
            }
          : {
              etag: "",
              filename: descriptor.filename,
              lastAttempt: now,
              lastError: "",
              lastFetched: 0,
              lastModified: "",
              url: descriptor.url,
            };
        metadataChanged = true;

        try {
          const result = await fetchList(descriptor, oldEntry, true);

          if (result.notModified) {
            nextEntry.lastFetched = now;
          } else if (result.text) {
            await lazy.ListStore.writeText(listPath, result.text);
            nextEntry.lastFetched = now;
            nextEntry.etag = result.etag || "";
            nextEntry.lastModified = result.lastModified || "";
            anyUpdated = true;
          }
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err || "unknown error");
          nextEntry.lastError = message.slice(0, 500);
          console.warn(
            `[WaterfoxBlocker] Failed to update list: ${descriptor.url}`,
            err
          );
        }

        // Keep failure metadata even when the list has not been fetched yet,
        // and keep the file when this fetch failed.
        if ((await IOUtils.exists(listPath)) || nextEntry.lastError) {
          nextEntries.push(nextEntry);
        }
      }

      if (metadataChanged) {
        await lazy.ListStore.writeJSON(metadataPath, {
          lists: nextEntries,
        });
      }

      return {
        anyUpdated,
        descriptors,
      };
    } finally {
      this._updateInProgress = false;
    }
  }
}
