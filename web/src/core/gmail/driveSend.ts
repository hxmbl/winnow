/**
 * Drive links at the moment a message is dispatched: what to share, whether the user has
 * to be asked first, and what to take back. The Drive calls are `drive.ts`; this is the
 * decision around them, kept out of `App` so it can be tested.
 *
 * **When.** Never at Send-tap. The composer only checks, without the network, whether a
 * message with Winnow's own Drive links can be shared at all (`needsDriveGrant`): if the
 * token lacks `drive.file` (signed out and back in, or the permission removed at Google),
 * the user is asked before anything is scheduled — allow Drive again, or send anyway
 * knowing the recipients may not be able to open the link. The sharing itself happens at
 * dispatch (`prepareDriveDispatch`): when the undo window has run out (or at once with
 * Undo send off), and for a send the offline queue holds, when the queue replays it
 * (`prepareQueuedShare`). A message that is undone, kept as a draft or discarded before
 * then has shared nothing.
 *
 * **What is taken back.** Each dispatch records the permission ids it created (never one
 * that was already there: `shareForSend` reads a file's permissions first). They stay
 * with the message while it might still go: a send that fails and is retried keeps them,
 * and the retry adds only what is missing. They are taken back when the message is
 * abandoned instead — Keep editing on the share warning, the composer discarded or put
 * away as a draft, Undo, a queued send Gmail refused, a sign-out with sends still
 * waiting — and, on a retry, the ones for a recipient or link no longer on the message
 * (`stale`).
 */

import type { Draft, DraftDriveShare, DrivePermissionRef } from "../model/email";
import {
  driveLinksForSend,
  driveUnreachable,
  recipientAddresses,
  shareForSend,
  type DriveApi,
  type ShareProblem,
} from "./drive";

/** The recipients a draft's links are shared with: To, Cc and Bcc. */
export function draftRecipients(draft: Pick<Draft, "to" | "cc" | "bcc">): string[] {
  return recipientAddresses(draft.to.join(", "), draft.cc.join(", "), draft.bcc.join(", "));
}

/**
 * At Send-tap, without the network: a message carrying Winnow's own Drive links while
 * Winnow may not use Drive has to ask first (allow again, or send anyway). Someone
 * else's link alone never asks: it is not Winnow's to share.
 */
export function needsDriveGrant(draft: Pick<Draft, "body" | "driveFiles">, allowed: boolean): boolean {
  if (allowed) return false;
  return driveLinksForSend(draft).some((link) => link.own);
}

export type DriveDispatchOptions = {
  /** Drive on this session's tokens (or the demo's); `null` when there is none. */
  api: DriveApi | null;
  /** Whether the device thinks it is online. Offline, sharing waits for the queue. */
  online: boolean;
  /** Whether `drive.file` is granted (the demo: allowed in its dialog). */
  allowed: boolean;
  /** The user saw the share warning and chose Send anyway. */
  accepted?: boolean;
  /** The user chose Send anyway without the grant: nothing is shared. */
  waived?: boolean;
  /** What an earlier attempt to send this message created (a failed send, kept for its retry). */
  prior?: readonly DrivePermissionRef[];
};

export type DriveDispatch =
  /**
   * Go ahead. `share` rides on the draft (`Draft.driveShare`): `shared` with what this
   * message created, `pending` for the queue to share at replay, or `waived`. `stale`:
   * permissions an earlier attempt made for a person or link no longer on it, to take back.
   */
  | { kind: "send"; share?: DraftDriveShare; stale: DrivePermissionRef[] }
  /**
   * Stop and ask. `grant`: Drive is not allowed. `problems`: some recipients could not be
   * given Winnow's own files. `failed`: something else (the Drive API off), with `error`.
   * `created` is what this message has made so far; it is kept while the user decides.
   */
  | {
      kind: "hold";
      reason: "grant" | "problems" | "failed";
      problems: ShareProblem[];
      created: DrivePermissionRef[];
      error?: unknown;
    };

/**
 * Share a draft's Drive links at dispatch, or say why the message has to wait for the user.
 */
export async function prepareDriveDispatch(
  draft: Pick<Draft, "body" | "driveFiles" | "to" | "cc" | "bcc">,
  options: DriveDispatchOptions,
): Promise<DriveDispatch> {
  const links = driveLinksForSend(draft);
  const recipients = draftRecipients(draft);
  const prior = options.prior ?? [];
  const keep = prior.filter(
    (permission) =>
      links.some((link) => link.id === permission.fileId) && recipients.includes(permission.email.toLowerCase()),
  );
  const stale = prior.filter((permission) => !keep.includes(permission));
  const share = (state: DraftDriveShare["state"], created: DrivePermissionRef[]): DraftDriveShare => ({
    links,
    recipients,
    state,
    created,
  });

  if (links.length === 0 || recipients.length === 0) return { kind: "send", stale };
  if (options.waived) return { kind: "send", share: share("waived", keep), stale };
  const own = links.some((link) => link.own);
  if (!options.api || !options.allowed) {
    if (own) return { kind: "hold", reason: "grant", problems: [], created: keep };
    // Only links that are not Winnow's, and no Drive: nothing of Winnow's to share.
    return { kind: "send", stale };
  }
  if (!options.online) return { kind: "send", share: share("pending", keep), stale };

  let made: DrivePermissionRef[] = [];
  try {
    const outcome = await shareForSend(options.api, links, recipients, (created) => {
      made = created;
    });
    const created = [...keep, ...outcome.created];
    if (outcome.problems.length > 0 && !options.accepted) {
      return { kind: "hold", reason: "problems", problems: outcome.problems, created };
    }
    return { kind: "send", share: share("shared", created), stale };
  } catch (error) {
    const created = [...keep, ...made];
    // No answer from Drive: the send goes to the offline queue, which shares at replay.
    if (driveUnreachable(error)) return { kind: "send", share: share("pending", created), stale };
    if (error instanceof Error && error.name === "DriveScopeMissing") {
      return { kind: "hold", reason: "grant", problems: [], created };
    }
    return { kind: "hold", reason: "failed", problems: [], created, error };
  }
}

/**
 * The offline queue's half: share a `pending` send just before it is replayed, recording
 * what it creates on `share` as it goes. Nobody is there to ask, so nothing holds the
 * message: refusals on Winnow's own links come back as `problems` (and a missing grant or
 * the API off as `failed`) for a notice, and the message goes. Throws only when Drive
 * gave no answer or the session needs signing in again, so the queue waits and retries.
 */
export async function prepareQueuedShare(
  api: DriveApi | null,
  share: DraftDriveShare,
): Promise<{ problems: ShareProblem[]; failed: unknown | null }> {
  if (share.state !== "pending") return { problems: [], failed: null };
  if (!api) {
    share.state = "shared";
    return { problems: [], failed: share.links.some((link) => link.own) ? new Error("Google Drive is not available.") : null };
  }
  try {
    const outcome = await shareForSend(api, share.links, share.recipients, (created) => {
      share.created = [...share.created, ...created];
    });
    share.state = "shared";
    return { problems: outcome.problems, failed: null };
  } catch (error) {
    if (driveUnreachable(error)) throw error;
    if (error instanceof Error && (error as { kind?: unknown }).kind === "reauth_required" && error.name !== "DriveScopeMissing") {
      throw error;
    }
    share.state = "shared";
    return { problems: [], failed: error };
  }
}

/** What the notice says when a queued send's links could not all be shared. */
export function queuedShareNotice(result: { problems: ShareProblem[]; failed: unknown | null }): string | null {
  if (result.failed) {
    return "A message waiting to send has Google Drive links Winnow couldn't share, so the recipients may not be able to open them.";
  }
  if (result.problems.length === 0) return null;
  const who = result.problems.map((problem) => problem.email).join(", ");
  return `A message waiting to send has Google Drive links ${who} can't open (Drive refused to share them).`;
}
