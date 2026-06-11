#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global Buffer, require, __dirname, process */
/* eslint-disable no-console */

"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

/**
 * A filter source, enabled by default, resolved from `list_catalog.json`.
 *
 * @typedef {{url: string, filename: string}} FilterSource
 */

/**
 * Shape of entries exported by uBO scriptlets module.
 *
 * @typedef {{
 *   name: string,
 *   fn?: Function,
 *   aliases?: string[],
 *   dependencies?: string[]
 * }} BuiltinScriptlet
 */

/**
 * Shape of entries in uBO's redirect-resource mapping.
 *
 * @typedef {{
 *   alias?: string | string[],
 *   data?: string,
 *   params?: string[]
 * }} RedirectResourceProperties
 */

const SCRIPT_DIR = __dirname;
const BLOCKER_DIR = path.resolve(SCRIPT_DIR, "..");
const ASSETS_DIR = path.join(BLOCKER_DIR, "assets");
const FILTERS_DIR = path.join(ASSETS_DIR, "filters");
const RESOURCES_DIR = path.join(ASSETS_DIR, "resources");

const CATALOG_PATH = path.join(ASSETS_DIR, "list_catalog.json");
const SUPPLEMENTARY_RESOURCE_URL =
  "https://raw.githubusercontent.com/brave/adblock-resources/refs/heads/master/dist/resources.json";
const SUPPLEMENTARY_OUTPUT_PATH = path.join(RESOURCES_DIR, "resources.json");
const UBO_SCRIPTLET_OUTPUT_PATH = path.join(
  RESOURCES_DIR,
  "ubo-scriptlets.json"
);

const REDIRECT_RESOURCE_MIME_BY_EXTENSION = Object.freeze({
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".mp3": "audio/mp3",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".txt": "text/plain",
  ".xml": "text/xml",
});
const REDIRECT_RESOURCE_MIME_BY_NAME = Object.freeze({
  empty: "text/plain",
});

const AUTO_UBLOCK_DIR = path.join(os.tmpdir(), "waterfox-blocker-ublock");
const RESOURCES_ONLY_ARG = "--resources-only";
const UBLOCK_GIT_URL = "https://github.com/gorhill/uBlock.git";
const UBLOCK_RELEASE_TAG_RE = /^refs\/tags\/(\d+\.\d+\.\d+)$/;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_BASE_MS = 2_000;
const FILTER_DOWNLOAD_CONCURRENCY = 6;

/**
 * Wrap scriptlet functions to consume Waterfox placeholder args.
 *
 * @param {string} fnString
 * @param {string} dependencyPrelude
 * @returns {string}
 */
const wrapScriptletArgFormat = (fnString, dependencyPrelude) => `{
const args = ["{{1}}", "{{2}}", "{{3}}", "{{4}}", "{{5}}", "{{6}}", "{{7}}", "{{8}}", "{{9}}"];
let last_arg_index = 0;
for (const arg_index in args) {
    if (args[arg_index] === '{{' + (Number(arg_index) + 1) + '}}') {
        break;
    }
    last_arg_index += 1;
}
${dependencyPrelude}
(${fnString})(...args.slice(0, last_arg_index))
}`;

/**
 * Convert unknown errors to readable text.
 *
 * @param {unknown} error
 * @returns {string}
 */
function toErrorMessage(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${cause}`;
}

/**
 * Sleep for the given duration.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if path exists.
 *
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (_) {
    // fs.access indicates absence by throwing.
    return false;
  }
}

/**
 * Assert a required path exists.
 *
 * @param {string} targetPath
 * @param {string} label
 * @returns {Promise<void>}
 */
async function assertExists(targetPath, label) {
  if (!(await pathExists(targetPath))) {
    throw new Error(`missing ${label}: ${targetPath}`);
  }
}

/**
 * Normalise a uBO redirect-resource alias field.
 *
 * @param {string | string[] | undefined} alias
 * @returns {string[]}
 */
function redirectResourceAliases(alias) {
  if (Array.isArray(alias)) {
    return alias.filter(item => typeof item === "string" && item);
  }
  if (typeof alias === "string" && alias) {
    return [alias];
  }
  return [];
}

/**
 * Infer an adblock-rs MIME string for a uBO web-accessible resource.
 *
 * @param {string} name
 * @returns {string}
 */
function redirectResourceMime(name) {
  const override = REDIRECT_RESOURCE_MIME_BY_NAME[name];
  if (override) {
    return override;
  }

  const extension = path.extname(name).toLowerCase();
  const mime = REDIRECT_RESOURCE_MIME_BY_EXTENSION[extension];
  if (!mime) {
    throw new Error(`unsupported redirect resource extension: ${name}`);
  }
  return mime;
}

/**
 * Validate resource names and aliases before adblock-rs silently drops duplicates.
 *
 * @param {{ name: string, aliases?: string[] }[]} resources
 */
function assertUniqueResourceIdentifiers(resources) {
  const identifiers = new Map();
  for (const resource of resources) {
    for (const ident of [resource.name, ...(resource.aliases ?? [])]) {
      const previous = identifiers.get(ident);
      if (previous) {
        throw new Error(
          `duplicate resource identifier "${ident}" in ${previous} and ${resource.name}`
        );
      }
      identifiers.set(ident, resource.name);
    }
  }
}

/**
 * Run command, optionally capturing stdout instead of inheriting stdio.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, capture?: boolean}} [options]
 * @returns {Promise<string>}
 */
function runCommand(command, args, { cwd, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";
    if (capture) {
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", chunk => {
        stdout += chunk;
      });
      proc.stderr.on("data", chunk => {
        stderr += chunk;
      });
    }

    proc.on("error", error => {
      reject(
        new Error(`failed to start "${command}": ${toErrorMessage(error)}`)
      );
    });
    proc.on("close", exitCode => {
      if (exitCode === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${exitCode}${detail}`
        )
      );
    });
  });
}

/**
 * Count newline bytes (same behavior as `wc -l`).
 *
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function countNewlines(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  let lines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
    }
  }
  return lines;
}

/**
 * Format file stats as a single line fragment.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function fileStatsLine(filePath) {
  const { size } = await fs.stat(filePath);
  const lines = await countNewlines(filePath);
  return `${size} bytes, ${lines} lines`;
}

/**
 * Download URL to destination atomically, one attempt.
 *
 * @param {string} url
 * @param {string} destinationPath
 * @returns {Promise<void>}
 */
async function downloadOnce(url, destinationPath) {
  const tempPath = `${destinationPath}.tmp.${process.pid}.${Date.now()}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) {
      throw new Error("downloaded file is empty");
    }
    const head = body
      .subarray(0, 512)
      .toString("utf8")
      .trimStart()
      .toLowerCase();
    if (head.startsWith("<!doctype") || head.startsWith("<html")) {
      throw new Error("response body looks like an HTML error page");
    }

    await fs.writeFile(tempPath, body);
    await fs.rename(tempPath, destinationPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {
      // Cleanup after a failed download is not critical, so ignore errors.
    });
    const reason =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
        ? `timed out after ${DOWNLOAD_TIMEOUT_MS} ms`
        : toErrorMessage(error);
    throw new Error(`failed to download: ${url} (${reason})`);
  }
}

/**
 * Download URL to destination with retries.
 *
 * @param {string} url
 * @param {string} destinationPath
 * @returns {Promise<void>}
 */
async function downloadToFile(url, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      await downloadOnce(url, destinationPath);
      console.log(
        `  - ${destinationPath}: ${await fileStatsLine(destinationPath)}\n    <- ${url}`
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        console.warn(
          `[update-bundled-assets] Attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed, retrying: ${toErrorMessage(error)}`
        );
        await sleep(DOWNLOAD_RETRY_BASE_MS * attempt);
      }
    }
  }
  throw lastError;
}

/**
 * Run worker over items with bounded concurrency, preserving order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index]);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

/**
 * Read the deduplicated source URLs that are enabled by default.
 *
 * @param {string} catalogPath
 * @returns {Promise<FilterSource[]>}
 */
async function readDefaultEnabledSources(catalogPath) {
  const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  if (!Array.isArray(catalog)) {
    throw new Error(`catalog is not an array: ${catalogPath}`);
  }

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {FilterSource[]} */
  const sources = [];

  for (const entry of catalog) {
    if (!entry || typeof entry !== "object" || entry.default_enabled !== true) {
      continue;
    }

    const list = Array.isArray(entry.sources) ? entry.sources : [];
    for (const source of list) {
      if (!source || typeof source !== "object") {
        continue;
      }

      const { url, filename } = source;
      if (typeof url !== "string" || typeof filename !== "string") {
        continue;
      }

      const key = `${url}\t${filename}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      sources.push({ url, filename });
    }
  }

  return sources;
}

/**
 * Compare dotted version number arrays.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Resolve the latest stable uBlock release tag over the git protocol,
 * avoiding GitHub API rate limits.
 *
 * @returns {Promise<string>}
 */
async function resolveLatestUblockTag() {
  const output = await runCommand(
    "git",
    ["ls-remote", "--tags", "--refs", UBLOCK_GIT_URL],
    { capture: true }
  );

  let bestTag = null;
  let bestVersion = null;
  for (const line of output.split("\n")) {
    const ref = line.split("\t")[1];
    const match = ref ? UBLOCK_RELEASE_TAG_RE.exec(ref) : null;
    if (!match) {
      continue;
    }
    const version = match[1].split(".").map(Number);
    if (!bestVersion || compareVersions(version, bestVersion) > 0) {
      bestVersion = version;
      bestTag = match[1];
    }
  }

  if (!bestTag) {
    throw new Error("no stable uBlock release tag found via git ls-remote");
  }
  return bestTag;
}

/**
 * Ensure the managed uBlock checkout matches the release tag.
 *
 * @param {string} tag
 * @returns {Promise<string>} Commit sha of the checkout.
 */
async function ensureUblockCheckout(tag) {
  if (await pathExists(AUTO_UBLOCK_DIR)) {
    const current = await runCommand(
      "git",
      ["-C", AUTO_UBLOCK_DIR, "describe", "--tags", "--exact-match"],
      { capture: true }
    ).catch(() => "");
    if (current.trim() !== tag) {
      await fs.rm(AUTO_UBLOCK_DIR, { recursive: true, force: true });
    }
  }

  if (!(await pathExists(AUTO_UBLOCK_DIR))) {
    await runCommand("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      tag,
      UBLOCK_GIT_URL,
      AUTO_UBLOCK_DIR,
    ]);
  }

  const sha = await runCommand(
    "git",
    ["-C", AUTO_UBLOCK_DIR, "rev-parse", "HEAD"],
    { capture: true }
  );
  return sha.trim();
}

/**
 * Build Waterfox scriptlet resources from uBO built-in scriptlets.
 *
 * uBO now publishes scriptlets as ESM modules with dependency graphs, while
 * adblock-rs's resource assembler is deprecated and does not handle that shape.
 * This follows Brave's bundling path so adblock-rs still receives base64-encoded
 * `Resource` entries with the expected argument placeholders.
 *
 * https://github.com/brave/brave-core-crx-packager/pull/599
 *
 * @param {BuiltinScriptlet[]} scriptlets
 * @returns {{
 *   aliases: string[],
 *   content: string,
 *   kind: { mime: string },
 *   name: string
 * }[]}
 */
function buildScriptletResources(scriptlets) {
  /** @type {Record<string, BuiltinScriptlet>} */
  const dependencyMap = scriptlets.reduce((map, entry) => {
    map[entry.name] = entry;
    return map;
  }, Object.create(null));

  return scriptlets
    .filter(scriptlet => !scriptlet.name.endsWith(".fn"))
    .map(scriptlet => {
      if (typeof scriptlet.fn !== "function") {
        console.warn(
          `[update-bundled-assets] Scriptlet has no callable fn: ${scriptlet.name}`
        );
        return null;
      }

      let dependencyPrelude = "";
      const requiredDependencies = [...(scriptlet.dependencies ?? [])];

      for (const depName of requiredDependencies) {
        for (const recursiveDepName of dependencyMap[depName]?.dependencies ??
          []) {
          if (!requiredDependencies.includes(recursiveDepName)) {
            requiredDependencies.push(recursiveDepName);
          }
        }
      }

      for (const depName of requiredDependencies.reverse()) {
        const depCode = dependencyMap[depName]?.fn?.toString();
        if (!depCode) {
          throw new Error(
            `uBO scriptlet "${scriptlet.name}" is missing dependency "${depName}"`
          );
        }
        dependencyPrelude += `${depCode}\n`;
      }

      const wrapped = wrapScriptletArgFormat(
        scriptlet.fn.toString(),
        dependencyPrelude
      );
      const content = Buffer.from(wrapped, "utf8").toString("base64");

      return {
        aliases: scriptlet.aliases ?? [],
        content,
        kind: { mime: "application/javascript" },
        name: scriptlet.name,
      };
    })
    .filter(Boolean);
}

/**
 * Build adblock-rs redirect resources from uBO web-accessible resources.
 *
 * @param {string} uBlockRoot
 * @returns {Promise<{
 *   aliases: string[],
 *   content: string,
 *   kind: { mime: string },
 *   name: string
 * }[]>}
 */
async function buildUblockRedirectResources(uBlockRoot) {
  const webAccessibleResourcesDir = path.join(
    uBlockRoot,
    "src",
    "web_accessible_resources"
  );
  const redirectResourcesPath = path.join(
    uBlockRoot,
    "src",
    "js",
    "redirect-resources.js"
  );

  await assertExists(
    webAccessibleResourcesDir,
    "uBlock web-accessible resources directory"
  );
  await assertExists(redirectResourcesPath, "uBlock redirect-resource mapping");

  const moduleUrl = pathToFileURL(redirectResourcesPath).href;
  // The module comes from a local uBlock Origin checkout managed by this script.
  // eslint-disable-next-line no-unsanitized/method
  const { default: redirectResources } = await import(moduleUrl);

  if (!(redirectResources instanceof Map)) {
    throw new Error("uBlock redirect-resource module did not export a Map");
  }

  const resources = [];
  let skippedParameterizedResources = 0;
  for (const [name, properties] of redirectResources) {
    if (typeof name !== "string") {
      throw new Error(
        "uBlock redirect-resource mapping contains a non-string name"
      );
    }

    /** @type {RedirectResourceProperties} */
    const details = properties ?? {};
    if (Array.isArray(details.params) && details.params.length) {
      skippedParameterizedResources += 1;
      continue;
    }

    const resourcePath = path.join(webAccessibleResourcesDir, name);
    await assertExists(resourcePath, `uBlock redirect resource "${name}"`);

    resources.push({
      aliases: redirectResourceAliases(details.alias),
      content: (await fs.readFile(resourcePath)).toString("base64"),
      kind: { mime: redirectResourceMime(name) },
      name,
    });
  }

  if (resources.length === 0) {
    throw new Error("uBO redirect resource generation produced 0 entries");
  }

  if (skippedParameterizedResources) {
    console.warn(
      `[update-bundled-assets] Skipped ${skippedParameterizedResources} parameterized redirect resource(s)`
    );
  }

  assertUniqueResourceIdentifiers(resources);
  return resources;
}

/**
 * Update the bundled filter list files that are enabled by default.
 *
 * @returns {Promise<void>}
 */
async function updateDefaultFilters() {
  console.log("→ Updating the bundled filter lists enabled by default from:");
  console.log(`    ${CATALOG_PATH}`);

  const sources = await readDefaultEnabledSources(CATALOG_PATH);
  await mapWithConcurrency(sources, FILTER_DOWNLOAD_CONCURRENCY, source =>
    downloadToFile(source.url, path.join(FILTERS_DIR, source.filename))
  );

  console.log(
    `Downloaded ${sources.length} filter list file(s) enabled by default.`
  );
}

/**
 * Update supplementary redirect resources.
 *
 * @param {string} uBlockRoot
 * @returns {Promise<void>}
 */
async function updateSupplementaryResources(uBlockRoot) {
  console.log();
  console.log("→ Updating supplementary resources.json...");

  const braveResourcesPath = `${SUPPLEMENTARY_OUTPUT_PATH}.brave.tmp`;
  try {
    await downloadToFile(SUPPLEMENTARY_RESOURCE_URL, braveResourcesPath);
    const braveResources = JSON.parse(
      await fs.readFile(braveResourcesPath, "utf8")
    );
    if (!Array.isArray(braveResources)) {
      throw new Error("Brave supplementary resources are not an array");
    }

    const uBlockRedirectResources =
      await buildUblockRedirectResources(uBlockRoot);
    const resources = [...braveResources, ...uBlockRedirectResources];
    assertUniqueResourceIdentifiers(resources);

    await fs.mkdir(path.dirname(SUPPLEMENTARY_OUTPUT_PATH), {
      recursive: true,
    });
    await fs.writeFile(
      SUPPLEMENTARY_OUTPUT_PATH,
      `${JSON.stringify(resources, null, 2)}\n`
    );
    console.log(
      `  - ${SUPPLEMENTARY_OUTPUT_PATH}: ${await fileStatsLine(SUPPLEMENTARY_OUTPUT_PATH)}`
    );

    console.log(
      `Generated ${resources.length} supplementary and redirect resources to ${SUPPLEMENTARY_OUTPUT_PATH}`
    );
  } finally {
    await fs.rm(braveResourcesPath, { force: true }).catch(() => {
      // Cleanup after a failed download is not critical, so ignore errors.
    });
  }
}

/**
 * Update bundled uBO scriptlet resources.
 *
 * @param {string} uBlockRoot
 * @returns {Promise<void>}
 */
async function updateScriptletResources(uBlockRoot) {
  const uBlockScriptletsPath = path.join(
    uBlockRoot,
    "src",
    "js",
    "resources",
    "scriptlets.js"
  );

  await assertExists(uBlockScriptletsPath, "uBlock scriptlets module");

  const moduleUrl = pathToFileURL(uBlockScriptletsPath).href;
  // The module comes from a local uBlock Origin checkout managed by this
  // script; it never runs inside the browser.
  // eslint-disable-next-line no-unsanitized/method
  const { builtinScriptlets: scriptlets } = await import(moduleUrl);

  if (!Array.isArray(scriptlets)) {
    throw new Error(
      "uBlock scriptlets module did not export builtinScriptlets"
    );
  }

  const resources = buildScriptletResources(scriptlets);
  if (resources.length === 0) {
    throw new Error("uBO scriptlet resource generation produced 0 entries");
  }

  await fs.mkdir(path.dirname(UBO_SCRIPTLET_OUTPUT_PATH), { recursive: true });
  await fs.writeFile(
    UBO_SCRIPTLET_OUTPUT_PATH,
    `${JSON.stringify(resources, null, 2)}\n`
  );

  console.log(
    `Generated ${resources.length} scriptlet resources to ${UBO_SCRIPTLET_OUTPUT_PATH}`
  );
}

/**
 * Entry point.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const resourcesOnly = process.argv.includes(RESOURCES_ONLY_ARG);

  await assertExists(CATALOG_PATH, "catalog");

  await fs.mkdir(FILTERS_DIR, { recursive: true });
  await fs.mkdir(RESOURCES_DIR, { recursive: true });

  const uBlockTag = await resolveLatestUblockTag();
  const uBlockSha = await ensureUblockCheckout(uBlockTag);
  console.log(
    `→ Using uBlock ${uBlockTag} (${uBlockSha}) at ${AUTO_UBLOCK_DIR}`
  );

  if (!resourcesOnly) {
    await updateDefaultFilters();
  }

  await updateSupplementaryResources(AUTO_UBLOCK_DIR);

  if (!resourcesOnly) {
    console.log();
    console.log("→ Updating bundled uBO scriptlet resources...");
    await updateScriptletResources(AUTO_UBLOCK_DIR);
  }

  console.log();
  console.log("→ Done");
  console.log("Bundled assets are updated under:");
  console.log(`  ${FILTERS_DIR}`);
  console.log(`  ${RESOURCES_DIR}`);
  console.log();
  console.log("Tip: review changes with:");
  console.log(`  git status -- ${FILTERS_DIR} ${RESOURCES_DIR}`);
}

main().catch(error => {
  console.error(`error: ${toErrorMessage(error)}`);
  process.exit(1);
});
