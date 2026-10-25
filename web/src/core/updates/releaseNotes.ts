/**
 * Release notes from `CHANGELOG.md`, for the release workflows
 * (`.github/workflows/release.yml` and `cut-release.yml`, through
 * `web/scripts/release-notes.mjs`, and `web/scripts/bump-version.mjs`).
 *
 * The changelog follows Keep a Changelog: an `## [Unreleased]` section, then one
 * `## [X.Y.Z] - YYYY-MM-DD` section per version, newest first, each with `### Added`,
 * `### Changed`, `### Fixed`, `### Security` (and the other standard) subsections. A
 * version's section becomes the "What's new" part of its GitHub release body, above
 * the Downloads table, and the `notes` of its `latest.json`.
 *
 * A tag finds its section by its exact version first (`v1.6.0-beta.2` reads
 * `## [1.6.0-beta.2]`), and a pre-release tag then falls back to its plain version
 * (`v1.7.0-beta.1` reads `## [1.7.0]`, the notes so far). There is no generic
 * fallback: a version without a non-empty section fails the cut, so a release never
 * ships with boilerplate where its notes should be.
 *
 * Pure and dependency-free, so the scripts run it straight from TypeScript (Node strips
 * the types) and the test suite can check it.
 */

/** The heading the release body opens with; `notesFromBody` looks for it. */
export const WHATS_NEW_HEADING = "## What's new";

/** Keep a Changelog's subsections, in its order. */
export const CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"] as const;

const SECTION_RE = /^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?(.*)$/;
const PLAIN_RE = /^\d+\.\d+\.\d+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const LINK_RE = /^\[([^\]]+)\]:\s*\S+/;

export type ChangelogSection = {
  /** `Unreleased`, or the version without a `v` (`1.6.3`, `1.6.0-beta.2`). */
  name: string;
  date: string | null;
  /** Whatever follows the date on the heading line, e.g. ` (pre-release)`. */
  rest: string;
  /** The heading line itself. */
  heading: string;
  /** The lines under the heading, up to the next `## ` heading or the link list. */
  body: string;
};

export type Changelog = {
  /** Everything before the first `## ` section. */
  preamble: string;
  sections: ChangelogSection[];
  /** The trailing link reference definitions (`[1.6.3]: https://…`), one per line. */
  links: string[];
};

/** Split the file into its preamble, `## [name]` sections and trailing link list. */
export function parseChangelog(text: string): Changelog {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // The link list is the run of reference definitions (and blank lines) at the end.
  let end = lines.length;
  while (end > 0 && (lines[end - 1].trim() === "" || LINK_RE.test(lines[end - 1].trim()))) end -= 1;
  const links = lines.slice(end).filter((line) => LINK_RE.test(line.trim()));
  const preamble: string[] = [];
  const sections: ChangelogSection[] = [];
  let current: { head: RegExpExecArray; line: string; body: string[] } | null = null;
  const close = () => {
    if (!current) return;
    sections.push({
      name: current.head[1].trim(),
      date: current.head[2] ?? null,
      rest: current.head[3] ?? "",
      heading: current.line,
      body: current.body.join("\n").replace(/^\n+|\s+$/g, ""),
    });
  };
  for (const line of lines.slice(0, end)) {
    if (line.startsWith("## ")) {
      const head = SECTION_RE.exec(line.trimEnd());
      if (!head) throw new Error(`CHANGELOG.md: "${line}" is not a "## [version] - YYYY-MM-DD" heading`);
      close();
      current = { head, line: line.trimEnd(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  close();
  return { preamble: preamble.join("\n").replace(/\s+$/, ""), sections, links };
}

/** The file again, in the shape `parseChangelog` reads. */
export function formatChangelog(changelog: Changelog): string {
  const parts = [changelog.preamble];
  for (const section of changelog.sections) {
    parts.push(section.body ? `${section.heading}\n\n${section.body}` : section.heading);
  }
  let out = parts.filter((part) => part !== "").join("\n\n") + "\n";
  if (changelog.links.length) out += `\n${changelog.links.join("\n")}\n`;
  return out;
}

/** True when a section body says nothing: only blank lines and subheadings. */
export function isEmptyBody(body: string): boolean {
  return body.split("\n").every((line) => line.trim() === "" || /^#{3,6}\s/.test(line.trim()));
}

/** The version a tag names, without the `v`. */
export function versionOfTag(tag: string): string {
  return tag.trim().replace(/^v/, "");
}

export type FoundNotes = {
  /** The section that was used (`1.7.0` for a `v1.7.0-beta.1` tag without its own). */
  section: string;
  body: string;
};

/**
 * The notes for a tag: its exact version's section, or for a pre-release its plain
 * version's. Null when neither exists or the one found is empty.
 */
export function notesForTag(text: string, tag: string): FoundNotes | null {
  const version = versionOfTag(tag);
  const { sections } = parseChangelog(text);
  const candidates = [version];
  const plain = version.split("-")[0];
  if (plain !== version) candidates.push(plain);
  for (const name of candidates) {
    const section = sections.find((s) => s.name === name);
    if (section && !isEmptyBody(section.body)) return { section: name, body: section.body };
  }
  return null;
}

/** The "What's new" block that opens a release body, ending in a blank line. */
export function whatsNewBlock(notes: string): string {
  return `${WHATS_NEW_HEADING}\n\n${notes.trim()}\n\n`;
}

/**
 * The notes in a release body: what sits under `## What's new`, up to the next `## `
 * heading (Downloads, or GitHub's generated "What's Changed"). Null without one, so
 * notes edited on a draft are what `latest.json` carries.
 */
export function notesFromBody(body: string): string | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+What['’]s new\b/i.test(line.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const stop = rest.findIndex((line) => /^##\s/.test(line));
  const notes = (stop < 0 ? rest : rest.slice(0, stop)).join("\n").trim();
  return notes && !isEmptyBody(notes) ? notes : null;
}

type Parts = { intro: string[]; categories: Map<string, string[]> };

/** A section body as its intro lines and its `### Category` lines. */
function splitCategories(body: string): Parts {
  const intro: string[] = [];
  const categories = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of body.split("\n")) {
    const head = /^###\s+(.+?)\s*$/.exec(line);
    if (head) {
      const name = head[1];
      if (!categories.has(name)) categories.set(name, []);
      current = categories.get(name)!;
    } else if (current) {
      current.push(line);
    } else {
      intro.push(line);
    }
  }
  return { intro, categories };
}

const trimLines = (lines: string[]) => lines.join("\n").replace(/^\n+|\s+$/g, "");

/** `from`'s intro and entries appended to `into`'s, category by category. */
export function mergeBodies(into: string, from: string): string {
  const a = splitCategories(into);
  const b = splitCategories(from);
  const intro = [trimLines(a.intro), trimLines(b.intro)].filter(Boolean).join("\n\n");
  const names = [...a.categories.keys(), ...[...b.categories.keys()].filter((name) => !a.categories.has(name))];
  const order = (name: string) => {
    const i = (CATEGORIES as readonly string[]).indexOf(name);
    return i < 0 ? CATEGORIES.length : i;
  };
  names.sort((x, y) => order(x) - order(y));
  const blocks = names
    .map((name) => {
      const lines = [trimLines(a.categories.get(name) ?? []), trimLines(b.categories.get(name) ?? [])].filter(Boolean);
      return lines.length ? `### ${name}\n\n${lines.join("\n")}` : "";
    })
    .filter(Boolean);
  return [intro, ...blocks].filter(Boolean).join("\n\n");
}

export type PromoteResult = {
  text: string;
  /** created: Unreleased became the version's section; merged: added to an existing one; kept: nothing to move. */
  action: "created" | "merged" | "kept";
};

/**
 * Move `## [Unreleased]`'s entries into `## [version] - date`, leaving an empty
 * Unreleased, and repoint the compare links when the file has them. A version that
 * already has a section gets Unreleased's entries added to it (a final release after
 * its betas, say). Throws when there is nothing to put under the version: no section
 * and an empty Unreleased.
 */
export function promoteUnreleased(text: string, version: string, date: string): PromoteResult {
  if (!VERSION_RE.test(version)) throw new Error(`"${version}" is not a version`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a YYYY-MM-DD date`);
  const changelog = parseChangelog(text);
  const unreleased = changelog.sections.find((s) => s.name.toLowerCase() === "unreleased");
  if (!unreleased) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const existing = changelog.sections.find((s) => s.name === version);
  const pending = !isEmptyBody(unreleased.body);
  if (!pending) {
    if (existing && !isEmptyBody(existing.body)) return { text, action: "kept" };
    throw new Error(
      `CHANGELOG.md has no notes for ${version}: write them under ## [Unreleased] (or a ## [${version}] section) first`,
    );
  }
  const emptied: ChangelogSection = { ...unreleased, body: "" };
  let action: PromoteResult["action"];
  let sections: ChangelogSection[];
  if (existing) {
    action = "merged";
    const merged: ChangelogSection = {
      ...existing,
      date,
      heading: `## [${existing.name}] - ${date}${existing.rest}`,
      body: mergeBodies(existing.body, unreleased.body),
    };
    sections = changelog.sections.map((s) => (s === unreleased ? emptied : s === existing ? merged : s));
  } else {
    action = "created";
    const created: ChangelogSection = {
      name: version,
      date,
      rest: "",
      heading: `## [${version}] - ${date}`,
      body: unreleased.body,
    };
    sections = changelog.sections.flatMap((s) => (s === unreleased ? [emptied, created] : [s]));
  }
  // Compare links: [Unreleased] compares the new tag with HEAD, and the version
  // compares the tag Unreleased used to start from with the new one.
  let links = changelog.links;
  const unreleasedLink = links.findIndex((line) => /^\[unreleased\]:/i.test(line.trim()));
  const compare = unreleasedLink >= 0 ? /^\[[^\]]+\]:\s*(\S+\/compare\/)(\S+)\.\.\.HEAD\s*$/i.exec(links[unreleasedLink].trim()) : null;
  if (compare) {
    const [, base, from] = compare;
    links = [...links];
    links[unreleasedLink] = `[Unreleased]: ${base}v${version}...HEAD`;
    if (!existing && !links.some((line) => line.startsWith(`[${version}]:`))) {
      links.splice(unreleasedLink + 1, 0, `[${version}]: ${base}${from}...v${version}`);
    }
  }
  return { text: formatChangelog({ ...changelog, sections, links }), action };
}

/**
 * Problems with the file's shape, for CI: an Unreleased section first, versions that
 * parse, no version twice, dates in order (newest first), only Keep a Changelog
 * subsections, and every section but Unreleased saying something.
 */
export function lintChangelog(text: string): string[] {
  const problems: string[] = [];
  let changelog: Changelog;
  try {
    changelog = parseChangelog(text);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const isUnreleased = (section: ChangelogSection) => section.name.toLowerCase() === "unreleased";
  const first = changelog.sections[0];
  if (!first || !isUnreleased(first)) problems.push("the first section must be ## [Unreleased]");
  if (changelog.sections.filter(isUnreleased).length > 1) problems.push("there is more than one ## [Unreleased]");
  const seen = new Set<string>();
  let previousDate: string | null = null;
  for (const section of changelog.sections.filter((s) => !isUnreleased(s))) {
    if (!VERSION_RE.test(section.name)) problems.push(`[${section.name}] is not a version`);
    if (seen.has(section.name)) problems.push(`[${section.name}] appears twice`);
    seen.add(section.name);
    if (!section.date) problems.push(`[${section.name}] has no date`);
    else if (previousDate && section.date > previousDate) problems.push(`[${section.name}] is dated after the section above it`);
    if (section.date) previousDate = section.date;
    if (isEmptyBody(section.body)) problems.push(`[${section.name}] has no entries`);
  }
  for (const section of changelog.sections) {
    for (const line of section.body.split("\n")) {
      const head = /^###\s+(.+?)\s*$/.exec(line);
      if (head && !(CATEGORIES as readonly string[]).includes(head[1])) {
        problems.push(`[${section.name}] has "### ${head[1]}"; use ${CATEGORIES.join(", ")}`);
      }
    }
  }
  return problems;
}

/** True for a plain MAJOR.MINOR.PATCH (no suffix). */
export function isPlainVersion(version: string): boolean {
  return PLAIN_RE.test(version);
}
