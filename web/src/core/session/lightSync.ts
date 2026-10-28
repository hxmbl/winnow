/**
 * The light sync of an account that is not open (1.4.0): its unread count, and the new
 * mail to notify about. Nothing else of it is held in memory or written to its cache;
 * the full mirror is only ever the open account's.
 *
 * One `messages.list` for `in:inbox is:unread` per check (5 quota units), compared with
 * the unread ids the last check saw (`winnow.lightSync.v1@<id>`). Ids that are new get one
 * metadata read each, newest first and at most `MAX_FETCHED`, for the notification's
 * sender and subject. The first check after an account is added or left only records
 * what is there: mail that was already waiting is not news (`seed` records the open
 * account's unread inbox as it is left, for the same reason).
 *
 * A new id counts as seen only once its read is settled: read (notified, or not inbox
 * unread any more), gone from Gmail (404), or failed `MAX_LOOKUP_ATTEMPTS` checks in a row.
 * A read that fails otherwise (offline, 5xx, rate limit) leaves it new, with its attempts
 * counted in the record (`retry`), so the next check notifies it, once.
 */

import type { GmailClient } from "../gmail/client";
import { toEmail } from "../gmail/mapper";
import type { Email } from "../model/email";
import type { KeyValueStorage } from "./accounts";

export const LIGHT_SYNC_KEY = "winnow.lightSync.v1";
/** How many unread ids are listed (and so the most the count reads exactly). */
export const LIGHT_SYNC_LIST = 100;
/** New messages read per check, for notifications. */
export const MAX_FETCHED = 5;

/** Checks in a row a new message's read may fail before it is given up (counted as seen). */
export const MAX_LOOKUP_ATTEMPTS = 3;

/** `retry`: failed reads so far, by id, of new messages not counted as seen yet. */
type Seen = { ids: string[]; retry?: Record<string, number> };

export type LightSyncResult = {
  /** Unread in the inbox: exact up to `LIGHT_SYNC_LIST`, Gmail's estimate past it. */
  unread: number;
  /** New unread inbox mail since the last check, newest first. */
  fresh: Email[];
  /**
   * Ids that were unread in the Inbox at the last check and are not now (read, archived,
   * deleted or moved, here or elsewhere): their notifications can go. Only from a
   * complete listing; past `LIGHT_SYNC_LIST` an id falling off the end says nothing.
   */
  left: string[];
};

export class LightSync {
  constructor(
    private readonly client: Pick<GmailClient, "list" | "message">,
    /** The account's scoped storage (`scopedStorage`). */
    private readonly storage: KeyValueStorage | null,
  ) {}

  private seen(): Seen | null {
    try {
      const raw = this.storage?.getItem(LIGHT_SYNC_KEY);
      const parsed = raw ? (JSON.parse(raw) as Seen) : null;
      if (!parsed || !Array.isArray(parsed.ids)) return null;
      const retry: Record<string, number> = {};
      if (parsed.retry && typeof parsed.retry === "object") {
        for (const [id, count] of Object.entries(parsed.retry)) {
          if (typeof count === "number" && Number.isFinite(count) && count > 0) retry[id] = count;
        }
      }
      return { ids: parsed.ids.filter((id) => typeof id === "string"), retry };
    } catch {
      return null;
    }
  }

  private remember(ids: readonly string[], retry: Record<string, number> = {}): void {
    try {
      const record: Seen = { ids: ids.slice(0, LIGHT_SYNC_LIST) };
      if (Object.keys(retry).length > 0) record.retry = retry;
      this.storage?.setItem(LIGHT_SYNC_KEY, JSON.stringify(record));
    } catch {
      // The next check notifies again rather than never.
    }
  }

  /** What is unread now counts as seen: called as the account stops being the open one. */
  seed(unreadInboxIds: readonly string[]): void {
    this.remember(unreadInboxIds);
  }

  /** The check in flight: a second caller meanwhile shares its count, not its news. */
  private running: Promise<LightSyncResult> | null = null;

  /**
   * One check at a time per account. The ids are remembered only after their reads, so a
   * check overlapping another would otherwise read, and notify, the same new mail again.
   */
  check(): Promise<LightSyncResult> {
    if (this.running) return this.running.then((result) => ({ unread: result.unread, fresh: [], left: [] }));
    const run = this.run().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(): Promise<LightSyncResult> {
    const listing = await this.client.list("in:inbox is:unread", LIGHT_SYNC_LIST);
    const ids = (listing.messages ?? []).map((message) => message.id);
    const unread = Math.max(ids.length, ids.length >= LIGHT_SYNC_LIST ? (listing.resultSizeEstimate ?? 0) : 0);
    const before = this.seen();
    if (!before) {
      this.remember(ids);
      return { unread, fresh: [], left: [] };
    }
    const known = new Set(before.ids);
    const now = new Set(ids);
    const left = ids.length < LIGHT_SYNC_LIST ? before.ids.filter((id) => !now.has(id)) : [];
    const fresh: Email[] = [];
    /** New ids whose read failed and is to be tried again, with the attempts so far. */
    const retry: Record<string, number> = {};
    for (const id of ids.filter((candidate) => !known.has(candidate)).slice(0, MAX_FETCHED)) {
      try {
        const email = toEmail(await this.client.message(id, "metadata"), { format: "metadata" });
        if (email && email.unread && email.mailbox === "inbox") fresh.push(email);
      } catch (error) {
        // Gone from Gmail (deleted between the list and the read) is settled: nothing to say.
        if ((error as { status?: number } | null)?.status === 404) continue;
        const attempts = (before.retry?.[id] ?? 0) + 1;
        // Past the cap it is given up, so one broken message cannot cost a read every check.
        if (attempts < MAX_LOOKUP_ATTEMPTS) retry[id] = attempts;
      }
    }
    // Everything listed counts as seen except the reads to try again. New ids past
    // `MAX_FETCHED` count as seen unread, as before: a burst notifies its newest few.
    this.remember(
      ids.filter((id) => retry[id] === undefined),
      retry,
    );
    return { unread, fresh: fresh.sort((a, b) => b.receivedAt - a.receivedAt), left };
  }
}
