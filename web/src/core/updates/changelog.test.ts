import { describe, expect, it } from "vitest";
import {
  MAX_NOTES_CHARS,
  RELEASES_LIST_URL,
  changelogBetween,
  fetchChangelog,
  parseInline,
  parseMarkdown,
  safeHref,
} from "./changelog";

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  body: `Notes for ${tag}`,
  html_url: `https://github.com/hxmbl/winnow/releases/tag/${tag}`,
  published_at: "2026-10-01T10:00:00Z",
  draft: false,
  prerelease: false,
  ...extra,
});

describe("the releases between two versions", () => {
  const list = [
    release("v1.7.0"),
    release("v1.6.1-beta.1", { prerelease: true }),
    release("v1.6.0"),
    release("v1.5.2", { draft: true }),
    release("v1.5.1"),
    release("v1.5.0"),
    release("v1.4.0"),
    release("v1.3.5"),
    release("nightly"),
    "junk",
  ];

  it("lists every published release after the installed one up to the latest, newest first", () => {
    expect(changelogBetween(list, "1.4.0", "1.6.0").map((entry) => entry.version)).toEqual(["1.6.0", "1.5.1", "1.5.0"]);
  });

  it("is just the latest after one release, and empty when current", () => {
    expect(changelogBetween(list, "1.6.0", "1.7.0").map((entry) => entry.version)).toEqual(["1.7.0"]);
    expect(changelogBetween(list, "1.7.0", "1.7.0")).toEqual([]);
  });

  it("sorts even when GitHub's order is not by version", () => {
    const shuffled = [release("v1.5.0"), release("v1.6.0"), release("v1.5.1")];
    expect(changelogBetween(shuffled, "1.4.0", "1.6.0").map((entry) => entry.version)).toEqual(["1.6.0", "1.5.1", "1.5.0"]);
  });

  it("keeps the body, date and page, and cuts a very long body", () => {
    const [entry] = changelogBetween([release("v1.5.0", { body: "x".repeat(MAX_NOTES_CHARS + 10) })], "1.4.0", "1.5.0");
    expect(entry.notes.length).toBe(MAX_NOTES_CHARS + 1);
    expect(entry.date).toBe("2026-10-01T10:00:00Z");
    expect(entry.pageUrl).toBe("https://github.com/hxmbl/winnow/releases/tag/v1.5.0");
    const [odd] = changelogBetween([release("v1.5.0", { body: null, html_url: "https://evil.example" })], "1.4.0", "1.5.0");
    expect(odd.notes).toBe("");
    expect(odd.pageUrl).toBe("https://github.com/hxmbl/winnow/releases/latest");
  });

  it("is empty for anything that is not a list", () => {
    expect(changelogBetween({ message: "rate limited" }, "1.4.0", "1.5.0")).toEqual([]);
  });

  it("fetches GitHub's release list and never throws", async () => {
    let asked = "";
    const ok = await fetchChangelog("1.4.0", "1.5.0", async (url) => {
      asked = url;
      return { ok: true, status: 200, json: async () => list };
    });
    expect(asked).toBe(RELEASES_LIST_URL);
    expect(ok).toEqual({ kind: "ok", entries: changelogBetween(list, "1.4.0", "1.5.0") });
    expect((await fetchChangelog("1.4.0", "1.5.0", async () => ({ ok: false, status: 403, json: async () => ({}) }))).kind).toBe(
      "failed",
    );
    const offline = await fetchChangelog("1.4.0", "1.5.0", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(offline).toEqual({ kind: "failed", reason: "Failed to fetch" });
  });
});

describe("the Markdown reader", () => {
  it("keeps https links only", () => {
    expect(safeHref("https://github.com/hxmbl/winnow/pull/22")).toBe("https://github.com/hxmbl/winnow/pull/22");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("http://example.com")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
  });

  it("reads inline code, emphasis and links, and never an image or a script", () => {
    expect(parseInline("Fix `x` in **bold** and *it* [PR](https://github.com/hxmbl/winnow/pull/1)")).toEqual([
      { kind: "text", text: "Fix " },
      { kind: "code", text: "x" },
      { kind: "text", text: " in " },
      { kind: "strong", children: [{ kind: "text", text: "bold" }] },
      { kind: "text", text: " and " },
      { kind: "em", children: [{ kind: "text", text: "it" }] },
      { kind: "text", text: " " },
      { kind: "link", href: "https://github.com/hxmbl/winnow/pull/1", children: [{ kind: "text", text: "PR" }] },
    ]);
    expect(parseInline("![a tracking pixel](https://evil.example/p.gif)")).toEqual([{ kind: "text", text: "a tracking pixel" }]);
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ kind: "text", text: "click" }, { kind: "text", text: ")" }]);
    expect(parseInline('<img src="https://evil.example/x.gif" onerror="alert(1)">hi<script>alert(1)</script>')).toEqual([
      { kind: "text", text: "hi" },
    ]);
    expect(parseInline("snake_case_name stays")).toEqual([{ kind: "text", text: "snake_case_name stays" }]);
  });

  it("turns a bare https URL into a link", () => {
    expect(parseInline("Full Changelog: https://github.com/hxmbl/winnow/compare/v1.4.0...v1.5.0")).toEqual([
      { kind: "text", text: "Full Changelog: " },
      {
        kind: "link",
        href: "https://github.com/hxmbl/winnow/compare/v1.4.0...v1.5.0",
        children: [{ kind: "text", text: "https://github.com/hxmbl/winnow/compare/v1.4.0...v1.5.0" }],
      },
    ]);
  });

  it("reads a GitHub release body", () => {
    const body = [
      "## Downloads",
      "",
      "| Platform | File |",
      "| --- | --- |",
      "| Linux | `.AppImage` |",
      "",
      "> [!WARNING]",
      "> Not code-signed.",
      "",
      "## What's Changed",
      "* Automatic updates by @hxmbl in https://github.com/hxmbl/winnow/pull/22",
      "* Undo pill auto-hides",
      "  after 6 seconds",
      "",
      "1. first",
      "2. second",
      "",
      "```",
      "sudo apt install ./Winnow_1.5.0_amd64.deb",
      "```",
      "---",
      "Plain paragraph",
      "on two lines.",
    ].join("\n");
    const blocks = parseMarkdown(body);
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "table",
      "quote",
      "heading",
      "list",
      "list",
      "code",
      "rule",
      "paragraph",
    ]);
    const table = blocks[1];
    expect(table.kind === "table" && table.rows[0][1]).toEqual([{ kind: "code", text: ".AppImage" }]);
    const quote = blocks[2];
    expect(quote.kind === "quote" && quote.children).toEqual([{ kind: "text", text: "Not code-signed." }]);
    const list = blocks[4];
    expect(list.kind === "list" && list.items.length).toBe(2);
    expect(list.kind === "list" && list.items[1]).toEqual([{ kind: "text", text: "Undo pill auto-hides after 6 seconds" }]);
    const ordered = blocks[5];
    expect(ordered.kind === "list" && ordered.ordered).toBe(true);
    expect(blocks[6]).toEqual({ kind: "code", text: "sudo apt install ./Winnow_1.5.0_amd64.deb" });
    expect(blocks[8]).toEqual({ kind: "paragraph", children: [{ kind: "text", text: "Plain paragraph on two lines." }] });
  });

  it("copes with empty and CRLF input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("# Title\r\n\r\nText")).toEqual([
      { kind: "heading", level: 1, children: [{ kind: "text", text: "Title" }] },
      { kind: "paragraph", children: [{ kind: "text", text: "Text" }] },
    ]);
  });
});
