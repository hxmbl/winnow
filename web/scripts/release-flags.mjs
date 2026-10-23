#!/usr/bin/env node
/**
 * The `gh release` flags for a tag (`.github/workflows/release.yml`), one per line:
 *
 *   node scripts/release-flags.mjs create <tag>
 *   node scripts/release-flags.mjs publish <tag> <github-says-prerelease: true|false>
 *   node scripts/release-flags.mjs prerelease <tag>      # prints true or false
 *
 * The rule lives in `src/core/updates/releaseFlags.ts` (run directly: Node strips the
 * types), where it is unit-tested.
 */
import { createFlags, isPrereleaseTag, publishFlags } from "../src/core/updates/releaseFlags.ts";

const [mode, tag, flag] = process.argv.slice(2);
if (!tag || !["create", "publish", "prerelease"].includes(mode)) {
  console.error("usage: release-flags.mjs <create|publish|prerelease> <tag> [github-prerelease]");
  process.exit(2);
}
const out =
  mode === "create" ? createFlags(tag) : mode === "publish" ? publishFlags(tag, flag === "true") : [String(isPrereleaseTag(tag))];
console.log(out.join("\n"));
