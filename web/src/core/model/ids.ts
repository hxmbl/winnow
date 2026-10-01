/**
 * Turning a Gmail id into a number.
 *
 * Gmail message ids are strings like `18d3f0c4a5b6c7d8`. The UI wants a
 * `number`: React keys should be primitives, `Map<number, …>` lookups beat
 * string lookups over a few thousand rows, and a deep link
 * (`winnow://message/18d3f…`) reads better with a short id.
 *
 * FNV-1a/64, truncated to a JS safe integer. The properties that matter:
 *
 *   - **Deterministic.** The same id always maps to the same number, so a
 *     cached classification stays valid across restarts and across machines.
 *   - **Cheap.** One pass over the UTF-8 bytes, no allocation. It runs for
 *     every message on every sync.
 *   - **Collision-resistant enough.** 53 bits of hash over a few thousand
 *     messages: a birthday collision is a rounding error, not a design risk.
 *
 * Where a collision would actually hurt — the persisted cache — the Gmail id
 * is the key, not this number. The number is a UI handle only.
 */

/**
 * 53 bits: `Number.MAX_SAFE_INTEGER` is 2^53 − 1, so anything wider loses
 * precision the moment it becomes a `Number`. FNV-1a produces 64, and simply
 * converting that produced ids above `MAX_SAFE_INTEGER` whose *low* bits — the
 * part that varies between neighbouring ids — were the ones rounded away. The
 * top 53 bits keep the full avalanche and stay exactly representable.
 */
const SAFE_BITS = 53n;

/** FNV-1a/64 offset basis. */
const OFFSET = 0xcbf29ce484222325n;
/** FNV-1a/64 prime. */
const PRIME = 0x100000001b3n;
/** 2^64, for wrapping arithmetic. */
const MASK = 0xffffffffffffffffn;

/**
 * A 64-bit FNV-1a hash of `value`, truncated to a positive safe integer.
 *
 * BigInt throughout the loop so the multiply wraps at 64 bits rather than
 * overflowing into a float; the final shift keeps the high 53 bits, which are
 * the ones that have finished mixing by the end of the hash.
 */
export function hashId(value: string): number {
  let hash = OFFSET;
  // Hash the UTF-8 bytes, not UTF-16 code units, so an id containing a
  // non-ASCII character hashes the same as the bytes Gmail actually sent.
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return Number(hash >> (64n - SAFE_BITS));
}

/**
 * A thread groups messages that reply to each other.
 *
 * Gmail always supplies a thread id, but a locally seeded demo message may not.
 * Falling back to a per-message key keeps such a message in its own thread
 * rather than merging it with every other thread-less message.
 */
export function threadKey(email: { gmailId: string; threadId?: string }): string {
  return email.threadId ?? `single-${email.gmailId}`;
}

/**
 * A per-message id that is unique within one run.
 *
 * Used for local-only rows (a demo seed, an optimistic insert) where no Gmail
 * id exists yet. The negative range keeps it clear of the hash space.
 */
let localCounter = 0;
export function localId(): number {
  localCounter -= 1;
  return localCounter;
}
