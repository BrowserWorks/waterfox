#!/usr/bin/env bun
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");

if (typeof Bun === "undefined") {
  throw new Error("This script must be run with Bun.");
}

/**
 * A default-enabled filter source resolved from `list_catalog.json`.
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

const AUTO_UBLOCK_DIR = path.join(os.tmpdir(), "waterfox-blocker-ublock");
const UBLOCK_GIT_URL = "https://github.com/gorhill/uBlock.git";
const DOWNLOAD_TIMEOUT_MS = 90_000;

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
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ensure command exists on PATH.
 *
 * @param {string} command
 */
function requireCommand(command) {
  if (!Bun.which(command)) {
    throw new Error(`required command not found: ${command}`);
  }
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
 * Run command with inherited stdio.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {Promise<void>}
 */
async function runCommand(command, args, cwd = process.cwd()) {
  let proc;
  try {
    proc = Bun.spawn([command, ...args], {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    throw new Error(`failed to start "${command}": ${toErrorMessage(error)}`);
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${exitCode}`
    );
  }
}

/**
 * Count newline bytes (same behavior as `wc -l`).
 *
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function countNewlines(filePath) {
  const text = await Bun.file(filePath).text();
  let lines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
    }
  }
  return lines;
}

/**
 * Print file stats.
 *
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function printFileStats(filePath) {
  const file = Bun.file(filePath);
  const lines = await countNewlines(filePath);
  console.log(`  - ${filePath}: ${file.size} bytes, ${lines} lines`);
}

/**
 * Download URL to destination atomically.
 *
 * @param {string} url
 * @param {string} destinationPath
 * @returns {Promise<void>}
 */
async function downloadToFile(url, destinationPath) {
  const tempPath = `${destinationPath}.tmp.${process.pid}.${Date.now()}`;

  console.log("Downloading:");
  console.log(`  ${url}`);
  console.log(`  -> ${destinationPath}`);

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    await Bun.write(tempPath, response);

    if (Bun.file(tempPath).size === 0) {
      throw new Error(`downloaded file is empty: ${url}`);
    }

    await fs.rename(tempPath, destinationPath);
    await printFileStats(destinationPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {
      // Temporary cleanup is best-effort after a failed download.
    });
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `timed out after ${DOWNLOAD_TIMEOUT_MS} ms`
        : toErrorMessage(error);
    throw new Error(`failed to download: ${url} (${reason})`);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Read deduplicated default-enabled source URLs from catalog.
 *
 * @param {string} catalogPath
 * @returns {Promise<FilterSource[]>}
 */
async function readDefaultEnabledSources(catalogPath) {
  const catalog = await Bun.file(catalogPath).json();
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
 * Clone fresh managed uBlock checkout.
 *
 * @returns {Promise<void>}
 */
async function cloneAutoUblockCheckout() {
  await fs.mkdir(path.dirname(AUTO_UBLOCK_DIR), { recursive: true });
  await runCommand("git", [
    "clone",
    "--depth",
    "1",
    UBLOCK_GIT_URL,
    AUTO_UBLOCK_DIR,
  ]);
}

/**
 * Ensure managed uBlock checkout exists and is updated.
 *
 * @returns {Promise<string>}
 */
async function ensureAutoUblockCheckout() {
  const gitDir = path.join(AUTO_UBLOCK_DIR, ".git");

  if (!(await pathExists(AUTO_UBLOCK_DIR))) {
    await cloneAutoUblockCheckout();
    return AUTO_UBLOCK_DIR;
  }

  if (!(await pathExists(gitDir))) {
    await fs.rm(AUTO_UBLOCK_DIR, { recursive: true, force: true });
    await cloneAutoUblockCheckout();
    return AUTO_UBLOCK_DIR;
  }

  try {
    await runCommand("git", ["-C", AUTO_UBLOCK_DIR, "pull", "--ff-only"]);
  } catch (error) {
    console.warn(
      "[update-bundled-assets] Failed to pull existing uBlock checkout; recloning.",
      toErrorMessage(error)
    );
    await fs.rm(AUTO_UBLOCK_DIR, { recursive: true, force: true });
    await cloneAutoUblockCheckout();
  }

  return AUTO_UBLOCK_DIR;
}

/**
 * Resolve managed uBlock root path.
 *
 * @returns {Promise<string>}
 */
async function resolveUblockPath() {
  return ensureAutoUblockCheckout();
}

/**
 * Build Waterfox scriptlet resources from uBO built-in scriptlets.
 *
 * This function intentionally replicates Brave's scriptlet bundling approach:
 * https://github.com/brave/brave-core-crx-packager/pull/599
 *
 * The problem is format drift as uBO scriptlets are now published as ESM modules
 * with cross file dependencies (for example `safeSelf` and `proxyApplyFn`),
 * while adblock-rs's resource assembler path is deprecated and does not handle
 * the current uBO module shape.
 *
 * The bundling algorithm used here is:
 * 1. `import()` the uBO scriptlets module and read the exported scriptlet list.
 * 2. Walk each scriptlet's `dependencies` graph recursively.
 * 3. Serialise dependency functions with `fn.toString()` and prepend them.
 * 4. Serialise the main scriptlet function and wrap it with the `{{1}}..{{9}}`
 *    argument placeholder template expected by our runtime path.
 * 5. Base64-encode the wrapped payload and emit an adblock-rs `Resource`.
 *
 * We keep this behaviour aligned with Brave so generated resources stay
 * compatible with adblock-rs scriptlet execution expectations.
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
          console.warn(
            `[update-bundled-assets] Missing dependency: ${depName}`
          );
          continue;
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
 * Update default-enabled bundled filter list files.
 *
 * @returns {Promise<void>}
 */
async function updateDefaultFilters() {
  console.log("→ Updating default-enabled bundled filter lists from:");
  console.log(`    ${CATALOG_PATH}`);

  const sources = await readDefaultEnabledSources(CATALOG_PATH);
  let downloadCount = 0;

  for (const source of sources) {
    await downloadToFile(source.url, path.join(FILTERS_DIR, source.filename));
    downloadCount += 1;
  }

  console.log(
    `Downloaded ${downloadCount} default-enabled filter list file(s).`
  );
}

/**
 * Update supplementary redirect resources.
 *
 * @returns {Promise<void>}
 */
async function updateSupplementaryResources() {
  console.log();
  console.log("→ Updating supplementary resources.json...");
  await downloadToFile(SUPPLEMENTARY_RESOURCE_URL, SUPPLEMENTARY_OUTPUT_PATH);
}

/**
 * Update bundled uBO scriptlet resources.
 *
 * @returns {Promise<void>}
 */
async function updateScriptletResources() {
  const uBlockRoot = await resolveUblockPath();
  const uBlockScriptletsPath = path.join(
    uBlockRoot,
    "src",
    "js",
    "resources",
    "scriptlets.js"
  );

  await assertExists(uBlockScriptletsPath, "uBlock scriptlets module");

  const moduleUrl = Bun.pathToFileURL(uBlockScriptletsPath).href;
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
  await Bun.write(
    UBO_SCRIPTLET_OUTPUT_PATH,
    `${JSON.stringify(resources, null, 2)}\n`
  );

  const outputFile = Bun.file(UBO_SCRIPTLET_OUTPUT_PATH);
  if (!(await outputFile.exists()) || outputFile.size === 0) {
    throw new Error(
      `scriptlet output was not generated: ${UBO_SCRIPTLET_OUTPUT_PATH}`
    );
  }

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
  requireCommand("git");
  requireCommand("bun");

  console.log(`→ Using managed uBlock checkout: ${AUTO_UBLOCK_DIR}`);

  await assertExists(CATALOG_PATH, "catalog");

  await fs.mkdir(FILTERS_DIR, { recursive: true });
  await fs.mkdir(RESOURCES_DIR, { recursive: true });

  await updateDefaultFilters();
  await updateSupplementaryResources();

  console.log();
  console.log("→ Updating bundled uBO scriptlet resources...");
  await updateScriptletResources();

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
