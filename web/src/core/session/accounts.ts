/**
 * Accounts (1.4.0): which Google accounts this device is signed in to, which one is
 * open, and where each one's data lives.
 *
 * Pure apart from the storage it is handed. The registry is one small JSON record,
 * `winnow.accounts.v1`; everything an account owns is stored under its own namespace,
 * `<key>@<id>` (see `ACCOUNT_SCOPED_KEYS` and `accountKey`), so no account's mail,
 * drafts, learning or tokens can be read through another's keys, and signing out of one
 * removes exactly that namespace.
 *
 * The id is minted when an account is added and never derived from the address: the
 * migration from 1.3.5 has to name the existing account's namespace before it knows the
 * address (the address is filled in on the first profile read), and a keychain entry
 * named after a random id says nothing about whose it is.
 *
 * What is shared, on purpose: the OAuth client (one Google client, many grants), the
 * preferences (appearance, sort, notification settings, hidden and muted senders: they
 * describe the person, not an account), the setup guide's progress and the reader split.
 */


/** Owner decision: at most five accounts on one device. */
export const MAX_ACCOUNTS = 5;

export const ACCOUNTS_STORAGE_KEY = "winnow.accounts.v1";

/**
 * The colours an account's dot can take: four of the accents, then the danger hue's rose,
 * so five accounts can all differ. Names only; `ui/accounts.ts` has the hues per mode.
 * Written out rather than spread from `ACCENT_THEMES` (1.4.0): the accents grew to eight
 * and gained their own "rose", and a stored account colour must keep meaning what it did.
 */
export const ACCOUNT_COLORS = ["space", "plum", "ember", "aurora", "rose"] as const;
export type AccountColor = (typeof ACCOUNT_COLORS)[number];

export function isAccountColor(value: unknown): value is AccountColor {
  return typeof value === "string" && (ACCOUNT_COLORS as readonly string[]).includes(value);
}

/** One signed-in account, as the registry keeps it. */
export type AccountRecord = {
  /** The namespace: `[a-z0-9]{4,24}`. Never shown. */
  id: string;
  /** The Gmail address; empty only for a migrated account not yet read from Gmail. */
  email: string;
  color: AccountColor;
  /** New-mail notifications while this account is not the open one (owner: on by default). */
  notify: boolean;
  addedAt: number;
};

export type AccountsSnapshot = {
  version: 1;
  active: string | null;
  accounts: AccountRecord[];
};

/**
 * Every key whose data belongs to one account, as 1.3.5 wrote it (unscoped). Each is
 * stored as `<key>@<id>` from 1.4.0 on, and the migration moves the old copy there.
 *
 * Not here, and why: `winnow.drafts.v1:<address>` is already one key per account (it is
 * named by the address, so the migration leaves it alone); the tokens live in the
 * platform's token store (`TokenStore`, keychain on desktop and Android), migrated
 * through it; `winnow.preferences.v1`, `winnow.google.oauthClient`,
 * `winnow.google.setupProgress` and `winnow.readerSplit.v1` are shared.
 */
export const ACCOUNT_SCOPED_KEYS = [
  "winnow.gmail.cache.messages",
  "winnow.gmail.cache.cursor",
  "winnow.offlineQueue.v1",
  "winnow.google.contacts.v1",
  "winnow.brandLogos.v1",
  "winnow.gravatars.v1",
  "winnow.learning.v1",
  "winnow.filterLearning.v1",
  "winnow.activeFilters.v1",
  "winnow.mailbox.v1",
  "winnow.lightSync.v1",
  "winnow.offlineSave.v1",
  "winnow.reconcile.v1",
] as const;
export type AccountScopedKey = (typeof ACCOUNT_SCOPED_KEYS)[number];

const ID = /^[a-z0-9]{4,24}$/;

export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

/** `<key>@<id>`: the one spelling of an account's storage key. */
export function accountKey(key: string, id: string): string {
  if (!isAccountId(id)) throw new Error(`not an account id: ${JSON.stringify(id)}`);
  return `${key}@${id}`;
}

/** The keychain entry (desktop, Android) for an account's tokens; the service name is unchanged. */
export function tokenSecretName(id: string): string {
  return accountKey("gmail.tokens", id);
}

/** The web token key for an account. */
export function webTokenKey(id: string): string {
  return accountKey("winnow.gmail.tokens", id);
}

/** A fresh id: 10 base-36 characters from the platform's random source. */
export function newAccountId(random: () => number = Math.random): string {
  let id = "";
  const bytes = new Uint8Array(10);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (random === Math.random && crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  for (const byte of bytes) id += (byte % 36).toString(36);
  return id;
}

/** The storage a scoped view writes through. */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * A `Storage` view that keeps one account's copy of every scoped key: a read or write of
 * `winnow.offlineQueue.v1` reaches `winnow.offlineQueue.v1@<id>`. Keys outside
 * `ACCOUNT_SCOPED_KEYS` pass through unchanged, so a shared key is never duplicated.
 */
export function scopedStorage(storage: KeyValueStorage | null, id: string): KeyValueStorage | null {
  if (!storage) return null;
  const scoped = new Set<string>(ACCOUNT_SCOPED_KEYS);
  const map = (key: string) => (scoped.has(key) ? accountKey(key, id) : key);
  return {
    getItem: (key) => storage.getItem(map(key)),
    setItem: (key, value) => storage.setItem(map(key), value),
    removeItem: (key) => storage.removeItem(map(key)),
  };
}

/** Normalise an address for comparison: Gmail addresses are case-insensitive. */
export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== "";
}

/** The first colour no account is using, in palette order; the palette again after five. */
export function nextColor(accounts: readonly Pick<AccountRecord, "color">[]): AccountColor {
  const used = new Set(accounts.map((account) => account.color));
  return ACCOUNT_COLORS.find((color) => !used.has(color)) ?? ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length];
}

export const EMPTY_ACCOUNTS: AccountsSnapshot = { version: 1, active: null, accounts: [] };

/** Read what storage holds; anything unusable is dropped, never guessed at. */
export function reviveAccounts(raw: unknown): AccountsSnapshot {
  if (!raw || typeof raw !== "object") return EMPTY_ACCOUNTS;
  const source = raw as { active?: unknown; accounts?: unknown };
  const seen = new Set<string>();
  const accounts: AccountRecord[] = [];
  for (const entry of Array.isArray(source.accounts) ? source.accounts : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (!isAccountId(e.id) || seen.has(e.id)) continue;
    const email = typeof e.email === "string" ? e.email.trim() : "";
    if (email && accounts.some((account) => sameAddress(account.email, email))) continue;
    seen.add(e.id);
    accounts.push({
      id: e.id,
      email,
      color: isAccountColor(e.color) ? e.color : nextColor(accounts),
      notify: e.notify !== false,
      addedAt: typeof e.addedAt === "number" ? e.addedAt : 0,
    });
    if (accounts.length === MAX_ACCOUNTS) break;
  }
  const active = isAccountId(source.active) && seen.has(source.active) ? source.active : (accounts[0]?.id ?? null);
  return { version: 1, active, accounts };
}

export function loadAccounts(storage: KeyValueStorage | null): AccountsSnapshot {
  try {
    const raw = storage?.getItem(ACCOUNTS_STORAGE_KEY);
    return raw ? reviveAccounts(JSON.parse(raw)) : EMPTY_ACCOUNTS;
  } catch {
    return EMPTY_ACCOUNTS;
  }
}

/** Whether storage has a registry at all (a 1.4.0 launch has happened on this device). */
export function hasAccountsRecord(storage: KeyValueStorage | null): boolean {
  try {
    return Boolean(storage?.getItem(ACCOUNTS_STORAGE_KEY));
  } catch {
    return false;
  }
}

/**
 * Write the registry and read it back: `true` only when storage now holds exactly this
 * snapshot. For a caller that deletes something on the strength of the registry being
 * there (the migration from 1.3.5): a refused write, or one a host quietly drops, is
 * `false`, never swallowed.
 */
export function persistAccounts(storage: KeyValueStorage | null, snapshot: AccountsSnapshot): boolean {
  if (!storage) return false;
  const raw = JSON.stringify(snapshot);
  try {
    storage.setItem(ACCOUNTS_STORAGE_KEY, raw);
    return storage.getItem(ACCOUNTS_STORAGE_KEY) === raw;
  } catch {
    return false;
  }
}

/** The registry's write-through: best effort, since nothing is deleted on the strength of it. */
export function saveAccounts(storage: KeyValueStorage | null, snapshot: AccountsSnapshot): void {
  // A full quota: the registry stays in memory for this run.
  persistAccounts(storage, snapshot);
}

/** Why an account could not be added. */
export type AddRefusal = { kind: "duplicate"; id: string } | { kind: "full" };

/**
 * The registry, in memory, written through on every change. Immutable snapshots, so a
 * subscriber can compare by identity.
 */
export class AccountRegistry {
  private value: AccountsSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: KeyValueStorage | null,
    initial?: AccountsSnapshot,
    private readonly now: () => number = Date.now,
  ) {
    this.value = initial ?? loadAccounts(storage);
  }

  /** Read storage again (after the migration wrote the registry). */
  reload(): void {
    this.value = loadAccounts(this.storage);
    for (const listener of this.listeners) listener();
  }

  snapshot(): AccountsSnapshot {
    return this.value;
  }

  list(): readonly AccountRecord[] {
    return this.value.accounts;
  }

  active(): AccountRecord | null {
    return this.value.accounts.find((account) => account.id === this.value.active) ?? null;
  }

  get(id: string): AccountRecord | null {
    return this.value.accounts.find((account) => account.id === id) ?? null;
  }

  byEmail(email: string): AccountRecord | null {
    return this.value.accounts.find((account) => sameAddress(account.email, email)) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether one more can be added. */
  canAdd(): boolean {
    return this.value.accounts.length < MAX_ACCOUNTS;
  }

  /**
   * Add an account under `id`, or say why not: an address already added (the caller
   * switches to it instead) or the cap. Does not make it active.
   */
  add(id: string, email: string): AccountRecord | AddRefusal {
    const existing = this.byEmail(email);
    if (existing) return { kind: "duplicate", id: existing.id };
    if (!this.canAdd()) return { kind: "full" };
    if (!isAccountId(id) || this.get(id)) throw new Error("account id in use or malformed");
    const record: AccountRecord = {
      id,
      email: email.trim(),
      color: nextColor(this.value.accounts),
      notify: true,
      addedAt: this.now(),
    };
    this.commit({ ...this.value, accounts: [...this.value.accounts, record] });
    return record;
  }

  setActive(id: string | null): void {
    if (id !== null && !this.get(id)) return;
    if (this.value.active === id) return;
    this.commit({ ...this.value, active: id });
  }

  update(id: string, patch: Partial<Pick<AccountRecord, "email" | "color" | "notify">>): void {
    const current = this.get(id);
    if (!current) return;
    if (patch.email !== undefined && patch.email && this.value.accounts.some((a) => a.id !== id && sameAddress(a.email, patch.email!))) {
      return;
    }
    const next = { ...current, ...patch };
    if (patch.color !== undefined && !isAccountColor(patch.color)) next.color = current.color;
    this.commit({ ...this.value, accounts: this.value.accounts.map((a) => (a.id === id ? next : a)) });
  }

  /** Forget an account. If it was active, the first one left becomes active (or none). */
  remove(id: string): void {
    const accounts = this.value.accounts.filter((account) => account.id !== id);
    if (accounts.length === this.value.accounts.length) return;
    const active = this.value.active === id ? (accounts[0]?.id ?? null) : this.value.active;
    this.commit({ version: 1, active, accounts });
  }

  private commit(next: AccountsSnapshot): void {
    this.value = next;
    saveAccounts(this.storage, next);
    for (const listener of this.listeners) listener();
  }
}
