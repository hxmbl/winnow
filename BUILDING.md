# Building Winnow from source

Everything here is what CI and the release workflow actually run
(`.github/workflows/ci.yml`, `.github/workflows/release.yml`). If this file and a
workflow disagree, the workflow is right and this file is a bug.

There are three builds of the same program:

| Build | What it is | Where it lives |
| --- | --- | --- |
| Web | The whole app as a static site (Vite, React) | `web/` |
| Desktop | The web build inside a Tauri v2 shell: Linux and macOS | `native/src-tauri/` |
| Android | The same Tauri crate built for Android | `native/src-tauri/gen/android/` |

You only need the tools for the build you want. The web app needs Node and nothing
else.

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js | 24 (what CI and the Docker image use), with npm | everything |
| Rust | stable, via [rustup](https://rustup.rs) (CI uses `dtolnay/rust-toolchain@stable`) | desktop, Android |
| Tauri CLI | `^2` | desktop, Android |
| JDK | 17 (Temurin in CI) | Android |
| Android SDK + NDK | NDK `27.2.12479018` | Android |

There is no `.nvmrc` or `rust-toolchain` file; CI pins Node 24 and Rust stable in
the workflows. `Cargo.toml` declares `rust-version = "1.77"`, but the locked
dependencies are only built against current stable.

Install the Tauri CLI once:

```sh
cargo install tauri-cli --version "^2"
# or, faster, the prebuilt binary (what CI does):
cargo binstall tauri-cli --version "^2"
```

Check it with `cargo tauri --version`.

### Linux system packages

The desktop build links against WebKitGTK 4.1 and a few GTK libraries. CI installs
exactly this on Ubuntu:

**Debian / Ubuntu**

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential curl file libayatana-appindicator3-dev librsvg2-dev \
  libssl-dev libwebkit2gtk-4.1-dev libxdo-dev patchelf pkg-config wget
```

**Arch**

```sh
sudo pacman -S --needed \
  base-devel curl file libayatana-appindicator librsvg \
  openssl webkit2gtk-4.1 xdotool patchelf wget
```

(`pkgconf` comes with `base-devel`; `xdotool` provides `libxdo`.)

**Fedora**

```sh
sudo dnf install \
  libayatana-appindicator-gtk3-devel librsvg2-devel openssl-devel \
  webkit2gtk4.1-devel libxdo-devel patchelf pkgconf-pkg-config curl file wget
sudo dnf group install c-development
```

How the CI names map:

| CI (apt) | Arch | Fedora |
| --- | --- | --- |
| `build-essential` | `base-devel` | `c-development` group |
| `libwebkit2gtk-4.1-dev` | `webkit2gtk-4.1` | `webkit2gtk4.1-devel` |
| `libayatana-appindicator3-dev` | `libayatana-appindicator` | `libayatana-appindicator-gtk3-devel` |
| `librsvg2-dev` | `librsvg` | `librsvg2-devel` |
| `libssl-dev` | `openssl` | `openssl-devel` |
| `libxdo-dev` | `xdotool` | `libxdo-devel` |
| `patchelf` | `patchelf` | `patchelf` |
| `pkg-config` | `pkgconf` (in `base-devel`) | `pkgconf-pkg-config` |
| `curl`, `file`, `wget` | same | same |

### macOS

Xcode or the Command Line Tools (`xcode-select --install`). For the `.dmg` only:

```sh
brew install create-dmg
```

The `.app` doesn't need it. Xcode 26 or later compiles the Liquid Glass icon
(`icons/Winnow.icon`); with an older Xcode the build still works and the app uses
`icon.icns` instead (see `native/README.md`, "The macOS icon").

## Web app

From `web/`:

```sh
npm ci                 # exactly what package-lock.json says, as CI does (npm install works too)
npm run dev            # http://localhost:5173, demo mailbox, no account needed
npm run build          # typecheck (tsc -b) + production bundle in web/dist
npm run preview        # serve web/dist locally
```

Checks, the same ones CI's "Typecheck, lint and test" job runs:

```sh
npm run check          # typecheck + lint (app and proxy) + vitest
npm test               # just the unit tests (npm run test:watch to keep them running)
node scripts/check-version.mjs          # the six manifests agree on the version
node scripts/release-notes.mjs lint     # CHANGELOG.md parses
```

The smoke test drives the production build in Playwright's Chromium. Install the
browser once, then run it:

```sh
npx playwright install --with-deps chromium   # Debian/Ubuntu; elsewhere drop --with-deps
npm run smoke          # builds, then runs every smoke script (about 11 minutes)
```

CI splits the smoke run into shards (`web/scripts/smoke-shards.mjs`). One shard
locally: `node scripts/smoke-shards.mjs core` (`--list` names them all). It builds
`dist/` if there is none but doesn't rebuild a stale one, so run `npx vite build`
after changing code.

`web/dist` is a complete, deployable Winnow: put it on any static host. It has no
render proxy unless you build with `VITE_RENDER_PROXY` set (README, "The render
proxy").

## Desktop

From `web/`:

```sh
npm run tauri:dev      # runs `cargo tauri dev` in native/, with the Vite dev server
npm run tauri:build    # release bundles for this host
```

`tauri:dev` starts Vite itself (Tauri's `beforeDevCommand`), so don't run
`npm run dev` alongside it.

### What `tauri:build` makes

| Host | Bundles | Command |
| --- | --- | --- |
| Linux | `.deb` and `.AppImage` | `npm run tauri:build` |
| Linux, one kind | | `npm run tauri:build -- deb` or `-- appimage` |
| macOS | `.app` and `.dmg` | `npm run tauri:build` (needs `create-dmg`) |
| macOS, no `create-dmg` | `.app` only | `npm run tauri:build -- app` |
| macOS, universal (as released) | | `npm run tauri:build -- --target universal-apple-darwin` |

The universal build needs both Apple targets:
`rustup target add aarch64-apple-darwin x86_64-apple-darwin`.

Bundles land in `native/src-tauri/target/release/bundle/` (`deb/`, `appimage/`,
`macos/` for the `.app`, `dmg/`). With `--target <triple>` it's
`target/<triple>/release/bundle/`. The script prints the paths when it finishes.

Other flags pass through to `cargo tauri build`. A debug build without bundles, as
CI does on PRs, is run from `native/`:

```sh
cd native && cargo tauri build --debug --no-bundle
```

**Why a script and not `cargo tauri build`:** `web/scripts/bundle.mjs` picks the
bundle kinds this host can make (Tauri quietly skips one it can't), and it fails if
a requested bundle isn't actually on disk afterwards, instead of trusting the exit
code. It also checks for `create-dmg` before a `.dmg` build. The full story is in
`native/README.md`, "Why the build is a script and not `cargo tauri build`".

Local builds aren't signed for self-update (`createUpdaterArtifacts` is off), so
they need no keys. Only `release.yml` signs, with repository secrets
(`native/README.md`, "Updates").

There is no Windows desktop build: `bundle.mjs` knows Windows' bundle kinds, but
nothing builds or tests them. On Windows, run the web app.

### Rust checks

The Rust side's own gate (CI's "Rust fmt, clippy and test" job), from
`native/src-tauri`:

```sh
cargo fmt --all --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

`tauri::generate_context!` embeds `web/dist` at compile time, so build the web app
first, or stub it the way CI does:
`mkdir -p web/dist && echo '<!doctype html>' > web/dist/index.html`.

## Android

### Setup

1. **JDK 17** (Android Studio's bundled JBR works). Set `JAVA_HOME` if `java` on
   your PATH is older.
2. **Android SDK.** Android Studio's SDK Manager, or the command-line tools. You
   need `platform-tools` and the NDK CI pins:

   ```sh
   sdkmanager --licenses
   sdkmanager "platform-tools" "ndk;27.2.12479018"
   ```

   The app compiles against SDK 37 (`compileSdk`/`targetSdk` 37, `minSdk` 24 in
   `gen/android/app/build.gradle.kts`). CI installs only the two packages above;
   Gradle fetches the platform and build-tools itself once the licences are
   accepted. The Gradle wrapper (9.6.1) downloads itself too.
3. **Environment:**

   ```sh
   export ANDROID_HOME="$HOME/Android/Sdk"          # macOS: $HOME/Library/Android/sdk
   export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
   ```

4. **Rust targets.** All four for a release (universal) APK:

   ```sh
   rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
   ```

   One is enough for a single-ABI build, e.g. `aarch64-linux-android` for a modern
   phone.

### Build

From `native/`. The Android Studio project (`src-tauri/gen/android`) is committed,
so there's no `cargo tauri android init` step.

```sh
# Debug APK, arm64 only (what CI builds on Android PRs)
cargo tauri android build --debug --apk --target aarch64
#   → src-tauri/gen/android/app/build/outputs/apk/universal/debug/

# Release APK, all four ABIs (what release.yml builds)
cargo tauri android build --apk
#   → src-tauri/gen/android/app/build/outputs/apk/universal/release/

# Run on a connected device or emulator
cargo tauri android dev
```

Like the desktop build, these build `web/` first (`beforeBuildCommand`).

The Kotlin unit tests run from `src-tauri/gen/android`, after one build (it writes
the Gradle files Tauri generates, which are gitignored):

```sh
./gradlew --no-daemon :app:testUniversalDebugUnitTest
```

A type check needs no SDK or NDK at all, only the Rust target:
`cargo check --target aarch64-linux-android` in `native/src-tauri`.

### Signing

**The release keystore isn't in the repo** and never will be. A release build with
no keystore configured is signed with your local debug key, so it still installs;
Gradle prints `Winnow: no release keystore configured` when that happens.

To sign with your own key, put an untracked `src-tauri/gen/android/keystore.properties`
next to the Gradle project:

```properties
storeFile=/absolute/path/to/winnow-release.jks
password=<keystore password>
keyAlias=winnow
keyPassword=<key password; optional, defaults to password>
```

or set `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD` (the environment wins). `*.jks`, `*.keystore` and
`keystore.properties` are gitignored. Making a keystore, and how CI signs releases
from repository secrets: `native/README.md`, "Android signing".

Android installs an update only over an app signed with the same key. Your build,
the debug build and the official release are three different keys, so switching
between them means uninstalling first.

## Docker and self-hosting the web app

```sh
docker compose up -d             # http://localhost:8080, the published image
docker compose up -d --build     # built from your checkout instead
```

The `Dockerfile` runs the same `npm ci` and `vite build` on `node:24-slim` and
serves the result with nginx. Settings, updating, the render proxy and https are in
the README's [Docker](README.md#docker) section. Any static host works too: serve
`web/dist` from `npm run build`.

## Google sign-in

Winnow ships no Google OAuth client, so a build from source has nothing to
configure at build time: no `.env`, no secret. Each person creates their own client
in Google Cloud and pastes it into the app. The desktop and Android builds need a
**Desktop app** client; the web build needs a **Web application** client with the
page's address (for `npm run dev`, `http://localhost:5173`) as redirect URI and
origin. Step by step: [docs/google-setup.md](docs/google-setup.md). The demo mailbox
works without any of it.

## Troubleshooting

- **The AppImage won't start** (`dlopen(): error loading libfuse.so.2`). It needs
  FUSE 2: `libfuse2` on Debian and Ubuntu (`libfuse2t64` on Ubuntu 24.04 and later),
  `fuse2` on Arch, `fuse-libs` on Fedora. The `.deb` doesn't need it.
- **An AppImage you built won't run on an older distro.** An AppImage needs a glibc
  at least as new as the one it was built against, which is why releases are built
  on Ubuntu 22.04.
- **`failed to run linuxdeploy` while bundling the AppImage**, usually on Arch or
  another rolling distro: linuxdeploy's bundled `strip` is older than your system's
  libraries. `NO_STRIP=true npm run tauri:build` gets past it, or build just the
  `.deb` with `npm run tauri:build -- deb`.
- **`Port 5173 is already in use`.** The dev server uses `strictPort`, because Tauri
  loads exactly `http://localhost:5173`. Stop the other `npm run dev` (or whatever
  holds the port).
- **`frontendDist` / `web/dist` doesn't exist** from `cargo build`, `clippy` or `test`
  in `native/src-tauri`. Build the web app first, or stub `web/dist` (see
  [Rust checks](#rust-checks)).
- **`Bundling a .dmg needs … create-dmg`.** `brew install create-dmg`, or
  `npm run tauri:build -- app` for the `.app` alone.
- **A grey icon on macOS 26.** The `.app` was built without Xcode 26's `actool`, so
  it has no `Assets.car`. Select Xcode 26 (`sudo xcode-select -s …`) and rebuild.
- **A blank or white window on Linux** (often NVIDIA, or Wayland): try
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri:dev`. That's WebKitGTK, not Winnow.
- **`NDK_HOME` / `ANDROID_HOME` not set**, or the NDK not found: export both (see
  [Setup](#setup)); `NDK_HOME` points at the versioned folder, not `ndk/`.
- **`INSTALL_FAILED_UPDATE_INCOMPATIBLE`** installing an APK: the installed copy is
  signed with a different key. Uninstall it first (that signs you out).
