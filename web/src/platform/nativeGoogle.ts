/**
 * Reading what the Android sign-in plugin hands back.
 *
 * The plugin (Kotlin, `gen/android/.../signin/GoogleSignInPlugin.kt`) answers through
 * Rust's `google_signin_*` commands, which pass its JSON through untouched. Nothing
 * here trusts the shape: anything unexpected is `unavailable`, which sends the sign-in
 * to the browser, rather than a half-read code.
 */

import type { AppSigningInfo, NativeSignInResult, NativeUnavailableReason } from "./types";

const REASONS: readonly NativeUnavailableReason[] = [
  "unsupported",
  "no_play_services",
  "developer_error",
  "network",
  "failed",
];

/** A certificate fingerprint as Android and the Cloud Console write it: `AA:BB:…`. */
const SHA1_PATTERN = /^(?:[0-9A-F]{2}:){19}[0-9A-F]{2}$/;

/** Cap on anything echoed from the plugin, so a stack trace never reaches the screen. */
const DETAIL_LIMIT = 200;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, DETAIL_LIMIT) : "";
}

export function unavailable(reason: NativeUnavailableReason, detail: string): NativeSignInResult {
  return { kind: "unavailable", reason, detail: detail.slice(0, DETAIL_LIMIT) };
}

/** The plugin's answer to `authorize`, or `unavailable` when it is not one. */
export function parseNativeSignInResult(raw: unknown): NativeSignInResult {
  if (!raw || typeof raw !== "object") return unavailable("failed", "no answer from the sign-in plugin");
  const value = raw as Record<string, unknown>;
  if (value.kind === "code") {
    const code = typeof value.code === "string" ? value.code.trim() : "";
    if (!code) return unavailable("failed", "Google returned no authorization code");
    const granted = Array.isArray(value.grantedScopes)
      ? value.grantedScopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
      : [];
    return { kind: "code", code, grantedScopes: granted };
  }
  if (value.kind === "cancelled") return { kind: "cancelled" };
  if (value.kind === "unavailable") {
    const reason = REASONS.includes(value.reason as NativeUnavailableReason)
      ? (value.reason as NativeUnavailableReason)
      : "failed";
    return unavailable(reason, text(value.detail));
  }
  return unavailable("failed", "unrecognised answer from the sign-in plugin");
}

/** The plugin's `signingInfo`, or `null` when it is not usable. */
export function parseSigningInfo(raw: unknown): AppSigningInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const packageName = text(value.packageName);
  if (!packageName) return null;
  const sha1 = typeof value.sha1 === "string" && SHA1_PATTERN.test(value.sha1) ? value.sha1 : null;
  return { packageName, sha1, playServices: value.playServices === true };
}
