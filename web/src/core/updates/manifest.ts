/**
 * The Tauri updater's `latest.json`, built by the release workflow
 * (`web/scripts/updater-manifest.mjs`) from the signed updater artifacts.
 *
 * Pure and dependency-free so the script can run it straight from TypeScript (Node's
 * type stripping) and the test suite can check it.
 *
 * Platform keys, as `tauri-plugin-updater` looks them up (`{os}-{arch}`, then
 * `{os}-{arch}-{installer}`):
 *
 * - macOS ships one universal app, so `darwin-aarch64` and `darwin-x86_64` (and their
 *   `-app` forms) all point at the same `.app.tar.gz` and its signature.
 * - Linux: `linux-x86_64` and `linux-x86_64-appimage` point at the AppImage. Only an
 *   AppImage install asks the updater (`updater.rs`); a `.deb` install never does, so
 *   it can never be handed the AppImage.
 */

export type SignedArtifact = {
  /** The release asset's file name, e.g. `Winnow_1.5.0_universal.app.tar.gz`. */
  name: string;
  /** The contents of its `.sig` file (minisign, base64), exactly as the CLI wrote it. */
  signature: string;
};

export type ManifestInput = {
  version: string;
  tag: string;
  /** `owner/repo`. */
  repo: string;
  /** The release notes (the GitHub release body). */
  notes: string;
  /** RFC 3339. */
  pubDate: string;
  macos?: SignedArtifact | null;
  appimage?: SignedArtifact | null;
};

export type UpdaterManifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

export const MAC_KEYS = ["darwin-aarch64", "darwin-x86_64", "darwin-aarch64-app", "darwin-x86_64-app"] as const;
export const APPIMAGE_KEYS = ["linux-x86_64", "linux-x86_64-appimage"] as const;

/** The download URL of a release asset. */
export function assetUrl(repo: string, tag: string, name: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** `latest.json` for a release. Throws when there is nothing signed to put in it. */
export function buildManifest(input: ManifestInput): UpdaterManifest {
  const platforms: UpdaterManifest["platforms"] = {};
  const add = (keys: readonly string[], artifact: SignedArtifact | null | undefined) => {
    if (!artifact) return;
    const signature = artifact.signature.trim();
    if (!signature) throw new Error(`empty signature for ${artifact.name}`);
    for (const key of keys) platforms[key] = { signature, url: assetUrl(input.repo, input.tag, artifact.name) };
  };
  add(MAC_KEYS, input.macos);
  add(APPIMAGE_KEYS, input.appimage);
  if (Object.keys(platforms).length === 0) throw new Error("no signed updater artifacts");
  return {
    version: input.version.replace(/^v/, ""),
    notes: input.notes,
    pub_date: input.pubDate,
    platforms,
  };
}
