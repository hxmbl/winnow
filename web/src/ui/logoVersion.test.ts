import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION_TOGGLE_LABEL, logoHaptic, logoPressed, logoViewAfter, versionText } from "./logoVersion";

describe("the logo's version toggle", () => {
  it("names the app and the build's version", () => {
    expect(versionText("1.2.2")).toBe("Winnow 1.2.2");
    expect(versionText(" 2.0.0-beta.1 ")).toBe("Winnow 2.0.0-beta.1");
  });

  it("says just the name until the build has said what it is", () => {
    expect(versionText(null)).toBe("Winnow");
    expect(versionText(undefined)).toBe("Winnow");
    expect(versionText("")).toBe("Winnow");
  });

  it("is not a literal: the version comes from the build (package.json through Vite)", () => {
    const source = readFileSync(new URL("./logoVersion.ts", import.meta.url), "utf8");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(source).not.toContain(pkg.version);
    const vite = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
    expect(vite).toMatch(/__WINNOW_VERSION__: JSON\.stringify\(version\)/);
  });

  it("toggles on the mark, there and back", () => {
    expect(logoViewAfter("search", "logo")).toBe("version");
    expect(logoViewAfter("version", "logo")).toBe("search");
  });

  it("goes back to search for / or a focus on the field, and stays there", () => {
    expect(logoViewAfter("version", "focusSearch")).toBe("search");
    expect(logoViewAfter("search", "focusSearch")).toBe("search");
  });

  it("reads as pressed while the version shows, under one unchanging name", () => {
    expect(logoPressed("version")).toBe(true);
    expect(logoPressed("search")).toBe(false);
    expect(VERSION_TOGGLE_LABEL).toMatch(/version/i);
  });

  it("ticks on a phone, and not on the desktop", () => {
    expect(logoHaptic(true)).toBeGreaterThan(0);
    expect(logoHaptic(false)).toBeNull();
  });
});
