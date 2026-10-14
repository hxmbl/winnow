/**
 * Google's address book, kept locally and refreshed incrementally.
 *
 * The mail in the store says who the user corresponds with; this says who they have
 * *saved*, and who Google remembers them writing to from anywhere (other devices, the
 * Gmail web app, mail older than the sync window). `buildContactIndex` merges the two.
 *
 * **Sync tokens, not re-listing.** Each listing is fetched in full once, with
 * `requestSyncToken`, and every refresh after that asks only for what changed. A
 * removal arrives as a person with `metadata.deleted`, so the local copy can drop it.
 * Google expires a token after about a week; an expired one is answered by forgetting
 * that listing and fetching it whole again — never by surfacing an error, because the
 * user has done nothing wrong and the fix is mechanical.
 *
 * **All or nothing per listing.** Changes are applied only once every page of a listing
 * has arrived. A refresh that fails on page three leaves the previous copy and the
 * previous token exactly as they were, so the next refresh replays the same changes
 * rather than skipping the two pages it already saw.
 *
 * **Stored beside the mail cache, cleared with it.** The address book is the user's
 * data in the same sense their mail is, so signing out erases it (`GmailSession.signOut`).
 */

import { normalizeAddress } from "./addresses";
import {
  ExpiredSyncToken,
  type PeopleClient,
  type PeoplePerson,
  type PeopleSource,
} from "../gmail/people";

/** One address from Google, ready for the contact index. */
export type GoogleContact = {
  address: string;
  name?: string;
  /** Saved contacts rank above other contacts. See `SOURCE_PRIOR` in `index.ts`. */
  source: PeopleSource;
};

/** One person as stored: the parts the index reads, and nothing else. */
type StoredPerson = { name?: string; emails: string[] };

/** One listing's local copy and the cursor that continues it. */
type ListingState = {
  /** Absent until a full listing has completed, which forces a full listing next time. */
  syncToken?: string;
  /** Keyed by `resourceName`, because that is how a change or a deletion names its target. */
  people: Record<string, StoredPerson>;
};

export type GoogleContactsSnapshot = {
  version: 1;
  saved: ListingState;
  other: ListingState;
  /** When the last refresh finished, for deciding whether another is worth it. */
  syncedAt: number | null;
};

export function emptySnapshot(): GoogleContactsSnapshot {
  return { version: 1, saved: { people: {} }, other: { people: {} }, syncedAt: null };
}

/** Where the snapshot lives. `localStorage` on both hosts, like the mail cache. */
export interface GoogleContactsStore {
  read(): Promise<GoogleContactsSnapshot | null>;
  write(snapshot: GoogleContactsSnapshot): Promise<void>;
  clear(): Promise<void>;
}

/**
 * A `localStorage`-backed store.
 *
 * Every accessor is guarded for the reason `localCache` gives: Safari private mode and a
 * full quota throw rather than return. A store that cannot persist still works for the
 * session, and the next launch simply lists everything again.
 */
export function localContactsStore(key = "winnow.google.contacts.v1"): GoogleContactsStore {
  return {
    async read() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        if (!raw) return null;
        return reviveSnapshot(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    async write(snapshot) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(snapshot));
      } catch {
        // Kept in memory for this run; the next launch does a full listing.
      }
    },
    async clear() {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Already unreachable.
      }
    },
  };
}

/** A stored snapshot, or `null` for anything this build does not recognise. */
export function reviveSnapshot(raw: unknown): GoogleContactsSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<GoogleContactsSnapshot>;
  if (source.version !== 1) return null;
  const listing = (value: unknown): ListingState | null => {
    if (!value || typeof value !== "object") return null;
    const state = value as Partial<ListingState>;
    if (!state.people || typeof state.people !== "object") return null;
    const people: Record<string, StoredPerson> = {};
    for (const [resourceName, person] of Object.entries(state.people)) {
      if (!person || !Array.isArray(person.emails)) continue;
      const emails = person.emails.filter((email): email is string => typeof email === "string");
      people[resourceName] = { name: typeof person.name === "string" ? person.name : undefined, emails };
    }
    return { syncToken: typeof state.syncToken === "string" ? state.syncToken : undefined, people };
  };
  const saved = listing(source.saved);
  const other = listing(source.other);
  if (!saved || !other) return null;
  return {
    version: 1,
    saved,
    other,
    syncedAt: typeof source.syncedAt === "number" ? source.syncedAt : null,
  };
}

/**
 * The parts of a People API person the index uses.
 *
 * The primary name and the primary address first, because the primary is what the
 * person chose to be called and written to; the rest follow so every address they have
 * is findable. `null` for a person with no address at all — a phone-only contact is
 * nobody the composer can offer.
 */
export function toStoredPerson(person: PeoplePerson): StoredPerson | null {
  const names = person.names ?? [];
  const primaryName = names.find((name) => name.metadata?.primary) ?? names[0];
  const name = primaryName?.displayName?.trim() || undefined;

  const ordered = [...(person.emailAddresses ?? [])].sort(
    (a, b) => Number(Boolean(b.metadata?.primary)) - Number(Boolean(a.metadata?.primary)),
  );
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const entry of ordered) {
    const value = entry.value?.trim();
    if (!value || !value.includes("@")) continue;
    const key = normalizeAddress(value);
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(value);
  }
  if (emails.length === 0) return null;
  return { name, emails };
}

/**
 * Fold one listing's pages into its previous state.
 *
 * A full listing replaces the people outright, which is what makes a contact deleted
 * while the token was expired disappear. An incremental one applies each change in
 * order: a deletion drops the person, anything else replaces them whole (Google sends
 * the full requested fields of a changed person, not a diff).
 */
export function applyListing(
  previous: ListingState,
  pages: readonly PeoplePerson[][],
  mode: "full" | "incremental",
  syncToken: string | undefined,
): ListingState {
  const people: Record<string, StoredPerson> = mode === "full" ? {} : { ...previous.people };
  for (const page of pages) {
    for (const person of page) {
      if (!person.resourceName) continue;
      if (person.metadata?.deleted) {
        delete people[person.resourceName];
        continue;
      }
      const stored = toStoredPerson(person);
      if (stored) people[person.resourceName] = stored;
      else delete people[person.resourceName];
    }
  }
  return { syncToken, people };
}

/**
 * The snapshot as a flat list, one row per address.
 *
 * An address that is both a saved contact and an other contact is listed once, as
 * saved: Google keeps the two listings separately and it is common for both to hold the
 * same person, but the stronger claim is the one that should rank.
 */
export function flattenSnapshot(snapshot: GoogleContactsSnapshot): GoogleContact[] {
  const out = new Map<string, GoogleContact>();
  const add = (listing: ListingState, source: PeopleSource): void => {
    // Sorted by resource name so the result does not depend on the order a JSON object
    // happened to be filled in — the index breaks ties alphabetically, but the *name*
    // chosen for a shared address should be stable too.
    for (const resourceName of Object.keys(listing.people).sort()) {
      const person = listing.people[resourceName];
      for (const address of person.emails) {
        const key = normalizeAddress(address);
        const existing = out.get(key);
        if (existing && (existing.source === "saved" || source === "other")) {
          if (!existing.name && person.name) existing.name = person.name;
          continue;
        }
        out.set(key, { address, name: person.name ?? existing?.name, source });
      }
    }
  };
  add(snapshot.saved, "saved");
  add(snapshot.other, "other");
  return [...out.values()];
}

/** How many pages one listing is allowed before the refresh gives up on it. */
export const MAX_PAGES = 50;

type GoogleContactsSyncOptions = {
  client: Pick<PeopleClient, "list">;
  store: GoogleContactsStore;
  now?: () => number;
};

/**
 * The refresh loop for both listings.
 *
 * One refresh at a time: the composer and the post-sync hook can both ask, and two
 * refreshes racing would both read the same token and both write, with the loser's
 * older snapshot landing last.
 */
export class GoogleContactsSync {
  private snapshot: GoogleContactsSnapshot | null = null;
  private inflight: Promise<GoogleContact[]> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: GoogleContactsSyncOptions) {
    this.now = options.now ?? Date.now;
  }

  /** What is stored, without touching the network. Empty before any refresh. */
  async cached(): Promise<GoogleContact[]> {
    return flattenSnapshot(await this.load());
  }

  /** When the last refresh finished, or `null` if none has. */
  async lastSyncedAt(): Promise<number | null> {
    return (await this.load()).syncedAt;
  }

  /** Fetch what changed in both listings, persist it, and return the merged list. */
  refresh(): Promise<GoogleContact[]> {
    if (this.inflight) return this.inflight;
    const attempt = this.run();
    this.inflight = attempt;
    void attempt
      .catch(() => undefined)
      .finally(() => {
        if (this.inflight === attempt) this.inflight = null;
      });
    return attempt;
  }

  /** Forget everything — on sign-out, or when access is revoked. */
  async clear(): Promise<void> {
    this.snapshot = emptySnapshot();
    await this.options.store.clear();
  }

  private async load(): Promise<GoogleContactsSnapshot> {
    if (this.snapshot) return this.snapshot;
    this.snapshot = (await this.options.store.read()) ?? emptySnapshot();
    return this.snapshot;
  }

  private async run(): Promise<GoogleContact[]> {
    const previous = await this.load();
    // Saved first: if the other-contacts listing fails, the more valuable half has
    // still landed and is persisted below.
    const saved = await this.syncListing("saved", previous.saved);
    const afterSaved: GoogleContactsSnapshot = { ...previous, saved };
    this.snapshot = afterSaved;
    await this.options.store.write(afterSaved);

    const other = await this.syncListing("other", previous.other);
    const next: GoogleContactsSnapshot = { ...afterSaved, other, syncedAt: this.now() };
    this.snapshot = next;
    await this.options.store.write(next);
    return flattenSnapshot(next);
  }

  /**
   * One listing, incremental when there is a token and full when there is not — or when
   * Google refuses the token, which is the one failure handled here rather than thrown.
   */
  private async syncListing(source: PeopleSource, previous: ListingState): Promise<ListingState> {
    if (previous.syncToken) {
      try {
        const { pages, nextSyncToken } = await this.listAll(source, previous.syncToken);
        // A page set that ends without a new token keeps the old one: an incremental
        // listing with nothing to report is still a valid continuation point.
        return applyListing(previous, pages, "incremental", nextSyncToken ?? previous.syncToken);
      } catch (error) {
        if (!(error instanceof ExpiredSyncToken)) throw error;
        // Fall through to a full listing.
      }
    }
    const { pages, nextSyncToken } = await this.listAll(source, undefined);
    return applyListing(previous, pages, "full", nextSyncToken);
  }

  private async listAll(
    source: PeopleSource,
    syncToken: string | undefined,
  ): Promise<{ pages: PeoplePerson[][]; nextSyncToken?: string }> {
    const pages: PeoplePerson[][] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.options.client.list(source, { pageToken, syncToken });
      pages.push(result.people);
      if (!result.nextPageToken) return { pages, nextSyncToken: result.nextSyncToken };
      pageToken = result.nextPageToken;
    }
    // Past any address book the composer can usefully rank. Keep what arrived, but no
    // token: the next refresh starts over rather than continue an unfinished listing.
    return { pages };
  }
}
