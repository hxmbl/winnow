/**
 * Build the desktop bundle.
 *
 * Wrapped in a script rather than left as a bare `cargo tauri build` for two
 * reasons, one of which turned out to be a false premise and is kept because the
 * *check* is worth having regardless.
 *
 * 1. **Bundle kinds are named per host.** Asking macOS for `deb` is not an error
 *    Tauri reports — it declines to bundle, quietly. So the targets are decided
 *    here, where a missing one is a sentence.
 *
 * 2. **Success is asserted by looking for the output.** The original version of this
 *    file claimed `cargo tauri build` exits 0 without writing anything, and cited
 *    tauri-cli 2.11 as the reason. That claim was wrong — `bundle.active` defaults
 *    to `true`, so a bare `cargo tauri build` *does* bundle. The check stayed
 *    because it is still the right thing to assert: "the tool said it succeeded" and
 *    "a file exists where a release should be" are different facts, and the second
 *    one is the one a release depends on. It costs nothing and it catches the case
 *    where a future tauri-cli reintroduces the silent case.
 *
 * The argument handling was also wrong and is the other reason this is a script:
 * `--bundles app,dmg … passthrough.slice(bundles.length)` is always an empty slice,
 * because `bundles.length` *is* `passthrough.length` on that branch. Any flag other
 * than a bundle name — `--target`, `--ci`, `--debug` — was silently swallowed, and
 * `npm run tauri:build -- --bundles app` produced the literal string
 * `--bundles,app` as a bundle name. Flags are now parsed rather than sliced.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

/**
 * Split the arguments into bundle names and flags to forward.
 *
 * A bundle name is a bare word; anything beginning with `-` is a flag, and a flag
 * that takes a value is given the word after it. `--bundles` takes the remainder as
 * a comma-separated list, which is the one case where a following word is *not* a
 * flag and *not* a bundle — it is consumed as the flag's own value.
 *
 * Returns `{ bundles, flags }`, both in the order they were written, because the
 * order of forwarded flags can matter (`--debug --ci` is not `--ci --debug`).
 */
function parseArgs(argv, platform) {
  const bundles = [];
  const flags = [];
  const rest = [...argv];

  while (rest.length > 0) {
    const arg = rest.shift();

    if (arg === "--bundles" || arg === "-b") {
      // Whatever follows *is* the value, commas and all. A missing value is a usage
      // error rather than an empty bundle list, because the latter builds nothing
      // and says nothing.
      const value = rest.shift();
      if (!value) {
        throw new Error(`${arg} needs a comma-separated list of bundle kinds`);
      }
      for (const kind of value.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!bundles.includes(kind)) bundles.push(kind);
      }
      continue;
    }

    if (arg.startsWith("-")) {
      flags.push(arg);
      // The flags that take a value. Everything else is a bare switch, and a bare
      // switch followed by a bare word is a word, not its value.
      if (["--target", "--config", "--features", "--profile", "-p"].includes(arg)) {
        const value = rest.shift();
        if (!value) throw new Error(`${arg} needs a value`);
        flags.push(value);
      }
      continue;
    }

    // A bare word is a bundle kind. This is the case the old slicing got wrong.
    if (!bundles.includes(arg)) bundles.push(arg);
  }

  return { bundles: bundles.length > 0 ? bundles : bundlesFor(platform), flags };
}

let bundles;
let flags;
const platform = process.platform;

try {
  ({ bundles, flags } = parseArgs(process.argv.slice(2), platform));
} catch (error) {
  console.error(`${error.message}\n`);
  console.error("Usage: npm run tauri:build -- [bundle-kind…] [--flag …]");
  console.error(`  Bundle kinds for this host: ${bundlesFor(platform).join(", ")}`);
  process.exit(1);
}

if (!existsSync(resolve(native, "src-tauri", "tauri.conf.json"))) {
  console.error(`Cannot find the Tauri config under ${native}. Is the repo intact?`);
  process.exit(1);
}

/**
 * Preflight the tools Tauri shells out to, so a missing one is a sentence rather
 * than a stack trace from inside a vendored bash script.
 *
 * Tauri's `bundle_dmg.sh` is a thin wrapper around Homebrew's `create-dmg`. Without
 * it the `.app` builds fine and the `.dmg` dies deep inside a script with no mention
 * of what to install — which reads as a bug in this repo rather than a missing
 * prerequisite. `hdiutil` ships with macOS; `create-dmg` does not.
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

const args = ["tauri", "build", "--bundles", bundles.join(","), ...flags];
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

  // The check this script exists for. Asserting success by looking for the output
  // rather than by trusting the exit code: "the tool said it succeeded" and "a
  // release exists where it should" are different facts.
  const out = resolve(native, "src-tauri", "target", "release", "bundle");
  if (!existsSync(out)) {
    console.error(
      `\nBuild reported success but produced no bundle at ${out}.\n` +
        "Treating that as a failure: shipping a binary with no bundle is the exact\n" +
        "outcome this check exists to prevent.\n",
    );
    process.exit(1);
  }

  // Check each requested bundle kind for an actual artifact, not just a directory.
  //
  // Tauri writes each bundle kind to bundle/<kind>/, except the macOS
  // application bundle, which is written under bundle/macos/.
  const dirFor = (kind) => (kind === "app" ? "macos" : kind);

  const missing = bundles.filter((kind) => {
    const dir = resolve(out, dirFor(kind));
    if (!existsSync(dir)) return true;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      if (kind === "app") {
        return !entries.some(
          (entry) =>
            entry.isDirectory() &&
            entry.name.endsWith(".app") &&
            existsSync(resolve(dir, entry.name, "Contents", "Info.plist")),
        );
      }
      return !entries.some((entry) => entry.isFile());
    } catch {
      return true;
    }
  });

  if (missing.length > 0) {
    console.error(
      `\nBuild reported success but produced nothing for: ${missing.join(", ")}.\n` +
        `Looked under ${out}\n`,
    );
    process.exit(1);
  }

  console.log(`\nBundles written to ${out}`);
  for (const kind of bundles) console.log(`  ${resolve(out, dirFor(kind))}`);
});
