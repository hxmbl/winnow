/**
 * The Docker image's two start-up scripts, run for real against fixtures.
 *
 * `docker/web/configure.sh` writes the runtime config tag and patches the CSP; these tests
 * hold its output to `contentSecurityPolicy()` and `parseRuntimeConfig()`, so the shell
 * and the TypeScript cannot drift apart.
 *
 * `docker/fetch-release.sh` downloads releases. It runs with a fake `curl` first on
 * PATH that answers from a fixture directory and logs every URL it was asked for, so
 * the network rules (hosts, https, redirects, checksums, archive contents) are tested
 * without a network.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./csp";
import { RUNTIME_CONFIG_META, parseRuntimeConfig } from "./runtimeConfig";

const DOCKER = new URL("../../../docker/", import.meta.url).pathname;
const CONFIGURE = join(DOCKER, "web/configure.sh");
const FETCH = join(DOCKER, "fetch-release.sh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "winnow-docker-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── configure.sh ─────────────────────────────────────────────────────────────

/** A bundle shaped like `vite build`'s: the meta tag Vite writes, and `_headers`. */
function fakeBundle(): string {
  const bundle = join(dir, "bundle");
  mkdirSync(bundle, { recursive: true });
  const meta = contentSecurityPolicy().replaceAll("'", "&#39;");
  writeFileSync(
    join(bundle, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${meta}"><script src="./theme-boot.js"></script></head><body></body></html>`,
  );
  writeFileSync(
    join(bundle, "_headers"),
    `/*\n  Content-Security-Policy: ${contentSecurityPolicy({ header: true })}\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n`,
  );
  writeFileSync(join(bundle, "VERSION"), "1.4.0\n");
  return bundle;
}

function configure(env: Record<string, string>) {
  const bundle = fakeBundle();
  const serve = join(dir, "www");
  const nginx = join(dir, "nginx");
  const result = spawnSync("sh", [CONFIGURE, bundle, serve, nginx], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  const html = read(join(serve, "index.html"));
  const tags = [...html.matchAll(new RegExp(`<meta name="${RUNTIME_CONFIG_META}" content="([^"]*)">`, "g"))];
  const metaPolicy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1]?.replaceAll("&#39;", "'") ?? null;
  const headers = read(join(nginx, "headers.conf"));
  const headerPolicy = /^add_header Content-Security-Policy "([^"]*)" always;$/m.exec(headers)?.[1] ?? null;
  return {
    status: result.status,
    stderr: result.stderr,
    config: parseRuntimeConfig(tags[0]?.[1]),
    tags: tags.length,
    html,
    metaPolicy,
    headerPolicy,
    headers,
    proxyConf: read(join(nginx, "proxy.conf")),
    servedHeadersFile: existsSync(join(serve, "_headers")),
  };
}

describe("docker/web/configure.sh", () => {
  it("serves the build's own policy and a Docker config when given nothing", () => {
    const out = configure({});
    expect(out.status).toBe(0);
    expect(out.config).toEqual({ distribution: "docker", updates: "auto", renderProxy: null });
    expect(out.tags).toBe(1);
    // First thing in <head>, before anything that could read it.
    expect(out.html).toMatch(/^<!doctype html><html lang="en"><head><meta name="winnow-config" /);
    expect(out.metaPolicy).toBe(contentSecurityPolicy());
    expect(out.headerPolicy).toBe(contentSecurityPolicy({ header: true }));
    expect(out.headers).toMatch(/^add_header Referrer-Policy "no-referrer" always;$/m);
    expect(out.headers).toMatch(/^add_header X-Content-Type-Options "nosniff" always;$/m);
    expect(out.proxyConf).toBe("");
    expect(out.servedHeadersFile).toBe(false);
  });

  it("adds a cross-origin proxy to connect-src exactly as csp.ts does, and nothing else", () => {
    for (const renderProxy of ["https://render.example:8443/x", "https://render.example:443/", "http://10.0.0.5:8787"]) {
      const out = configure({ WINNOW_RENDER_PROXY: renderProxy });
      expect(out.config.renderProxy).toBe(renderProxy);
      expect(out.metaPolicy).toBe(contentSecurityPolicy({ renderProxy }));
      expect(out.headerPolicy).toBe(contentSecurityPolicy({ renderProxy, header: true }));
      expect(out.metaPolicy).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
    }
  });

  it("forwards to an upstream proxy same-origin, which needs no policy change", () => {
    const out = configure({ WINNOW_PROXY_UPSTREAM: "http://proxy:8787" });
    expect(out.config.renderProxy).toBe("self");
    expect(out.metaPolicy).toBe(contentSecurityPolicy());
    expect(out.proxyConf).toContain("set $winnow_proxy http://proxy:8787;");
    expect(out.proxyConf).toContain("location = /render");
    expect(out.proxyConf).toContain("location ^~ /asset/");
    expect(out.proxyConf).toContain("proxy_set_header Origin $winnow_forward_origin;");
  });

  it("refuses anything that is not a plain URL, and runs without a proxy", () => {
    for (const bad of ['https://x.example/"});alert(1)//', "javascript:alert(1)", "https://X.example", "ftp://x.example", "https://x.example/?a=b"]) {
      const out = configure({ WINNOW_RENDER_PROXY: bad });
      expect(out.status).toBe(0);
      expect(out.config.renderProxy).toBeNull();
      expect(out.metaPolicy).toBe(contentSecurityPolicy());
    }
    const upstream = configure({ WINNOW_PROXY_UPSTREAM: "http://proxy:8787; evil" });
    expect(upstream.proxyConf).toBe("");
    expect(upstream.config.renderProxy).toBeNull();
  });

  it("refuses a bundle whose index.html already carries a runtime config tag", () => {
    const bundle = fakeBundle();
    const html = readFileSync(join(bundle, "index.html"), "utf8");
    writeFileSync(join(bundle, "index.html"), html.replace("<head>", '<head><meta name="winnow-config" content="renderProxy=https://evil.example">'));
    const result = spawnSync("sh", [CONFIGURE, bundle, join(dir, "www2"), join(dir, "nginx2")], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });

  it("tells the app how this container updates", () => {
    expect(configure({ WINNOW_VERSION: "v1.5.0" }).config.updates).toBe("pinned");
    expect(configure({ WINNOW_AUTO_UPDATE: "false" }).config.updates).toBe("image");
    expect(configure({ WINNOW_AUTO_UPDATE: "false", WINNOW_VERSION: "v1.5.0" }).config.updates).toBe("image");
  });
});

// ── fetch-release.sh ─────────────────────────────────────────────────────────

/**
 * A `curl` that answers from `<gh>/<url with / and : as _>`: the file is the body, a
 * `.redirect` beside it means 302 to its contents, a missing file means 404, and a
 * file named `offline` makes every request fail to connect.
 */
const FAKE_CURL = `#!/bin/sh
out=""; fmt=""; url=""
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift ;;
    -w) fmt=$2; shift ;;
    -A|-H|--proto|--connect-timeout|--max-time|--max-filesize) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
echo "$url" >> "$FAKE_GH/requests.log"
[ -f "$FAKE_GH/offline" ] && { echo "curl: (7) offline" >&2; exit 7; }
key=$(printf '%s' "$url" | sed 's#[/:]#_#g')
if [ -f "$FAKE_GH/$key.redirect" ]; then
  : > "$out"; printf '302 %s' "$(cat "$FAKE_GH/$key.redirect")"; exit 0
fi
if [ -f "$FAKE_GH/$key" ]; then cp "$FAKE_GH/$key" "$out"; printf '200 '; exit 0; fi
: > "$out"; printf '404 '
`;

const REPO = "hxmbl/winnow";
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const download = (tag: string, name: string) => `https://github.com/${REPO}/releases/download/${tag}/${name}`;

type Harness = {
  gh: string;
  baked: string;
  cache: string;
  serve: (url: string, body: string | Buffer) => void;
  redirect: (from: string, to: string) => void;
  /** Publish `winnow-web-<version>` on a release, with its checksum and API entry. */
  release: (version: string, options?: { tamper?: boolean; digest?: string; files?: (root: string) => void; latest?: boolean }) => void;
  run: (env?: Record<string, string>) => { chosen: string; stderr: string; requests: string[] };
};

let harnesses = 0;
function harness(): Harness {
  const root = join(dir, `h${harnesses++}`);
  const gh = join(root, "gh");
  const bin = join(root, "bin");
  const baked = join(root, "baked");
  const cache = join(root, "cache");
  mkdirSync(gh, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(baked, { recursive: true });
  writeFileSync(join(baked, "VERSION"), "1.4.0\n");
  writeFileSync(join(baked, "index.html"), "baked");
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  chmodSync(join(bin, "curl"), 0o755);

  const key = (url: string) => url.replace(/[/:]/g, "_");
  const serve = (url: string, body: string | Buffer) => writeFileSync(join(gh, key(url)), body);
  const redirect = (from: string, to: string) => writeFileSync(join(gh, `${key(from)}.redirect`), to);

  const release: Harness["release"] = (version, options = {}) => {
    const tag = `v${version}`;
    const name = `winnow-web-${version}.tar.gz`;
    const src = join(root, `src-${version}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "VERSION"), `${version}\n`);
    writeFileSync(join(src, "index.html"), `release ${version}`);
    options.files?.(src);
    const archive = join(root, name);
    execFileSync("tar", ["-czf", archive, "-C", src, "."]);
    const bytes = readFileSync(archive);
    const sum = createHash("sha256").update(bytes).digest("hex");
    serve(download(tag, name), options.tamper ? Buffer.concat([bytes, Buffer.from("x")]) : bytes);
    serve(download(tag, `${name}.sha256`), `${sum}  ${name}\n`);
    const json = JSON.stringify({
      tag_name: tag,
      assets: [{ name, digest: options.digest ?? `sha256:${sum}` }],
    });
    serve(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, json);
    if (options.latest !== false) serve(API_LATEST, json);
  };

  const run: Harness["run"] = (env = {}) => {
    rmSync(join(gh, "requests.log"), { force: true });
    const result = spawnSync("sh", [FETCH, "web", baked, cache], {
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_GH: gh, ...env },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const log = join(gh, "requests.log");
    return {
      chosen: result.stdout.trim(),
      stderr: result.stderr,
      requests: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [],
    };
  };

  return { gh, baked, cache, serve, redirect, release, run };
}

const hasTools = ["jq", "tar", "sha256sum"].every((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0);

describe.skipIf(!hasTools)("docker/fetch-release.sh", () => {
  it("downloads, verifies and serves the newest release, then reuses it", () => {
    const h = harness();
    h.release("1.5.0");
    const first = h.run();
    expect(first.chosen).toBe(join(h.cache, "web", "v1.5.0"));
    expect(readFileSync(join(first.chosen, "index.html"), "utf8")).toBe("release 1.5.0");
    expect(readlinkSync(join(h.cache, "web", "current"))).toBe("v1.5.0");

    // The same release again: one API call, no download.
    const second = h.run();
    expect(second.chosen).toBe(first.chosen);
    expect(second.requests).toEqual([API_LATEST]);
  });

  it("serves the last download when GitHub is unreachable, else the baked copy", () => {
    const h = harness();
    writeFileSync(join(h.gh, "offline"), "");
    expect(h.run().chosen).toBe(h.baked);
    rmSync(join(h.gh, "offline"));
    h.release("1.5.0");
    h.run();
    writeFileSync(join(h.gh, "offline"), "");
    expect(h.run().chosen).toBe(join(h.cache, "web", "v1.5.0"));
  });

  it("does not let an older download outrank a newer image", () => {
    const h = harness();
    h.release("1.5.0");
    h.run();
    writeFileSync(join(h.baked, "VERSION"), "1.6.0\n");
    writeFileSync(join(h.gh, "offline"), "");
    expect(h.run().chosen).toBe(h.baked);
  });

  it("uses the baked copy without downloading when it is the newest", () => {
    const h = harness();
    h.release("1.4.0");
    const out = h.run();
    expect(out.chosen).toBe(h.baked);
    expect(out.requests).toEqual([API_LATEST]);
  });

  it("refuses an archive whose checksum or GitHub digest does not match", () => {
    const h = harness();
    h.release("1.5.0", { tamper: true });
    expect(h.run().chosen).toBe(h.baked);
    expect(existsSync(join(h.cache, "web", "v1.5.0"))).toBe(false);

    const g = harness();
    g.release("1.5.1", { digest: `sha256:${"0".repeat(64)}` });
    const out = g.run();
    expect(out.chosen).toBe(g.baked);
    expect(out.stderr).toMatch(/digest/);
  });

  it("refuses an archive with links or paths that climb out", () => {
    const h = harness();
    h.release("1.5.0", { files: (root) => symlinkSync("/etc/passwd", join(root, "passwd")) });
    expect(h.run().chosen).toBe(h.baked);
    expect(existsSync(join(h.cache, "web", "v1.5.0"))).toBe(false);
  });

  it("refuses an archive that is not a complete copy of that version", () => {
    const h = harness();
    h.release("1.5.0", { files: (root) => writeFileSync(join(root, "VERSION"), "9.9.9\n") });
    expect(h.run().chosen).toBe(h.baked);
  });

  it("follows redirects to GitHub's asset hosts and nowhere else", () => {
    const h = harness();
    h.release("1.5.0");
    const name = "winnow-web-1.5.0.tar.gz";
    const asset = readFileSync(join(h.gh, download("v1.5.0", name).replace(/[/:]/g, "_")));
    const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x";
    rmSync(join(h.gh, download("v1.5.0", name).replace(/[/:]/g, "_")));
    h.redirect(download("v1.5.0", name), cdn);
    h.serve(cdn, asset);
    const ok = h.run();
    expect(ok.chosen).toBe(join(h.cache, "web", "v1.5.0"));
    expect(ok.requests).toContain(cdn);

    const g = harness();
    g.release("1.5.0");
    const evil = "https://evil.example/winnow.tar.gz";
    rmSync(join(g.gh, download("v1.5.0", name).replace(/[/:]/g, "_")));
    g.redirect(download("v1.5.0", name), evil);
    g.serve(evil, asset);
    const refused = g.run();
    expect(refused.chosen).toBe(g.baked);
    expect(refused.requests).not.toContain(evil);

    const k = harness();
    k.release("1.5.0");
    rmSync(join(k.gh, download("v1.5.0", name).replace(/[/:]/g, "_")));
    k.redirect(download("v1.5.0", name), "http://objects.githubusercontent.com/x");
    const plain = k.run();
    expect(plain.chosen).toBe(k.baked);
    expect(plain.requests).not.toContain("http://objects.githubusercontent.com/x");
  });

  it("asks for nothing when auto-update is off", () => {
    const h = harness();
    h.release("1.5.0");
    const out = h.run({ WINNOW_AUTO_UPDATE: "false" });
    expect(out.chosen).toBe(h.baked);
    expect(out.requests).toEqual([]);
  });

  it("fetches a pinned release, and refuses a pin that is not a tag", () => {
    const h = harness();
    h.release("1.5.0", { latest: false });
    h.release("1.6.0");
    const pinned = h.run({ WINNOW_VERSION: "1.5.0" });
    expect(pinned.chosen).toBe(join(h.cache, "web", "v1.5.0"));
    expect(pinned.requests[0]).toBe(`https://api.github.com/repos/${REPO}/releases/tags/v1.5.0`);

    const bad = h.run({ WINNOW_VERSION: "v1.5.0/../../x" });
    expect(bad.requests).toEqual([]);
    const repo = h.run({ WINNOW_REPO: "evil/../x?" });
    expect(repo.requests).toEqual([]);
  });

  it("keeps the current and previous downloads only", () => {
    const h = harness();
    for (const version of ["1.5.0", "1.6.0", "1.7.0"]) {
      h.release(version);
      h.run();
    }
    expect(existsSync(join(h.cache, "web", "v1.5.0"))).toBe(false);
    expect(existsSync(join(h.cache, "web", "v1.6.0"))).toBe(true);
    expect(readlinkSync(join(h.cache, "web", "current"))).toBe("v1.7.0");
  });
});
