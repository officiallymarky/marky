import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { evaluateDependencyReport } from "../scripts/dependency-policy.mjs";

// Synthetic OSV/CycloneDX fixtures: three required sources, native advisory
// aliases, an unrelated finding, and a dependency embedded in Mermaid.
const ROOT = "/repo";
const CARGO = `${ROOT}/src-tauri/Cargo.lock`;
const PNPM = `${ROOT}/pnpm-lock.yaml`;
const SBOM = "/tmp/marky-dependency-sbom.json";
const OTHER_SBOM = "/tmp/other-dependency-sbom.json";
const APPROVED_AT = "2026-09-01T00:00:00.000Z";
const EXPIRES_AT = "2026-11-06T00:00:00.000Z";
const NOW = new Date("2026-10-07T12:00:00.000Z");

const GLIB_ADVISORY = "RUSTSEC-2025-0042";
const GLIB_ALIAS = "GHSA-aaaa-bbbb-cccc";
const GLIB_EXTRA = "RUSTSEC-2024-9999";
const MINIMATCH_ADVISORY = "GHSA-pppp-qqqq-rrrr";
const D3_ADVISORY = "GHSA-dddd-eeee-ffff";

function basePolicy() {
  return {
    version: 1,
    exceptions: [
      {
        id: GLIB_ADVISORY,
        name: "glib",
        version: "0.20.10",
        ecosystem: "crates.io",
        source: { type: "lockfile", path: "src-tauri/Cargo.lock" },
        approvedAt: APPROVED_AT,
        expiresAt: EXPIRES_AT,
        reason: "Upstream fix pending; risk accepted through 2026-11-06.",
        tracking: "SEC-1042",
      },
      {
        id: D3_ADVISORY,
        name: "d3",
        version: "7.8.5",
        ecosystem: "npm",
        source: { type: "sbom", embeddedIn: "mermaid@12.1.0" },
        approvedAt: APPROVED_AT,
        expiresAt: EXPIRES_AT,
        reason: "Bundled in mermaid 12.1.0 dist chunks; fixed upstream in 12.2.",
        tracking: "SEC-1043",
      },
    ],
  };
}

// Mirrors scripts/dependency-sbom.mjs: the root metadata component is the app,
// each target gets a `marky:sbom:target:<name>` property, and every inventoried
// component carries a `marky:embedded-in` property naming its target.
function baseSbom(mermaidVersion = "12.1.0") {
  const target = `mermaid@${mermaidVersion}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: { type: "application", name: "marky", version: "0.11.3" },
      properties: [{ name: "marky:sbom:target:mermaid", value: `${target}: 3 chunks scanned, 3 via comments, 0 via sourcemap sources, 0 without provenance` }],
    },
    components: [
      { type: "library", name: "mermaid", version: mermaidVersion, purl: `pkg:npm/mermaid@${mermaidVersion}`, properties: [{ name: "marky:embedded-in", value: target }] },
      { type: "library", name: "@mermaid-js/parser", version: "0.3.0", purl: "pkg:npm/%40mermaid-js/parser@0.3.0", properties: [{ name: "marky:embedded-in", value: target }] },
      { type: "library", name: "d3", version: "7.8.5", purl: "pkg:npm/d3@7.8.5", properties: [{ name: "marky:embedded-in", value: target }] },
    ],
  };
}

function affectedPackage(name, version, ecosystem, records, extra = {}) {
  return {
    package: { name, version, ecosystem },
    groups: [{ ids: records.map((record) => record.id), aliases: [], max_severity: "7.5" }],
    vulnerabilities: records,
    ...extra,
  };
}

// glib records both advisories under their canonical ids plus the alias record,
// exercising id/alias matching and deduplication in one package.
function glibPackage(records = glibRecords(), version = "0.20.10") {
  return affectedPackage("glib", version, "crates.io", records);
}

function glibRecords() {
  return [
    { id: GLIB_ADVISORY, aliases: [GLIB_ALIAS] },
    { id: GLIB_ALIAS, aliases: [GLIB_ADVISORY] },
    { id: GLIB_EXTRA, aliases: [] },
  ];
}

function baseReport() {
  return {
    results: [
      {
        source: { path: CARGO, type: "lockfile" },
        packages: [
          { package: { name: "libc", version: "0.2.155", ecosystem: "crates.io" } },
          glibPackage(),
        ],
      },
      {
        source: { path: PNPM, type: "lockfile" },
        packages: [
          { package: { name: "mermaid", version: "12.1.0", ecosystem: "npm" } },
          affectedPackage("minimatch", "3.0.4", "npm", [{ id: MINIMATCH_ADVISORY, aliases: [] }]),
        ],
      },
      {
        source: { path: SBOM, type: "sbom" },
        packages: [affectedPackage("d3", "7.8.5", "npm", [{ id: D3_ADVISORY, aliases: [] }])],
      },
    ],
  };
}

function evaluate(report, { sbom = baseSbom(), policy = basePolicy(), now = NOW, root = ROOT, sbomPath = SBOM } = {}) {
  return evaluateDependencyReport(report, sbom, policy, { root, sbomPath, now });
}

const idsOf = (findings) => findings.map((finding) => finding.id).sort();


test("accepts the approved native and bundled advisories, deduplicates aliases, and blocks everything else", () => {
  const { accepted, blocked } = evaluate(baseReport());
  assert.deepEqual(idsOf(accepted), [D3_ADVISORY, GLIB_ADVISORY]);
  assert.deepEqual(idsOf(blocked), [GLIB_EXTRA, MINIMATCH_ADVISORY].sort());
});


test("root-relative lockfile sources match the same approval as absolute ones", () => {
  const report = baseReport();
  report.results[0].source.path = "src-tauri/Cargo.lock";
  report.results[1].source.path = "pnpm-lock.yaml";

  const { accepted, blocked } = evaluate(report);

  assert.deepEqual(idsOf(accepted), [D3_ADVISORY, GLIB_ADVISORY]);
  assert.deepEqual(idsOf(blocked), [GLIB_EXTRA, MINIMATCH_ADVISORY].sort());
});

test("an extra advisory on the same approved package stays blocked", () => {
  const report = baseReport();
  report.results[0].packages[1] = glibPackage([{ id: GLIB_EXTRA, aliases: [] }]);

  const { accepted, blocked } = evaluate(report);

  assert.deepEqual(idsOf(accepted), [D3_ADVISORY]);
  assert.equal(blocked.find((finding) => finding.id === GLIB_EXTRA).version, "0.20.10");
});

test("the approved advisory blocks when the affected version changes", () => {
  const report = baseReport();
  report.results[0].packages[1] = glibPackage([{ id: GLIB_ADVISORY, aliases: [] }], "0.21.0");

  const { accepted, blocked } = evaluate(report);

  assert.deepEqual(idsOf(accepted), [D3_ADVISORY]);
  const changed = blocked.find((finding) => finding.id === GLIB_ADVISORY);
  assert.equal(changed.version, "0.21.0");
  assert.equal(resolve(changed.source.path), CARGO);
});

test("the approved advisory blocks when it appears in another lockfile", () => {
  const report = baseReport();
  report.results[1].packages.push(affectedPackage("d3", "7.8.5", "npm", [{ id: D3_ADVISORY, aliases: [] }]));

  const { accepted, blocked } = evaluate(report);

  assert.deepEqual(idsOf(accepted), [D3_ADVISORY, GLIB_ADVISORY]);
  const stray = blocked.find((finding) => finding.id === D3_ADVISORY);
  assert.equal(resolve(stray.source.path), PNPM);
  assert.equal(stray.source.type, "lockfile");
});

test("a bundled advisory in another SBOM does not inherit the approval", () => {
  const report = baseReport();
  report.results.push({
    source: { path: OTHER_SBOM, type: "sbom" },
    packages: [affectedPackage("d3", "7.8.5", "npm", [{ id: D3_ADVISORY, aliases: [] }])],
  });

  const { accepted, blocked } = evaluate(report);

  assert.deepEqual(idsOf(accepted), [D3_ADVISORY, GLIB_ADVISORY]);
  const stray = blocked.find((finding) => finding.id === D3_ADVISORY);
  assert.equal(resolve(stray.source.path), OTHER_SBOM);
});

test("a bundled advisory blocks when Mermaid changes", () => {
  const report = baseReport();

  const { accepted, blocked } = evaluate(report, { sbom: baseSbom("12.2.0") });

  assert.deepEqual(idsOf(accepted), [GLIB_ADVISORY]);
  const bundled = blocked.find((finding) => finding.id === D3_ADVISORY);
  assert.equal(resolve(bundled.source.path), SBOM);
});

test("a bundled advisory blocks when the target property disagrees with the root component", () => {
  const sbom = baseSbom();
  sbom.metadata.properties[0].value = "mermaid@12.2.0: 3 chunks scanned, 3 via comments, 0 via sourcemap sources, 0 without provenance";

  const { accepted, blocked } = evaluate(baseReport(), { sbom });

  assert.deepEqual(idsOf(accepted), [GLIB_ADVISORY]);
  assert.ok(blocked.some((finding) => finding.id === D3_ADVISORY));
});

test("a bundled advisory blocks under parser or otherwise ambiguous provenance", () => {
  const sbom = baseSbom();
  sbom.components.find((component) => component.name === "d3").properties[0].value = "@mermaid-js/parser@0.3.0";

  const { accepted, blocked } = evaluate(baseReport(), { sbom });

  assert.deepEqual(idsOf(accepted), [GLIB_ADVISORY]);
  const bundled = blocked.find((finding) => finding.id === D3_ADVISORY);
  assert.equal(resolve(bundled.source.path), SBOM);
});

test("approval remains active just before the deadline and expires at the exact instant", () => {
  const atExpiry = evaluate(baseReport(), { now: new Date(EXPIRES_AT) });
  assert.deepEqual(idsOf(atExpiry.accepted), []);
  assert.deepEqual(idsOf(atExpiry.blocked), [
    GLIB_ALIAS,
    D3_ADVISORY,
    MINIMATCH_ADVISORY,
    GLIB_EXTRA,
    GLIB_ADVISORY,
  ]);

  const beforeExpiry = evaluate(baseReport(), { now: new Date("2026-11-05T23:59:59.999Z") });
  assert.deepEqual(idsOf(beforeExpiry.accepted), [D3_ADVISORY, GLIB_ADVISORY]);
});

test("findings block before approval and are accepted at the approval instant", () => {
  const preApproval = evaluate(baseReport(), { now: new Date("2026-08-31T23:59:59.999Z") });
  assert.deepEqual(idsOf(preApproval.accepted), []);
  assert.ok(preApproval.blocked.some((finding) => finding.id === GLIB_ADVISORY));
  assert.ok(preApproval.blocked.some((finding) => finding.id === D3_ADVISORY));

  const atApproval = evaluate(baseReport(), { now: new Date(APPROVED_AT) });
  assert.deepEqual(idsOf(atApproval.accepted), [D3_ADVISORY, GLIB_ADVISORY]);
});

test("non-vulnerability findings throw instead of being silently discarded", () => {
  const generic = baseReport();
  generic.experimental_generic_findings = [{ id: "GENERIC-0001", source: { path: PNPM, type: "lockfile" } }];
  assert.throws(() => evaluate(generic), Error);

  const license = baseReport();
  license.results[0].packages[1].license_violations = ["GPL-3.0-only"];
  assert.throws(() => evaluate(license), Error);

  const deprecated = baseReport();
  deprecated.results[0].packages[1].package.deprecated = true;
  assert.throws(() => evaluate(deprecated), Error);
});

test("missing or malformed scan coverage throws instead of passing clean", () => {
  assert.throws(() => evaluate({}), Error);
  assert.throws(() => evaluate({ results: [] }), Error);
  assert.throws(() => evaluate(null), Error);

  const missingPnpm = baseReport();
  missingPnpm.results.splice(1, 1);
  assert.throws(() => evaluate(missingPnpm), Error);

  const basenameOnly = baseReport();
  basenameOnly.results[0].source.path = "Cargo.lock";
  assert.throws(() => evaluate(basenameOnly), Error);

  const emptyPackages = baseReport();
  emptyPackages.results[2].packages = [];
  assert.throws(() => evaluate(emptyPackages), Error);
});

test("groups naming missing vulnerability records throw", () => {
  const report = baseReport();
  report.results[0].packages[1].groups = [{ ids: [GLIB_ADVISORY, "RUSTSEC-0000-0000"], aliases: [], max_severity: "7.5" }];

  assert.throws(() => evaluate(report), Error);
});

test("null or malformed vulnerability records throw", () => {
  const withNull = baseReport();
  withNull.results[0].packages[1].vulnerabilities.push(null);
  assert.throws(() => evaluate(withNull), Error);

  const withoutId = baseReport();
  withoutId.results[0].packages[1].vulnerabilities = [{ aliases: [] }];
  assert.throws(() => evaluate(withoutId), Error);

  const nullContainer = baseReport();
  nullContainer.results[0].packages[0].vulnerabilities = null;
  assert.throws(() => evaluate(nullContainer), Error);
});


test("malformed policy shapes throw", () => {
  assert.throws(() => evaluate(baseReport(), { policy: { ...basePolicy(), version: 2 } }), Error);

  const missingField = basePolicy();
  delete missingField.exceptions[1].tracking;
  assert.throws(() => evaluate(baseReport(), { policy: missingField }), Error);

  const notCanonical = basePolicy();
  notCanonical.exceptions[0].approvedAt = "September 1st, 2026";
  assert.throws(() => evaluate(baseReport(), { policy: notCanonical }), Error);
});

test("duplicate policy identity and scope throw", () => {
  const policy = basePolicy();
  policy.exceptions.push({ ...policy.exceptions[0] });

  assert.throws(() => evaluate(baseReport(), { policy }), Error);
});

test("separate advisories on the same package can each have a narrow approval", () => {
  const policy = basePolicy();
  policy.exceptions.push({ ...policy.exceptions[0], id: GLIB_EXTRA });
  const { accepted, blocked } = evaluate(baseReport(), { policy });
  assert.deepEqual(idsOf(accepted), [D3_ADVISORY, GLIB_ADVISORY, GLIB_EXTRA].sort());
  assert.deepEqual(idsOf(blocked), [MINIMATCH_ADVISORY]);
});

test("invalid calendar dates cannot silently extend an approval", () => {
  const policy = basePolicy();
  policy.exceptions[0].expiresAt = "2026-11-31T00:00:00.000Z";
  assert.throws(() => evaluate(baseReport(), { policy }), Error);
});

test("malformed SBOM shapes throw", () => {
  const withoutSpecVersion = baseSbom();
  delete withoutSpecVersion.specVersion;
  assert.throws(() => evaluate(baseReport(), { sbom: withoutSpecVersion }), Error);

  const badComponents = baseSbom();
  badComponents.components = "d3";
  assert.throws(() => evaluate(baseReport(), { sbom: badComponents }), Error);
});

test("conflicting duplicate SBOM components throw", () => {
  const sbom = baseSbom();
  sbom.components.push({
    type: "library",
    name: "d3",
    version: "7.8.5",
    purl: "pkg:npm/d3@7.8.5",
    properties: [{ name: "marky:embedded-in", value: "@mermaid-js/parser@0.3.0" }],
  });

  assert.throws(() => evaluate(baseReport(), { sbom }), Error);
});
