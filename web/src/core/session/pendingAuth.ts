/**
 * The pending sign-in, kept across a page navigation.
 *
 * The desktop flow never needs this: the Rust listener holds the exchange open,
 * the webview never navigates away, and the verifier lives in a local that
 * survives until the code comes back.
 *
 * The web flow does. Sending the browser to `accounts.google.com` unloads the
 * page, so every in-memory value is destroyed — including the PKCE verifier,
 * without which the authorization code cannot be exchanged. The standard
 * answer is `sessionStorage`: it is scoped to the origin *and* to the tab, and
 * it survives a navigation away and back, which is exactly the lifetime this
 * needs. Nothing here outlives the tab, so closing the browser is sufficient
 * cleanup; there is still an expiry, because a tab left open on a login screen
 * should not be able to complete a sign-in hours later.
 *
 * Keyed by `state` rather than a single slot, so two tabs cannot clobber each
 * other: signing in on both at once is unusual but not something to break.
 */

const KEY = "winnow.pendingAuth";
const MAX_AGE_MS = 15 * 60 * 1000;

interface PendingAuth {
  state: string;
  verifier: string;
  redirectUri: string;
  at: number;
  /**
   * Why the trip to Google was made. Absent for a sign-in; `contacts` for the Google
   * contacts opt-in and `drafts` for the drafts opt-in, whose decline must not read as a
   * failed sign-in on the way back.
   */
  purpose?: "contacts" | "drafts" | "drive";
  /** For the contacts opt-in: the account that asked, so a different one can be refused. */
  expectEmail?: string;
  /**
   * The account namespace whose session started this trip (1.4.0): the redirect back is
   * finished by that account's session, so its tokens land in its own store. `pending`
   * for an account being added, whose address is not known until the profile read.
   */
  account?: string;
}

/** `sessionStorage` may throw outright when storage is disabled. */
function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readAll(): PendingAuth[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(
      (entry): entry is PendingAuth =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as PendingAuth).state === "string" &&
        typeof (entry as PendingAuth).verifier === "string" &&
        typeof (entry as PendingAuth).redirectUri === "string" &&
        typeof (entry as PendingAuth).at === "number" &&
        now - (entry as PendingAuth).at < MAX_AGE_MS,
    );
  } catch {
    return [];
  }
}

function writeAll(entries: readonly PendingAuth[]): void {
  const store = storage();
  if (!store) return;
  try {
    if (entries.length === 0) store.removeItem(KEY);
    else store.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Storage is full or blocked. The sign-in started but cannot be resumed;
    // the flow reports that rather than failing at the exchange with a
    // confusing "invalid_grant".
  }
}

/** Record a verifier so the redirect back can complete the exchange. */
export function rememberPendingAuth(entry: Omit<PendingAuth, "at">): void {
  writeAll([...readAll().filter((e) => e.state !== entry.state), { ...entry, at: Date.now() }]);
}

/**
 * Take the verifier for `state`, removing it.
 *
 * Removal on read is deliberate: a code is single-use, so a second attempt to
 * resume the same sign-in must not find a verifier waiting for it.
 */
export function takePendingAuth(state: string): PendingAuth | null {
  const entries = readAll();
  const found = entries.find((entry) => entry.state === state) ?? null;
  if (found) writeAll(entries.filter((entry) => entry.state !== state));
  return found;
}

/** The namespace a pending sign-in belongs to, without taking it (the exchange takes it). */
export function peekPendingAccount(state: string): string | null {
  return readAll().find((entry) => entry.state === state)?.account ?? null;
}

/** Forget a sign-in the user declined, so the entry cannot linger. */
export function forgetPendingAuth(state: string): void {
  writeAll(readAll().filter((entry) => entry.state !== state));
}

/** Drop every pending sign-in — on sign-out, or when a session already exists. */
export function clearPendingAuth(): void {
  writeAll([]);
}