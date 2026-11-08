/**
 * Utility functions and constants extracted from App.tsx
 */

import type { Draft } from "../core/model/email";
import type { ComposerState } from "./types";
import type { Snapshot } from "../core/store/store";
import type { PlatformInfo } from "../platform/types";
import { DEMO_ACCOUNT } from "../core/data/demo";
import { stripQuote } from "../core/mail/reply";
import { isUntouchedNewDraft } from "../core/mail/compose";

/**
 * Whether the one-time session restore has already been started.
 *
 * Module scope on purpose: a `useRef` would be reset by StrictMode's teardown-and-rebuild
 * — the very thing it is meant to survive — and a `useState` would render differently on
 * the second pass, a StrictMode warning of its own.
 */
export const sessionRestoreStarted = false;

/** A promise and its resolver, for "once the launch has finished restoring". */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * How stale Google contacts may get before opening the composer refreshes them.
 *
 * Fifteen minutes: an incremental refresh is one cheap request per listing, but the
 * composer opens far more often than anyone adds a contact.
 */
export const CONTACTS_REFRESH_MS = 15 * 60_000;

export const HALF_GRANT_MESSAGE =
  "Google did not grant both contact permissions. Tick both boxes on Google's screen to use them.";

/** How long "Draft saved." stays up after a half-written reply is put away, in ms. */
export const DRAFT_NOTICE_MS = 4000;

/** How long "Message sent." stays up before it clears itself, in ms. */
export const SENT_NOTICE_MS = 6000;

/** How long the pill says a scheduled message went, or was scheduled. */
export const SCHEDULED_SENT_NOTICE_MS = 6000;

/** How often the open app looks for snoozes to wake and scheduled sends to go. */
export const DUE_CHECK_MS = 15_000;

/**
 * Where this Winnow runs, for Settings → About: "Desktop app · linux x86_64", "Browser".
 */
export function platformLabel(info: PlatformInfo): string {
  if (info.kind === "web") return "Browser";
  if (info.os === "android") return "Android app";
  return `Desktop app · ${info.os}${info.arch && info.arch !== "unknown" ? ` ${info.arch}` : ""}`;
}

/**
 * The user's own address, for leaving it off a reply-all: the demo's is its seeded account.
 */
export function selfAddressOf(snap: Pick<Snapshot, "contactsAccess" | "account">): string | undefined {
  return snap.account?.email ?? (snap.contactsAccess === "demo" ? DEMO_ACCOUNT.email : undefined);
}

/**
 * Whose drafts these are: the signed-in address, `demo`, or `null` before either.
 */
export function draftAccount(snap: Pick<Snapshot, "contactsAccess" | "account">): string | null {
  if (snap.contactsAccess === "demo") return "demo";
  return snap.account?.email ?? null;
}

/** A blank new message's recipients and subject, the baseline for "untouched". */
export const BLANK_INITIAL: NonNullable<ComposerState["initial"]> = { to: [], cc: [], bcc: [], subject: "" };

/**
 * Whether discarding this draft would lose anything the user wrote.
 *
 * Not "is the body empty" but "is the user's *contribution* empty": a reply's body starts
 * as the quoted original, so `stripQuote` removes an untouched quote suffix, and a
 * forward's baseline is recorded in `Draft.prefilled`.
 *
 * Getting this wrong is not cosmetic: testing the body for emptiness made *every* forward
 * "written", so opening one with `f` and pressing Escape asked whether to throw away text
 * Winnow had just put there — which trains people to click through confirmations.
 */
export function isUntouchedDraft(draft: Draft, initial?: ComposerState["initial"]): boolean {
  if (initial) return isUntouchedNewDraft(draft, initial);
  if ((draft.attachments?.length ?? 0) > 0) return false;
  const written = stripQuote(draft.body, draft.quoteBlock).trim();
  return written === (draft.prefilled ?? "").trim();
}
