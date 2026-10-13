set shell := ["bash", "-uc"]

default: verify

# Run the app in development mode (vite dev server + tauri window)
# Match the AppImage's X11 backend and Adwaita theme; keep the NVIDIA WebKit workaround.
dev:
    GDK_BACKEND=x11 GTK_THEME=Adwaita:dark CARGO_NET_OFFLINE=true WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm tauri dev

# Build a release bundle (deb, rpm, AppImage)
# linuxdeploy needs extract-and-run on systems without FUSE.
build:
    APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true pnpm tauri build

# Run offline behavioral tests
test:
    pnpm test
    cargo test --manifest-path src-tauri/Cargo.toml

# Lint frontend (oxlint) and Rust (clippy)
lint:
    pnpm exec oxlint src
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# Typecheck the frontend
typecheck:
    pnpm exec tsc --noEmit


# Scripted UI checks in headless Chrome (needs a Chromium build; override with
# CHROME=). Kept out of `verify`: it starts a dev server and a browser.
e2e:
    node tests/e2e/run.mjs

# Non-mutating, offline checks: tests + lint + typecheck + cargo check + secret
# scan. The scan is part of the gate so that it cannot be forgotten; a machine
# without gitleaks reports the skipped scan instead of failing the gate.
verify: lint typecheck test verify-secrets
    cargo check --manifest-path src-tauri/Cargo.toml

# Dependency vulnerability + secret scans. Both always run even when the other
# reports findings; the recipe fails if either scan fails.
scan:
    #!/usr/bin/env bash
    set -uo pipefail
    status=0
    just dependency-security || status=1
    just secret-scan || status=1
    exit "$status"

# Secret scan of the working tree. `.gitleaks.toml` excludes build output, so
# only authored files are reported; files over 1 MB are skipped, which limits
# coverage of large bundles and vendored blobs.
secret-scan:
    gitleaks dir . --redact --max-target-megabytes 1

# The gate's view of the secret scan. `secret-scan` itself stays strict: the
# pre-push hook must fail closed rather than pass when no scanner is present.
verify-secrets:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v gitleaks >/dev/null 2>&1; then
        echo "secret scan skipped: gitleaks is not installed"
        exit 0
    fi
    just secret-scan

# Installs this repository's Git hooks. Hooks are not versioned, so this is the
# setup step for a fresh clone. The pre-push hook runs `just secret-scan`: the
# secret scan is the one check that must pass before content leaves a machine.
install-hooks:
    install -Dm755 scripts/hooks/pre-push .git/hooks/pre-push

# Online advisory checks for lockfiles and identifiable dependencies embedded
# in Mermaid's shipped ESM distributions. No dependency code is executed.
dependency-security:
    #!/usr/bin/env bash
    set -euo pipefail
    status=0
    echo '==> pnpm audit (level: low)'
    pnpm audit --audit-level low || status=1
    sbom_dir="$(mktemp -d "${TMPDIR:-/tmp}/marky-sbom-XXXXXXXX")"
    trap 'rm -rf "$sbom_dir"' EXIT
    # Native ignore files must not hide findings before the scoped policy check.
    : > "$sbom_dir/osv-scanner.toml"
    scan_args=(scan source -r . --all-vulns --all-packages --no-resolve '--no-call-analysis=rust,go' --config "$sbom_dir/osv-scanner.toml" --format json --output-file "$sbom_dir/osv.json")
    echo '==> bundled dependency SBOM (CycloneDX)'
    if node scripts/dependency-sbom.mjs "$sbom_dir/bom.cdx.json"; then
        scan_args+=(--lockfile "$sbom_dir/bom.cdx.json")
    else
        status=1
    fi
    echo '==> osv-scanner (lockfiles and bundled dependencies)'
    osv_exit=0
    osv-scanner "${scan_args[@]}" || osv_exit=$?
    node scripts/dependency-security.mjs "$sbom_dir/osv.json" "$sbom_dir/bom.cdx.json" "$osv_exit" || status=1
    exit "$status"
