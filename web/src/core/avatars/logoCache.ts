/**
 * The brand-logo cache: one BIMI answer per sender domain, kept locally.
 *
 * - **Hits and misses both cached.** Most domains publish nothing, and asking DNS about
 *   them on every launch would be the bulk of the traffic. A logo is kept for a week, a
 *   "no logo" for a day. A lookup that *failed* (offline, resolver down) is not cached at
 *   all beyond a short cool-down, so it is retried rather than remembered as a miss.
 * - **One lookup per domain in flight.** Fifty rows from the same newsletter ask once.
 * - **Rate-limited.** At most `concurrency` lookups at a time and `perMinute` a minute,
 *   so scrolling through a large mailbox does not fire hundreds of DNS queries at once.
 *   Requests beyond that wait in a queue, newest first: the rows on screen now matter
 *   more than the ones scrolled past.
 * - **Never blocks.** `peek` is synchronous and returns what is known; `request` starts a
 *   lookup and notifies subscribers when it lands, so an avatar swaps in afterwards.
 * - **Cleared with the mail.** Signing out, or turning the setting off, calls `clear`.
 */

import { lookupBimiLogo, safeLogoUrl, senderDomain, type TxtResolver } from "./bimi";

export const LOGO_HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGO_MISS_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed lookup, how long before the same domain is tried again. */
export const LOGO_RETRY_MS = 10 * 60 * 1000;
/** Entries kept in storage. Oldest dropped first. */
export const MAX_LOGO_ENTRIES = 500;
export const LOGO_STORAGE_KEY = "winnow.brandLogos.v1";
/**
 * Lookups waiting behind the rate limit, at most. Scrolling through a few thousand
 * senders would otherwise queue a lookup for every row that ever flashed past; the
 * oldest requests (rows long scrolled away) are dropped, unanswered rather than
 * remembered, so a row that comes back asks again.
 */
export const MAX_QUEUED_LOOKUPS = 100;
/** A stored entry dated further ahead than this is a bad clock or a bad write, not a fact. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

type Entry = { url: string | null; at: number };

export interface LogoStorage {
  read(): Record<string, Entry> | null;
  write(entries: Record<string, Entry>): void;
  clear(): void;
}

/** `localStorage`, guarded the way every other cache in the app is. */
export function localLogoStorage(key: string = LOGO_STORAGE_KEY): LogoStorage {
  return {
    read() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? (JSON.parse(raw) as Record<string, Entry>) : null;
      } catch {
        return null;
      }
    },
    write(entries) {
      // Over quota: keep the newest half, then a quarter, and so on, rather than nothing
      // or (worse) the stale copy from the last write that fitted. If even a handful
      // will not fit, the key is removed and the cache lives in memory for this run.
      let keep = Object.entries(entries).sort(([, a], [, b]) => b.at - a.at);
      for (;;) {
        try {
          globalThis.localStorage?.setItem(key, JSON.stringify(Object.fromEntries(keep)));
          return;
        } catch {
          if (keep.length <= 1) break;
          keep = keep.slice(0, Math.floor(keep.length / 2));
        }
      }
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Storage is unusable; memory it is.
      }
    },
    clear() {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Already gone.
      }
    },
  };
}

export function memoryLogoStorage(): LogoStorage {
  let store: Record<string, Entry> | null = null;
  return {
    read: () => (store ? { ...store } : null),
    write: (entries) => {
      store = { ...entries };
    },
    clear: () => {
      store = null;
    },
  };
}

type Options = {
  resolve: TxtResolver;
  storage?: LogoStorage;
  now?: () => number;
  concurrency?: number;
  perMinute?: number;
  /** Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /**
   * Whether the network is there. Offline, nothing is looked up and nothing is
   * remembered as a failure: the answer is simply not known yet, and `retryFailed` (on
   * the window's `online` event) asks again. `core/` cannot read `navigator`, so the app
   * passes it in; the default is always online.
   */
  isOnline?: () => boolean;
};

/** The answer for an address, as far as the cache knows right now. */
export type LogoState = { kind: "logo"; url: string } | { kind: "none" } | { kind: "unknown" };

export class BrandLogoCache {
  private entries: Record<string, Entry>;
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly failedAt = new Map<string, number>();
  private readonly queue: { domain: string; run: () => void; drop: () => void }[] = [];
  private readonly starts: number[] = [];
  private active = 0;
  private timerPending = false;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private readonly storage: LogoStorage;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly perMinute: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly isOnline: () => boolean;
  /** Bumped on every change, for `useSyncExternalStore`. */
  version = 0;

  constructor(private readonly options: Options) {
    this.storage = options.storage ?? localLogoStorage();
    this.now = options.now ?? Date.now;
    this.concurrency = options.concurrency ?? 2;
    this.perMinute = options.perMinute ?? 30;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.isOnline = options.isOnline ?? (() => true);
    this.entries = sanitise(this.storage.read(), this.now());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** What is known for this address's domain, without starting anything. */
  peek(address: string): LogoState {
    const domain = senderDomain(address);
    if (!domain) return { kind: "none" };
    const entry = this.fresh(domain);
    if (!entry) return { kind: "unknown" };
    return entry.url ? { kind: "logo", url: entry.url } : { kind: "none" };
  }

  /**
   * The logo for an address's domain: from the cache, from a lookup already running, or
   * from a new one queued behind the rate limit. Resolves `null` for no logo; never
   * rejects.
   */
  request(address: string): Promise<string | null> {
    const domain = senderDomain(address);
    if (!domain) return Promise.resolve(null);
    const entry = this.fresh(domain);
    if (entry) return Promise.resolve(entry.url);
    const running = this.inflight.get(domain);
    if (running) return running;
    const failed = this.failedAt.get(domain);
    if (failed !== undefined && this.now() - failed < LOGO_RETRY_MS) return Promise.resolve(null);
    if (!this.isOnline()) return Promise.resolve(null);

    const generation = this.generation;
    // Only the entry this request put in the map: a lookup from before a `clear` must not
    // delete the one a newer request for the same domain has started since.
    const settle = () => {
      if (this.inflight.get(domain) === promise) this.inflight.delete(domain);
    };
    const promise = new Promise<string | null>((resolve) => {
      // Newest first: the rows on screen now are the ones that asked last.
      this.queue.unshift({
        domain,
        drop: () => {
          settle();
          resolve(null);
        },
        run: () => {
          void lookupBimiLogo(domain, this.options.resolve)
            .then(
              (url) => {
                if (generation === this.generation) this.remember(domain, url);
                return url;
              },
              () => {
                if (generation === this.generation) this.failedAt.set(domain, this.now());
                return null;
              },
            )
            .then((url) => {
              this.active -= 1;
              settle();
              resolve(url);
              this.pump();
            });
        },
      });
    });
    this.inflight.set(domain, promise);
    while (this.queue.length > MAX_QUEUED_LOOKUPS) this.queue.pop()?.drop();
    this.pump();
    return promise;
  }

  /**
   * Forget recent failures and tell subscribers to ask again: for when the network
   * comes back, so avatars that came up while offline get their logos without a reload.
   */
  retryFailed(): void {
    this.failedAt.clear();
    this.emit();
  }

  /** Forget everything: storage, memory, failures. Lookups still running are ignored. */
  clear(): void {
    this.generation += 1;
    this.entries = {};
    this.failedAt.clear();
    // Queued lookups never start; their callers get "no logo" rather than a promise
    // that never settles.
    for (const entry of this.queue.splice(0)) entry.drop();
    this.inflight.clear();
    this.storage.clear();
    this.emit();
  }

  private fresh(domain: string): Entry | null {
    const entry = this.entries[domain];
    if (!entry) return null;
    const ttl = entry.url ? LOGO_HIT_TTL_MS : LOGO_MISS_TTL_MS;
    return this.now() - entry.at < ttl ? entry : null;
  }

  private remember(domain: string, url: string | null): void {
    this.failedAt.delete(domain);
    this.entries[domain] = { url, at: this.now() };
    const keys = Object.keys(this.entries);
    if (keys.length > MAX_LOGO_ENTRIES) {
      keys
        .sort((a, b) => this.entries[a].at - this.entries[b].at)
        .slice(0, keys.length - MAX_LOGO_ENTRIES)
        .forEach((key) => delete this.entries[key]);
    }
    this.storage.write(this.entries);
    this.emit();
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** Start as many queued lookups as the limits allow; schedule a retry when capped. */
  private pump(): void {
    while (this.queue.length > 0 && this.active < this.concurrency) {
      const now = this.now();
      while (this.starts.length > 0 && now - this.starts[0] >= 60_000) this.starts.shift();
      if (this.starts.length >= this.perMinute) {
        if (!this.timerPending) {
          this.timerPending = true;
          this.setTimer(() => {
            this.timerPending = false;
            this.pump();
          }, 60_000 - (now - this.starts[0]) + 10);
        }
        return;
      }
      const next = this.queue.shift();
      if (!next) return;
      this.active += 1;
      this.starts.push(now);
      next.run();
    }
  }
}

/**
 * What storage held, minus anything it should not have: entries under a key that is not
 * a domain, with a time that is not a finite number or is in the future (which would
 * pin the entry until the clock caught up), and URLs that are no longer acceptable.
 * Exported for tests.
 */
export function sanitise(raw: unknown, now: number): Record<string, Entry> {
  const out: Record<string, Entry> = Object.create(null) as Record<string, Entry>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [domain, entry] of Object.entries(raw as Record<string, Entry>)) {
    if (senderDomain(`x@${domain}`) !== domain) continue;
    if (!entry || typeof entry !== "object" || typeof entry.at !== "number") continue;
    if (!Number.isFinite(entry.at) || entry.at > now + FUTURE_SLACK_MS) continue;
    if (entry.url === null) {
      out[domain] = { url: null, at: entry.at };
      continue;
    }
    // A stored URL is re-checked: storage is not a trusted source of `<img>` URLs.
    const url = typeof entry.url === "string" ? safeLogoUrl(entry.url) : undefined;
    if (url) out[domain] = { url, at: entry.at };
  }
  return out;
}
