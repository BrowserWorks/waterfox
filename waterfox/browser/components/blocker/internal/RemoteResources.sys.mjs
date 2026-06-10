/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ListStore: "resource:///modules/internal/ListStore.sys.mjs",
});

const PREF_REMOTE_RESOURCES_ENABLED = "waterfox.blocker.remoteResourcesEnabled";

// 4 MB ceiling per bundle. The worker outputs are well under 1 MB today; this
// guards against a runaway response masquerading as a valid payload.
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

const REMOTE_BUNDLES = Object.freeze([
  Object.freeze({
    name: "ubo-scriptlets",
    url: "https://aus.waterfox.com/v1/blocker/ubo-scriptlets.json",
    bundledUrl:
      "resource://waterfox/blocker/assets/resources/ubo-scriptlets.json",
  }),
  Object.freeze({
    name: "resources",
    url: "https://aus.waterfox.com/v1/blocker/resources.json",
    bundledUrl: "resource://waterfox/blocker/assets/resources/resources.json",
  }),
]);

function isRemoteEnabled() {
  return Services.prefs.getBoolPref(PREF_REMOTE_RESOURCES_ENABLED, true);
}

function validateBundleText(text) {
  if (text.length > MAX_BUNDLE_BYTES) {
    throw new Error(`bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON parse failed: ${err?.message || err}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("bundle is not an array");
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      throw new Error("bundle entry is not an object");
    }
    if (typeof entry.name !== "string" || !entry.name) {
      throw new Error("bundle entry missing string `name`");
    }
    if (typeof entry.content !== "string") {
      throw new Error(`entry "${entry.name}" missing string \`content\``);
    }
    if (entry.kind?.mime !== "application/javascript") {
      throw new Error(
        `entry "${entry.name}" has unsupported kind.mime: ${entry.kind?.mime}`
      );
    }
  }

  return parsed;
}

async function readMetaSafely(metaPath) {
  return lazy.ListStore.readJSON(metaPath, null);
}

async function writeMeta(metaPath, meta) {
  try {
    await lazy.ListStore.writeJSON(metaPath, meta);
  } catch (err) {
    console.warn(
      `[WaterfoxBlocker] Failed writing remote-resource meta ${metaPath}:`,
      err
    );
  }
}

async function fetchBundle(bundle, previousEtag) {
  const headers = new Headers();
  if (previousEtag) {
    headers.set("If-None-Match", previousEtag);
  }

  const response = await fetch(bundle.url, {
    cache: "no-store",
    headers,
  });

  if (response.status === 304) {
    return { notModified: true };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return {
    etag: response.headers.get("ETag") || "",
    notModified: false,
    text: await response.text(),
  };
}

async function refreshOneBundle(bundle) {
  const filePath = lazy.ListStore.remoteResourceFilePath(bundle.name);
  const metaPath = lazy.ListStore.remoteResourceMetaPath(bundle.name);
  const previous = (await readMetaSafely(metaPath)) || {
    etag: "",
    lastError: "",
    lastFetched: 0,
  };

  const now = Date.now();
  const nextMeta = {
    etag: previous.etag || "",
    lastAttempt: now,
    lastError: "",
    lastFetched: previous.lastFetched || 0,
  };

  try {
    const result = await fetchBundle(bundle, previous.etag);

    if (result.notModified) {
      await writeMeta(metaPath, nextMeta);
      return;
    }

    validateBundleText(result.text);

    await lazy.ListStore.ensureRootDir();
    await lazy.ListStore.writeText(filePath, result.text);

    nextMeta.etag = result.etag || "";
    nextMeta.lastFetched = now;
    await writeMeta(metaPath, nextMeta);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err || "unknown error");
    nextMeta.lastError = message.slice(0, 500);
    console.warn(
      `[WaterfoxBlocker] Failed to refresh remote bundle "${bundle.name}":`,
      err
    );
    await writeMeta(metaPath, nextMeta);
  }
}

async function readBundledArray(bundledUrl) {
  try {
    const response = await fetch(bundledUrl, { cache: "no-store" });
    if (!response.ok) {
      return [];
    }
    const parsed = JSON.parse(await response.text());
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(
      `[WaterfoxBlocker] Failed reading bundled resource ${bundledUrl}:`,
      err
    );
    return [];
  }
}

async function readRemoteArray(bundle) {
  const filePath = lazy.ListStore.remoteResourceFilePath(bundle.name);
  if (!(await IOUtils.exists(filePath))) {
    return null;
  }

  try {
    const text = await lazy.ListStore.readText(filePath);
    if (!text) {
      return null;
    }
    return validateBundleText(text);
  } catch (err) {
    console.warn(
      `[WaterfoxBlocker] Stored remote bundle "${bundle.name}" is invalid, falling back to bundled copy:`,
      err
    );
    return null;
  }
}

export const RemoteResources = {
  REMOTE_BUNDLES,

  async refresh() {
    if (!isRemoteEnabled()) {
      return;
    }

    for (const bundle of REMOTE_BUNDLES) {
      try {
        await refreshOneBundle(bundle);
      } catch (err) {
        // refreshOneBundle handles its own errors. This is a safety net so
        // one bad bundle never aborts the rest.
        console.warn(
          `[WaterfoxBlocker] Unexpected error refreshing "${bundle.name}":`,
          err
        );
      }
    }
  },

  async readMergedResources() {
    const remoteEnabled = isRemoteEnabled();
    const merged = [];

    for (const bundle of REMOTE_BUNDLES) {
      let entries = null;
      if (remoteEnabled) {
        entries = await readRemoteArray(bundle);
      }
      if (!entries) {
        entries = await readBundledArray(bundle.bundledUrl);
      }
      if (entries.length) {
        merged.push(...entries);
      }
    }

    return merged;
  },
};
