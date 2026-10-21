#!/usr/bin/env node
/**
 * Write the Tauri updater's `latest.json` for a release (`.github/workflows/release.yml`).
 *
 *   node scripts/updater-manifest.mjs <dir-with-.sig-files> <version> <tag> <notes.md> <out.json>
 *
 * Finds `*_universal.app.tar.gz.sig` and `*.AppImage.sig` in the directory, reads each
 * signature, and builds the manifest with `src/core/updates/manifest.ts` (run directly:
 * Node 23.6+ strips the types). The notes are the GitHub release body, so the updater's
 * `notes` match the Releases page. Fails when neither signature is there.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest } from "../src/core/updates/manifest.ts";

const [dir, version, tag, notesFile, out] = process.argv.slice(2);
if (!dir || !version || !tag || !notesFile || !out) {
  console.error("usage: updater-manifest.mjs <sig-dir> <version> <tag> <notes.md> <out.json>");
  process.exit(2);
}

const files = readdirSync(dir);
const artifact = (suffix) => {
  const sig = files.find((name) => name.endsWith(`${suffix}.sig`));
  if (!sig) {
    console.log(`::warning::No ${suffix}.sig found; latest.json will not offer that platform.`);
    return null;
  }
  return { name: sig.slice(0, -".sig".length), signature: readFileSync(join(dir, sig), "utf8") };
};

const manifest = buildManifest({
  version,
  tag,
  repo: process.env.GITHUB_REPOSITORY || "hxmbl/winnow",
  notes: readFileSync(notesFile, "utf8").trim(),
  // PUB_DATE from the workflow (`date -u`), so the date does not depend on Node's locale.
  pubDate: process.env.PUB_DATE || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  macos: artifact("_universal.app.tar.gz"),
  appimage: artifact(".AppImage"),
});
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out}: ${Object.keys(manifest.platforms).join(", ")}`);
