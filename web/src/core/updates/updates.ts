/**
 * Automatic updates: the decisions, pure.
 *
 * Winnow runs in six ways, and each one updates differently:
 *
 * | Runtime | How it updates |
 * | --- | --- |
 * | macOS app (universal DMG) | Tauri's updater: downloads the signed `.app.tar.gz`, swaps the app, relaunches |
 * | Linux AppImage | Tauri's updater: replaces the AppImage file in place, relaunches |
 * | Linux `.deb` | Downloads the new `.deb` and opens it in the system installer (`apt` fallback) |
 * | Android APK | Downloads the new APK and hands it to Android's package installer |
 * | Web (self-hosted) | Nothing to download: says `git pull`, rebuild and redeploy |
 * | Web (Docker image) | Nothing to download here: the container fetches the newest release each time it starts, so it says to restart it |
 *
 * Every runtime finds out the same way: GitHub's `releases/latest` for the repository,
 * which never returns a draft or a pre-release, compared with the running version. This
 * module decides; `platform/` carries out the install, and `ui/useUpdates.ts` owns the
 * timer and the stored state. No DOM, no network, no clock: each is passed in.
 *
 * **Two channels.** Stable (everyone, always the default) never offers a pre-release,
 * and does not trust GitHub's `prerelease` flag alone for that: any tag with a `-` in it
 * (`v1.6.0-beta.1`) is refused here, in the changelog, in the native installers
 * (`updater.rs`, `UpdateLogic.kt`) and in the Docker image's fetch, so a pre-release
 * marked "latest" by mistake still reaches nobody. Beta (Dev Options → Beta updates,
 * native builds only) lists `/releases` instead and takes the newest published release
 * of any kind, pre-releases included, installing from that release's own files. Neither
 * ever offers anything older than what runs, so turning Beta off never downgrades: a
 * beta user waits for the next stable release newer than their beta.
 */

export const UPDATE_REPO = "hxmbl/winnow";

/** GitHub's newest published, non-pre-release release. */
export const RELEASES_LATEST_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

/** Every release, newest first: what the Beta channel reads (and the changelog). */
export const RELEASES_LIST_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=50`;

/** Where a release's files live; every download must be one of these. */
export const RELEASE_DOWNLOAD_PREFIX = `https://github.com/${UPDATE_REPO}/releases/download/`;

/** The page a user can always fall back to. */
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;

/** Checks are at most this often: on launch, then every six hours. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A failed check waits this long before the next try, so a flaky network is not hammered. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

// ── Runtime ───────────────────────────────────────────────────────────────────

/**
 * How this copy of Winnow is running, which decides how it updates.
 *
 * - `macos`, `appimage`: Tauri's own updater replaces the app.
 * - `deb`: installed by the system package manager; we download, it installs.
 * - `android`: the package installer, with the user's confirmation.
 * - `web`: a self-hosted build; the person who deployed it updates it.
 * - `docker`: the Docker image (`docker/`); restarting the container updates it, unless
 *   the operator pinned a release or turned that off (`UpdateRuntime.docker`).
 * - `manual`: a desktop build that is none of the above (a `cargo` dev binary, or a
 *   platform without a release); it can only point at the Releases page.
 */
export type UpdateChannel = "macos" | "appimage" | "deb" | "android" | "web" | "docker" | "manual";

/**
 * How a Docker deployment updates, from its runtime configuration
 * (`platform/runtimeConfig.ts`): `auto` fetches the newest release on every start,
 * `pinned` runs the release `WINNOW_VERSION` names, `image` runs the copy in the image.
 */
export type DockerUpdateMode = "auto" | "pinned" | "image";

export type UpdateRuntime = {
  channel: UpdateChannel;
  /** The running version, e.g. `1.4.0`. */
  version: string;
  /** CPU, as Rust spells it (`x86_64`, `aarch64`); `unknown` in a browser. */
  arch: string;
  /** For `docker`: how the container updates (absent means `auto`). */
  docker?: DockerUpdateMode;
  /**
   * Dev Options → Beta updates: consider pre-releases too. Honoured only on a native
   * build that installs releases (`betaChannel`); everywhere else it is ignored.
   */
  beta?: boolean;
};

/** The runtimes that install a release themselves, and so may opt into Beta updates. */
const NATIVE_CHANNELS: readonly UpdateChannel[] = ["macos", "appimage", "deb", "android"];

/** Whether this runtime may offer Dev Options → Beta updates at all: a native build that installs releases. */
export function betaAvailable(runtime: UpdateRuntime | null | undefined): boolean {
  return runtime != null && NATIVE_CHANNELS.includes(runtime.channel);
}

/** Whether this runtime is on the Beta channel (opted in, and a native build). */
export function betaChannel(runtime: UpdateRuntime): boolean {
  return runtime.beta === true && NATIVE_CHANNELS.includes(runtime.channel);
}

/** The channel a native shell's `update_runtime` reported, or `manual` when unrecognised. */
export function parseChannel(raw: unknown): UpdateChannel {
  return raw === "macos" || raw === "appimage" || raw === "deb" || raw === "android" || raw === "web"
    ? raw
    : "manual";
}

// ── Versions ──────────────────────────────────────────────────────────────────

export type Version = {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers (`beta.2` → `["beta", "2"]`); empty for a release. */
  pre: string[];
};

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `1.4.0`, `v1.5.0-beta.1` (a tag), or `null` for anything else. Build metadata is ignored. */
export function parseVersion(raw: string | null | undefined): Version | null {
  const match = VERSION_RE.exec((raw ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".").filter((part) => part !== "") : [],
  };
}

function comparePre(a: string[], b: string[]): number {
  // A release outranks any pre-release of the same version.
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (xNum !== yNum) {
      // Numeric identifiers sort before alphanumeric ones (semver §11).
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Semver order: negative when `a` is older, 0 when equal, positive when newer. */
export function compareVersions(a: Version, b: Version): number {
  return (
    Math.sign(a.major - b.major) ||
    Math.sign(a.minor - b.minor) ||
    Math.sign(a.patch - b.patch) ||
    comparePre(a.pre, b.pre)
  );
}

/** Whether `candidate` is strictly newer than `current`; `false` when either is unreadable. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  return a !== null && b !== null && compareVersions(a, b) > 0;
}

/**
 * A stable version or tag: one with no `-` at all, so no pre-release part. The check is
 * on the raw string rather than only on the parsed `pre`, so nothing that parses
 * oddly can slip a suffix through.
 */
export function isStableVersion(raw: string): boolean {
  const parsed = parseVersion(raw);
  return parsed !== null && parsed.pre.length === 0 && !raw.includes("-");
}

/** `v1.5.0` → `1.5.0`. */
export function versionOfTag(tag: string): string {
  return tag.trim().replace(/^v/, "");
}

// ── Releases ──────────────────────────────────────────────────────────────────

export type ReleaseAsset = { name: string; url: string; size: number };

export type Release = {
  version: string;
  tag: string;
  /** A pre-release: GitHub's flag, or a tag with a `-`. Only the Beta channel reads one. */
  prerelease: boolean;
  /** The release's page on GitHub. */
  pageUrl: string;
  assets: ReleaseAsset[];
};

/**
 * A GitHub release, as `releases/latest` (or one entry of `/releases`) returns it, or
 * `null` when it is not one we can use: a draft, a tag that is not a version, or a body
 * that is not an object — and, unless `allowPrerelease` (the Beta channel), a
 * pre-release, by GitHub's flag *or* by a `-` in its tag, whichever says so. Asset URLs
 * outside this repository's release downloads are dropped.
 */
export function parseRelease(json: unknown, { allowPrerelease = false }: { allowPrerelease?: boolean } = {}): Release | null {
  if (!json || typeof json !== "object") return null;
  const raw = json as Record<string, unknown>;
  if (raw.draft === true) return null;
  const tag = typeof raw.tag_name === "string" ? raw.tag_name : "";
  const version = versionOfTag(tag);
  if (!parseVersion(version)) return null;
  const prerelease = raw.prerelease === true || tag.includes("-") || !isStableVersion(version);
  if (prerelease && !allowPrerelease) return null;
  const pageUrl =
    typeof raw.html_url === "string" && raw.html_url.startsWith(`https://github.com/${UPDATE_REPO}/`)
      ? raw.html_url
      : RELEASES_PAGE_URL;
  const assets: ReleaseAsset[] = [];
  for (const entry of Array.isArray(raw.assets) ? raw.assets : []) {
    if (!entry || typeof entry !== "object") continue;
    const asset = entry as Record<string, unknown>;
    const name = typeof asset.name === "string" ? asset.name : "";
    const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
    if (!name || !isReleaseDownload(url)) continue;
    assets.push({ name, url, size: typeof asset.size === "number" ? asset.size : 0 });
  }
  return { version, tag, prerelease, pageUrl, assets };
}

/**
 * The newest usable release in a `/releases` list (the Beta channel): drafts skipped,
 * pre-releases included, ordered by semver rather than by GitHub's list order (a hotfix
 * to an older line can be published after a newer beta). `null` when none is usable.
 */
export function newestRelease(json: unknown): Release | null {
  if (!Array.isArray(json)) return null;
  let best: Release | null = null;
  for (const item of json) {
    const release = parseRelease(item, { allowPrerelease: true });
    if (release && (!best || isNewer(release.version, best.version))) best = release;
  }
  return best;
}

/** Whether a URL is a file attached to one of this repository's releases. */
export function isReleaseDownload(url: string): boolean {
  // `..` is refused on the raw string: `URL` would resolve it away and leave a path
  // outside the prefix that still parses.
  if (!url.startsWith(RELEASE_DOWNLOAD_PREFIX) || url.includes("..")) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.host === "github.com" &&
      parsed.pathname.startsWith(`/${UPDATE_REPO}/releases/download/`)
    );
  } catch {
    return false;
  }
}

/** Debian's name for a Rust architecture. */
function debArch(arch: string): string {
  if (arch === "x86_64") return "amd64";
  if (arch === "aarch64") return "arm64";
  return arch;
}

/**
 * The file a channel installs from, or `null` when the release has none for it.
 *
 * - `deb`: `Winnow_<v>_<debarch>.deb` (the release ships amd64 only).
 * - `android`: the universal APK, never a `-debug` one: Android refuses an update
 *   signed with a different key, so offering it would only fail at install.
 * - Everything else installs without a picked asset (Tauri's updater reads
 *   `latest.json` itself) or has nothing to install.
 */
export function pickAsset(channel: UpdateChannel, arch: string, assets: readonly ReleaseAsset[]): ReleaseAsset | null {
  switch (channel) {
    case "deb": {
      const suffix = `_${debArch(arch)}.deb`;
      return assets.find((asset) => asset.name.endsWith(suffix)) ?? null;
    }
    case "android":
      return (
        assets.find((asset) => /android-universal\.apk$/.test(asset.name) && !/-debug\.apk$/.test(asset.name)) ?? null
      );
    default:
      return null;
  }
}

// ── The offer ─────────────────────────────────────────────────────────────────

/**
 * What the app can do about a newer release on this runtime.
 *
 * - `self`: Tauri's updater installs it and relaunches.
 * - `deb`: download `asset` and open it in the system installer.
 * - `apk`: download `asset` and hand it to Android's package installer.
 * - `git-pull`: a self-hosted web build; tell whoever runs it to pull and redeploy.
 * - `docker`: the Docker image; tell whoever runs it to restart the container (or, for
 *   a pinned release or an image without auto-update, what to change first).
 * - `page`: nothing to install here; open the release page.
 */
export type UpdateAction =
  /**
   * `manifest`: the Beta channel's own `latest.json`, from the offered release (Tauri's
   * updater otherwise reads `releases/latest/download/latest.json`, which is stable only).
   */
  | { kind: "self"; manifest?: string }
  | { kind: "deb"; asset: ReleaseAsset }
  | { kind: "apk"; asset: ReleaseAsset }
  | { kind: "git-pull" }
  | { kind: "docker"; mode: DockerUpdateMode }
  | { kind: "page" };

export type UpdateOffer = {
  version: string;
  current: string;
  pageUrl: string;
  action: UpdateAction;
  /**
   * Offered on the Beta channel: the native installers accept a pre-release's files only
   * when this says so (they refuse any tag with a `-` otherwise).
   */
  beta?: boolean;
};

/**
 * The offer for `release` on `runtime`, or `null` when it is not newer than what runs.
 * A channel whose file is missing from the release (a release without its `.deb`, or
 * with only a debug APK) falls back to the release page rather than offering nothing.
 */
export function planUpdate(runtime: UpdateRuntime, release: Release): UpdateOffer | null {
  const beta = betaChannel(runtime);
  // The stable channel's hard guard: a pre-release is never offered, whatever produced
  // the `Release`.
  if (!beta && (release.prerelease || !isStableVersion(release.version) || release.tag.includes("-"))) return null;
  if (!isNewer(release.version, runtime.version)) return null;
  const offer = (action: UpdateAction): UpdateOffer => ({
    version: release.version,
    current: runtime.version,
    pageUrl: release.pageUrl,
    action,
    ...(beta ? { beta: true } : {}),
  });
  switch (runtime.channel) {
    case "macos":
    case "appimage": {
      if (!beta) return offer({ kind: "self" });
      // Beta installs from the offered release's own manifest; without one there is
      // nothing signed to install, so the page instead.
      const manifest = release.assets.find((asset) => asset.name === "latest.json");
      return offer(manifest ? { kind: "self", manifest: manifest.url } : { kind: "page" });
    }
    case "deb":
    case "android": {
      const asset = pickAsset(runtime.channel, runtime.arch, release.assets);
      if (!asset) return offer({ kind: "page" });
      return offer(runtime.channel === "deb" ? { kind: "deb", asset } : { kind: "apk", asset });
    }
    case "web":
      return offer({ kind: "git-pull" });
    case "docker":
      return offer({ kind: "docker", mode: runtime.docker ?? "auto" });
    case "manual":
      return offer({ kind: "page" });
  }
}

/** The fallback a `.deb` user can paste into a terminal. */
export function aptCommand(asset: ReleaseAsset): string {
  return `sudo apt install ./${asset.name}`;
}

/** What a self-hosted build's operator runs: the README's update steps. */
export const GIT_PULL_COMMAND = "git pull && npm --prefix web ci && npm --prefix web run build";

/** What a Docker deployment's operator runs to restart it, which is the update. */
export const DOCKER_RESTART_COMMAND = "docker compose restart";

/** With `WINNOW_AUTO_UPDATE=false`, the image is the version: pull a newer one. */
export const DOCKER_PULL_COMMAND = "docker compose pull && docker compose up -d";

/**
 * What the operator of a deployment Winnow cannot update itself is told: the words
 * before the command, the command, and the words after. `null` for a runtime that has
 * a button instead (`offerButton`).
 */
export function operatorUpdate(offer: UpdateOffer): { before: string; command: string; after: string } | null {
  const action = offer.action;
  if (action.kind === "git-pull") {
    return { before: "This copy runs from your own deployment. To update it, run", command: GIT_PULL_COMMAND, after: "in your clone, then redeploy." };
  }
  if (action.kind !== "docker") return null;
  switch (action.mode) {
    case "auto":
      return {
        before: "This copy runs in Docker and fetches the newest release each time it starts. To update it, restart the container:",
        command: DOCKER_RESTART_COMMAND,
        after: "(or stop and start it).",
      };
    case "pinned":
      return {
        before: `This copy runs in Docker, pinned to one release. To update it, set WINNOW_VERSION to v${offer.version} (or remove it), then run`,
        command: "docker compose up -d",
        after: "to restart the container.",
      };
    case "image":
      return {
        before: "This copy runs in Docker with automatic updates off, so the image is the version. To update it, run",
        command: DOCKER_PULL_COMMAND,
        after: "",
      };
  }
}

/** The pill's words for an offer. */
export function offerText(offer: UpdateOffer): string {
  if (offer.action.kind === "git-pull") return `Winnow ${offer.version} is out. Run git pull to update.`;
  if (offer.action.kind === "docker") {
    return offer.action.mode === "auto"
      ? `Winnow ${offer.version} is out. Restart the container to update.`
      : `Winnow ${offer.version} is out. Update the container to get it.`;
  }
  return `Winnow ${offer.version} is available.`;
}

/** The pill's button for an offer, or `null` when there is nothing to press. */
export function offerButton(offer: UpdateOffer): string | null {
  switch (offer.action.kind) {
    case "self":
    case "deb":
    case "apk":
      return "Update";
    case "page":
      return "Download";
    case "git-pull":
    case "docker":
      return null;
  }
}

// ── Stored state: when we last checked, and what was dismissed ────────────────

export type UpdateState = {
  /** Automatic checks on launch and every few hours. Off: only "Check now". */
  auto: boolean;
  /** When the last check finished (ms), successful or not. */
  lastCheckAt: number;
  /** Whether that check failed (then the next comes after `RETRY_AFTER_FAILURE_MS`). */
  lastCheckFailed: boolean;
  /** The newest version the user has seen the notice for and let go; never announced again. */
  dismissed: string | null;
};

export const DEFAULT_UPDATE_STATE: UpdateState = {
  auto: true,
  lastCheckAt: 0,
  lastCheckFailed: false,
  dismissed: null,
};

/** Tolerant: the input is `localStorage`, and anything can be in there. */
export function parseUpdateState(raw: string | null | undefined): UpdateState {
  if (!raw) return { ...DEFAULT_UPDATE_STATE };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object") return { ...DEFAULT_UPDATE_STATE };
    return {
      auto: value.auto !== false,
      lastCheckAt:
        typeof value.lastCheckAt === "number" && Number.isFinite(value.lastCheckAt) && value.lastCheckAt > 0
          ? value.lastCheckAt
          : 0,
      lastCheckFailed: value.lastCheckFailed === true,
      dismissed: typeof value.dismissed === "string" && parseVersion(value.dismissed) ? value.dismissed : null,
    };
  } catch {
    return { ...DEFAULT_UPDATE_STATE };
  }
}

export function serialiseUpdateState(state: UpdateState): string {
  return JSON.stringify(state);
}

/**
 * Whether an automatic check is due: automatic checks on, online, and the last one
 * long enough ago. A clock that went backwards (last check "in the future") counts as
 * due, so a wrong clock cannot switch checks off for good.
 */
export function checkDue(state: UpdateState, now: number, online: boolean): boolean {
  if (!state.auto || !online) return false;
  if (state.lastCheckAt === 0 || state.lastCheckAt > now) return true;
  const wait = state.lastCheckFailed ? RETRY_AFTER_FAILURE_MS : CHECK_INTERVAL_MS;
  return now - state.lastCheckAt >= wait;
}

/** Milliseconds until the next automatic check is due (0 when due now). */
export function msUntilDue(state: UpdateState, now: number): number {
  if (state.lastCheckAt === 0 || state.lastCheckAt > now) return 0;
  const wait = state.lastCheckFailed ? RETRY_AFTER_FAILURE_MS : CHECK_INTERVAL_MS;
  return Math.max(0, state.lastCheckAt + wait - now);
}

/**
 * Whether the pill should announce `offer`: not when the user already let this version
 * (or a newer one) go. A newer release than the dismissed one is announced once more.
 */
export function shouldAnnounce(offer: UpdateOffer | null, state: UpdateState): boolean {
  if (!offer) return false;
  if (!state.dismissed) return true;
  return isNewer(offer.version, state.dismissed);
}

/** The state after the user let `version` go (Dismiss, or the notice timing out). */
export function dismiss(state: UpdateState, version: string): UpdateState {
  if (state.dismissed && !isNewer(version, state.dismissed)) return state;
  return { ...state, dismissed: version };
}

/** The state after a check finished at `now`. */
export function recordCheck(state: UpdateState, now: number, ok: boolean): UpdateState {
  return { ...state, lastCheckAt: now, lastCheckFailed: !ok };
}

// ── The check ─────────────────────────────────────────────────────────────────

export type CheckResult =
  | { kind: "offer"; offer: UpdateOffer }
  | { kind: "current"; latest: string | null }
  | { kind: "failed"; reason: string };

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Ask GitHub for the latest release and plan it for `runtime`. Never throws. A 404
 * (a repository with no published release yet) is "current", not a failure.
 *
 * Stable reads `releases/latest`; a `-` tag there (a pre-release marked latest by
 * mistake) is "current", not an offer. Beta (`betaChannel`) reads `/releases` and plans
 * the newest release of any kind.
 */
export async function checkForUpdate(
  runtime: UpdateRuntime,
  fetcher: FetchLike,
  signal?: AbortSignal,
): Promise<CheckResult> {
  try {
    const beta = betaChannel(runtime);
    const response = await fetcher(beta ? RELEASES_LIST_URL : RELEASES_LATEST_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal,
    });
    if (response.status === 404) return { kind: "current", latest: null };
    if (!response.ok) return { kind: "failed", reason: `GitHub answered ${response.status}` };
    const body = await response.json();
    if (beta) {
      const newest = newestRelease(body);
      if (!newest) return { kind: "current", latest: null };
      const offer = planUpdate(runtime, newest);
      return offer ? { kind: "offer", offer } : { kind: "current", latest: newest.version };
    }
    if (body && typeof body === "object" && typeof (body as { tag_name?: unknown }).tag_name === "string" &&
      ((body as { tag_name: string }).tag_name.includes("-") || (body as { prerelease?: unknown }).prerelease === true)) {
      return { kind: "current", latest: null };
    }
    const release = parseRelease(body);
    if (!release) return { kind: "failed", reason: "the latest release could not be read" };
    const offer = planUpdate(runtime, release);
    return offer ? { kind: "offer", offer } : { kind: "current", latest: release.version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: message || "the network request failed" };
  }
}
