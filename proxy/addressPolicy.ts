/**
 * What the render proxy may fetch, and what it may not.
 *
 * This file exists because the proxy turns a message into a document that its
 * *server* assembles, and that inverts who is making the requests. Locally, a
 * tracking pixel loads from the reader's own machine and tells the sender only that
 * the message was opened. Behind the proxy, the same pixel is fetched by the proxy
 * — which means the proxy's address is what the sender sees, which is the whole
 * privacy argument for the thing. It also means the proxy is a server that will
 * fetch a URL chosen by whoever sent you mail, which is the oldest server-side
 * request forgery there is.
 *
 * So the policy is here, as pure functions, away from the HTTP server, because a
 * rule about which addresses a service will connect to is exactly the kind of
 * rule that has to be stated as a rule rather than remembered as a habit.
 *
 * The load-bearing rule: **an address is judged after it is resolved, and every
 * address a hostname resolves to is judged.** Checking the hostname's text is not
 * enough — `http://127.0.0.1/` and `http://localtest.me/` and any A record
 * pointing at `169.254.169.254` all reach the inside of a machine or a cloud's
 * metadata service, and all of them are spelled as innocent names.
 */

import { isIP } from "node:net";

/** Why a URL was refused, or `null` if it was not. */
export type Refusal = "scheme" | "malformed" | "address" | "credentials";

export type Verdict = { ok: true; url: URL } | { ok: false; reason: Refusal };

// ── IPv4 ────────────────────────────────────────────────────────────────────

/** Parse a dotted-quad into its four bytes, or `null`. */
function ipv4Bytes(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return [bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!];
}

/**
 * Whether an address is inside a CIDR block, for both address families.
 *
 * One test rather than two, and the sharing is not tidiness. A block is written with
 * four bytes — `10, 0, 0, 0, 8` — but an IPv6 address is sixteen, so a prefix that
 * reaches past the end of the `bits` array means "the rest of these bytes are zero".
 * Comparing against `undefined` instead fails for the wrong reason, and the failure
 * it produces is `::` — the unspecified address — being treated as something a proxy
 * is willing to fetch. Hence the explicit `i < bits.length ? bits[i] : 0`.
 */
function inBlock(
  bytes: readonly number[],
  prefix: number,
  bits: readonly number[],
): boolean {
  const leading = Math.floor(prefix / 8);
  for (let i = 0; i < leading; i += 1) {
    const want = i < bits.length ? bits[i]! : 0;
    if (bytes[i] !== want) return false;
  }
  const remainder = prefix % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  const want = leading < bits.length ? bits[leading]! : 0;
  return (bytes[leading]! & mask) === (want & mask);
}

/**
 * IPv4 ranges a public web server must never be talked into fetching.
 *
 * Read the entries, because each one is a way somebody has reached something they
 * should not have:
 *
 *   - `0.0.0.0/8`, `127.0.0.0/8` — the host itself. A loopback fetch is how a
 *     message gets to read an admin API on the machine running the proxy.
 *   - `10/8`, `172.16/12`, `192.168/16` — the private network. On a cloud VM this
 *     is the other tenants.
 *   - `169.254.0.0/16` — link-local, and specifically `169.254.169.254`, which is
 *     the instance-metadata endpoint on AWS, GCP and Azure. One fetch of that from
 *     an unauthenticated service is a credential leak for the whole account.
 *   - `100.64.0.0/10` — carrier NAT. Not routable on the internet, so nothing
 *     legitimate resolves there.
 *   - `192.0.0.0/24`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`,
 *     `198.18.0.0/15` — IETF special-purpose and benchmarking blocks.
 *   - `224.0.0.0/4`, `240.0.0.0/4` — multicast and reserved, including the
 *     broadcast address.
 */
const BLOCKED_V4: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 0, 0, 8],
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 0, 0, 0, 24],
  [192, 0, 2, 0, 24],
  [192, 88, 99, 0, 24],
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15],
  [198, 51, 100, 0, 24],
  [203, 0, 113, 0, 24],
  [224, 0, 0, 0, 4],
  [240, 0, 0, 0, 4],
];

/** Whether a dotted-quad is one the proxy will connect to. */
export function isPublicIPv4(host: string): boolean {
  const bytes = ipv4Bytes(host);
  if (!bytes) return false;
  return !BLOCKED_V4.some(([a, b, c, d, prefix]) => inBlock(bytes, prefix, [a, b, c, d]));
}

// ── IPv6 ────────────────────────────────────────────────────────────────────

/** Expand an IPv6 literal into sixteen bytes, or `null` if it does not parse. */
function ipv6Bytes(host: string): number[] | null {
  // A zone id (`fe80::1%eth0`) is meaningful only on the local machine and is
  // dropped before the literal is judged.
  const bare = host.split("%")[0]!.toLowerCase();
  if (bare === "") return null;

  // An IPv4-mapped or -translated tail: `::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  let text = bare;
  if (dotted) {
    const bytes = ipv4Bytes(dotted[2]!);
    if (!bytes) return null;
    const high = ((bytes[0] << 8) | bytes[1]).toString(16).padStart(4, "0");
    const low = ((bytes[2] << 8) | bytes[3]).toString(16).padStart(4, "0");
    text = `${dotted[1]}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toWords = (part: string): number[] | null => {
    if (part === "") return [];
    const words: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      words.push(Number.parseInt(group, 16));
    }
    return words;
  };

  const head = toWords(halves[0]!);
  const tail = halves.length === 2 ? toWords(halves[1]!) : [];
  if (!head || !tail) return null;

  const words = halves.length === 2
    ? [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail]
    : head;
  if (words.length !== 8) return null;

  const bytes: number[] = [];
  for (const word of words) {
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  return bytes;
}

/** IPv6 prefixes the proxy refuses, written out for the same reason. */
const BLOCKED_V6: ReadonlyArray<readonly [number, number, number, number, number]> = [
  // fc00::/7 — unique local, the IPv6 private range.
  [0xfc, 0, 0, 0, 7],
  // fe80::/10 — link-local, the IPv6 answer to 169.254.
  [0xfe, 0x80, 0, 0, 10],
  // 2001:db8::/32 — documentation.
  [0x20, 0x01, 0x0d, 0xb8, 32],
  // ff00::/8 — multicast.
  [0xff, 0, 0, 0, 8],
];

/**
 * The IPv4 address an IPv6 literal wraps, if it wraps one.
 *
 * Three ways to spell a v4 address in a v6 literal, each of which defeats a filter
 * reading the text:
 *
 *   - `::ffff:a.b.c.d` — IPv4-mapped. A dual-stack socket asking for an IPv4
 *     address is handed one of these, so it is what the resolver returns routinely
 *     rather than an exotic spelling.
 *   - `64:ff9b::a.b.c.d` — NAT64, which translates an embedded v4 address.
 *   - `2002:aabb:ccdd::/48` — 6to4, which puts a v4 address in the next four bytes.
 */
function embeddedIPv4(bytes: readonly number[]): string | null {
  const zeroThrough = (index: number): boolean =>
    bytes.slice(0, index).every((byte) => byte === 0);

  const isMapped = zeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isNat64 =
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  const isSixToFour = bytes[0] === 0x20 && bytes[1] === 0x02;

  return isMapped || isNat64 || isSixToFour ? bytes.slice(12).join(".") : null;
}

/**
 * Whether an IPv6 literal is one the proxy will connect to.
 *
 * The wrapping is unwrapped *first*, because each of those three forms is a way to
 * spell a blocked IPv4 address so that a text filter does not see it. The
 * consequence worth stating is the other one: an address that is *public* inside a
 * wrapper stays allowed, so `::ffff:93.184.216.34` is not refused for the crime of
 * being written oddly. The rule is about where the address points, never about how
 * neatly it is spelled.
 */
export function isPublicIPv6(host: string): boolean {
  const bytes = ipv6Bytes(host);
  if (!bytes) return false;

  const wrapped = embeddedIPv4(bytes);
  if (wrapped !== null) return isPublicIPv4(wrapped);

  // `::` and `::1`, named rather than written as prefixes. A /128 over sixteen
  // bytes against a four-byte block is exactly the kind of shortcut that lets the
  // unspecified address through, and the unspecified address is not a destination
  // anything should be willing to fetch.
  if (bytes.every((byte) => byte === 0)) return false;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return false;

  return !BLOCKED_V6.some(([a, b, c, d, prefix]) => inBlock(bytes, prefix, [a, b, c, d]));
}

// ── URLs ────────────────────────────────────────────────────────────────────

/**
 * The schemes the proxy will fetch.
 *
 * `http` as well as `https`, because half the images in a 2014 newsletter are on a
 * plain HTTP host and refusing them is refusing to render the message. The proxy
 * does the fetching, so the reader's browser never makes a plaintext request and
 * never learns the address the message is talking to.
 */
const FETCHABLE = new Set(["http:", "https:"]);

/**
 * A URL the proxy may fetch, judged on everything that can be judged from the text
 * alone.
 *
 * DNS is not resolved here — the caller resolves it and judges *every* address the
 * name came back with, which is the part that cannot be done from a string and the
 * part that a name-based check gets wrong.
 */
export function checkUrl(raw: string): Verdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!FETCHABLE.has(url.protocol)) return { ok: false, reason: "scheme" };

  // `https://user:pass@host/` is a URL that will send an Authorization header to a
  // host the sender chose, from a service the reader vouched for. Mail does not
  // need it and it is a phishing primitive.
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };

  // A host that is an IP literal is judged now; a name is judged after resolution.
  // `URL.hostname` keeps the brackets on an IPv6 literal and `isIP` does not
  // accept them, so `http://[::1]/` used to be read as a name and pass.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    return { ok: false, reason: "address" };
  }

  return { ok: true, url };
}

/** Whether an address literal is one the proxy will connect to. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPublicIPv4(address);
  if (kind === 6) return isPublicIPv6(address);
  return false;
}

/**
 * The ceiling on one fetched resource.
 *
 * A message can name a four-gigabyte file. The proxy holds fetched assets in memory
 * for the caching lifetime below, so an unbounded read is an unbounded allocation
 * driven by whoever sent the mail — and a resource that is not an image is refused
 * anyway, which is checked *before* the body is read rather than after.
 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/** How many assets one document may pull. A newsletter has a dozen, not a thousand. */
export const MAX_ASSETS_PER_DOCUMENT = 60;

/** How long one fetch may take before it is abandoned. */
export const ASSET_TIMEOUT_MS = 8_000;

/**
 * How long a fetched asset is kept, in milliseconds.
 *
 * Long enough that re-opening the same message is instant, short enough that the
 * process's memory does not become a cache of everything anyone has ever been sent.
 */
export const ASSET_TTL_MS = 15 * 60 * 1000;

/**
 * Content types the proxy will re-host.
 *
 * Anything else is left as a live reference rather than fetched, which means the
 * reader's browser would make the request — so the honest answer is to fetch
 * nothing at all for it and let the reader see the same thing Winnow shows locally.
 *
 * SVG is deliberately absent. It is a document that can script, and a re-hosted one
 * would be served from the proxy's own origin; keeping it out means the only SVG
 * that ever arrives is one referenced by an `<img>`, where no engine runs its
 * script. Everything here is a raster format that cannot carry code.
 */
const ASSET_CONTENT_TYPE =
  /^image\/(png|jpeg|jpg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)\b/i;

/** Whether a `Content-Type` is one the proxy will hold on someone else's behalf. */
export function isAssetContentType(contentType: string): boolean {
  return ASSET_CONTENT_TYPE.test(contentType.trim());
}