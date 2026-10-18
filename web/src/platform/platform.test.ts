/**
 * Platform boundary wire-shape tests.
 */

import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLATFORM_KEYS, webTokenStore, type PlatformInfo, type PlatformKey } from "./types";
import type { TokenSet } from "../core/gmail/dto";

type InvokeCall = { cmd: string; args?: Record<string, unknown> };

// ── The Tauri boundary, recorded ─────────────────────────────────────────────

const invokes: InvokeCall[] = [];
/** What `invoke` answers with. Throw from it to make the call reject. */
let reply: (cmd: string, args?: Record<string, unknown>) => unknown = () => undefined;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    return reply(cmd, args);
  },
}));

type Subscription = { event: string; handler: (event: { payload: unknown }) => void };

const subscriptions: Subscription[] = [];
const unlistened: string[] = [];
/** Hold `listen` open, so the "unsubscribed before it resolved" race is reachable. */
let listenHeld = false;
/** Refuse the subscription outright, which `listen` can do for a denied event. */
let listenFails = false;
const waitingUnlistens: Array<() => void> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    subscriptions.push({ event, handler });
    const unlisten = () => void unlistened.push(event);
    if (listenFails) return Promise.reject(new Error("event not allowed"));
    if (!listenHeld) return Promise.resolve(unlisten);
    return new Promise<() => void>((resolve) => waitingUnlistens.push(() => resolve(unlisten)));
  },
}));

const windowCalls: string[] = [];
/** Throw from this to make one of the three focus calls fail. */
let windowReply: (call: string) => void = () => {};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    unminimize: async () => {
      windowCalls.push("unminimize");
      windowReply("unminimize");
    },
    show: async () => {
      windowCalls.push("show");
      windowReply("show");
    },
    setFocus: async () => {
      windowCalls.push("setFocus");
      windowReply("setFocus");
    },
  }),
}));

// ── Harness ──────────────────────────────────────────────────────────────────

async function loadDesktop() {
  vi.resetModules();
  return import("./desktop");
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function releaseListeners(): void {
  const waiting = waitingUnlistens.splice(0, waitingUnlistens.length);
  for (const release of waiting) release();
}

const AUTHORIZE_SENT = "https://accounts.google.com/o/oauth2/auth?state=abc";
// What Rust sends back: the placeholder is replaced by the port it actually bound,
// so the URL that comes back is not the URL that went in.
const AUTHORIZE_OPENED = "https://accounts.google.com/o/oauth2/auth?state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A4242%2F";
const REQUEST = { authorizeUrl: AUTHORIZE_SENT, timeoutMs: 300_000 };

function begun(port = 4242, outcome: unknown = { kind: "code", code: "c", state: "abc" }) {
  reply = (cmd) => {
    if (cmd === "oauth_begin") return { port, authorize_url: AUTHORIZE_OPENED };
    if (cmd === "oauth_await") return outcome;
    return undefined;
  };
}

function commands(): string[] {
  return invokes.map((call) => call.cmd);
}

function argsFor(cmd: string): Record<string, unknown> | undefined {
  const matching = invokes.filter((call) => call.cmd === cmd);
  expect(matching, `expected exactly one ${cmd}`).toHaveLength(1);
  return matching[0].args;
}

beforeEach(() => {
  invokes.length = 0;
  subscriptions.length = 0;
  unlistened.length = 0;
  windowCalls.length = 0;
  waitingUnlistens.length = 0;
  listenHeld = false;
  listenFails = false;
  reply = () => undefined;
  windowReply = () => {};
  Object.defineProperty(globalThis, "btoa", {
    configurable: true,
    value: (binary: string) => Buffer.from(binary, "latin1").toString("base64"),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, "btoa");
});

// ── app_info ─────────────────────────────────────────────────────────────────

const APP_INFO_WIRE = {
  name: "Winnow",
  version: "0.3.1",
  os: "macos",
  arch: "aarch64",
  kind: "desktop",
  native_oauth: true,
  native_secrets: true,
  background_sync: true,
  save_files: true,
};

describe("info()", () => {
  it("asks Rust once, with no argument object", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = () => APP_INFO_WIRE;
    await desktopPlatform.info();
    expect(invokes).toEqual([{ cmd: "app_info" }]);
  });

  it("maps the snake_case wire shape onto the camelCase the UI reads", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = () => APP_INFO_WIRE;
    expect(await desktopPlatform.info()).toEqual({
      name: "Winnow",
      version: "0.3.1",
      os: "macos",
      arch: "aarch64",
      kind: "desktop",
      nativeOAuth: true,
      nativeSecrets: true,
      backgroundSync: true,
      saveFiles: true,
    });
  });

  it("accepts a camelCase reply as well", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = () => ({
      name: "Winnow",
      kind: "desktop",
      nativeOAuth: true,
      nativeSecrets: false,
      backgroundSync: true,
      saveFiles: true,
    });
    const info = await desktopPlatform.info();
    expect(info.nativeOAuth).toBe(true);
    expect(info.nativeSecrets).toBe(false);
    expect(info.backgroundSync).toBe(true);
    expect(info.saveFiles).toBe(true);
  });

  it("never yields undefined for a capability flag Rust omitted", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = () => ({ name: "Winnow", kind: "desktop" });
    const info = await desktopPlatform.info();
    for (const key of PLATFORM_KEYS) {
      expect(info[key], `${key} was undefined`).toBe(false);
    }
  });

  it("fills in the descriptive fields rather than passing undefined through", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = () => ({});
    expect(await desktopPlatform.info()).toEqual({
      name: "Winnow",
      version: "0.0.0",
      os: "unknown",
      arch: "unknown",
      kind: "web",
      nativeOAuth: false,
      nativeSecrets: false,
      backgroundSync: false,
      saveFiles: false,
    });
  });

  it("asks once, however many callers want it", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = () => APP_INFO_WIRE;
    const [first, second] = await Promise.all([
      desktopPlatform.info(),
      desktopPlatform.info(),
    ]);
    expect(invokes).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("does not cache a rejection", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = () => {
      throw new Error("ipc unavailable");
    };
    await expect(desktopPlatform.info()).rejects.toThrow("ipc unavailable");
    expect(invokes).toHaveLength(1);

    reply = () => APP_INFO_WIRE;
    const info = await desktopPlatform.info();
    expect(invokes).toHaveLength(2);
    expect(info.backgroundSync).toBe(true);
  });
});

describe("credentialStore()", () => {
  it("keeps the user's OAuth client in the keychain, under its own entry", async () => {
    const { desktopPlatform } = await loadDesktop();
    const store = desktopPlatform.credentialStore();
    await store.write({ clientId: " 123-abc.apps.googleusercontent.com ", clientSecret: "shh" });

    expect(commands()).toEqual(["secrets_set"]);
    const args = argsFor("secrets_set");
    // Not the token entry: removing the client must never touch the tokens' row.
    expect(args?.name).toBe("google.oauth-client");
    expect(JSON.parse(String(args?.value))).toEqual({
      clientId: "123-abc.apps.googleusercontent.com",
      clientSecret: "shh",
    });
  });

  it("reads it back, and treats a malformed entry as nothing stored", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = () => JSON.stringify({ clientId: "123-abc.apps.googleusercontent.com" });
    expect(await desktopPlatform.credentialStore().read()).toEqual({
      clientId: "123-abc.apps.googleusercontent.com",
    });
    reply = () => "{not json";
    expect(await desktopPlatform.credentialStore().read()).toBeNull();
    reply = () => null;
    expect(await desktopPlatform.credentialStore().read()).toBeNull();
  });

  it("removes it with secrets_delete", async () => {
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.credentialStore().clear();
    expect(argsFor("secrets_delete")).toEqual({ name: "google.oauth-client" });
  });

  it("never reads a client from the build environment", async () => {
    vi.stubEnv("VITE_GMAIL_CLIENT_ID", "baked.apps.googleusercontent.com");
    vi.stubEnv("VITE_GMAIL_CLIENT_SECRET", "should-never-be-read");
    const { desktopPlatform } = await loadDesktop();
    reply = () => null;
    expect(await desktopPlatform.credentialStore().read()).toBeNull();
  });
});

// ── Sign-in ──────────────────────────────────────────────────────────────────

describe("beginSignIn()", () => {
  it("opens the URL Rust returned, not the one it was sent", async () => {
    const { desktopPlatform } = await loadDesktop();
    begun();
    await desktopPlatform.beginSignIn(REQUEST);

    expect(commands()).toEqual(["oauth_begin", "open_external", "oauth_await"]);
    expect(argsFor("oauth_begin")).toEqual({ authorizeUrl: AUTHORIZE_SENT });
    expect(argsFor("open_external")).toEqual({ url: AUTHORIZE_OPENED });
    expect(argsFor("oauth_await")).toEqual({ port: 4242, timeoutMs: 300_000 });
  });

  it("hands the code back exactly as Rust shaped it, plus the redirect URI it opened", async () => {
    const { desktopPlatform } = await loadDesktop();
    begun(4242, { kind: "code", code: "4/abc", state: "abc" });
    expect(await desktopPlatform.beginSignIn(REQUEST)).toEqual({
      kind: "code",
      code: "4/abc",
      state: "abc",
      redirectUri: "http://127.0.0.1:4242/",
    });
  });

  it("hands an error back exactly as Rust shaped it", async () => {
    const { desktopPlatform } = await loadDesktop();
    begun(4242, {
      kind: "error",
      error: "access_denied",
      description: "The user denied the request",
      state: "abc",
    });
    expect(await desktopPlatform.beginSignIn(REQUEST)).toEqual({
      kind: "error",
      error: "access_denied",
      description: "The user denied the request",
      state: "abc",
    });
  });

  it("calls a timeout a timeout", async () => {
    const { desktopPlatform } = await loadDesktop();
    begun(4242);
    reply = (cmd) => {
      if (cmd === "oauth_await") throw new Error("the redirect listener timed out");
      if (cmd === "oauth_begin") return { port: 4242, authorize_url: AUTHORIZE_OPENED };
      return undefined;
    };
    expect(await desktopPlatform.beginSignIn(REQUEST)).toEqual({ kind: "timeout" });
  });

  it("calls a cancel, a close and a drop cancellations", async () => {
    const messages = [
      "the user pressed cancel",
      "the redirect socket closed",
      "the connection was dropped",
    ];
    for (const message of messages) {
      const { desktopPlatform } = await loadDesktop();
      reply = (cmd) => {
        if (cmd === "oauth_begin") return { port: 4242, authorize_url: AUTHORIZE_OPENED };
        if (cmd === "oauth_await") throw new Error(message);
        return undefined;
      };
      expect(await desktopPlatform.beginSignIn(REQUEST), message).toEqual({
        kind: "cancelled",
      });
    }
  });

  it("recognises the past participles it was aiming at", async () => {
    const ABANDONED = [
      "the sign-in was cancelled",
      "the sign-in was canceled",
      "sign-in cancelled",
      "request aborted",
      "the listener was aborted by the user",
      "connection dropped",
      "stream closed",
      "cancellable",
      "close requested",
      "listener abandoned",
    ];

    for (const message of ABANDONED) {
      const { desktopPlatform } = await loadDesktop();
      reply = (cmd) => {
        if (cmd === "oauth_begin") return { port: 4242, authorize_url: AUTHORIZE_OPENED };
        if (cmd === "oauth_await") throw new Error(message);
        return undefined;
      };
      expect(await desktopPlatform.beginSignIn(REQUEST), message).toEqual({ kind: "cancelled" });
    }
  });

  it("still separates a timeout from a cancellation", async () => {
    for (const message of ["timed out", "timeout", "timed-out", "timedout"]) {
      const { desktopPlatform } = await loadDesktop();
      reply = (cmd) => {
        if (cmd === "oauth_begin") return { port: 4242, authorize_url: AUTHORIZE_OPENED };
        if (cmd === "oauth_await") throw new Error(message);
        return undefined;
      };
      expect(await desktopPlatform.beginSignIn(REQUEST), message).toEqual({ kind: "timeout" });
    }
  });

  it("reports anything else as unavailable, with the message it was given", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = (cmd) => {
      if (cmd === "oauth_begin") return { port: 4242, authorize_url: AUTHORIZE_OPENED };
      if (cmd === "oauth_await") throw new Error("connection refused by 127.0.0.1:4242");
      return undefined;
    };
    expect(await desktopPlatform.beginSignIn(REQUEST)).toEqual({
      kind: "unavailable",
      detail: "connection refused by 127.0.0.1:4242",
    });
  });

  it("falls back to a sentence when the rejection carries no message", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = (cmd) => {
      if (cmd === "oauth_begin") return { port: 4242, authorize_url: AUTHORIZE_OPENED };
      if (cmd === "oauth_await") throw "";
      return undefined;
    };
    expect(await desktopPlatform.beginSignIn(REQUEST)).toEqual({
      kind: "unavailable",
      detail: "the sign-in listener stopped",
    });
  });

  it("frees the port when the browser would not open", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = (cmd) => {
      if (cmd === "oauth_begin") return { port: 5151, authorize_url: AUTHORIZE_OPENED };
      if (cmd === "open_external") throw new Error("no handler for the url");
      return undefined;
    };
    const result = await desktopPlatform.beginSignIn(REQUEST);

    expect(result).toEqual({ kind: "unavailable", detail: "no handler for the url" });
    expect(invokes).toEqual([
      { cmd: "oauth_begin", args: { authorizeUrl: AUTHORIZE_SENT } },
      { cmd: "open_external", args: { url: AUTHORIZE_OPENED } },
      { cmd: "oauth_cancel", args: { port: 5151 } },
    ]);
    // And nothing is left waiting on a redirect that cannot arrive.
    expect(commands()).not.toContain("oauth_await");
  });

  it("is cancellable while it waits", async () => {
    const { desktopPlatform } = await loadDesktop();
    let finish: (outcome: unknown) => void = () => {};
    reply = (cmd) => {
      if (cmd === "oauth_begin") return { port: 4242, authorize_url: AUTHORIZE_OPENED };
      if (cmd === "oauth_await") {
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return undefined;
    };

    const pending = desktopPlatform.beginSignIn(REQUEST);
    await flush();
    await desktopPlatform.cancelSignIn();
    expect(argsFor("oauth_cancel")).toEqual({ port: 4242 });

    finish({ kind: "code", code: "c", state: "abc" });
    expect(await pending).toEqual({
      kind: "code",
      code: "c",
      state: "abc",
      redirectUri: "http://127.0.0.1:4242/",
    });
  });

  it("does nothing at all when no sign-in is in flight", async () => {
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.cancelSignIn();
    expect(invokes).toEqual([]);
  });

  it("lets a second sign-in bind a port of its own", async () => {
    const { desktopPlatform } = await loadDesktop();
    begun(4242);
    await desktopPlatform.beginSignIn(REQUEST);
    await desktopPlatform.cancelSignIn();
    expect(commands()).toEqual(["oauth_begin", "open_external", "oauth_await"]);

    begun(4343);
    await desktopPlatform.beginSignIn(REQUEST);
    expect(commands()).not.toContain("oauth_cancel");
    expect(invokes.filter((call) => call.cmd === "oauth_begin")).toHaveLength(2);
    expect(invokes.at(-1)).toEqual({
      cmd: "oauth_await",
      args: { port: 4343, timeoutMs: 300_000 },
    });
  });
});

// ── OS integration ───────────────────────────────────────────────────────────

describe("notifyNewMail()", () => {
  it("sends `message_ids` inside the mail value", async () => {
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.notifyNewMail({ title: "Winnow", body: "3 new", messageIds: [7, 9] });
    expect(invokes).toEqual([
      {
        cmd: "notify_new_mail",
        args: { mail: { title: "Winnow", body: "3 new", message_ids: [7, 9] } },
      },
    ]);
    expect(JSON.stringify(invokes)).not.toContain("messageIds");
  });

  it("sends an empty list as an empty list, not as an absent key", async () => {
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.notifyNewMail({ title: "t", body: "b", messageIds: [] });
    expect(invokes[0].args).toEqual({ mail: { title: "t", body: "b", message_ids: [] } });
  });
});

describe("setBackgroundSync()", () => {
  it("sends the interval as `intervalSecs`, which Tauri does rewrite", async () => {
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.setBackgroundSync(300);
    expect(invokes).toEqual([{ cmd: "set_background_sync", args: { intervalSecs: 300 } }]);
  });

  it("parks the ticker with an explicit null rather than omitting the key", async () => {
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.setBackgroundSync(null);
    expect(invokes).toEqual([{ cmd: "set_background_sync", args: { intervalSecs: null } }]);
  });
});

describe("saveFile()", () => {
  it("base64-encodes the bytes and returns the path Rust chose", async () => {
    const { desktopPlatform } = await loadDesktop();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x00, 0xff, 0xfe]);
    reply = () => "/Users/someone/Downloads/invoice.pdf";
    const saved = await desktopPlatform.saveFile("invoice.pdf", bytes, "application/pdf");

    expect(saved).toBe("/Users/someone/Downloads/invoice.pdf");
    expect(invokes).toEqual([
      {
        cmd: "save_attachment",
        args: {
          filename: "invoice.pdf",
          bytesBase64: Buffer.from(bytes).toString("base64"),
        },
      },
    ]);
  });

  it("encodes an attachment larger than one chunk", async () => {
    const { desktopPlatform } = await loadDesktop();
    const bytes = new Uint8Array(0x8000 + 1);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    reply = () => null;
    expect(await desktopPlatform.saveFile("big.bin", bytes, "application/octet-stream")).toBeNull();
    expect(argsFor("save_attachment")?.bytesBase64).toBe(
      Buffer.from(bytes).toString("base64"),
    );
  });

  it("sends an empty attachment as an empty string", async () => {
    const { desktopPlatform } = await loadDesktop();
    reply = () => null;
    await desktopPlatform.saveFile("empty.txt", new Uint8Array(), "text/plain");
    expect(argsFor("save_attachment")).toEqual({ filename: "empty.txt", bytesBase64: "" });
  });
});

describe("focusWindow()", () => {
  it("unminimises, shows and focuses, in that order", async () => {
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.focusWindow();
    expect(windowCalls).toEqual(["unminimize", "show", "setFocus"]);
  });

  it("still shows the window when unminimise is refused", async () => {
    const { desktopPlatform } = await loadDesktop();
    windowReply = (call) => {
      if (call === "unminimize") throw new Error("unminimize not allowed");
    };
    await expect(desktopPlatform.focusWindow()).resolves.toBeUndefined();
    expect(windowCalls).toEqual(["unminimize", "show", "setFocus"]);
  });

  it("still focuses the window when showing it is refused", async () => {
    const { desktopPlatform } = await loadDesktop();
    windowReply = (call) => {
      if (call === "show") throw new Error("show not allowed");
    };
    await expect(desktopPlatform.focusWindow()).resolves.toBeUndefined();
    expect(windowCalls).toContain("setFocus");
  });
});

describe("openExternal()", () => {
  it("passes the url as `url`", async () => {
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.openExternal("https://example.com/help");
    expect(invokes).toEqual([{ cmd: "open_external", args: { url: "https://example.com/help" } }]);
  });
});

// ── Events from Rust ─────────────────────────────────────────────────────────

describe("the Rust events", () => {
  it("listens on exactly the three names the Rust side emits", async () => {
    const { desktopPlatform, desktopPlatformExtras } = await loadDesktop();
    desktopPlatform.onBackgroundTick(() => {});
    desktopPlatformExtras.onDeepLink(() => {});
    desktopPlatformExtras.onTrayAction(() => {});
    await flush();
    expect(subscriptions.map((sub) => sub.event)).toEqual([
      "winnow://sync-tick",
      "winnow://open-url",
      "winnow://tray-action",
    ]);
  });

  it("hands the tick count to the handler", async () => {
    const { desktopPlatform } = await loadDesktop();
    const ticks: number[] = [];
    desktopPlatform.onBackgroundTick((tick) => ticks.push(tick));
    await flush();
    subscriptions[0].handler({ payload: 3 });
    expect(ticks).toEqual([3]);
  });

  it("hands a deep link to the handler as the payload alone", async () => {
    const { desktopPlatformExtras } = await loadDesktop();
    const urls: string[] = [];
    desktopPlatformExtras.onDeepLink((url) => urls.push(url));
    await flush();
    subscriptions[0].handler({ payload: "winnow://message/42" });
    expect(urls).toEqual(["winnow://message/42"]);
  });

  it("hands a tray choice to the handler as the payload alone", async () => {
    const { desktopPlatformExtras } = await loadDesktop();
    const actions: string[] = [];
    desktopPlatformExtras.onTrayAction((action) => actions.push(action));
    await flush();
    subscriptions[0].handler({ payload: "sync-now" });
    expect(actions).toEqual(["sync-now"]);
  });
});

describe("unsubscribing from a Rust event", () => {
  it("unlistens when the subscription was already live", async () => {
    const { desktopPlatform } = await loadDesktop();
    const unsubscribe = desktopPlatform.onBackgroundTick(() => {});
    await flush();
    unsubscribe();
    expect(unlistened).toEqual(["winnow://sync-tick"]);
  });

  it("unlistens even when `listen` resolves after the unsubscribe", async () => {
    listenHeld = true;
    const { desktopPlatform } = await loadDesktop();
    const unsubscribe = desktopPlatform.onBackgroundTick(() => {});
    unsubscribe();
    expect(unlistened).toEqual([]);

    releaseListeners();
    await flush();
    expect(unlistened).toEqual(["winnow://sync-tick"]);
  });

  it("holds the race for a deep link too", async () => {
    listenHeld = true;
    const { desktopPlatformExtras } = await loadDesktop();
    desktopPlatformExtras.onDeepLink(() => {})();
    expect(unlistened).toEqual([]);
    releaseListeners();
    await flush();
    expect(unlistened).toEqual(["winnow://open-url"]);
  });

  it("holds the race for a tray action too", async () => {
    listenHeld = true;
    const { desktopPlatformExtras } = await loadDesktop();
    desktopPlatformExtras.onTrayAction(() => {})();
    expect(unlistened).toEqual([]);
    releaseListeners();
    await flush();
    expect(unlistened).toEqual(["winnow://tray-action"]);
  });

  it("subscribes each caller separately", async () => {
    const { desktopPlatform } = await loadDesktop();
    const first: number[] = [];
    const second: number[] = [];
    const stopFirst = desktopPlatform.onBackgroundTick((tick) => first.push(tick));
    desktopPlatform.onBackgroundTick((tick) => second.push(tick));
    await flush();
    expect(subscriptions).toHaveLength(2);

    subscriptions[0].handler({ payload: 1 });
    subscriptions[1].handler({ payload: 2 });
    expect(first).toEqual([1]);
    expect(second).toEqual([2]);

    stopFirst();
    expect(unlistened).toEqual(["winnow://sync-tick"]);
  });

  it("swallows a subscription that is refused outright", async () => {
    listenFails = true;
    const { desktopPlatform } = await loadDesktop();
    const unsubscribe = desktopPlatform.onBackgroundTick(() => {});
    await flush();
    expect(subscriptions).toHaveLength(1);
    expect(() => unsubscribe()).not.toThrow();
    expect(unlistened).toEqual([]);
  });
});

// ── The capability list ──────────────────────────────────────────────────────

/** A `PlatformInfo` with every field present, so its keys are enumerable here. */
const FULL_INFO: PlatformInfo = {
  name: "Winnow",
  version: "0.3.1",
  os: "macos",
  arch: "aarch64",
  kind: "desktop",
  nativeOAuth: true,
  nativeSecrets: true,
  backgroundSync: true,
  saveFiles: true,
};

type BooleanFields<T> = {
  [K in keyof T]-?: boolean extends T[K] ? K : never;
}[keyof T];

type UndeclaredFlag = Exclude<BooleanFields<PlatformInfo>, PlatformKey>;

function assertEveryFlagDeclared(
  _proof: UndeclaredFlag extends never ? true : UndeclaredFlag,
): void {
  void _proof;
}

describe("PLATFORM_KEYS", () => {
  it("names nothing that is not a field of PlatformInfo", () => {
    const declared: readonly (keyof PlatformInfo)[] = PLATFORM_KEYS;
    for (const key of declared) {
      expect(typeof FULL_INFO[key], `${key} is not a boolean field`).toBe("boolean");
    }
  });

  it("covers every boolean field of PlatformInfo", () => {
    assertEveryFlagDeclared(true);
    // Runtime half of the same claim, off a value rather than the type.
    const booleans = Object.keys(FULL_INFO).filter(
      (key) => typeof FULL_INFO[key as keyof PlatformInfo] === "boolean",
    );
    expect(booleans.sort()).toEqual([...PLATFORM_KEYS].sort());
  });

  it("is exactly the four capabilities the boundary is built around", () => {
    expect(PLATFORM_KEYS).toEqual([
      "nativeOAuth",
      "nativeSecrets",
      "backgroundSync",
      "saveFiles",
    ]);
  });
});

// ── The browser's token store ────────────────────────────────────────────────

function installLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    },
  });
  return backing;
}

describe("webTokenStore", () => {
  let backing: Map<string, string>;

  beforeEach(() => {
    backing = installLocalStorage();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("round-trips a token set", async () => {
    const store = webTokenStore();
    const tokens: TokenSet = {
      accessToken: "ya29.access",
      refreshToken: "1//refresh",
      expiresAt: 1_800_000_000_000,
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    };
    expect(await store.read()).toBeNull();

    await store.write(tokens);
    expect(backing.get("winnow.gmail.tokens")).toBe(JSON.stringify(tokens));
    expect(await store.read()).toEqual(tokens);

    await store.clear();
    expect(await store.read()).toBeNull();
    expect(backing.size).toBe(0);
  });

  it("keeps its tokens under the key it was given", async () => {
    const store = webTokenStore("winnow.gmail.other");
    await store.write({ accessToken: "a", expiresAt: 1 });
    expect(backing.has("winnow.gmail.other")).toBe(true);
    expect(await webTokenStore().read()).toBeNull();
  });

  it("reads back null for anything it cannot use, rather than throwing", async () => {
    const store = webTokenStore();
    const unusable = [
      "",
      "{not json",
      "null",
      "[]",
      JSON.stringify({ refreshToken: "1//refresh", expiresAt: 1 }),
      JSON.stringify({ accessToken: "", expiresAt: 1 }),
    ];
    for (const raw of unusable) {
      backing.set("winnow.gmail.tokens", raw);
      expect(await store.read(), raw).toBeNull();
    }
  });

  it("reads back null when there is no storage at all", async () => {
    Reflect.deleteProperty(globalThis, "localStorage");
    const store = webTokenStore();
    expect(await store.read()).toBeNull();
    await expect(store.write({ accessToken: "a", expiresAt: 1 })).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});

// ── waitForForeground ────────────────────────────────────────────────────────

describe("desktopPlatform.waitForForeground", () => {
  function hiddenDocument() {
    const listeners: Array<() => void> = [];
    const doc = {
      visibilityState: "hidden",
      addEventListener: (_type: string, listener: () => void) => void listeners.push(listener),
      removeEventListener: () => {},
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
    return {
      show() {
        doc.visibilityState = "visible";
        for (const listener of listeners) listener();
      },
    };
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
  });

  it("does not wait on a desktop OS, even with the window hidden", async () => {
    hiddenDocument();
    reply = (cmd) => (cmd === "app_info" ? { ...APP_INFO_WIRE, os: "macos" } : undefined);
    const { desktopPlatform } = await loadDesktop();
    await expect(desktopPlatform.waitForForeground?.()).resolves.toBe(true);
  });

  it("waits on Android until the app is visible again", async () => {
    const page = hiddenDocument();
    reply = (cmd) => (cmd === "app_info" ? { ...APP_INFO_WIRE, os: "android" } : undefined);
    const { desktopPlatform } = await loadDesktop();
    let settled: unknown = "pending";
    const waiting = desktopPlatform.waitForForeground!().then((value) => (settled = value));
    await flush();
    expect(settled).toBe("pending");
    page.show();
    await waiting;
    expect(settled).toBe(true);
  });
});
