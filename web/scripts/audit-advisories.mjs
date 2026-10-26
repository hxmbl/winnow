#!/usr/bin/env node
// Dependency advisory gate: `npm audit` (web/) and `cargo audit` (native/src-tauri)
// against the committed lockfiles, filtered through .github/advisory-allowlist.json.
//
//   node web/scripts/audit-advisories.mjs
//
// Fails (exit 1) only on an advisory that is NOT in the allowlist and is
//   - npm: high or critical, in the production tree (`npm audit --omit=dev`);
//   - Cargo: a vulnerability (not an informational unmaintained/unsound/yanked
//     warning) scored high or critical, or with no CVSS score at all (most
//     RustSec advisories carry none, so an unscored one counts as high).
// Everything else is reported (dev-only npm findings, moderate/low, Cargo warnings)
// without failing. Exit 2 means a scanner could not run or its output did not parse,
// which is never a pass. Nothing here installs, updates or rewrites a lockfile.
//
// See SECURITY.md, "Dependency advisories", for the policy and the local commands.
//
// Testing the gate itself: --npm-prod=FILE --npm-full=FILE --cargo=FILE read saved
// `--json` output instead of running the scanners; --allowlist=FILE swaps the list.

import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WEB = resolve(ROOT, 'web')
const NATIVE = resolve(ROOT, 'native', 'src-tauri')
const GATE = new Set(['high', 'critical'])
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (!m) usage(`unknown argument: ${a}`)
    return [m[1], m[2]]
  }),
)
for (const k of Object.keys(args)) {
  if (!['npm-prod', 'npm-full', 'cargo', 'allowlist'].includes(k)) usage(`unknown option --${k}`)
}

function usage(msg) {
  console.error(`audit-advisories: ${msg}`)
  console.error('usage: node web/scripts/audit-advisories.mjs [--npm-prod=F --npm-full=F --cargo=F] [--allowlist=F]')
  process.exit(2)
}

function scannerError(msg) {
  annotate('error', 'Advisory scan incomplete', msg)
  console.error(`\nadvisory scan incomplete: ${msg}`)
  process.exit(2)
}

function annotate(level, title, msg) {
  if (!IN_ACTIONS) return
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  console.log(`::${level} title=${esc(title).replace(/[:,]/g, ' ')}::${esc(msg)}`)
}

function run(cmd, argv, cwd) {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.error) scannerError(`${cmd} ${argv.join(' ')}: ${r.error.message}`)
  return r
}

function parseJson(text, what) {
  try {
    return JSON.parse(text)
  } catch {
    scannerError(`${what} did not print JSON:\n${String(text).slice(0, 2000)}`)
  }
}

function load(file, what) {
  return parseJson(readFileSync(resolve(file), 'utf8'), what)
}

// ---- allowlist ------------------------------------------------------------------

const allowFile = resolve(args.allowlist ?? resolve(ROOT, '.github', 'advisory-allowlist.json'))
const allow = load(allowFile, allowFile)
if (!Array.isArray(allow.advisories)) scannerError(`${allowFile}: "advisories" must be an array`)
for (const [i, e] of allow.advisories.entries()) {
  for (const key of ['id', 'ecosystem', 'package', 'reason']) {
    if (typeof e[key] !== 'string' || !e[key].trim()) {
      scannerError(`${allowFile}: entry ${i} (${e.id ?? '?'}) needs a non-empty "${key}"`)
    }
  }
  if (!['npm', 'cargo'].includes(e.ecosystem)) scannerError(`${allowFile}: ${e.id}: ecosystem must be npm or cargo`)
}
const used = new Set()
function allowed(ecosystem, id, pkg) {
  const e = allow.advisories.find((a) => a.ecosystem === ecosystem && a.id === id && a.package === pkg)
  if (e) used.add(e)
  return e
}

// ---- CVSS 3.x base score (RustSec gives a vector, not a severity) --------------

function cvss3Severity(vector) {
  if (!vector) return null
  if (!/^CVSS:3\.[01]\//.test(vector)) return 'unscored'
  const m = Object.fromEntries(vector.split('/').slice(1).map((p) => p.split(':')))
  const W = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
    AC: { L: 0.77, H: 0.44 },
    UI: { N: 0.85, R: 0.62 },
    CIA: { H: 0.56, L: 0.22, N: 0 },
  }
  const changed = m.S === 'C'
  const PR = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR]
  const vals = [W.AV[m.AV], W.AC[m.AC], PR, W.UI[m.UI], W.CIA[m.C], W.CIA[m.I], W.CIA[m.A]]
  if (vals.some((v) => v === undefined) || !['U', 'C'].includes(m.S)) return 'unscored'
  const [av, ac, pr, ui, c, i, a] = vals
  const iss = 1 - (1 - c) * (1 - i) * (1 - a)
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss
  const expl = 8.22 * av * ac * pr * ui
  const roundUp = (x) => {
    const n = Math.round(x * 100000)
    return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10
  }
  const score = impact <= 0 ? 0 : roundUp(Math.min((changed ? 1.08 : 1) * (impact + expl), 10))
  return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : score > 0 ? 'low' : 'none'
}

// ---- scanners ------------------------------------------------------------------

function npmAudit(extra, what) {
  const r = run('npm', ['audit', '--json', ...extra], WEB)
  const d = parseJson(r.stdout, what)
  if (d.error) scannerError(`${what}: ${d.error.summary ?? JSON.stringify(d.error)}`)
  if (!d.vulnerabilities || !d.metadata) scannerError(`${what}: unexpected output (no vulnerabilities/metadata)`)
  return d
}

function cargoAudit() {
  // A missing Cargo.lock would make cargo-audit generate one; refuse instead.
  const r = run('cargo', ['audit', '--json', '--file', 'Cargo.lock'], NATIVE)
  // Exit 1 just means "vulnerabilities found"; the JSON is still complete.
  const d = parseJson(r.stdout, 'cargo audit --json')
  if (!d.vulnerabilities || !d.database) scannerError(`cargo audit: unexpected output\n${r.stderr.slice(-2000)}`)
  return d
}

const versions = []
if (!args['npm-prod'] || !args['npm-full']) {
  versions.push(`npm ${run('npm', ['--version'], WEB).stdout.trim()} (node ${process.version})`)
}
if (!args.cargo) {
  const v = run('cargo', ['audit', '--version'], NATIVE)
  if (v.status !== 0) scannerError(`cargo audit is not installed: ${v.stderr.trim()}`)
  versions.push(v.stdout.trim().replace(/^cargo-audit-audit/, 'cargo-audit'))
}

const npmProd = args['npm-prod'] ? load(args['npm-prod'], 'npm-prod') : npmAudit(['--omit=dev'], 'npm audit --omit=dev')
const npmFull = args['npm-full'] ? load(args['npm-full'], 'npm-full') : npmAudit([], 'npm audit')
const cargo = args.cargo ? load(args.cargo, 'cargo') : cargoAudit()

// ---- findings ------------------------------------------------------------------

/** @type {{eco:string,id:string,pkg:string,version:string,severity:string,scope:string,title:string,url:string,fix:string,status:'fail'|'warn'|'accepted',reason?:string}[]} */
const findings = []

function npmAdvisories(report) {
  const out = []
  for (const [name, v] of Object.entries(report.vulnerabilities)) {
    for (const via of v.via) {
      if (typeof via === 'string') continue // a dependent of an advisory listed under its own name
      const id = /GHSA-[\w-]+/.exec(via.url ?? '')?.[0] ?? `npm-${via.source}`
      const fix = v.fixAvailable === true ? 'npm audit fix'
        : v.fixAvailable ? `${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (semver-major)' : ''}`
          : 'none'
      out.push({ id, pkg: via.name ?? name, range: via.range ?? v.range, severity: via.severity, title: via.title, url: via.url, fix, nodes: v.nodes })
    }
  }
  return out
}

const prodKeys = new Set(npmAdvisories(npmProd).map((a) => `${a.id} ${a.pkg}`))
const seen = new Set()
for (const a of [...npmAdvisories(npmProd), ...npmAdvisories(npmFull)]) {
  const key = `${a.id} ${a.pkg}`
  if (seen.has(key)) continue
  seen.add(key)
  const scope = prodKeys.has(key) ? 'production' : 'dev-only'
  const ok = allowed('npm', a.id, a.pkg)
  findings.push({
    eco: 'npm', id: a.id, pkg: a.pkg, version: `${a.range} (${(a.nodes ?? []).join(', ')})`, severity: a.severity,
    scope, title: a.title, url: a.url, fix: a.fix,
    status: ok ? 'accepted' : scope === 'production' && GATE.has(a.severity) ? 'fail' : 'warn',
    reason: ok?.reason,
  })
}

for (const v of cargo.vulnerabilities.list ?? []) {
  const adv = v.advisory
  const sev = cvss3Severity(adv.cvss) ?? 'unscored'
  const ok = allowed('cargo', adv.id, v.package.name)
  const os = v.affected?.os?.length ? ` [os: ${v.affected.os.join(', ')}]` : ''
  findings.push({
    eco: 'cargo', id: adv.id, pkg: v.package.name, version: v.package.version, severity: sev, scope: `vulnerability${os}`,
    title: adv.title, url: adv.url ?? `https://rustsec.org/advisories/${adv.id}`,
    fix: v.versions?.patched?.length ? v.versions.patched.join(' or ') : 'none',
    status: ok ? 'accepted' : GATE.has(sev) || sev === 'unscored' ? 'fail' : 'warn',
    reason: ok?.reason,
  })
}
for (const [kind, list] of Object.entries(cargo.warnings ?? {})) {
  for (const w of list) {
    const id = w.advisory?.id ?? `${kind}`
    const ok = allowed('cargo', id, w.package.name)
    findings.push({
      eco: 'cargo', id, pkg: w.package.name, version: w.package.version, severity: kind, scope: 'informational',
      title: w.advisory?.title ?? `${w.package.name} ${w.package.version} is ${kind}`,
      url: w.advisory?.url ?? (w.advisory ? `https://rustsec.org/advisories/${id}` : `https://crates.io/crates/${w.package.name}`),
      fix: w.versions?.patched?.length ? w.versions.patched.join(' or ') : 'none',
      status: ok ? 'accepted' : 'warn',
      reason: ok?.reason,
    })
  }
}

// ---- report --------------------------------------------------------------------

const db = cargo.database ?? {}
console.log(`Scanners: ${versions.join('; ') || 'saved JSON'}`)
console.log(`RustSec DB: ${db['advisory-count'] ?? '?'} advisories, commit ${db['last-commit'] ?? '?'} (${db['last-updated'] ?? '?'})`)
console.log(`npm tree: ${npmFull.metadata.dependencies?.total ?? '?'} packages (${npmFull.metadata.dependencies?.prod ?? '?'} production); Cargo.lock: ${cargo.lockfile?.['dependency-count'] ?? '?'} crates`)
console.log('')

const order = { fail: 0, warn: 1, accepted: 2 }
findings.sort((a, b) => order[a.status] - order[b.status] || a.eco.localeCompare(b.eco) || a.pkg.localeCompare(b.pkg))
for (const f of findings) {
  const head = `${f.status.toUpperCase().padEnd(8)} ${f.eco} ${f.pkg} ${f.version} ${f.id} [${f.severity}, ${f.scope}]`
  console.log(head)
  console.log(`         ${f.title}`)
  console.log(`         ${f.url}  fix: ${f.fix}`)
  if (f.reason) console.log(`         accepted: ${f.reason}`)
  const msg = `${f.pkg} ${f.version}: ${f.title} (${f.severity}, ${f.scope}). Fix: ${f.fix}. ${f.url}`
  if (f.status === 'fail') annotate('error', `${f.id} in ${f.pkg}`, msg)
  else if (f.status === 'warn') annotate('warning', `${f.id} in ${f.pkg}`, msg)
}
const stale = allow.advisories.filter((e) => !used.has(e))
for (const e of stale) {
  console.log(`STALE    allowlist entry ${e.ecosystem} ${e.package} ${e.id} no longer matches a finding; remove it`)
  annotate('notice', `Stale allowlist entry ${e.id}`, `${e.package} ${e.id} is no longer reported; remove it from .github/advisory-allowlist.json`)
}

const counts = { fail: 0, warn: 0, accepted: 0 }
for (const f of findings) counts[f.status]++
const summary = `${counts.fail} blocking, ${counts.warn} reported, ${counts.accepted} accepted (allowlist), ${stale.length} stale allowlist entries`
console.log(`\n${summary}`)

if (process.env.GITHUB_STEP_SUMMARY) {
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const rows = findings.map((f) => `| ${f.status} | ${f.eco} | ${cell(f.pkg)} ${cell(f.version)} | [${f.id}](${f.url}) | ${f.severity} | ${f.scope} | ${cell(f.fix)} |`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    '## Dependency advisories', '', summary, '',
    `Scanners: ${versions.join('; ') || 'saved JSON'}. RustSec DB commit \`${db['last-commit'] ?? '?'}\`.`, '',
    ...(rows.length ? ['| status | ecosystem | package | advisory | severity | scope | fix |', '| --- | --- | --- | --- | --- | --- | --- |', ...rows] : ['No findings.']),
    '',
  ].join('\n'))
}

if (counts.fail > 0) {
  console.error('\nNew high/critical advisory in shipped dependencies. Fix it with the smallest compatible bump,')
  console.error('or, if it cannot apply to Winnow, add it to .github/advisory-allowlist.json with the reason.')
  process.exit(1)
}
