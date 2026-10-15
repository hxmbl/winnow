/**
 * Brand logos from BIMI.
 *
 * A sender that publishes BIMI puts a TXT record at `default._bimi.<domain>` of the form
 * `v=BIMI1; l=https://…/logo.svg; a=https://…/cert.pem`. The `l=` tag is the logo Gmail,
 * Apple Mail and Yahoo show beside the sender; Winnow uses the same one for senders the
 * user's own contacts have no photo for.
 *
 * **Opt-in, because it is not private.** Resolving the record tells a DNS provider which
 * domains mail the user, and loading the logo tells the sender's web host that someone
 * is looking at their mail right now. That is why this lives behind the "Show brand
 * logos" setting, off by default, and is never consulted in the demo.
 *
 * **Only the logo URL is trusted.** Winnow does not verify the `a=` mark certificate
 * (VMC): doing so needs X.509 path validation against the mark verifying authorities,
 * which is far more code than an avatar is worth. The consequence is bounded — a domain
 * can only show a logo for mail that claims to be from that same domain — and Gmail's
 * own authentication result is what the reader uses for trust, not the picture.
 *
 * **Never inline.** The logo is an SVG from a stranger's host. It is only ever rendered
 * through `<img>`, where an SVG runs no script, loads nothing else and cannot touch the
 * page; https is required, and the URL length is capped.
 */

/** DNS-over-HTTPS, JSON flavour. Cloudflare's resolver: CORS-enabled and no IP logging. */
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** The longest logo URL accepted. BIMI logos are short CDN paths; this is generous. */
export const MAX_LOGO_URL = 2048;

/** What one TXT lookup can say. */
export type TxtAnswer =
  /** The name exists and these are its TXT strings (each already joined). */
  | { kind: "records"; records: string[] }
  /** NXDOMAIN, or a name with no TXT records. */
  | { kind: "none" };

export type TxtResolver = (name: string) => Promise<TxtAnswer>;

/** What a BIMI record says about the logo. */
export type BimiRecord =
  /** A logo to show. */
  | { kind: "logo"; url: string }
  /** A valid record with an empty `l=`: the domain declines to show a logo. */
  | { kind: "declined" };

/**
 * One TXT answer's `data`, joined.
 *
 * A TXT record longer than 255 bytes is split into several character-strings, and DoH
 * JSON returns them as `"part one" "part two"`. Joined without a separator, which is
 * how RFC 7208 and BIMI both read them. An unquoted value is returned as it is.
 */
export function joinTxtData(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return data.trim();
  return parts.map((part) => part.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

/** A logo URL Winnow may hand to an `<img>`, or `undefined`. */
export function safeLogoUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_LOGO_URL) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  return url.toString();
}

/**
 * Parse one TXT string as a BIMI record.
 *
 * `null` when it is not a BIMI record at all (a different TXT record at the same name,
 * which happens) or is malformed: `v=BIMI1` must be the first tag, tags are `;`
 * separated `name=value` pairs, and a tag that appears twice makes the record invalid.
 * An `l=` that is present but empty is the domain declining; an `l=` that is not an
 * https URL is treated as no logo, because the record is broken rather than declining.
 */
export function parseBimiRecord(text: string): BimiRecord | null {
  const tags = text
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (tags.length === 0) return null;
  const parsed = new Map<string, string>();
  for (const tag of tags) {
    const eq = tag.indexOf("=");
    if (eq <= 0) return null;
    const name = tag.slice(0, eq).trim().toLowerCase();
    const value = tag.slice(eq + 1).trim();
    if (parsed.has(name)) return null;
    parsed.set(name, value);
  }
  // The version tag first, and exactly `BIMI1` (case-sensitive in the draft).
  const first = tags[0].split("=")[0].trim().toLowerCase();
  if (first !== "v" || parsed.get("v") !== "BIMI1") return null;
  if (!parsed.has("l")) return null;
  const raw = parsed.get("l") ?? "";
  if (raw === "") return { kind: "declined" };
  // An early draft allowed a comma-separated list; the first entry is the one to use.
  const url = safeLogoUrl(raw.split(",")[0]);
  return url ? { kind: "logo", url } : null;
}

/**
 * Multi-label public suffixes common enough to matter for mail.
 *
 * Not the Public Suffix List — bundling that is 200 KB for an avatar. A sender at
 * `news.brand.co.uk` falls back to `brand.co.uk`, not `co.uk`, which is the case that
 * actually comes up; an exotic suffix just means no fallback, never a wrong one beyond
 * asking DNS about a name that has no record.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.kr", "or.kr",
  "com.br", "com.mx", "com.ar", "com.co",
  "co.in", "net.in", "org.in", "firm.in",
  "co.za", "com.sg", "com.hk", "com.tw", "com.cn", "com.tr", "com.my", "com.ph",
  "co.id", "co.il", "com.ua", "com.pl", "com.es", "co.th",
]);

/**
 * The organisational domain: the registrable name under its public suffix.
 *
 * `mail.news.example.com` → `example.com`; `news.brand.co.uk` → `brand.co.uk`.
 */
export function organisationalDomain(domain: string): string {
  const labels = domain.trim().toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  const keep = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/**
 * The domain part of an address, lower-cased and in its ASCII (punycode) form, or `null`
 * when there is none.
 *
 * An internationalised domain (`bücher.de`) is what the DNS knows as `xn--bcher-kva.de`,
 * and that is the name a BIMI record lives under, so it is converted rather than
 * rejected. An IP literal (`[192.0.2.1]`, or a bare dotted quad) has no BIMI record and
 * is not asked about. `core/` has no DOM, but `URL` is in every JS runtime Winnow runs
 * on, browser and Node alike.
 */
export function senderDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  let domain = address
    .slice(at + 1)
    .trim()
    .replace(/[>\s].*$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!domain || domain.length > 253) return null;
  if (/[^\x20-\x7e]/.test(domain)) {
    try {
      domain = new URL(`http://${domain}/`).hostname;
    } catch {
      return null;
    }
  }
  // A hostname, nothing else: letters, digits, hyphens and dots, at least one dot, no
  // empty or hyphen-edged label, and a top-level label that is not all digits.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.some((label) => label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return domain;
}

/**
 * The BIMI record that applies to one domain's records, or `null` for none.
 *
 * More than one BIMI record at a name is an invalid publication, not a choice — the
 * draft says to treat it as no record — and non-BIMI TXT strings are ignored.
 */
function pickRecord(records: readonly string[]): BimiRecord | null | "invalid" {
  const bimi = records.filter((text) => /^\s*v\s*=\s*BIMI1\s*(;|$)/.test(text));
  if (bimi.length === 0) return null;
  if (bimi.length > 1) return "invalid";
  return parseBimiRecord(bimi[0]) ?? "invalid";
}

/**
 * The logo for a sender domain, or `null`.
 *
 * `default._bimi.<domain>` first. Only when that name has *no* BIMI record does the
 * organisational domain get asked — a subdomain that publishes a declining or a broken
 * record has said something, and falling back would override it.
 */
export async function lookupBimiLogo(domain: string, resolve: TxtResolver): Promise<string | null> {
  const at = async (name: string) => {
    const answer = await resolve(`default._bimi.${name}`);
    return answer.kind === "records" ? pickRecord(answer.records) : null;
  };
  let record = await at(domain);
  const org = organisationalDomain(domain);
  if (record === null && org !== domain) record = await at(org);
  return record && record !== "invalid" && record.kind === "logo" ? record.url : null;
}

type DohJson = {
  Status?: number;
  Answer?: { type?: number; data?: string }[];
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A `TxtResolver` over DNS-over-HTTPS (the JSON API Cloudflare and Google both serve).
 *
 * Throws on a transport failure or an HTTP error, so the cache can tell "this domain has
 * no logo" (cached for a day) from "the lookup did not happen" (retried later). Answers
 * of other types — a CNAME on the way to the TXT — are skipped.
 */
export function dohResolver(fetchImpl: FetchLike, endpoint: string = DOH_ENDPOINT): TxtResolver {
  return async (name) => {
    const url = `${endpoint}?name=${encodeURIComponent(name)}&type=TXT`;
    const response = await fetchImpl(url, {
      headers: { accept: "application/dns-json" },
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error(`DoH ${response.status}`);
    const body = (await response.json()) as DohJson;
    // 0 NOERROR, 3 NXDOMAIN. Anything else (SERVFAIL, REFUSED) is a failed lookup.
    if (body.Status === 3) return { kind: "none" };
    if (body.Status !== 0) throw new Error(`DoH status ${String(body.Status)}`);
    const records = (body.Answer ?? [])
      .filter((answer) => answer.type === 16 && typeof answer.data === "string")
      .map((answer) => joinTxtData(answer.data as string));
    return records.length > 0 ? { kind: "records", records } : { kind: "none" };
  };
}
