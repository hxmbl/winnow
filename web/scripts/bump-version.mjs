/**
 * Set the same version in every manifest check-version.mjs reads, editing each
 * file in place so its formatting survives. Prints the new version.
 *
 *   node scripts/bump-version.mjs patch    # 1.1.1 -> 1.1.2
 *   node scripts/bump-version.mjs minor    # 1.1.1 -> 1.2.0
 *   node scripts/bump-version.mjs major    # 1.1.1 -> 2.0.0
 *   node scripts/bump-version.mjs 1.4.0    # exactly this (may equal the current one)
 *
 * Refuses to go backwards, and refuses when the manifests already disagree.
 *
 * It also moves CHANGELOG.md's `## [Unreleased]` entries under `## [<new version>]`
 * (added to that section when it already exists, say for the final release after a
 * beta), and refuses, before touching anything, when the new version would have no
 * notes: no section and an empty Unreleased. `--date YYYY-MM-DD` sets the section's
 * date (default: today, UTC). The release workflow fails the same way without notes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promoteUnreleased } from "../src/core/updates/releaseNotes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dateAt = argv.indexOf("--date");
const date = dateAt >= 0 ? argv.splice(dateAt, 2)[1] : new Date().toISOString().slice(0, 10);
const arg = argv[0];
if (!arg) fail("usage: bump-version.mjs <patch|minor|major|MAJOR.MINOR.PATCH> [--date YYYY-MM-DD]");

// check-version exits 1 with the list of disagreements, which it prints itself.
let current;
try {
  current = execFileSync(process.execPath, [resolve(here, "check-version.mjs")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
} catch {
  process.exit(1);
}

const [, maj, min, pat] = current.match(PLAIN).map(Number);
let next;
if (arg === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (arg === "minor") next = `${maj}.${min + 1}.0`;
else if (arg === "major") next = `${maj + 1}.0.0`;
else if (PLAIN.test(arg.replace(/^v/, ""))) next = arg.replace(/^v/, "");
else fail(`"${arg}" is not patch, minor, major or a plain MAJOR.MINOR.PATCH`);

const parts = (v) => v.split(".").map(Number);
const cmp = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
if (cmp(next, current) < 0) fail(`${next} is older than the current ${current}`);

// The notes first: a version without any is refused before a manifest changes.
const changelogPath = resolve(repo, "CHANGELOG.md");
let changelog;
try {
  changelog = promoteUnreleased(readFileSync(changelogPath, "utf8"), next, date);
} catch (error) {
  fail(`CHANGELOG.md: ${error.message}`);
}

/** Replace exactly one match of `pattern` in `path`, or fail naming the file. */
function edit(path, pattern, replace) {
  const file = resolve(repo, path);
  const text = readFileSync(file, "utf8");
  const matches = text.match(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"));
  if (!matches || matches.length !== 1) {
    fail(`${path}: expected one version to replace, found ${matches?.length ?? 0}`);
  }
  writeFileSync(file, text.replace(pattern, replace));
}

const esc = current.replace(/\./g, "\\.");

// JSON manifests: the top-level "version" is the first one, indented two spaces.
edit("web/package.json", new RegExp(`^(  "version": )"${esc}"`, "m"), `$1"${next}"`);
edit("native/src-tauri/tauri.conf.json", new RegExp(`^(  "version": )"${esc}"`, "m"), `$1"${next}"`);

// package-lock.json: the top-level version and packages[""], which sit together
// at the head of the file; edited by position so dependencies are never touched.
{
  const path = "web/package-lock.json";
  const file = resolve(repo, path);
  const text = readFileSync(file, "utf8");
  const head = text.indexOf('"packages"');
  const rootEnd = text.indexOf("\n    },", text.indexOf('"": {', head));
  if (head < 0 || rootEnd < 0) fail(`${path}: could not find packages[""]`);
  const top = text.slice(0, head).replace(new RegExp(`^(  "version": )"${esc}"`, "m"), `$1"${next}"`);
  const root = text
    .slice(head, rootEnd)
    .replace(new RegExp(`^(      "version": )"${esc}"`, "m"), `$1"${next}"`);
  writeFileSync(file, top + root + text.slice(rootEnd));
}

// Cargo.toml: the version line inside [package] only.
{
  const path = "native/src-tauri/Cargo.toml";
  const file = resolve(repo, path);
  const sections = readFileSync(file, "utf8").split(/^(?=\[)/m);
  const i = sections.findIndex((s) => s.startsWith("[package]"));
  if (i < 0) fail(`${path}: no [package] section`);
  sections[i] = sections[i].replace(new RegExp(`^(version\\s*=\\s*)"${esc}"`, "m"), `$1"${next}"`);
  writeFileSync(file, sections.join(""));
}

// Cargo.lock: our own winnow-app block (the one with no `source`).
{
  const path = "native/src-tauri/Cargo.lock";
  const file = resolve(repo, path);
  const blocks = readFileSync(file, "utf8").split(/^(?=\[\[package\]\]$)/m);
  const i = blocks.findIndex((b) => /^name = "winnow-app"$/m.test(b) && !/^source = /m.test(b));
  if (i < 0) fail(`${path}: no winnow-app package`);
  blocks[i] = blocks[i].replace(new RegExp(`^version = "${esc}"$`, "m"), `version = "${next}"`);
  writeFileSync(file, blocks.join(""));
}

if (changelog.action !== "kept") {
  writeFileSync(changelogPath, changelog.text);
  console.error(`CHANGELOG.md: Unreleased ${changelog.action === "created" ? "moved under" : "added to"} ## [${next}]`);
}

// Prove every file now agrees on the new version.
try {
  const after = execFileSync(process.execPath, [resolve(here, "check-version.mjs")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  if (after !== next) fail(`manifests say ${after} after bumping to ${next}`);
} catch {
  process.exit(1);
}

console.log(next);
