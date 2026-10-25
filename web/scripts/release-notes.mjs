#!/usr/bin/env node
/**
 * Release notes from CHANGELOG.md, for `.github/workflows/release.yml` and
 * `cut-release.yml`:
 *
 *   node scripts/release-notes.mjs notes <tag> [CHANGELOG.md]       # the tag's notes
 *   node scripts/release-notes.mjs whats-new <tag> [CHANGELOG.md]   # "## What's new" + notes
 *   node scripts/release-notes.mjs from-body <body.md> <tag> [CHANGELOG.md]
 *       # the notes under a release body's "## What's new", else the tag's notes
 *   node scripts/release-notes.mjs promote <version> [YYYY-MM-DD] [CHANGELOG.md]
 *       # move ## [Unreleased] into ## [version] (bump-version.mjs does this itself)
 *   node scripts/release-notes.mjs lint [CHANGELOG.md]
 *
 * A tag reads its exact version's section, then (a pre-release) its plain version's.
 * A tag with no non-empty section is an error (exit 1): the release stops rather
 * than shipping generic notes. The rules live in `src/core/updates/releaseNotes.ts`
 * (run directly: Node strips the types), where they are unit-tested.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lintChangelog,
  notesForTag,
  notesFromBody,
  promoteUnreleased,
  versionOfTag,
  whatsNewBlock,
} from "../src/core/updates/releaseNotes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT = resolve(here, "..", "..", "CHANGELOG.md");

function usage() {
  console.error(
    "usage: release-notes.mjs notes|whats-new <tag> [CHANGELOG.md]\n" +
      "       release-notes.mjs from-body <body.md> <tag> [CHANGELOG.md]\n" +
      "       release-notes.mjs promote <version> [YYYY-MM-DD] [CHANGELOG.md]\n" +
      "       release-notes.mjs lint [CHANGELOG.md]",
  );
  process.exit(2);
}

function fail(message) {
  console.error(`::error title=CHANGELOG.md::${message}`);
  process.exit(1);
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(`${path} not found`);
  }
}

function notesOrFail(text, tag, path) {
  let found;
  try {
    found = notesForTag(text, tag);
  } catch (error) {
    fail(error.message);
  }
  if (!found) {
    const version = versionOfTag(tag);
    const plain = version.split("-")[0];
    fail(
      `${path} has no notes for ${tag}: add a non-empty "## [${version}]" section` +
        (plain !== version ? ` (or "## [${plain}]")` : "") +
        ` and run the release again. A release never ships without its notes.`,
    );
  }
  if (found.section !== versionOfTag(tag)) {
    console.error(`Notes for ${tag} come from the ## [${found.section}] section.`);
  }
  return found.body;
}

const [mode, ...args] = process.argv.slice(2);

if (mode === "notes" || mode === "whats-new") {
  const [tag, path = DEFAULT] = args;
  if (!tag) usage();
  const notes = notesOrFail(read(path), tag, path);
  process.stdout.write(mode === "notes" ? `${notes}\n` : whatsNewBlock(notes));
} else if (mode === "from-body") {
  const [bodyFile, tag, path = DEFAULT] = args;
  if (!bodyFile || !tag) usage();
  const fromBody = notesFromBody(read(bodyFile));
  if (fromBody) {
    process.stdout.write(`${fromBody}\n`);
  } else {
    console.error(`::warning title=Release notes::The release body has no "## What's new" section; latest.json takes ${tag}'s notes from CHANGELOG.md.`);
    process.stdout.write(`${notesOrFail(read(path), tag, path)}\n`);
  }
} else if (mode === "promote") {
  const [version, date = new Date().toISOString().slice(0, 10), path = DEFAULT] = args;
  if (!version) usage();
  try {
    const result = promoteUnreleased(read(path), versionOfTag(version), date);
    if (result.action !== "kept") writeFileSync(path, result.text);
    console.log(`${path}: ${result.action} ## [${versionOfTag(version)}]`);
  } catch (error) {
    fail(error.message);
  }
} else if (mode === "lint") {
  const [path = DEFAULT] = args;
  const problems = lintChangelog(read(path));
  if (problems.length) {
    for (const problem of problems) console.error(`::error title=CHANGELOG.md::${problem}`);
    process.exit(1);
  }
  console.log(`${path}: OK`);
} else {
  usage();
}
