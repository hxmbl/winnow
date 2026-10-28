import { describe, expect, it } from "vitest";
import {
  actionFlags,
  backgroundServiceConfig,
  backgroundServiceHint,
  parseActiveNotices,
  parseBackgroundStatus,
  type BackgroundServicePrefs,
} from "./backgroundService";

const prefs: BackgroundServicePrefs = {
  backgroundSync: true,
  notificationsEnabled: true,
  notificationActions: { reply: true, trash: true, read: false },
  notificationHidePreview: false,
  mutedSenders: ["News@Example.com"],
  blockedSenders: ["spam@example.com", "news@example.com"],
};
const one = [{ id: "abcd1234", email: "me@example.com", notify: true }];
const two = [...one, { id: "work9999", email: "me@work.example", notify: false }];

describe("backgroundServiceConfig", () => {
  it("is on only with syncing while closed, notifications and a signed-in account", () => {
    expect(backgroundServiceConfig(prefs, one, "abcd1234", true).enabled).toBe(true);
    expect(backgroundServiceConfig({ ...prefs, backgroundSync: false }, one, "abcd1234", true).enabled).toBe(false);
    expect(backgroundServiceConfig({ ...prefs, notificationsEnabled: false }, one, "abcd1234", true).enabled).toBe(false);
    expect(backgroundServiceConfig(prefs, one, "abcd1234", false).enabled).toBe(false);
    expect(backgroundServiceConfig(prefs, [], null, true).enabled).toBe(false);
  });

  it("carries each account's own switch, and the address only with several accounts", () => {
    expect(backgroundServiceConfig(prefs, one, "abcd1234", true).accounts).toEqual([{ id: "abcd1234", label: null, notify: true }]);
    expect(backgroundServiceConfig(prefs, two, "work9999", true).accounts).toEqual([
      { id: "abcd1234", label: "me@example.com", notify: true },
      { id: "work9999", label: "me@work.example", notify: false },
    ]);
  });

  it("passes muted and hidden senders once each, lowercased, and the buttons as flags", () => {
    const config = backgroundServiceConfig(prefs, one, "abcd1234", true);
    expect(config.quietSenders).toEqual(["news@example.com", "spam@example.com"]);
    expect(config.actions).toBe(3);
    expect(actionFlags({ reply: false, trash: false, read: true })).toBe(4);
  });

  it("never names an account that is not signed in as the open one, nor a malformed id", () => {
    expect(backgroundServiceConfig(prefs, one, "gone0000", true).activeAccount).toBeNull();
    expect(backgroundServiceConfig(prefs, [{ id: "../x", email: "a@b", notify: true }], null, true).accounts).toEqual([]);
  });
});

describe("what comes back from the native side", () => {
  it("a status is read strictly", () => {
    expect(parseBackgroundStatus({ enabled: true, running: true, batteryUnrestricted: false, notificationsAllowed: true })).toEqual({
      enabled: true,
      running: true,
      batteryUnrestricted: false,
      notificationsAllowed: true,
    });
    expect(parseBackgroundStatus(null)).toBeNull();
    expect(parseBackgroundStatus({ running: "yes" })).toBeNull();
  });

  it("active notifications keep only well-formed ids", () => {
    expect(
      parseActiveNotices([
        { account: "abcd1234", gmailId: "18f2a" },
        { account: null, gmailId: "abc" },
        { account: "../x", gmailId: "def" },
        { gmailId: "bad id" },
        "nope",
      ]),
    ).toEqual([
      { account: "abcd1234", gmailId: "18f2a" },
      { account: null, gmailId: "abc" },
      { account: null, gmailId: "def" },
    ]);
    expect(parseActiveNotices(null)).toEqual([]);
  });
});

describe("backgroundServiceHint", () => {
  const running = { enabled: true, running: true, batteryUnrestricted: true, notificationsAllowed: true };
  it("says what the user can fix first", () => {
    expect(backgroundServiceHint({ backgroundSync: false, notificationsEnabled: true }, running)).toBeNull();
    expect(backgroundServiceHint({ backgroundSync: true, notificationsEnabled: false }, running)).toMatch(/Turn on notifications/);
    expect(backgroundServiceHint({ backgroundSync: true, notificationsEnabled: true }, { ...running, notificationsAllowed: false })).toMatch(/Android isn't letting/);
    expect(backgroundServiceHint({ backgroundSync: true, notificationsEnabled: true }, running)).toMatch(/once a minute/);
    expect(backgroundServiceHint({ backgroundSync: true, notificationsEnabled: true }, null)).toBeNull();
  });
});
