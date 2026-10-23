import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATEGORIES, SETTINGS, SETTING_IDS, settingsIn } from "./settingsCatalog";

/** The Settings components (and the Accounts page, which took the per-account rows), read as text: every row names its setting by id. */
const source = ["components/SettingsPanel.tsx", "components/SettingsControls.tsx", "components/SmartFilterSettings.tsx", "components/AccountsPage.tsx"]
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");

/** Sentences in a piece of copy: ends at . ! or ? followed by a space or the end. */
function sentences(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0).length;
}

describe("the settings catalog", () => {
  it("gives every setting an explanation of two to four sentences", () => {
    const missing = SETTING_IDS.filter((id) => SETTINGS[id].explanation.trim().length === 0);
    expect(missing).toEqual([]);
    for (const id of SETTING_IDS) {
      const count = sentences(SETTINGS[id].explanation);
      expect({ id, ok: count >= 2 && count <= 4 }).toEqual({ id, ok: true });
    }
  });

  it("gives every setting a label and a category that exists", () => {
    const categories = new Set(CATEGORIES.map((category) => category.id));
    for (const id of SETTING_IDS) {
      expect(SETTINGS[id].label.trim()).not.toBe("");
      expect(categories.has(SETTINGS[id].category)).toBe(true);
    }
  });

  it("gives every category an intro and at least one setting", () => {
    for (const category of CATEGORIES) {
      expect(category.intro.trim()).not.toBe("");
      expect(settingsIn(category.id).length).toBeGreaterThan(0);
    }
  });

  it("has one category per id", () => {
    const ids = CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders every catalogued setting, so no explanation is orphaned", () => {
    const rendered = new Set([...source.matchAll(/setting="([A-Za-z]+)"/g)].map((match) => match[1]));
    expect(SETTING_IDS.filter((id) => !rendered.has(id))).toEqual([]);
  });

  it("has an entry for every setting the screen renders, so no row lacks its copy", () => {
    const rendered = [...source.matchAll(/setting="([A-Za-z]+)"/g)].map((match) => match[1]);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.filter((id) => !(id in SETTINGS))).toEqual([]);
  });

  it("names the privacy cost of the two picture sources", () => {
    expect(SETTINGS.brandLogos.explanation).toMatch(/Cloudflare/);
    expect(SETTINGS.brandLogos.explanation).toMatch(/DNS-over-HTTPS/);
    expect(SETTINGS.gravatars.explanation).toMatch(/hashed copy of each sender's address/);
  });

  it("ends with Dev Options, which holds Pure Plain Text", () => {
    expect(CATEGORIES.at(-1)).toMatchObject({ id: "dev", label: "Dev Options" });
    expect(settingsIn("dev")[0]).toBe("purePlainText");
    expect(SETTINGS.purePlainText.label).toBe("Pure Plain Text");
    // A real switch with its name and its one-line description wired for screen readers.
    expect(source).toMatch(/<Row setting="purePlainText" hint=\{PURE_PLAIN_TEXT_HINT\} hintId="winnow-pure-plain-text-hint">/);
    expect(source).toMatch(/label=\{SETTINGS\.purePlainText\.label\}\s+describedBy="winnow-pure-plain-text-hint"/);
    expect(source).toContain('const PURE_PLAIN_TEXT_HINT = "Show plain text exactly as sent, with nothing removed";');
    expect(source).toContain("aria-describedby={describedBy}");
  });

  it("does not use American spellings in the copy", () => {
    const copy = [...SETTING_IDS.map((id) => SETTINGS[id].explanation), ...CATEGORIES.map((c) => c.intro)].join(" ");
    expect(copy).not.toMatch(/\b(color|license|favorite|organize|behavior)\b/i);
  });
});
