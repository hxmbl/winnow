import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * "Why it's here" sits at the bottom of the email (1.3.3, the owner's call), grouped with
 * the "Not where it belongs? / Change smart filters…" footer, on phone and desktop alike.
 */
describe("the reader's Why it's here", () => {
  const reader = readFileSync(new URL("./components/Reader.tsx", import.meta.url), "utf8");
  const article = reader.indexOf("<article");
  const footer = reader.indexOf('data-reader-filters-footer=""');

  it("is rendered once, inside the filters footer after the message", () => {
    expect(reader.match(/\{whyHere\}/g)).toHaveLength(1);
    expect(article).toBeGreaterThan(0);
    expect(footer).toBeGreaterThan(article);
    const group = reader.slice(footer, reader.indexOf("Change smart filters…", footer));
    expect(group).toContain("{whyHere}");
    expect(group).toContain("Not where it belongs?");
  });

  it("is not in the header under the sender any more", () => {
    expect(reader.slice(0, article)).not.toMatch(/\{whyHere\s*&&/);
  });

  it("shows the group when there is a reason even without Change smart filters", () => {
    expect(reader).toMatch(/\(whyHere \|\| actions\.onChangeFilters\) && \(\s*<div data-reader-filters-footer/);
  });
});
