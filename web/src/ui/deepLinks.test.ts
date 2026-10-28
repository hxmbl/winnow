import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messageLink } from "../core/notify/notifications";
import { deepLinkRoute, linkRepeatFilter, REPEAT_LINK_MS, wireDeepLinks, type DeepLinkSources } from "./deepLinks";

describe("deepLinkRoute", () => {
  it("opens the exact message a notification names, in its account", () => {
    expect(deepLinkRoute(messageLink(42, "18f0abc", "acct1234"))).toEqual({
      kind: "action",
      event: { action: "open", messageId: 42, gmailId: "18f0abc", origin: "desktop", account: "acct1234" },
    });
  });

  it("opens a background-sync notification's message by its Gmail id (no local id yet)", () => {
    // MailSyncService posts messageId 0: the message may not be in the local store, so
    // the app fetches it by its Gmail id (store.ensureMessage).
    expect(deepLinkRoute("winnow://message/0?account=acct1234&gmail=18f0abc")).toEqual({
      kind: "action",
      event: { action: "open", messageId: 0, gmailId: "18f0abc", origin: "desktop", account: "acct1234" },
    });
  });

  it("opens the account's inbox for a summary's tap", () => {
    expect(deepLinkRoute("winnow://open?account=acct1234&view=inbox")).toEqual({
      kind: "action",
      event: { action: "inbox", messageId: 0, gmailId: "", origin: "desktop", account: "acct1234" },
    });
  });

  it("only syncs for a plain open, and only focuses for sign-in's return or anything unknown", () => {
    expect(deepLinkRoute("winnow://open")).toEqual({ kind: "refresh" });
    expect(deepLinkRoute("winnow://signed-in")).toEqual({ kind: "focus" });
    expect(deepLinkRoute("winnow://elsewhere/1")).toEqual({ kind: "focus" });
    expect(deepLinkRoute("https://example.com")).toEqual({ kind: "focus" });
  });
});

describe("linkRepeatFilter", () => {
  it("drops the same link inside the window and lets it through after", () => {
    let now = 1_000;
    const fresh = linkRepeatFilter(REPEAT_LINK_MS, () => now);
    expect(fresh("winnow://message/1?gmail=a")).toBe(true);
    expect(fresh("winnow://message/1?gmail=a")).toBe(false);
    expect(fresh("winnow://message/2?gmail=b")).toBe(true);
    now += REPEAT_LINK_MS + 1;
    expect(fresh("winnow://message/1?gmail=a")).toBe(true);
  });
});

/** Sources driven by the test: `emit` is the deep-link event, `keep` what native holds. */
function fakeSources(android: boolean, initial: string[] = []) {
  let handler: ((url: string) => void) | null = null;
  let kept = [...initial];
  let asks = 0;
  const sources: DeepLinkSources = {
    onDeepLink(next) {
      handler = next;
      return () => {
        handler = null;
      };
    },
    launchLinks() {
      asks += 1;
      const out = kept;
      // Android takes the kept link once; the desktop's "current" link stays.
      if (android) kept = [];
      return Promise.resolve(out);
    },
    keepsDeliveredLinks: () => Promise.resolve(android),
  };
  return {
    sources,
    emit: (url: string) => handler?.(url),
    keep: (url: string) => {
      kept = [url];
    },
    asks: () => asks,
    listening: () => handler !== null,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("wireDeepLinks", () => {
  const A = "winnow://message/0?account=acct1234&gmail=aaa";
  const B = "winnow://message/0?account=acct1234&gmail=bbb";

  it("cold start: opens the link the app was started for, once", async () => {
    const fake = fakeSources(true, [A]);
    const opened: string[] = [];
    wireDeepLinks(fake.sources, (url) => opened.push(url));
    await flush();
    expect(opened).toEqual([A]);
  });

  it("warm tap on Android: opens it once, and takes the kept copy so a later page load doesn't reopen it", async () => {
    const fake = fakeSources(true);
    const opened: string[] = [];
    wireDeepLinks(fake.sources, (url) => opened.push(url));
    await flush();
    // MainActivity.onNewIntent keeps it, then the plugin's event delivers it.
    fake.keep(B);
    fake.emit(B);
    await flush();
    expect(opened).toEqual([B]);
    // The kept copy is gone: a page reload asks again and gets nothing.
    expect(await fake.sources.launchLinks()).toEqual([]);
  });

  it("a tap the event route lost (Rust not up yet) is still opened from the kept copy", async () => {
    const fake = fakeSources(true);
    const opened: string[] = [];
    wireDeepLinks(fake.sources, (url) => opened.push(url));
    await flush();
    fake.keep(B);
    // The plugin missed B; the next event (here A) takes the kept copy too.
    fake.emit(A);
    await flush();
    expect(opened).toEqual([A, B]);
  });

  it("the same tap by both routes opens once", async () => {
    const fake = fakeSources(true, [A]);
    const opened: string[] = [];
    wireDeepLinks(fake.sources, (url) => opened.push(url));
    fake.emit(A);
    await flush();
    expect(opened).toEqual([A]);
  });

  it("desktop: never asks again after an event (its current link can be an older launch's)", async () => {
    const fake = fakeSources(false, [A]);
    const opened: string[] = [];
    wireDeepLinks(fake.sources, (url) => opened.push(url));
    await flush();
    fake.emit(B);
    await flush();
    expect(opened).toEqual([A, B]);
    expect(fake.asks()).toBe(1);
  });

  it("unsubscribes", () => {
    const fake = fakeSources(true);
    const stop = wireDeepLinks(fake.sources, () => undefined);
    expect(fake.listening()).toBe(true);
    stop();
    expect(fake.listening()).toBe(false);
  });

  it("a failing launch ask opens nothing and throws nothing", async () => {
    const fake = fakeSources(true);
    const opened: string[] = [];
    wireDeepLinks({ ...fake.sources, launchLinks: () => Promise.reject(new Error("no shell")) }, (url) => opened.push(url));
    await flush();
    expect(opened).toEqual([]);
  });
});

describe("Android accepts winnow:// links (STRM-439)", () => {
  it("tauri.conf.json lists the winnow scheme for the deep-link plugin on mobile", () => {
    // Without a `mobile` entry the plugin's Android half drops every link, so a
    // notification's tap opened Winnow but never the email.
    const path = fileURLToPath(new URL("../../../native/src-tauri/tauri.conf.json", import.meta.url));
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      plugins: { "deep-link": { mobile?: { scheme?: string[]; host?: string; appLink?: boolean }[] } };
    };
    const mobile = config.plugins["deep-link"].mobile ?? [];
    const winnow = mobile.find((entry) => entry.scheme?.includes("winnow"));
    expect(winnow).toBeDefined();
    expect(winnow?.host).toBeUndefined();
    expect(winnow?.appLink).toBe(false);
  });
});
