/**
 * Build the desktop bundle.
 *
 * Wrapped in a script rather than left as a bare `cargo tauri build` because
 * that command produces *no distributable at all* with tauri-cli 2.11: it
 * compiles the binary, prints "Built application at …", exits 0, and writes
 * nothing under `target/release/bundle/`. Naming bundle kinds in
 * `tauri.conf.json` does not change this — verified against an explicit
 * cross-platform list, a macOS-only list, `"all"`, and omitting the key
 * entirely. Only `--bundles` on the command line bundles anything.
 *
 * The failure mode is the reason this is worth a script rather than a note in
 * the README: an exit code of 0 and a plausible-looking log make it look like a
 * release succeeded. Nothing shipped.
 *
 * So the targets are named here, per host, and passed explicitly. Bundles are
 * named per platform because asking macOS for `deb` is not an error Tauri
 * reports — it just declines to bundle, which is the same silent nothing this
 * script exists to prevent.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const native = resolve(repo, "native");

/** The bundle kinds this host can actually produce. */
function bundlesFor(platform) {
  switch (platform) {
    case "darwin":
      return ["app", "dmg"];
    case "win32":
      return ["msi", "nsis"];
    default:
      return ["deb", "appimage"];
  }
}

/** Anything after `--` goes straight through, so CI can narrow the targets. */
const passthrough = process.argv.slice(2);
const platform = process.platform;
const bundles = passthrough.length > 0 ? passthrough : bundlesFor(platform);

if (!existsSync(resolve(native, "src-tauri", "tauri.conf.json"))) {
  console.error(`Cannot find the Tauri config under ${native}. Is the repo intact?`);
  process.exit(1);
}

/**
 * Preflight the tools Tauri shells out to, so a missing one is a sentence
 * rather than a stack trace from inside a vendored bash script.
 *
 * Tauri's `bundle_dmg.sh` is a thin wrapper around Homebrew's `create-dmg`.
 * Without it the `.app` builds fine and the `.dmg` dies deep inside a script
 * with no mention of what to install — which reads as a bug in this repo rather
 * than a missing prerequisite. `hdiutil` ships with macOS; `create-dmg` does not.
 */
if (platform === "darwin" && bundles.includes("dmg")) {
  const missing = [];
  if (!has("hdiutil")) missing.push("hdiutil (part of macOS)");
  if (!has("create-dmg")) missing.push("create-dmg (brew install create-dmg)");
  if (missing.length > 0) {
    console.error(
      `Bundling a .dmg needs ${missing.join(" and ")}.\n\n` +
        "  brew install create-dmg\n\n" +
        "The .app bundle needs none of this — pass `app` to build just that:\n" +
        "  npm run tauri:build -- app\n",
    );
    process.exit(1);
  }
}

/** Whether `command` is on the PATH. */
function has(command) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command]);
  return probe.status === 0;
}

const args = ["tauri", "build", "--bundles", bundles.join(","), ...passthrough.slice(bundles.length)];
console.log(`> cargo ${args.join(" ")}   (running in native/)`);

const child = spawn("cargo", args, {
  cwd: native,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    console.error(
      "\ncargo was not found, or the Tauri CLI is not installed.\n" +
        "Install it with:  cargo install tauri-cli --version \"^2\"\n",
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`\nInterrupted by ${signal}.`);
    process.exit(1);
  }
  if (code !== 0) process.exit(code ?? 1);

  // The check this script exists for. `cargo tauri build` can exit 0 having
  // written no bundle at all, so success is asserted by looking for the output
  // rather than by trusting the exit code.
  const out = resolve(native, "src-tauri", "target", "release", "bundle");
  if (!existsSync(out)) {
    console.error(
      `\nBuild reported success but produced no bundle at ${out}.\n` +
        "That is the silent-no-bundle failure this script guards against.\n",
    );
    process.exit(1);
  }
  console.log(`\nBundles written to ${out}`);
});