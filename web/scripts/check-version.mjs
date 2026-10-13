/**
 * Check that every place the app's version is written agrees, and optionally that
 * a release tag names the same version.
 *
 *   node scripts/check-version.mjs              # manifests agree with each other
 *   node scripts/check-version.mjs v0.2.0       # ...and with this tag
 *   node scripts/check-version.mjs v0.2.0-beta.1
 *
 * The version lives in four files — `web/package.json` (and its lockfile),
 * `native/src-tauri/tauri.conf.json` and `native/src-tauri/Cargo.toml` — and the
 * one the installers carry is `tauri.conf.json`'s. A release whose tag says one
 * thing and whose About box says another is a support question waiting to happen,
 * so the release workflow runs this before it builds anything.
 *
 * **Manifests hold a plain `MAJOR.MINOR.PATCH`; a pre-release lives only in the
 * tag.** `v0.2.0-beta.1` releases version `0.2.0` marked as a GitHub pre-release.
 * The reason is the Windows installer: WiX only accepts numeric versions, so a
 * `0.2.0-beta.1` in `tauri.conf.json` would fail the `.msi` build outright.
 *
 * Prints the version on success; exits 1 with every disagreement listed otherwise.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");

const PLAIN = /^\d+\.\d+\.\d+$/;
const TAG = /^v(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?$/;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repo, path), "utf8"));
}

/** The `[package]` version of Cargo.toml, without pulling in a TOML parser. */
function cargoVersion(path) {
  const text = readFileSync(resolve(repo, path), "utf8");
  const pkg = text.split(/^\[/m).find((section) => section.startsWith("package]"));
  const match = pkg?.match(/^version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

/** The version Cargo.lock recorded for the `winnow` crate that is *ours* (no `source`). */
function cargoLockVersion(path) {
  const text = readFileSync(resolve(repo, path), "utf8");
  for (const block of text.split(/^\[\[package\]\]$/m)) {
    if (/^name = "winnow"$/m.test(block) && !/^source = /m.test(block)) {
      return block.match(/^version = "([^"]+)"$/m)?.[1] ?? null;
    }
  }
  return null;
}

const lock = readJson("web/package-lock.json");
const found = {
  "web/package.json": readJson("web/package.json").version,
  "web/package-lock.json": lock.version,
  'web/package-lock.json packages[""]': lock.packages?.[""]?.version,
  "native/src-tauri/tauri.conf.json": readJson("native/src-tauri/tauri.conf.json").version,
  "native/src-tauri/Cargo.toml": cargoVersion("native/src-tauri/Cargo.toml"),
  "native/src-tauri/Cargo.lock": cargoLockVersion("native/src-tauri/Cargo.lock"),
};

const problems = [];
const expected = found["native/src-tauri/tauri.conf.json"];

for (const [file, version] of Object.entries(found)) {
  if (!version) problems.push(`${file}: no version found`);
  else if (!PLAIN.test(version)) {
    problems.push(`${file}: ${version} is not a plain MAJOR.MINOR.PATCH (put a pre-release in the tag only)`);
  } else if (version !== expected) problems.push(`${file}: ${version}, but tauri.conf.json says ${expected}`);
}

const tag = process.argv[2];
if (tag) {
  const match = tag.replace(/^refs\/tags\//, "").match(TAG);
  if (!match) problems.push(`tag ${tag} is not v<MAJOR.MINOR.PATCH>[-suffix]`);
  else if (match[1] !== expected) problems.push(`tag ${tag} names ${match[1]}, but the manifests say ${expected}`);
}

if (problems.length > 0) {
  console.error("Versions disagree:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nSet the same plain version in every file above, then tag v<version>.");
  process.exit(1);
}

console.log(expected);
