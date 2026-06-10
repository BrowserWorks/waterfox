/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ListCatalog: "resource:///modules/internal/ListCatalog.sys.mjs",
  ListStore: "resource:///modules/internal/ListStore.sys.mjs",
});

// easylist.txt is about 2.2 MiB today; 8 MiB leaves room for list growth.
// Lists are mostly ASCII, so decoded length tracks byte length closely after the
// early Content-Length byte guard.
export const MAX_LIST_BYTES = 8 * 1024 * 1024;

function assertListTextLength(text) {
  if (text.length > MAX_LIST_BYTES) {
    throw new Error(`Fetched list exceeds ${MAX_LIST_BYTES} bytes`);
  }
}

function assertListContentLength(response) {
  const rawLength = response.headers.get("Content-Length");
  if (rawLength === null) {
    return;
  }

  const normalizedLength = rawLength.trim();
  if (!/^\d+$/.test(normalizedLength)) {
    return;
  }

  const length = Number(normalizedLength);
  if (length > MAX_LIST_BYTES) {
    throw new Error(`Fetched list exceeds ${MAX_LIST_BYTES} bytes`);
  }
}

export function getListFetchRedirectMode(descriptor) {
  if (lazy.ListCatalog.isCatalogListDescriptor(descriptor)) {
    return "follow";
  }
  return "manual";
}

export function assertListFetchResponseOk(response, descriptor, redirectMode) {
  if (response.ok) {
    return;
  }

  if (
    redirectMode === "manual" &&
    (response.type === "opaqueredirect" || response.status === 0)
  ) {
    const message = lazy.ListCatalog.isCustomListUrlDescriptor(descriptor)
      ? "custom list URL redirected; redirects are not followed"
      : "list URL redirected; redirects are not followed";
    throw new Error(message);
  }

  throw new Error(`HTTP ${response.status}`);
}

export async function readListResponseText(response) {
  assertListContentLength(response);

  if (!response.body?.getReader) {
    const text = await response.text();
    assertListTextLength(text);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let length = 0;

  const appendChunk = chunk => {
    if (!chunk) {
      return;
    }

    length += chunk.length;
    if (length > MAX_LIST_BYTES) {
      throw new Error(`Fetched list exceeds ${MAX_LIST_BYTES} bytes`);
    }

    chunks.push(chunk);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      appendChunk(decoder.decode(value, { stream: true }));
    }
    appendChunk(decoder.decode());
  } catch (err) {
    try {
      await reader.cancel(err);
    } catch (_) {}
    throw err;
  }

  return chunks.join("");
}

async function hasUsableStoredListFile(filename) {
  const path = lazy.ListStore.listPath(filename);
  if (!(await IOUtils.exists(path))) {
    return false;
  }

  try {
    return !!(await lazy.ListStore.readText(path)).trim();
  } catch (_) {
    return false;
  }
}

export async function fetchList(
  descriptor,
  metadataEntry,
  conditional,
  redirectMode = "manual",
  fetchImpl = fetch
) {
  const headers = new Headers();
  let sentValidator = false;

  if (conditional && metadataEntry?.etag) {
    headers.set("If-None-Match", metadataEntry.etag);
    sentValidator = true;
  }
  if (conditional && metadataEntry?.lastModified) {
    headers.set("If-Modified-Since", metadataEntry.lastModified);
    sentValidator = true;
  }

  const response = await fetchImpl(descriptor.url, {
    cache: "no-store",
    headers,
    redirect: redirectMode,
  });

  if (response.status === 304) {
    if (!sentValidator) {
      throw new Error("Unexpected 304 response to unconditional list request");
    }
    return { notModified: true };
  }

  assertListFetchResponseOk(response, descriptor, redirectMode);

  const text = await readListResponseText(response);
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

/**
 * Tracks list refresh runs so only one update pass is in flight at a time.
 */
export class ListUpdatesState {
  constructor({ fetchImpl = fetch } = {}) {
    this._fetchImpl = fetchImpl;
    this._updateInProgress = false;
  }

  async updateIfNeeded() {
    if (this._updateInProgress) {
      return null;
    }

    this._updateInProgress = true;
    try {
      return await lazy.ListStore.withListWriteLock(async () => {
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

          const isCustomList =
            lazy.ListCatalog.isCustomListUrlDescriptor(descriptor);
          const previousFilename = isCustomList
            ? String(oldEntry?.filename || "")
            : descriptor.filename;
          const hasLegacyCustomFilename =
            isCustomList &&
            previousFilename !== descriptor.filename &&
            lazy.ListCatalog.isLegacyCustomListFilename(previousFilename);

          try {
            const canUseConditional =
              !hasLegacyCustomFilename &&
              (await hasUsableStoredListFile(descriptor.filename));
            if (!canUseConditional) {
              nextEntry.etag = "";
              nextEntry.lastModified = "";
            }
            const result = await fetchList(
              descriptor,
              oldEntry,
              canUseConditional,
              getListFetchRedirectMode(descriptor),
              this._fetchImpl
            );

            if (result.notModified) {
              nextEntry.lastFetched = now;
            } else if (result.text) {
              await lazy.ListStore.writeText(listPath, result.text);
              nextEntry.lastFetched = now;
              nextEntry.etag = result.etag || "";
              nextEntry.lastModified = result.lastModified || "";
              anyUpdated = true;

              if (hasLegacyCustomFilename) {
                try {
                  await IOUtils.remove(
                    lazy.ListStore.listPath(previousFilename),
                    { ignoreAbsent: true }
                  );
                } catch (err) {
                  console.warn(
                    `[WaterfoxBlocker] Failed removing legacy list ${previousFilename}:`,
                    err
                  );
                }
              }
            }
          } catch (err) {
            if (hasLegacyCustomFilename) {
              nextEntry.etag = "";
              nextEntry.filename = previousFilename;
              nextEntry.lastModified = "";
            }
            const message =
              err instanceof Error
                ? err.message
                : String(err || "unknown error");
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
      });
    } finally {
      this._updateInProgress = false;
    }
  }
}
