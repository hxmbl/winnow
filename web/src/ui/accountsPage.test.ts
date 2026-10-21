import { describe, expect, it } from "vitest";
import type { AccountSummary } from "../core/store/store";
import { MAX_ACCOUNTS } from "../core/session/accounts";
import { ACCOUNTS_FULL, ADD_ACCOUNT_HELP, demoAccounts } from "./accounts";
import {
  ACCOUNTS_LIST,
  accountDetail,
  accountStatusLine,
  accountsBack,
  accountsPageModel,
  accountsSummary,
  resolveView,
} from "./accountsPage";

function account(id: string, extra: Partial<AccountSummary> = {}): AccountSummary {
  return { id, email: `${id}@example.com`, color: "space", notify: true, unread: null, active: false, ...extra };
}

const idle = { busy: false, canOpenDemo: true };

describe("the Accounts page's list", () => {
  it("offers Connect Gmail with nothing signed in, and no sign-out or demo link", () => {
    const model = accountsPageModel([], idle);
    expect(model).toMatchObject({ demo: false, full: false, addLabel: "Connect Gmail", addDisabled: false, signOutAll: false, openDemo: false });
    expect(model.addHelp).toBe(ADD_ACCOUNT_HELP);
  });

  it("offers Add account, the demo inbox, and Sign out of all only from two accounts", () => {
    const one = accountsPageModel([account("a", { active: true })], idle);
    expect(one).toMatchObject({ addLabel: "Add account", signOutAll: false, openDemo: true });
    const two = accountsPageModel([account("a", { active: true }), account("b")], idle);
    expect(two.signOutAll).toBe(true);
    expect(accountsPageModel([account("a", { active: true })], { busy: false, canOpenDemo: false }).openDemo).toBe(false);
  });

  it("refuses a sixth account with the switcher's words", () => {
    const five = Array.from({ length: MAX_ACCOUNTS }, (_, index) => account(`a${index}`, { active: index === 0 }));
    const model = accountsPageModel(five, idle);
    expect(model).toMatchObject({ full: true, addDisabled: true, addHelp: ACCOUNTS_FULL });
  });

  it("waits while Google is asked", () => {
    const model = accountsPageModel([account("a", { active: true })], { busy: true, canOpenDemo: true });
    expect(model).toMatchObject({ addLabel: "Waiting for Google…", addDisabled: true });
  });

  it("shows the demo's accounts with Connect Gmail and nothing to sign out of", () => {
    const model = accountsPageModel(demoAccounts("work"), idle);
    expect(model).toMatchObject({ demo: true, full: false, addLabel: "Connect Gmail", signOutAll: false, openDemo: false });
  });

  it("says Open now for the open account, the unread count for the rest", () => {
    expect(accountStatusLine(account("a", { active: true, unread: 40 }), 3)).toBe("Open now");
    expect(accountStatusLine(account("b", { unread: 140 }), 3)).toBe("99+ unread");
    expect(accountStatusLine(account("c", { unread: 0 }), 3)).toBe("No unread mail");
    expect(accountStatusLine(account("d", { unread: 2, demo: true }), 0)).toBe("2 unread · demo");
  });

  it("summarises the accounts for the Settings row", () => {
    expect(accountsSummary([])).toBe("No Gmail account is signed in yet.");
    expect(accountsSummary(demoAccounts("work"))).toBe("No Gmail account is signed in yet.");
    expect(accountsSummary([account("a")])).toBe("1 account on this device");
    expect(accountsSummary([account("a"), account("b")])).toBe("2 accounts on this device");
  });
});

describe("an account's page", () => {
  it("offers switching for every account but the open one", () => {
    expect(accountDetail(account("a", { active: true }), false).canSwitch).toBe(false);
    expect(accountDetail(account("b"), false).canSwitch).toBe(true);
    expect(accountDetail(account("b"), true)).toMatchObject({ canSwitch: false, canSignOut: false });
  });

  it("gives a real account its colour, notifications and sign-out, the demo's Connect Gmail", () => {
    expect(accountDetail(account("a"), false)).toEqual({ canSwitch: true, canEdit: true, canSignOut: true, connectInstead: false });
    const [work] = demoAccounts("home");
    expect(accountDetail(work, false)).toEqual({ canSwitch: true, canEdit: false, canSignOut: false, connectInstead: true });
  });

  it("falls back to the list when its account is signed out", () => {
    const accounts = [account("a", { active: true }), account("b")];
    expect(resolveView({ screen: "detail", id: "b" }, accounts)).toEqual({ screen: "detail", id: "b" });
    expect(resolveView({ screen: "detail", id: "gone" }, accounts)).toEqual(ACCOUNTS_LIST);
    expect(resolveView(ACCOUNTS_LIST, [])).toEqual(ACCOUNTS_LIST);
  });

  it("steps Back to the list, and the list's Back closes the page", () => {
    expect(accountsBack({ screen: "detail", id: "b" })).toEqual(ACCOUNTS_LIST);
    expect(accountsBack(ACCOUNTS_LIST)).toBe("close");
  });
});
