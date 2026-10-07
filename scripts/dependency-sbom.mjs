#!/usr/bin/env node
// Emit a CycloneDX SBOM for npm dependencies that mermaid and
// @mermaid-js/parser bundle into their shipped production ES module chunks.
//
// Those bundles carry pnpm store provenance (".pnpm/name@version/node_modules/"
// paths) in module comments and, for chunks stripped of comments, in the
// sibling source map "sources" entries. Bundled packages like these never
// appear in pnpm-lock.yaml, so lockfile scanners cannot see them; this script
// makes them visible.
//
// Scope, deliberately narrow and disclosed in the SBOM properties:
// - only the shipped dist ESM chunks of the two target packages are scanned;
// - only dependencies whose provenance is embedded in those chunks are
//   inventoried - a target without extractable provenance is a hard failure,
//   unknown bundled code is never presented as clean;
// - no source bodies or secrets are emitted, only package names and versions.
//
// Run with: node scripts/dependency-sbom.mjs <output.json>
// The output belongs in a temporary file (see the just dependency-security
// recipe); it must never be committed.

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const projectRequire = createRequire(join(root, "package.json"));

// pnpm store directory keys look like "name@1.2.3", "name@1.2.3_peer@2.0.0",
// or "name@1.2.3_patch_hash=...". Scoped names are stored with "+" for "/".
const PNPM_PATH = /node_modules\/\.pnpm\/([^/"\s\\]+)\/node_modules\/[^/"\s\\]+/g;


function parseStoreKey(key) {
  const at = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
  if (at <= 0) return null;
  const name = key.slice(0, at).replaceAll("+", "/");
  const version = key.slice(at + 1).split(/[_()]/)[0];
  return name && version ? { name, version } : null;
}

function storeKeysIn(text) {
  return [...text.matchAll(PNPM_PATH)].map((match) => match[1]);
}

function die(message) {
  console.error(`dependency-sbom: ${message}`);
  process.exit(1);
}

// Resolve a package through Node resolution (never fixed version directories)
// and return its manifest and package directory. `require.resolve` honors the
// exports map when its conditions allow it (mermaid); otherwise fall back to
// Node's own node_modules ancestor walk, which is how Node itself searches
// when no export condition matches (@mermaid-js/parser only publishes an
// "import" condition and is a dependency of mermaid rather than the app, so
// pnpm does not hoist it to the project root).
function resolvePackage(name, require, fromDir = root) {
  let entry;
  if (require) {
    try {
      entry = require.resolve(name);
    } catch {
      entry = undefined;
    }
  }
  let dir = entry ? dirname(entry) : fromDir;
  if (!entry) {
    for (;;) {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) {
        dir = candidate;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) die(`cannot resolve ${name} from ${fromDir}`);
      dir = parent;
    }
  } else {
    dir = dirname(entry);
    for (;;) {
      try {
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        break;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) die(`no package.json found above the resolved entry of ${name}`);
        dir = parent;
      }
    }
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch (error) {
    die(`cannot read the package.json of ${name}: ${error.message}`);
  }
  if (manifest.name !== name || typeof manifest.version !== "string") {
    die(`invalid package identity for ${name} at ${dir}`);
  }
  return { name, dir, manifest };
}

// The package's ES module entry point from its manifest, whose directory
// anchors the dist tree of shipped chunks we scan.
function esmEntryDir({ name, dir, manifest }) {
  let exp = manifest.exports;
  if (exp && typeof exp === "object" && !Array.isArray(exp) && exp["."] !== undefined) exp = exp["."];
  if (typeof exp === "string") exp = { default: exp };
  const target = exp?.import ?? exp?.default ?? manifest.module ?? manifest.main;
  if (typeof target !== "string") die(`cannot determine the ES module entry of ${name}`);
  return dirname(join(dir, target));
}

// Every shipped production ES module chunk under the package's dist directory.
function collectChunks(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectChunks(path, out);
    else if (entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

// Extract provenance for one target package: comments are the primary source;
// only for chunks without any comment provenance do we fall back to the
// sibling source map's "sources" entries (the maps are large and carry full
// source bodies, so they are parsed only when the comments are not adequate).
function extractProvenance(target) {
  const chunks = collectChunks(target.entry);
  if (chunks.length === 0) die(`no shipped .mjs chunks found under ${target.entry}`);
  const found = new Map();
  const add = (key) => {
    const parsed = parseStoreKey(key);
    if (parsed) found.set(`${parsed.name}@${parsed.version}`, parsed);
  };
  let viaComments = 0;
  let viaMaps = 0;
  const silent = [];
  for (const chunk of chunks) {
    const keys = storeKeysIn(readFileSync(chunk, "utf8"));
    if (keys.length > 0) {
      viaComments++;
      keys.forEach(add);
      continue;
    }
    const map = `${chunk}.map`;
    let sources = [];
    if (existsSync(map)) {
      try {
        sources = JSON.parse(readFileSync(map, "utf8")).sources ?? [];
      } catch (error) {
        die(`cannot read source map ${map}: ${error.message}`);
      }
    }
    const mapKeys = storeKeysIn(sources.join("\n"));
    if (mapKeys.length > 0) {
      viaMaps++;
      mapKeys.forEach(add);
    } else {
      silent.push(relative(target.entry, chunk));
    }
  }
  if (found.size === 0) {
    die(
      `no bundled provenance could be extracted from ${target.name} chunks ` +
        `(${chunks.length} scanned); refusing to present unknown bundled code as clean`,
    );
  }
  return { target, chunks: chunks.length, viaComments, viaMaps, silent, found };
}

const output = process.argv[2];
if (!output) die("usage: node scripts/dependency-sbom.mjs <output.json>");

const mermaid = resolvePackage("mermaid", projectRequire);
// @mermaid-js/parser is a dependency of mermaid, not of the app, so pnpm does
// not hoist it to the project root; resolve it from mermaid's own location.
const parser = resolvePackage("@mermaid-js/parser", undefined, mermaid.dir);

const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const results = [mermaid, parser].map((target) => extractProvenance({ ...target, entry: esmEntryDir(target) }));
const components = new Map();
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    component: { type: "application", name: app.name, version: app.version },
    properties: [
      {
        name: "marky:sbom:scope",
        value:
          "Embedded npm dependencies of mermaid and @mermaid-js/parser only, " +
          "extracted from their shipped production ES module chunks. This is " +
          "not a full application SBOM; lockfile-declared dependencies are " +
          "covered by pnpm audit and OSV-Scanner instead.",
      },
      {
        name: "marky:sbom:extraction",
        value:
          "pnpm store provenance from module comments in the shipped dist " +
          "chunks, falling back to sibling source map sources entries for " +
          "chunks without comments. Bundled packages are invisible to " +
          "pnpm-lock.yaml by construction.",
      },
      {
        name: "marky:sbom:limitation",
        value:
          "Chunks without extractable provenance are not inventoried and are " +
          "not counted as clean; the dependency-security recipe fails if a " +
          "target yields no provenance at all.",
      },
    ],
  },
  components: [],
};

for (const { target, chunks, viaComments, viaMaps, silent, found } of results) {
  const targetVersion = `${target.name}@${target.manifest.version}`;
  bom.metadata.properties.push({
    name: `marky:sbom:target:${target.name}`,
    value:
      `${targetVersion}: ${chunks} chunks scanned, ${viaComments} via comments, ` +
      `${viaMaps} via sourcemap sources, ${silent.length} without provenance`,
  });
  components.set(`${target.name}@${target.manifest.version}`, {
    type: "library",
    name: target.name,
    version: target.manifest.version,
    purl: `pkg:npm/${target.name.startsWith("@") ? `%40${target.name.slice(1)}` : target.name}@${target.manifest.version}`,
    properties: [{ name: "marky:embedded-in", value: targetVersion }],
  });
  for (const { name, version } of found.values()) {
    components.set(`${name}@${version}`, {
      type: "library",
      name,
      version,
      purl: `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`,
      properties: [{ name: "marky:embedded-in", value: targetVersion }],
    });
  }
}

bom.components = [...components.values()].sort((a, b) => (a.purl < b.purl ? -1 : 1));
writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`);

for (const { target, chunks, viaComments, viaMaps, silent, found } of results) {
  console.log(
    `${target.name}@${target.manifest.version}: ${chunks} chunks scanned ` +
      `(${viaComments} via comments, ${viaMaps} via sourcemaps, ${silent.length} without provenance), ` +
      `${found.size} bundled packages inventoried`,
  );
}
console.log(`CycloneDX SBOM with ${bom.components.length} components written to ${output}`);
