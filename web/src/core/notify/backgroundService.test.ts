import { describe, expect, it } from "vitest";
import {
  actionFlags,
  backgroundServiceConfig,
  backgroundServiceHint,
  fallbackPollMinutes,
  gmailListenerHint,
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
    expect(backgroundServiceConfig(prefs, one, "abcd1234", true).accounts).toEqual([
      { id: "abcd1234", label: null, notify: true, address: "me@example.com" },
    ]);
    expect(backgroundServiceConfig(prefs, two, "work9999", true).accounts).toEqual([
      { id: "abcd1234", label: "me@example.com", notify: true, address: "me@example.com" },
      { id: "work9999", label: "me@work.example", notify: false, address: "me@work.example" },
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
      listenerAccess: false,
      listenerConnected: false,
      gmailInstalled: false,
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
  const running = {
    enabled: true,
    running: true,
    batteryUnrestricted: true,
    notificationsAllowed: true,
    listenerAccess: false,
    listenerConnected: false,
    gmailInstalled: true,
  };
  it("names the fallback pace: 10 minutes with the Gmail-app listener connected, 5 otherwise", () => {
    const on = { backgroundSync: true, notificationsEnabled: true, gmailListener: true };
    expect(backgroundServiceHint(on, running)).toMatch(/every 5 minutes/);
    expect(backgroundServiceHint(on, { ...running, listenerAccess: true, listenerConnected: true })).toMatch(/Gmail app.*every 10 minutes/);
    expect(backgroundServiceHint({ ...on, gmailListener: false }, { ...running, listenerConnected: true })).toMatch(/every 5 minutes/);
    expect(backgroundServiceHint(on, { ...running, running: false })).toBeNull();
  });
  it("says what the user can fix first", () => {
    expect(backgroundServiceHint({ backgroundSync: false, notificationsEnabled: true }, running)).toBeNull();
    expect(backgroundServiceHint({ backgroundSync: true, notificationsEnabled: false }, running)).toMatch(/Turn on notifications/);
    expect(backgroundServiceHint({ backgroundSync: true, notificationsEnabled: true }, { ...running, notificationsAllowed: false })).toMatch(/Android isn't letting/);
    expect(backgroundServiceHint({ backgroundSync: true, notificationsEnabled: true }, running)).toMatch(/every 5 minutes/);
    expect(backgroundServiceHint({ backgroundSync: true, notificationsEnabled: true }, null)).toBeNull();
  });
});

describe("Instant mail via the Gmail app", () => {
  const status = {
    enabled: true,
    running: true,
    batteryUnrestricted: true,
    notificationsAllowed: true,
    listenerAccess: true,
    listenerConnected: true,
    gmailInstalled: true,
  };

  it("is handed to the service only when the service itself is on", () => {
    expect(backgroundServiceConfig({ ...prefs, gmailListener: true }, one, "abcd1234", true).gmailListener).toBe(true);
    expect(backgroundServiceConfig(prefs, one, "abcd1234", true).gmailListener).toBe(false);
    expect(backgroundServiceConfig({ ...prefs, gmailListener: true, backgroundSync: false }, one, "abcd1234", true).gmailListener).toBe(false);
    expect(backgroundServiceConfig({ ...prefs, gmailListener: true, notificationsEnabled: false }, one, "abcd1234", true).gmailListener).toBe(false);
    expect(backgroundServiceConfig({ ...prefs, gmailListener: true }, one, "abcd1234", false).gmailListener).toBe(false);
  });

  it("sends a lowercased address for matching, and none when there is no address", () => {
    const accounts = backgroundServiceConfig(prefs, [{ id: "abcd1234", email: " Me@Example.COM ", notify: true }, { id: "work9999", email: "", notify: true }], null, true).accounts;
    expect(accounts.map((a) => a.address)).toEqual(["me@example.com", null]);
  });

  it("reads the listener's status, and only a definite yes counts", () => {
    expect(parseBackgroundStatus({ running: true, listenerAccess: true, listenerConnected: true, gmailInstalled: true })).toMatchObject({
      listenerAccess: true,
      listenerConnected: true,
      gmailInstalled: true,
    });
    // An older native side says nothing about it: no listener.
    expect(parseBackgroundStatus({ running: true })).toMatchObject({ listenerAccess: false, listenerConnected: false, gmailInstalled: false });
  });

  it("says what is in the way first, then whether Android has connected it", () => {
    expect(gmailListenerHint(false, status)).toBeNull();
    expect(gmailListenerHint(true, null)).toBeNull();
    expect(gmailListenerHint(true, { ...status, gmailInstalled: false })).toMatch(/Gmail app isn't installed/);
    expect(gmailListenerHint(true, { ...status, listenerAccess: false, listenerConnected: false })).toMatch(/Notification access/);
    expect(gmailListenerHint(true, { ...status, listenerConnected: false })).toMatch(/Waiting for Android/);
    expect(gmailListenerHint(true, status)).toMatch(/^On\./);
  });

  it("picks the same fallback pace as the service", () => {
    expect(fallbackPollMinutes(true, true)).toBe(10);
    expect(fallbackPollMinutes(true, false)).toBe(5);
    expect(fallbackPollMinutes(false, true)).toBe(5);
  });
});
