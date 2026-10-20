import { describe, expect, it } from "vitest";
import { ACCOUNT_COLORS } from "../core/session/accounts";
import { ADD_ACCOUNT_HELP, accountColorHex, demoAccounts, switcherLabel, unreadLabel } from "./accounts";

describe("the account switcher's rules", () => {
  it("gives five accounts five different dots in every mode", () => {
    for (const scheme of ["light", "dark", "oled"] as const) {
      const hexes = ACCOUNT_COLORS.map((color) => accountColorHex(color, scheme));
      expect(new Set(hexes).size).toBe(ACCOUNT_COLORS.length);
      for (const hex of hexes) expect(hex).toMatch(/^#[0-9A-F]{6}$/i);
    }
    // Something unknown in storage falls back to the first, never to no colour.
    expect(accountColorHex("chartreuse", "light")).toBe(accountColorHex("space", "light"));
  });

  it("caps the unread figure and says nothing for none", () => {
    expect(unreadLabel(null)).toBe("");
    expect(unreadLabel(0)).toBe("");
    expect(unreadLabel(7)).toBe("7");
    expect(unreadLabel(140)).toBe("99+");
  });

  it("the demo shows two accounts, one open, so the switcher can be tried", () => {
    const accounts = demoAccounts("work");
    expect(accounts).toHaveLength(2);
    expect(accounts.filter((account) => account.active)).toHaveLength(1);
    expect(accounts.every((account) => account.demo)).toBe(true);
    expect(demoAccounts("home").find((account) => account.active)?.email).toContain("home");
    expect(switcherLabel(accounts)).toBe(`Accounts: ${accounts[0].email}`);
  });

  it("says, under Add account, that in Testing mode every address must be a test user", () => {
    expect(ADD_ACCOUNT_HELP).toMatch(/Testing/);
    expect(ADD_ACCOUNT_HELP).toMatch(/test users/i);
  });
});
