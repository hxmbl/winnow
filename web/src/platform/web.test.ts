/**
 * Web platform sign-in tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webPlatform } from "./web";
import { webTokenStore } from "./types";
import type { SignInRequest, SignInResult } from "./types";

const AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?state=s0&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback";

const REQUEST: SignInRequest = { authorizeUrl: AUTHORIZE_URL, timeoutMs: 300_000 };

/** A `location` whose `assign` records what it was asked to open. */
function installLocation(assign: (url: string | URL) => void): void {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { assign, search: "", origin: "http://localhost:5173" },
  });
}

function installSessionStorage(): void {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    },
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

describe("webPlatform.beginSignIn", () => {
  it("records the state and asks the browser to navigate, without ever settling", async () => {
    installSessionStorage();
    const assigned: string[] = [];
    installLocation((url) => void assigned.push(String(url)));

    const inflight = webPlatform.beginSignIn(REQUEST);
    let settled: string | null = null;
    void inflight.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );
    await flush();

    expect(assigned).toEqual([AUTHORIZE_URL]);
    expect(globalThis.sessionStorage?.getItem("winnow.pendingState")).toBe("s0");
    expect(settled).toBeNull();
  });

  it("settles with a fault when the browser refuses the navigation", async () => {
    installSessionStorage();
    const refused = new Error("blocked by the browser");
    installLocation(() => {
      throw refused;
    });

    const result: SignInResult = await webPlatform.beginSignIn(REQUEST);
    expect(result).toEqual({ kind: "unavailable", detail: "blocked by the browser" });
  });

  it("settles with a fault when there is no browser to navigate", async () => {
    const result: SignInResult = await webPlatform.beginSignIn(REQUEST);
    expect(result).toEqual({
      kind: "unavailable",
      detail: "there is no browser to navigate to Google",
    });
  });
});

describe("webTokenStore", () => {
  it("is importable alongside the platform (the boundary stays one shape)", () => {
    expect(typeof webTokenStore).toBe("function");
  });
});
describe("webPlatform background polling", () => {
  it("floors the interval at 30s and keeps polling while hidden", async () => {
    const { webPollSeconds, MIN_BACKGROUND_POLL_SECONDS } = await import("./web");
    expect(MIN_BACKGROUND_POLL_SECONDS).toBe(30);
    await webPlatform.setBackgroundSync(5);
    expect(webPollSeconds()).toBe(30);
    await webPlatform.setBackgroundSync(300);
    expect(webPollSeconds()).toBe(300);
    await webPlatform.setBackgroundSync(null);
    expect(webPollSeconds()).toBe(0);
  });
});

describe("webPlatform notifications", () => {
  type Shown = { title: string; options: { body?: string; tag?: string; icon?: string }; onclick: (() => void) | null; closed: boolean };
  const shown: Shown[] = [];
  beforeEach(() => {
    shown.length = 0;
    class FakeNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, options: { body?: string; tag?: string; icon?: string }) {
        const entry: Shown = { title, options, onclick: null, closed: false };
        shown.push(entry);
        Object.defineProperty(this, "onclick", {
          set: (handler: () => void) => void (entry.onclick = handler),
          get: () => entry.onclick,
        });
      }
      close() {
        const entry = shown.find((candidate) => candidate.onclick === this.onclick);
        if (entry) entry.closed = true;
      }
    }
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: FakeNotification });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "Notification");
  });

  const batch = (hidePreview: boolean) => ({
    total: 7,
    summaryTitle: "7 new messages",
    summaryBody: "Ada, Bob",
    messages: [
      { messageId: 1, gmailId: "a1", threadId: null, title: "Ada", subject: "Plan", preview: "", receivedAt: 0, replyHead: null, picture: "/demo-avatars/ada.svg" },
      { messageId: 2, gmailId: "b2", threadId: null, title: "Bob", subject: "Lunch", preview: "", receivedAt: 0, replyHead: null, picture: null },
    ],
    actions: { reply: true, trash: true, read: true },
    hidePreview,
  });

  it("shows one notification per message plus a summary for the rest, each click opening its message", async () => {
    const pressed: unknown[] = [];
    const stop = webPlatform.onNotificationAction((event) => pressed.push(event));
    await webPlatform.notifyNewMail(batch(false));
    expect(shown.map((entry) => [entry.title, entry.options.body, entry.options.tag])).toEqual([
      ["Ada", "Plan", "winnow-a1"],
      ["Bob", "Lunch", "winnow-b2"],
      ["7 new messages", "Ada, Bob", "winnow-new-mail"],
    ]);
    shown[1].onclick?.();
    expect(pressed).toEqual([{ action: "open", messageId: 2, gmailId: "b2", origin: "web" }]);
    stop();
    shown[0].onclick?.();
    expect(pressed).toHaveLength(1);
  });

  it("1.4.0: tags each press with its account, says whose mail it is, and a summary opens that inbox", async () => {
    const pressed: unknown[] = [];
    const stop = webPlatform.onNotificationAction((event) => pressed.push(event));
    await webPlatform.notifyNewMail({ ...batch(false), account: { id: "acct2xx", label: "two@x.example" } });
    expect(shown.map((entry) => [entry.options.body, entry.options.tag])).toEqual([
      ["Plan\ntwo@x.example", "winnow-acct2xx-a1"],
      ["Lunch\ntwo@x.example", "winnow-acct2xx-b2"],
      ["Ada, Bob\ntwo@x.example", "winnow-new-mail-acct2xx"],
    ]);
    shown[0].onclick?.();
    shown[2].onclick?.();
    expect(pressed).toEqual([
      { action: "open", messageId: 1, gmailId: "a1", origin: "web", account: "acct2xx" },
      { action: "inbox", messageId: 0, gmailId: "", origin: "web", account: "acct2xx" },
    ]);
    stop();
  });

  it("names no subject when previews are hidden", async () => {
    await webPlatform.notifyNewMail(batch(true));
    expect(shown.map((entry) => entry.options.body)).toEqual(["New message", "New message", ""]);
    // Nor whose it is: no sender picture either.
    expect(shown.map((entry) => entry.options.icon)).toEqual([undefined, undefined, undefined]);
  });

  it("uses the sender's picture as the icon when there is one, and nothing otherwise", async () => {
    await webPlatform.notifyNewMail(batch(false));
    expect(shown.map((entry) => entry.options.icon)).toEqual(["/demo-avatars/ada.svg", undefined, undefined]);
  });
});
