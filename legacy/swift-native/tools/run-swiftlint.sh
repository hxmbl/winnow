#!/usr/bin/env bash
set -euo pipefail

# Run SwiftLint if installed. For "recommended" setup this only warns locally
# instead of failing the build. CI can opt into strict mode.
if command -v swiftlint >/dev/null 2>&1; then
  # A Homebrew SwiftLint bottle loads SourceKit from the active developer dir.
  # When only Command Line Tools is selected it can fail to find a usable
  # sourcekitd; fall back to an installed Xcode toolchain so the hook still runs.
  if [ -z "${DEVELOPER_DIR:-}" ] && [ ! -d "$(xcode-select -p 2>/dev/null)/Toolchains" ] \
     && [ -d /Applications/Xcode.app/Contents/Developer ]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  fi
  echo "Running SwiftLint..."
  # Run lint; don't treat warnings as errors here (recommended mode)
  swiftlint lint || true
else
  cat <<'MSG'
swiftlint is not installed. To enable linting:
  • Install via Homebrew: brew install swiftlint
  • Or add SwiftLint as an Xcode Package: File → Add Packages… → https://github.com/realm/SwiftLint

Once installed, re-run this script or add it as a Run Script Phase in the Xcode scheme.
MSG
fi
