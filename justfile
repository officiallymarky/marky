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

# Non-mutating, offline checks: tests + lint + typecheck + cargo check
verify: lint typecheck test
    cargo check --manifest-path src-tauri/Cargo.toml

# Dependency vulnerability + secret scans. Both always run even when the other
# reports findings; the recipe fails if either scan fails.
scan:
    #!/usr/bin/env bash
    set -uo pipefail
    status=0
    just dependency-security || status=1
    gitleaks dir . --redact --max-target-megabytes 1 || status=1
    exit "$status"

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
    scan_args=(scan source -r . --all-vulns --no-resolve '--no-call-analysis=rust,go')
    echo '==> bundled dependency SBOM (CycloneDX)'
    if node scripts/dependency-sbom.mjs "$sbom_dir/bom.cdx.json"; then
        scan_args+=(--lockfile "$sbom_dir/bom.cdx.json")
    else
        status=1
    fi
    echo '==> osv-scanner (lockfiles and bundled dependencies)'
    osv-scanner "${scan_args[@]}" || status=1
    exit "$status"
