/**
 * Hash Gmail message IDs to safe integers for React keys/deep links.
 * Uses FNV-1a/64 truncated to 53 bits. Deterministic; collisions negligible.
 * Gmail ID remains canonical in persisted caches.
 */

/** Top 53 bits kept (Number.MAX_SAFE_INTEGER-safe). */
const SAFE_BITS = 53n;

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** FNV-1a/64 hash truncated to 53-bit safe integer (hash UTF-8 bytes). */
export function hashId(value: string): number {
  let hash = OFFSET;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return Number(hash >> (64n - SAFE_BITS));
}

export function threadKey(email: { gmailId: string; threadId?: string }): string {
  return email.threadId ?? `single-${email.gmailId}`;
}

/** Per-run unique local ID (negative, outside hash space). */
let localCounter = 0;
export function localId(): number {
  localCounter -= 1;
  return localCounter;
}
