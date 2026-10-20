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

type Seen = { ids: string[] };

export type LightSyncResult = {
  /** Unread in the inbox: exact up to `LIGHT_SYNC_LIST`, Gmail's estimate past it. */
  unread: number;
  /** New unread inbox mail since the last check, newest first. */
  fresh: Email[];
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
      return parsed && Array.isArray(parsed.ids) ? { ids: parsed.ids.filter((id) => typeof id === "string") } : null;
    } catch {
      return null;
    }
  }

  private remember(ids: readonly string[]): void {
    try {
      this.storage?.setItem(LIGHT_SYNC_KEY, JSON.stringify({ ids: ids.slice(0, LIGHT_SYNC_LIST) }));
    } catch {
      // The next check notifies again rather than never.
    }
  }

  /** What is unread now counts as seen: called as the account stops being the open one. */
  seed(unreadInboxIds: readonly string[]): void {
    this.remember(unreadInboxIds);
  }

  async check(): Promise<LightSyncResult> {
    const listing = await this.client.list("in:inbox is:unread", LIGHT_SYNC_LIST);
    const ids = (listing.messages ?? []).map((message) => message.id);
    const unread = Math.max(ids.length, ids.length >= LIGHT_SYNC_LIST ? (listing.resultSizeEstimate ?? 0) : 0);
    const before = this.seen();
    this.remember(ids);
    if (!before) return { unread, fresh: [] };
    const known = new Set(before.ids);
    const fresh: Email[] = [];
    for (const id of ids.filter((candidate) => !known.has(candidate)).slice(0, MAX_FETCHED)) {
      try {
        const email = toEmail(await this.client.message(id, "metadata"), { format: "metadata" });
        if (email && email.unread && email.mailbox === "inbox") fresh.push(email);
      } catch {
        // One unreadable message costs only its notification.
      }
    }
    return { unread, fresh: fresh.sort((a, b) => b.receivedAt - a.receivedAt) };
  }
}
