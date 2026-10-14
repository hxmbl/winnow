/**
 * Check that every manifest holds the same version, and optionally that a release
 * tag names it. Prints the version, or lists every disagreement and exits 1.
 *
 *   node scripts/check-version.mjs                 # manifests agree
 *   node scripts/check-version.mjs v0.2.0-beta.1   # ...and match this tag
 *
 * Manifests hold a plain `MAJOR.MINOR.PATCH`; a pre-release suffix lives only in
 * the tag, because WiX rejects non-numeric versions and the `.msi` build would fail.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PLAIN = /^\d+\.\d+\.\d+$/;
const TAG = /^v(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/;

const read = (path) => readFileSync(resolve(repo, path), "utf8");
const readJson = (path) => JSON.parse(read(path));

/** The `[package]` version of Cargo.toml, without pulling in a TOML parser. */
function cargoVersion(path) {
  const pkg = read(path).split(/^\[/m).find((section) => section.startsWith("package]"));
  return pkg?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

/** Cargo.lock's version for our own `winnow` crate (the one with no `source`). */
function cargoLockVersion(path) {
  const block = read(path)
    .split(/^\[\[package\]\]$/m)
    .find((b) => /^name = "winnow"$/m.test(b) && !/^source = /m.test(b));
  return block?.match(/^version = "([^"]+)"$/m)?.[1] ?? null;
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
// The installers carry tauri.conf.json's version.
const expected = found["native/src-tauri/tauri.conf.json"];

const problems = [];
for (const [file, version] of Object.entries(found)) {
  if (!version) problems.push(`${file}: no version found`);
  else if (!PLAIN.test(version)) {
    problems.push(`${file}: ${version} is not a plain MAJOR.MINOR.PATCH (put a pre-release in the tag only)`);
  } else if (version !== expected) problems.push(`${file}: ${version}, but tauri.conf.json says ${expected}`);
}

const tag = process.argv[2];
if (tag) {
  const match = tag.match(TAG);
  if (!match) problems.push(`tag ${tag} is not v<MAJOR.MINOR.PATCH>[-suffix]`);
  else if (match[1] !== expected) problems.push(`tag ${tag} names ${match[1]}, but the manifests say ${expected}`);
}

if (problems.length > 0) {
  console.error(`Versions disagree:\n\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
  console.error("Set the same plain version in every file above, then tag v<version>.");
  process.exit(1);
}

console.log(expected);
