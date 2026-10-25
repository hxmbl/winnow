import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatChangelog,
  isEmptyBody,
  lintChangelog,
  mergeBodies,
  notesForTag,
  notesFromBody,
  parseChangelog,
  promoteUnreleased,
  whatsNewBlock,
} from "./releaseNotes";

const SAMPLE = `# Changelog

Intro.

## [Unreleased]

### Fixed

- A pending fix.

## [1.7.0] - 2026-11-02

### Added

- Something new.

## [1.7.0-beta.1] - 2026-11-01 (pre-release)

### Added

- Something to try.

## [1.6.3] - 2026-10-25

A security release.

### Security

- Removed zip.

## [1.6.2] - 2026-10-25

### Changed

- Tailwind v4.

[Unreleased]: https://github.com/hxmbl/winnow/compare/v1.7.0...HEAD
[1.7.0]: https://github.com/hxmbl/winnow/compare/v1.6.3...v1.7.0
`;

const repoFile = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/release-notes.mjs", import.meta.url));

describe("release notes from CHANGELOG.md", () => {
  it("reads sections, dates and the link list, and writes the file back unchanged", () => {
    const changelog = parseChangelog(SAMPLE);
    expect(changelog.sections.map((s) => [s.name, s.date])).toEqual([
      ["Unreleased", null],
      ["1.7.0", "2026-11-02"],
      ["1.7.0-beta.1", "2026-11-01"],
      ["1.6.3", "2026-10-25"],
      ["1.6.2", "2026-10-25"],
    ]);
    expect(changelog.sections[2].rest).toBe(" (pre-release)");
    expect(changelog.links).toHaveLength(2);
    expect(formatChangelog(changelog)).toBe(SAMPLE);
  });

  it("refuses a ## heading that is not a version section", () => {
    expect(() => parseChangelog("# C\n\n## Notes\n")).toThrow(/not a "## \[version\]/);
  });

  it("finds a tag's exact section, its intro included", () => {
    expect(notesForTag(SAMPLE, "v1.6.3")).toEqual({ section: "1.6.3", body: "A security release.\n\n### Security\n\n- Removed zip." });
    expect(notesForTag(SAMPLE, "1.6.2")?.body).toBe("### Changed\n\n- Tailwind v4.");
    expect(notesForTag(SAMPLE, "v1.7.0-beta.1")?.section).toBe("1.7.0-beta.1");
  });

  it("falls back from a pre-release tag to its plain version, never the other way", () => {
    expect(notesForTag(SAMPLE, "v1.7.0-beta.2")).toEqual({ section: "1.7.0", body: "### Added\n\n- Something new." });
    expect(notesForTag(SAMPLE, "v1.6.4")).toBeNull();
    expect(notesForTag(SAMPLE, "v1.8.0-rc.1")).toBeNull();
  });

  it("treats a section with only subheadings as missing", () => {
    expect(isEmptyBody("### Added\n\n### Fixed\n")).toBe(true);
    expect(isEmptyBody("Tagged, never released.")).toBe(false);
    expect(notesForTag("## [Unreleased]\n\n## [2.0.0] - 2026-12-01\n\n### Added\n", "v2.0.0")).toBeNull();
  });

  it("opens the release body with What's new and ends in a blank line before Downloads", () => {
    expect(whatsNewBlock("- One.\n")).toBe("## What's new\n\n- One.\n\n");
  });

  it("takes latest.json's notes from the body's What's new, stopping at the next ## heading", () => {
    const body = `${whatsNewBlock("### Fixed\n\n- Edited on the draft.")}## Downloads\n\n| a | b |\n\n## What's Changed\n* PR`;
    expect(notesFromBody(body)).toBe("### Fixed\n\n- Edited on the draft.");
    expect(notesFromBody("## What's new in 1.5.2\r\n\r\n- Old style.\r\n## What's Changed")).toBe("- Old style.");
    expect(notesFromBody("## Downloads\n\nfiles")).toBeNull();
    expect(notesFromBody("## What's new\n\n## Downloads")).toBeNull();
  });
});

describe("moving Unreleased under a version", () => {
  it("creates the section, empties Unreleased and repoints the compare links", () => {
    const { text, action } = promoteUnreleased(SAMPLE, "1.7.1", "2026-11-03");
    expect(action).toBe("created");
    const changelog = parseChangelog(text);
    expect(changelog.sections[0]).toMatchObject({ name: "Unreleased", body: "" });
    expect(changelog.sections[1]).toMatchObject({ name: "1.7.1", date: "2026-11-03", body: "### Fixed\n\n- A pending fix." });
    expect(changelog.links.slice(0, 2)).toEqual([
      "[Unreleased]: https://github.com/hxmbl/winnow/compare/v1.7.1...HEAD",
      "[1.7.1]: https://github.com/hxmbl/winnow/compare/v1.7.0...v1.7.1",
    ]);
    expect(lintChangelog(text)).toEqual([]);
  });

  it("adds Unreleased to an existing section, category by category, and redates it", () => {
    const { text, action } = promoteUnreleased(SAMPLE, "1.7.0", "2026-11-05");
    expect(action).toBe("merged");
    const section = parseChangelog(text).sections.find((s) => s.name === "1.7.0")!;
    expect(section.date).toBe("2026-11-05");
    expect(section.body).toBe("### Added\n\n- Something new.\n\n### Fixed\n\n- A pending fix.");
  });

  it("changes nothing when the version has notes and Unreleased is empty", () => {
    const once = promoteUnreleased(SAMPLE, "1.7.1", "2026-11-03").text;
    expect(promoteUnreleased(once, "1.7.1", "2026-11-04")).toEqual({ text: once, action: "kept" });
  });

  it("refuses a version that would have no notes", () => {
    const once = promoteUnreleased(SAMPLE, "1.7.1", "2026-11-03").text;
    expect(() => promoteUnreleased(once, "1.7.2", "2026-11-04")).toThrow(/no notes for 1\.7\.2/);
    expect(() => promoteUnreleased("# C\n\n## [1.0.0] - 2026-01-01\n\n- x\n", "1.0.1", "2026-01-02")).toThrow(/no ## \[Unreleased\]/);
    expect(() => promoteUnreleased(SAMPLE, "next", "2026-11-03")).toThrow(/not a version/);
  });

  it("merges intros and keeps Keep a Changelog's category order", () => {
    expect(mergeBodies("Intro.\n\n### Security\n\n- s", "More.\n\n### Added\n\n- a\n\n### Security\n\n- t")).toBe(
      "Intro.\n\nMore.\n\n### Added\n\n- a\n\n### Security\n\n- s\n- t",
    );
  });
});

describe("linting the changelog", () => {
  it("names each problem", () => {
    const bad = `# C\n\n## [1.0.0] - 2026-01-01\n\n### Fixes\n\n- x\n\n## [1.0.0] - 2026-01-02\n\n## [two]\n\n- y\n`;
    expect(lintChangelog(bad)).toEqual([
      "the first section must be ## [Unreleased]",
      "[1.0.0] appears twice",
      "[1.0.0] is dated after the section above it",
      "[1.0.0] has no entries",
      "[two] is not a version",
      "[two] has no date",
      '[1.0.0] has "### Fixes"; use Added, Changed, Deprecated, Removed, Fixed, Security',
    ]);
  });

  it("passes the repository's CHANGELOG.md, which has notes for the version in the manifests", () => {
    const text = readFileSync(repoFile("CHANGELOG.md"), "utf8");
    expect(lintChangelog(text)).toEqual([]);
    const { version } = JSON.parse(readFileSync(repoFile("native/src-tauri/tauri.conf.json"), "utf8")) as { version: string };
    expect(notesForTag(text, `v${version}`)?.section).toBe(version);
  });
});

describe("release-notes.mjs, as the workflows run it", () => {
  const dir = mkdtempSync(join(tmpdir(), "winnow-notes-"));
  const changelog = join(dir, "CHANGELOG.md");
  writeFileSync(changelog, SAMPLE);
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("prints What's new for a tag", () => {
    expect(execFileSync(process.execPath, [script, "whats-new", "v1.6.3", changelog], { encoding: "utf8" })).toBe(
      "## What's new\n\nA security release.\n\n### Security\n\n- Removed zip.\n\n",
    );
  });

  it("fails a tag without notes with an error annotation", () => {
    const result = run("notes", "v9.9.9", changelog);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("::error title=CHANGELOG.md::");
    expect(result.stderr).toContain('"## [9.9.9]"');
  });

  it("takes notes from a body, else from the changelog with a warning, keeping stdout clean", () => {
    const body = join(dir, "body.md");
    writeFileSync(body, `${whatsNewBlock("- From the draft.")}## Downloads\n`);
    expect(run("from-body", body, "v1.6.3", changelog).stdout).toBe("- From the draft.\n");
    writeFileSync(body, "## Downloads\n");
    const fallback = run("from-body", body, "v1.6.2", changelog);
    expect(fallback.status).toBe(0);
    expect(fallback.stdout).toBe("### Changed\n\n- Tailwind v4.\n");
    expect(fallback.stderr).toContain("::warning");
    expect(run("from-body", body, "v9.9.9", changelog).status).toBe(1);
  });

  it("lints and promotes a file", () => {
    expect(run("lint", changelog).status).toBe(0);
    expect(run("promote", "1.7.1", "2026-11-03", changelog).status).toBe(0);
    expect(parseChangelog(readFileSync(changelog, "utf8")).sections[1].name).toBe("1.7.1");
    expect(run("promote", "1.7.2", "2026-11-04", changelog).status).toBe(1);
  });
});
