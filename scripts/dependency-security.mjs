#!/usr/bin/env node
// Review the complete OSV JSON report, rather than globally ignoring advisory
// IDs: approval applies only to the recorded package version and source.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateDependencyReport } from "./dependency-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

try {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    throw new Error("usage: node scripts/dependency-security.mjs <osv.json> <bom.cdx.json> <scanner-exit-code>");
  }
  const [reportPath, sbomPath, scannerExitCode] = args;
  // OSV uses 1 for findings. All other nonzero exits are scanner failures,
  // which must never be converted into accepted-risk success.
  if (scannerExitCode !== "0" && scannerExitCode !== "1") {
    throw new Error(`OSV scanner failed with exit code ${scannerExitCode}`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
  const policy = JSON.parse(readFileSync(new URL("./dependency-exceptions.json", import.meta.url), "utf8"));
  const { accepted, blocked } = evaluateDependencyReport(report, sbom, policy, { root, sbomPath });
  if (scannerExitCode === "1" && accepted.length === 0 && blocked.length === 0) {
    throw new Error("OSV reported findings but its JSON report contains none");
  }
  for (const finding of accepted) {
    console.log(`ACCEPTED until ${finding.expiresAt}: ${finding.id} ${finding.ecosystem}:${finding.name}@${finding.version}`);
    console.log(`  ${finding.source.type}: ${JSON.stringify(finding.source.path)}`);
    console.log(`  ${finding.reason}`);
    console.log(`  Tracking: ${finding.tracking}`);
  }
  for (const finding of blocked) {
    console.error(`BLOCKED: ${finding.id} ${finding.ecosystem}:${finding.name}@${finding.version}`);
    console.error(`  ${finding.source.type}: ${JSON.stringify(finding.source.path)}`);
    console.error(`  ${finding.reason}`);
  }
  console.log(`Dependency policy: ${accepted.length} accepted findings; ${blocked.length} blocking findings`);
  process.exitCode = blocked.length > 0 ? 1 : 0;
} catch (error) {
  console.error(`dependency-security: ${error.message}`);
  process.exitCode = 1;
}
