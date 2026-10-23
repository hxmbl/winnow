/**
 * "What's new": the release notes for every version between the one running and the
 * newest, newest first, and a small Markdown reader for them.
 *
 * The notes are each release's `body` from GitHub (`/releases`), the same text the
 * Releases page shows and the release workflow copies into `latest.json`'s `notes`.
 *
 * The Markdown is parsed into plain data, never HTML: the UI renders it as React text
 * nodes, so nothing in a release body can run script, embed a frame, or load a remote
 * picture. Images become their alt text; links are kept only for `https:` URLs and open
 * in the system browser; raw HTML is shown as text with its tags removed.
 */

import { RELEASES_LIST_URL, RELEASES_PAGE_URL, UPDATE_REPO, isNewer, parseVersion, versionOfTag } from "./updates";

/** Enough releases to cover a long gap; GitHub returns newest first. */
export { RELEASES_LIST_URL };

/** A release body longer than this is cut, with a link to the rest. */
export const MAX_NOTES_CHARS = 20_000;

export type ChangelogEntry = {
  version: string;
  /** `published_at`, ISO, when GitHub gave one. */
  date: string | null;
  pageUrl: string;
  notes: string;
};

/**
 * The published, non-pre-release releases newer than `current` and no newer than
 * `latest`, newest first. Drafts and pre-releases are left out (the stable channel never
 * offers them): a pre-release by GitHub's flag or by a `-` in its tag. With
 * `includePrereleases` (the Beta channel, which does offer them) pre-releases are listed
 * too. Unreadable entries are skipped.
 */
export function changelogBetween(
  json: unknown,
  current: string,
  latest: string,
  { includePrereleases = false }: { includePrereleases?: boolean } = {},
): ChangelogEntry[] {
  if (!Array.isArray(json)) return [];
  const entries: ChangelogEntry[] = [];
  const seen = new Set<string>();
  for (const item of json) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (raw.draft === true) continue;
    const tag = typeof raw.tag_name === "string" ? raw.tag_name : "";
    if (!includePrereleases && (raw.prerelease === true || tag.includes("-"))) continue;
    const version = versionOfTag(tag);
    if (!parseVersion(version) || seen.has(version)) continue;
    if (!isNewer(version, current) || isNewer(version, latest)) continue;
    seen.add(version);
    const body = typeof raw.body === "string" ? raw.body : "";
    entries.push({
      version,
      date: typeof raw.published_at === "string" ? raw.published_at : null,
      pageUrl:
        typeof raw.html_url === "string" && raw.html_url.startsWith(`https://github.com/${UPDATE_REPO}/`)
          ? raw.html_url
          : RELEASES_PAGE_URL,
      notes: body.length > MAX_NOTES_CHARS ? `${body.slice(0, MAX_NOTES_CHARS)}…` : body,
    });
  }
  entries.sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0));
  return entries;
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type ChangelogResult = { kind: "ok"; entries: ChangelogEntry[] } | { kind: "failed"; reason: string };

/** Fetch the notes between `current` and `latest`. Never throws. */
export async function fetchChangelog(
  current: string,
  latest: string,
  fetcher: FetchLike,
  signal?: AbortSignal,
  { includePrereleases = false }: { includePrereleases?: boolean } = {},
): Promise<ChangelogResult> {
  try {
    const response = await fetcher(RELEASES_LIST_URL, { headers: { Accept: "application/vnd.github+json" }, signal });
    if (!response.ok) return { kind: "failed", reason: `GitHub answered ${response.status}` };
    return { kind: "ok", entries: changelogBetween(await response.json(), current, latest, { includePrereleases }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: message || "the network request failed" };
  }
}

// ── Markdown, as data ─────────────────────────────────────────────────────────

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

/** Only `https:` links survive; anything else is shown as its text. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Remove HTML: comments and `<script>` / `<style>` with their contents, then any other
 * tag (`<img …>`, `<details>`), keeping the text between them.
 */
function stripHtml(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, "");
}

/** Inline Markdown: `code`, **strong**, *em* / _em_, [links](https://…), images as alt text. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };
  let i = 0;
  const s = stripHtml(source);
  while (i < s.length) {
    const rest = s.slice(i);
    let match: RegExpExecArray | null;
    if ((match = /^\\([\\`*_[\]()#!|>-])/.exec(rest))) {
      text += match[1];
      i += match[0].length;
    } else if ((match = /^`([^`]+)`/.exec(rest))) {
      flush();
      out.push({ kind: "code", text: match[1] });
      i += match[0].length;
    } else if ((match = /^!\[([^\]]*)\]\([^)]*\)/.exec(rest))) {
      // Images are never loaded: their alt text stands in.
      text += match[1];
      i += match[0].length;
    } else if ((match = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest))) {
      flush();
      const href = safeHref(match[2]);
      const children = parseInline(match[1]);
      if (href) out.push({ kind: "link", href, children });
      else out.push(...children);
      i += match[0].length;
    } else if ((match = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
      flush();
      out.push({ kind: "strong", children: parseInline(match[2]) });
      i += match[0].length;
    } else if ((match = /^(\*|_)(?=\S)([^*_]*?\S)\1(?![A-Za-z0-9])/.exec(rest)) && (i === 0 || !/[A-Za-z0-9]/.test(s[i - 1]))) {
      flush();
      out.push({ kind: "em", children: parseInline(match[2]) });
      i += match[0].length;
    } else if ((match = /^https:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest)) && (i === 0 || /\s|\(/.test(s[i - 1]))) {
      flush();
      const href = safeHref(match[0]);
      if (href) out.push({ kind: "link", href, children: [{ kind: "text", text: match[0] }] });
      else text += match[0];
      i += match[0].length;
    } else {
      text += s[i];
      i += 1;
    }
  }
  flush();
  return out;
}

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Block Markdown: headings, lists, quotes, fenced code, tables, rules, paragraphs. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    let match: RegExpExecArray | null;
    if (trimmed === "") {
      endParagraph();
      i += 1;
    } else if (/^(```|~~~)/.test(trimmed)) {
      endParagraph();
      const fence = trimmed.slice(0, 3);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
      i += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
    } else if ((match = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed))) {
      endParagraph();
      const level = Math.min(4, match[1].length) as 1 | 2 | 3 | 4;
      blocks.push({ kind: "heading", level, children: parseInline(match[2]) });
      i += 1;
    } else if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      endParagraph();
      blocks.push({ kind: "rule" });
      i += 1;
    } else if (trimmed.startsWith("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      endParagraph();
      const header = tableCells(trimmed).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(tableCells(lines[i++]).map(parseInline));
      blocks.push({ kind: "table", header, rows });
    } else if (/^>/.test(trimmed)) {
      endParagraph();
      const body: string[] = [];
      while (i < lines.length && /^>/.test(lines[i].trim())) body.push(lines[i++].trim().replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", children: parseInline(body.join(" ").replace(/\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*/g, "")) });
    } else if ((match = /^([-*+]|\d+[.)])\s+/.exec(trimmed))) {
      endParagraph();
      const ordered = /\d/.test(match[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i].trim();
        const item = /^([-*+]|\d+[.)])\s+(.*)$/.exec(current);
        if (item && /\d/.test(item[1]) === ordered) {
          items.push(item[2]);
        } else if (current !== "" && items.length && /^\s+/.test(lines[i]) && !item) {
          // A wrapped continuation of the item above.
          items[items.length - 1] += ` ${current}`;
        } else if (item) {
          // A nested or differently-marked item: kept as its own entry.
          items.push(item[2]);
        } else {
          break;
        }
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items: items.map(parseInline) });
    } else {
      paragraph.push(trimmed);
      i += 1;
    }
  }
  endParagraph();
  return blocks;
}
