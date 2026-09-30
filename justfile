set shell := ["bash", "-uc"]

default: verify

# Run the app in development mode (vite dev server + tauri window)
# NVIDIA Wayland: webkit2gtk crashes without the env workaround.
dev:
    WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm tauri dev

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

# Dependency vulnerability + secret scans
scan:
    osv-scanner scan source -r .
    gitleaks dir . --redact --max-target-megabytes 1
