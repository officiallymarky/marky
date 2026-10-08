// Temporary dependency-advisory exception policy evaluator.
//
// Consumes an osv-scanner 2.6.0 VulnerabilityResults JSON report, a CycloneDX
// 1.6 SBOM, and the approved dependency policy, and splits every vulnerability
// record into an accepted or blocked finding. Fails closed: malformed input,
// missing scan coverage, license violations, deprecated-package findings,
// experimental generic findings, and groups referencing omitted vulnerability
// records all throw instead of producing a clean result.
import path from 'node:path';

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BLOCKED_REASON = 'No approved dependency exception covers this finding.';
const POLICY_FIELDS = 'approvedAt, ecosystem, expiresAt, id, name, reason, source, tracking, version';

function fail(message) {
  throw new Error(`dependency-policy: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array of strings`);
  for (const [index, item] of value.entries()) {
    requireString(item, `${label}[${index}]`);
  }
  return value;
}

function parseEpoch(value, label) {
  requireString(value, label);
  const epoch = Date.parse(value);
  if (!ISO_UTC_PATTERN.test(value) || Number.isNaN(epoch) || new Date(epoch).toISOString() !== value) {
    fail(`${label} must be a canonical ISO UTC timestamp such as 2026-10-07T00:00:00.000Z`);
  }
  return epoch;
}

function parseNameVersion(value, label) {
  requireString(value, label);
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) {
    fail(`${label} must look like name@version`);
  }
  return { name: value.slice(0, at), version: value.slice(at + 1) };
}

function validateExceptionSource(value, label) {
  requireObject(value, label);
  if (value.type === 'lockfile') {
    if (Object.keys(value).length !== 2 || !('path' in value)) {
      fail(`${label} lockfile source must contain exactly type and path`);
    }
    return { type: 'lockfile', path: requireString(value.path, `${label}.path`) };
  }
  if (value.type === 'sbom') {
    if (Object.keys(value).length !== 2 || !('embeddedIn' in value)) {
      fail(`${label} sbom source must contain exactly type and embeddedIn`);
    }
    const embeddedIn = requireString(value.embeddedIn, `${label}.embeddedIn`);
    return { type: 'sbom', embeddedIn, root: parseNameVersion(embeddedIn, `${label}.embeddedIn`) };
  }
  fail(`${label}.type must be 'lockfile' or 'sbom'`);
}

function validatePolicy(policy, root) {
  requireObject(policy, 'policy');
  if (policy.version !== 1) fail('policy.version must be exactly 1');
  if (!Array.isArray(policy.exceptions)) fail('policy.exceptions must be an array');

  const seenExceptions = new Set();
  return policy.exceptions.map((raw, index) => {
    const label = `policy.exceptions[${index}]`;
    requireObject(raw, label);
    const keys = Object.keys(raw).sort().join(', ');
    if (keys !== POLICY_FIELDS) {
      fail(`${label} must contain exactly the fields ${POLICY_FIELDS}`);
    }
    const id = requireString(raw.id, `${label}.id`);
    const name = requireString(raw.name, `${label}.name`);
    const version = requireString(raw.version, `${label}.version`);
    const ecosystem = requireString(raw.ecosystem, `${label}.ecosystem`);
    const reason = requireString(raw.reason, `${label}.reason`);
    const tracking = requireString(raw.tracking, `${label}.tracking`);
    const approvedAtMs = parseEpoch(raw.approvedAt, `${label}.approvedAt`);
    const expiresAtMs = parseEpoch(raw.expiresAt, `${label}.expiresAt`);
    if (approvedAtMs >= expiresAtMs) {
      fail(`${label}.approvedAt must be earlier than ${label}.expiresAt`);
    }
    const source = validateExceptionSource(raw.source, `${label}.source`);
    const scope =
      source.type === 'lockfile'
        ? `lockfile:${path.resolve(root, source.path)}`
        : `sbom:${source.embeddedIn}`;
    const identity = JSON.stringify([id, name, version, ecosystem, scope]);
    if (seenExceptions.has(identity)) fail(`duplicate exception ${id} for ${name}@${version} in ${scope}`);
    seenExceptions.add(identity);
    return {
      id,
      name,
      version,
      ecosystem,
      reason,
      tracking,
      source,
      approvedAtMs,
      expiresAtMs,
      expiresAt: raw.expiresAt,
      resolvedSourcePath: source.type === 'lockfile' ? path.resolve(root, source.path) : null,
    };
  });
}

function validateOptions(options) {
  requireObject(options, 'options');
  for (const key of Object.keys(options)) {
    if (key !== 'root' && key !== 'sbomPath' && key !== 'now') {
      fail(`options.${key} is not a recognized option`);
    }
  }
  const root = requireString(options.root, 'options.root');
  const sbomPath = requireString(options.sbomPath, 'options.sbomPath');
  let now = options.now === undefined ? new Date() : options.now;
  if (now instanceof Date) {
    if (Number.isNaN(now.getTime())) fail('options.now must be a valid Date');
  } else {
    now = new Date(parseEpoch(now, 'options.now'));
  }
  return { root, sbomPath, nowMs: now.getTime() };
}

function validatePackageEntry(entry, label) {
  requireObject(entry, label);
  const pkg = requireObject(entry.package, `${label}.package`);
  const name = requireString(pkg.name, `${label}.package.name`);
  const version = requireString(pkg.version, `${label}.package.version`);
  const ecosystem = requireString(pkg.ecosystem, `${label}.package.ecosystem`);
  if (pkg.deprecated) {
    fail(`${label} contains a deprecated-package finding for ${name}@${version}; it must be triaged, not silently discarded`);
  }
  const violations = entry.license_violations;
  if (violations != null) {
    if (!Array.isArray(violations)) fail(`${label}.license_violations must be an array`);
    if (violations.length > 0) {
      fail(`${label} contains license violations for ${name}@${version}; they must be triaged, not silently discarded`);
    }
  }

  const vulns = [];
  const knownIds = new Set();
  const rawVulns = entry.vulnerabilities;
  if (rawVulns !== undefined) {
    if (!Array.isArray(rawVulns)) fail(`${label}.vulnerabilities must be an array`);
    rawVulns.forEach((vuln, vi) => {
      const vulnLabel = `${label}.vulnerabilities[${vi}]`;
      requireObject(vuln, vulnLabel);
      const id = requireString(vuln.id, `${vulnLabel}.id`);
      const aliases = vuln.aliases == null ? [] : stringArray(vuln.aliases, `${vulnLabel}.aliases`);
      knownIds.add(id);
      for (const alias of aliases) knownIds.add(alias);
      vulns.push({ id, aliases });
    });
  }

  const rawGroups = entry.groups;
  if (rawGroups != null) {
    if (!Array.isArray(rawGroups)) fail(`${label}.groups must be an array`);
    rawGroups.forEach((group, gi) => {
      const groupLabel = `${label}.groups[${gi}]`;
      requireObject(group, groupLabel);
      const ids = stringArray(group.ids, `${groupLabel}.ids`);
      const aliases = group.aliases == null ? [] : stringArray(group.aliases, `${groupLabel}.aliases`);
      for (const ref of [...ids, ...aliases]) {
        if (!knownIds.has(ref)) {
          fail(`${groupLabel} references ${ref}, which has no matching vulnerability record in ${name}@${version}`);
        }
      }
    });
  }

  return { name, version, ecosystem, vulns };
}

function validateReport(report, root) {
  requireObject(report, 'report');
  const generic = report.experimental_generic_findings;
  if (generic != null) {
    if (!Array.isArray(generic)) fail('report.experimental_generic_findings must be an array');
    if (generic.length > 0) {
      fail('report contains experimental_generic_findings; they must be triaged, not silently discarded');
    }
  }
  if (!Array.isArray(report.results)) fail('report.results must be an array');
  return report.results.map((result, ri) => {
    requireObject(result, `report.results[${ri}]`);
    const source = requireObject(result.source, `report.results[${ri}].source`);
    const sourcePath = requireString(source.path, `report.results[${ri}].source.path`);
    const sourceType = requireString(source.type, `report.results[${ri}].source.type`);
    if (!Array.isArray(result.packages)) fail(`report.results[${ri}].packages must be an array`);
    const packages = result.packages.map((entry, pi) =>
      validatePackageEntry(entry, `report.results[${ri}].packages[${pi}]`),
    );
    return {
      path: sourcePath,
      type: sourceType,
      resolved: path.resolve(root, sourcePath),
      packages,
    };
  });
}

function requireProperty(value, label) {
  requireObject(value, label);
  return {
    name: requireString(value.name, `${label}.name`),
    value: requireString(value.value, `${label}.value`),
  };
}

function validateSbom(sbom) {
  requireObject(sbom, 'sbom');
  if (sbom.bomFormat !== 'CycloneDX') fail('sbom.bomFormat must be CycloneDX');
  if (sbom.specVersion !== '1.6') fail('sbom.specVersion must be 1.6');

  const metadata = requireObject(sbom.metadata, 'sbom.metadata');
  const application = requireObject(metadata.component, 'sbom.metadata.component');
  requireString(application.name, 'sbom.metadata.component.name');
  requireString(application.version, 'sbom.metadata.component.version');
  if (!Array.isArray(metadata.properties)) fail('sbom.metadata.properties must be an array');
  let targetValue = null;
  for (const [index, property] of metadata.properties.entries()) {
    const parsed = requireProperty(property, `sbom.metadata.properties[${index}]`);
    if (parsed.name === 'marky:sbom:target:mermaid') {
      if (targetValue != null) fail('sbom.metadata has duplicate marky:sbom:target:mermaid properties');
      targetValue = parsed.value;
    }
  }

  const components = new Map();
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) fail('sbom.components must be a non-empty array');
  for (const [index, raw] of sbom.components.entries()) {
    requireObject(raw, `sbom.components[${index}]`);
    const name = requireString(raw.name, `sbom.components[${index}].name`);
    const version = requireString(raw.version, `sbom.components[${index}].version`);
    const key = `${name}@${version}`;
    if (components.has(key)) fail(`sbom contains conflicting duplicate component ${key}`);
    const embeddedIn = [];
    if (raw.properties != null) {
      if (!Array.isArray(raw.properties)) fail(`sbom.components[${index}].properties must be an array`);
      for (const [propertyIndex, property] of raw.properties.entries()) {
        const parsed = requireProperty(property, `sbom.components[${index}].properties[${propertyIndex}]`);
        if (parsed.name === 'marky:embedded-in') embeddedIn.push(parsed.value);
      }
    }
    components.set(key, embeddedIn);
  }
  return { targetValue, components };
}

function requireCoverage(sources, root, sbomPath) {
  const expected = [
    { path: path.resolve(root, 'src-tauri/Cargo.lock'), type: 'lockfile', label: 'src-tauri/Cargo.lock' },
    { path: path.resolve(root, 'pnpm-lock.yaml'), type: 'lockfile', label: 'pnpm-lock.yaml' },
    { path: path.resolve(root, sbomPath), type: 'sbom', label: sbomPath },
  ];
  const missing = [];
  for (const want of expected) {
    const covered = sources.some(
      (source) => source.resolved === want.path && source.type === want.type && source.packages.length > 0,
    );
    if (!covered) missing.push(`${want.type}:${want.label}`);
  }
  if (missing.length > 0) {
    fail(`scan report is missing required package coverage for: ${missing.join(', ')}`);
  }
}

function sbomExceptionApplies(exception, pkg, sbom) {
  const root = exception.source.root;
  const rootKey = `${root.name}@${root.version}`;
  const rootEmbeddedIn = sbom.components.get(rootKey);
  if (!rootEmbeddedIn?.length || !rootEmbeddedIn.every((value) => value === rootKey)) return false;
  if (sbom.targetValue === null || !sbom.targetValue.startsWith(`${rootKey}:`)) return false;
  const embeddedIn = sbom.components.get(`${pkg.name}@${pkg.version}`);
  if (embeddedIn === undefined || embeddedIn.length === 0) return false;
  return embeddedIn.every((value) => value === rootKey);
}

function findException(exceptions, vuln, pkg, source, nowMs, resolvedSbomPath, sbom) {
  for (const exception of exceptions) {
    if (nowMs < exception.approvedAtMs || nowMs >= exception.expiresAtMs) continue;
    if (
      exception.name !== pkg.name ||
      exception.version !== pkg.version ||
      exception.ecosystem !== pkg.ecosystem
    ) {
      continue;
    }
    if (vuln.id !== exception.id && !vuln.aliases.includes(exception.id)) continue;
    if (exception.source.type === 'lockfile') {
      if (source.type === 'lockfile' && source.resolved === exception.resolvedSourcePath) return exception;
      continue;
    }
    if (source.type === 'sbom' && source.resolved === resolvedSbomPath && sbomExceptionApplies(exception, pkg, sbom)) {
      return exception;
    }
  }
  return null;
}

/**
 * Split an osv-scanner report into accepted and blocked findings according to
 * the approved dependency policy.
 *
 * @param {object} report osv-scanner 2.6.0 VulnerabilityResults JSON.
 * @param {object} sbom CycloneDX 1.6 SBOM for the bundled frontend assets.
 * @param {object} policy { version: 1, exceptions: [...] }.
 * @param {object} options { root, sbomPath, now? }.
 * @returns {{ accepted: object[], blocked: object[] }}
 */
export function evaluateDependencyReport(report, sbom, policy, options) {
  const { root, sbomPath, nowMs } = validateOptions(options);
  const exceptions = validatePolicy(policy, root);
  const sources = validateReport(report, root);
  const sbomContext = validateSbom(sbom);
  requireCoverage(sources, root, sbomPath);

  const resolvedSbomPath = path.resolve(root, sbomPath);
  const accepted = [];
  const acceptedKeys = new Set();
  const blocked = [];
  for (const source of sources) {
    for (const pkg of source.packages) {
      for (const vuln of pkg.vulns) {
        const exception = findException(exceptions, vuln, pkg, source, nowMs, resolvedSbomPath, sbomContext);
        const findingSource = { path: source.path, type: source.type };
        if (exception !== null) {
          const key = [exception.id, pkg.name, pkg.version, pkg.ecosystem, source.resolved, source.type].join('\u0000');
          if (!acceptedKeys.has(key)) {
            acceptedKeys.add(key);
            accepted.push({
              id: exception.id,
              name: pkg.name,
              version: pkg.version,
              ecosystem: pkg.ecosystem,
              source: findingSource,
              reason: exception.reason,
              expiresAt: exception.expiresAt,
              tracking: exception.tracking,
            });
          }
        } else {
          blocked.push({
            id: vuln.id,
            name: pkg.name,
            version: pkg.version,
            ecosystem: pkg.ecosystem,
            source: findingSource,
            reason: BLOCKED_REASON,
          });
        }
      }
    }
  }
  return { accepted, blocked };
}
