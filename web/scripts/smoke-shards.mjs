/**
 * How CI splits the smoke run into parallel jobs, and the check that the split still
 * covers all of it.
 *
 * `npm run smoke` is the whole run, in order, in one process per script: that does not
 * change, and it is what to run locally. CI runs the same work as a matrix of shards
 * (`.github/workflows/ci.yml`, job `smoke-shard`), each building the bundle and running
 * `node scripts/smoke-shards.mjs <shard>`.
 *
 * A part is one independent slice of `smoke.mjs`: `core` is the long shared-page
 * sequence (boot through deep links, which hand state to each other), and every other
 * part opens its own browser contexts and depends on nothing before it. The standalone
 * scripts are listed by file name. `--check` fails unless every part of `smoke.mjs` and
 * every script `npm run smoke` runs is in exactly one shard, and the CI matrix names
 * exactly these shards, so a new part or script cannot silently fall out of CI.
 *
 *   node scripts/smoke-shards.mjs <shard>   # run one shard (builds dist/ if missing)
 *   node scripts/smoke-shards.mjs --check   # the coverage check (npm run check-free)
 *   node scripts/smoke-shards.mjs --list    # shard names, as JSON
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The parts of `smoke.mjs`, in run order. `smoke.mjs` validates `WINNOW_SMOKE_PARTS` against this. */
export const PARTS = [
  "core",
  "avatars",
  "swipe",
  "codes",
  "sender-pictures",
  "sidebar-edges",
  "rail-edges",
  "text-selection",
  "reader-split",
  "read-on-open",
  "settings",
  "privacy",
  "position",
  "glass",
  "offline",
  "offline-save",
  "attachments",
  "top-email",
  "motion",
  "fixes",
  "thumb",
  "schedule",
  "inbox-clear",
  "tour",
  "censor",
];

/**
 * Balanced on CI timings (seconds of runtime on ubuntu-latest, Oct 2026): `core` ~180 is
 * the floor, so every other shard is kept at or under it.
 */
export const SHARDS = {
  core: { parts: ["core"] },
  "contexts-a": {
    parts: ["avatars", "swipe", "codes", "sender-pictures", "sidebar-edges", "rail-edges", "text-selection", "reader-split", "read-on-open"],
  },
  "contexts-b": { parts: ["settings", "privacy", "position", "glass", "inbox-clear", "tour", "censor"] },
  "modules-a": { parts: ["fixes", "offline", "attachments", "motion"] },
  "modules-b": { parts: ["thumb", "top-email"], scripts: ["smoke-android.mjs", "smoke-notifications.mjs"] },
  "modules-c": { parts: ["schedule", "offline-save"], scripts: ["smoke-filters.mjs", "smoke-accounts.mjs"] },
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** The scripts `npm run smoke` runs after its build, in order. */
function smokeScripts() {
  const { scripts } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return [...scripts.smoke.matchAll(/node scripts\/([\w.-]+\.mjs)/g)].map((m) => m[1]);
}

function check() {
  const problems = [];
  const seen = new Map();
  for (const [name, shard] of Object.entries(SHARDS)) {
    for (const item of [...(shard.parts ?? []), ...(shard.scripts ?? [])]) {
      if (seen.has(item)) problems.push(`${item} is in both ${seen.get(item)} and ${name}`);
      seen.set(item, name);
    }
    for (const part of shard.parts ?? []) if (!PARTS.includes(part)) problems.push(`${name}: unknown part ${part}`);
  }
  const scripts = smokeScripts();
  if (scripts[0] !== "smoke.mjs") problems.push("npm run smoke no longer starts with smoke.mjs");
  for (const part of PARTS) if (!seen.has(part)) problems.push(`smoke.mjs part ${part} is in no shard`);
  for (const script of scripts.slice(1)) if (!seen.has(script)) problems.push(`${script} (npm run smoke) is in no shard`);
  for (const [item, name] of seen) {
    if (item.endsWith(".mjs") && !scripts.includes(item)) problems.push(`${name}: ${item} is not part of npm run smoke`);
  }
  // Every part must actually be gated in smoke.mjs, or a shard would run it twice or never.
  const smoke = readFileSync(path.join(HERE, "smoke.mjs"), "utf8");
  for (const part of PARTS) if (!smoke.includes(`part("${part}")`)) problems.push(`smoke.mjs has no part("${part}") gate`);
  // The CI matrix must list exactly these shards.
  const ci = readFileSync(path.join(ROOT, "..", ".github", "workflows", "ci.yml"), "utf8");
  const listed = ci.match(/^\s*shard:\s*\[([^\]]*)\]/m);
  if (!listed) problems.push("ci.yml: no `shard: [...]` matrix found");
  else {
    const names = listed[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const want = Object.keys(SHARDS);
    for (const n of want) if (!names.includes(n)) problems.push(`ci.yml matrix is missing shard ${n}`);
    for (const n of names) if (!want.includes(n)) problems.push(`ci.yml matrix names unknown shard ${n}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`smoke shards: ${p}`);
    process.exit(1);
  }
  console.log(`smoke shards: ${Object.keys(SHARDS).length} shards cover ${PARTS.length} parts and ${scripts.length - 1} scripts`);
}

function run(name) {
  const shard = SHARDS[name];
  if (!shard) {
    console.error(`unknown shard "${name}"; one of: ${Object.keys(SHARDS).join(", ")}`);
    process.exit(2);
  }
  const steps = [];
  if (shard.parts?.length) steps.push(["smoke.mjs", { WINNOW_SMOKE_PARTS: shard.parts.join(",") }]);
  for (const script of shard.scripts ?? []) steps.push([script, {}]);
  let failed = 0;
  for (const [script, env] of steps) {
    const started = Date.now();
    console.log(`\n▶ ${script}${env.WINNOW_SMOKE_PARTS ? ` (${env.WINNOW_SMOKE_PARTS})` : ""}`);
    // Every step runs even after a failure, so one shard reports all of its regressions.
    const result = spawnSync(process.execPath, [path.join(HERE, script)], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.status !== 0) failed += 1;
    console.log(`◀ ${script}: ${result.status === 0 ? "passed" : `FAILED (exit ${result.status ?? result.signal})`} in ${seconds}s`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--check") check();
  else if (arg === "--list") console.log(JSON.stringify(Object.keys(SHARDS)));
  else if (arg) run(arg);
  else {
    console.error("usage: node scripts/smoke-shards.mjs <shard> | --check | --list");
    process.exit(2);
  }
}
