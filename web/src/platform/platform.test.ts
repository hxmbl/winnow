/**
 * The platform boundary, pinned at the wire.
 *
 * These are wire-shape tests, and that is a deliberate thing to be explicit
 * about: the defects they guard were not logic errors, they were *casing* errors.
 * Tauri rewrites the keys of an `invoke` argument from camelCase to snake_case,
 * but it never rewrites a return value — a struct declared `native_oauth` in Rust
 * and read as `nativeOAuth` here arrives `undefined`. Nothing throws, nothing
 * logs, and the result is a desktop feature that was implemented, permissioned
 * and unreachable.
 *
 * So every assertion below is on what went *out* over the wire as much as on what
 * came back, because the wire is where the contract actually lives. The mocks
 * record each `invoke` by command name and argument object, and the assertions
 * are exact rather than "contains", for the same reason: a wrong key inside an
 * argument is invisible to a test that only checks the command ran.
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

/**
 * A fresh copy of the desktop module.
 *
 * `info()` caches its answer and `beginSignIn` remembers the in-flight loopback
 * port, both in module variables — and those caches are precisely what several of
 * these tests are about, so each needs a module that has never answered anything.
 * Dynamic import is also what keeps the mock factories below unevaluated until
 * after this file's own state exists.
 */
async function loadDesktop() {
  vi.resetModules();
  return import("./desktop");
}

/** Let every pending microtask — and the macrotask holding a held `listen` — run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Hand back the unlisten functions a held `listen` is still sitting on. */
function releaseListeners(): void {
  const waiting = waitingUnlistens.splice(0, waitingUnlistens.length);
  for (const release of waiting) release();
}

const AUTHORIZE_SENT = "https://accounts.google.com/o/oauth2/auth?state=abc";
// What Rust sends back: the placeholder is replaced by the port it actually bound,
// so the URL that comes back is not the URL that went in.
const AUTHORIZE_OPENED = "https://accounts.google.com/o/oauth2/auth?state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A4242%2F";
const REQUEST = { authorizeUrl: AUTHORIZE_SENT, timeoutMs: 300_000 };

/** The reply `oauth_begin` gives, plus the `oauth_await` answer, in one place. */
function begun(port = 4242, outcome: unknown = { kind: "code", code: "c", state: "abc" }) {
  reply = (cmd) => {
    if (cmd === "oauth_begin") return { port, authorize_url: AUTHORIZE_OPENED };
    if (cmd === "oauth_await") return outcome;
    return undefined;
  };
}

/** Every command issued, in order. */
function commands(): string[] {
  return invokes.map((call) => call.cmd);
}

/** The arguments of the one call to `cmd`. */
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
  // `btoa` is a browser global and this suite runs in Node, where it does not
  // exist. Defined from Buffer rather than imported into the module under test,
  // because `desktop.ts` reaches for the global — the absence is exactly what a
  // Node-side save would otherwise trip over.
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

/** The wire shape serde produces for `AppInfo`. Field names are Rust's. */
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
    // The regression, in full: every capability arrived `undefined`, so the
    // settings panel's Background section — gated on `backgroundSync` — was
    // absent on the one build that had background sync implemented.
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
    // The belt to the braces: a future struct cannot fail this way silently just
    // because someone declared it `rename_all = "camelCase"` on the Rust side.
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
    // An absent flag means this build cannot do it, which is `false`. It must not
    // mean "unknown": the panel tests `backgroundSync !== null`, so `undefined`
    // removed the control outright, with no error anywhere to explain why.
    const { desktopPlatform } = await loadDesktop();
    reply = () => ({ name: "Winnow", kind: "desktop" });
    const info = await desktopPlatform.info();
    for (const key of PLATFORM_KEYS) {
      expect(info[key], `${key} was undefined`).toBe(false);
    }
  });

  it("fills in the descriptive fields rather than passing undefined through", async () => {
    // The same reasoning as the flags: `PlatformInfo` promises strings, and a
    // settings panel that renders `undefined` is showing the word "undefined".
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
    // The answer cannot change while the app runs, so two callers at startup must
    // not mean two round-trips — and must not be free to drift apart either.
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
    // A transient IPC failure must not pin the app to "this build can do nothing"
    // for the life of the process.
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

describe("oauthClientSecret()", () => {
  it("has nothing to give, even when one is configured for the web build", async () => {
    // Google classifies this build as an installed app and forbids it a secret.
    // Reading the environment would give a developer running `tauri:dev` a build
    // that silently publishes one and sends it to a token exchange Google
    // rejects anyway.
    vi.stubEnv("VITE_GMAIL_CLIENT_SECRET", "GOCSPX-should-never-be-here");
    const { desktopPlatform } = await loadDesktop();
    expect(desktopPlatform.oauthClientSecret()).toBeUndefined();
    expect(invokes).toHaveLength(0);
  });
});

// ── Sign-in ──────────────────────────────────────────────────────────────────

describe("beginSignIn()", () => {
  it("opens the URL Rust returned, not the one it was sent", async () => {
    // Rust binds the port first and substitutes it into the redirect URI, so the
    // two URLs differ. Opening the sent one would send the browser to an
    // unsubstituted placeholder and the redirect would never come back.
    const { desktopPlatform } = await loadDesktop();
    begun();
    await desktopPlatform.beginSignIn(REQUEST);

    expect(commands()).toEqual(["oauth_begin", "open_external", "oauth_await"]);
    expect(argsFor("oauth_begin")).toEqual({ authorizeUrl: AUTHORIZE_SENT });
    expect(argsFor("open_external")).toEqual({ url: AUTHORIZE_OPENED });
    expect(argsFor("oauth_await")).toEqual({ port: 4242, timeoutMs: 300_000 });
  });

  it("hands the code back exactly as Rust shaped it, plus the redirect URI it opened", async () => {
    // No mapping, no validation of the code. One field is recovered: the
    // `redirect_uri` the substituted authorize URL actually carried. The session
    // must name that exact URI at the token exchange — it is the only one that
    // matches what Google saw — and it is not the placeholder the session built.
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
    // A refusal from Google carries a description the sign-in screen shows
    // verbatim; truncating or rewriting it here would lose the only wording the
    // user can act on.
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
    // A five-minute wait that ends is a fault the user can retry, and telling them
    // it was cancelled is the one thing it could not have been.
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
    // One kind for a listener the user stopped: the tab closed, the button was
    // pressed. Distinct from a fault, which is why it is its own member of the
    // union rather than a string.
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
    // The pattern's `\b` after the keyword group is what broke it: a word boundary
    // needs a non-word character on both sides, so `cancel` matched but `cancelled`,
    // `canceled` and `aborted` did not. `types.ts` names "Sign-in was cancelled" as
    // the exact case that must not be reported as a fault, and it was.
    //
    // Every spelling a Rust `Err` or a Tauri error plausibly takes, asserted
    // individually — the point is that *none* of them may be classified as a fault.
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
    // The two are the pair most easily confused, and the widened pattern must not
    // have swallowed one into the other: a five-minute wait is a fault, a user
    // clicking Cancel is not.
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
    // Only a genuine fault should be reported as one, and the caller cannot
    // reconstruct the reason from a kind alone — so the text has to survive.
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
    // The fallback gives the message a subject, so an unrecognised failure is
    // still something a person can be shown.
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
    // A bound socket and a thread waiting on it, with nothing ever going to
    // arrive. Without the cancel they run for the life of the process, and the
    // next attempt finds a port that is still held.
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
    // `cancelSignIn` is called on unmount and on sign-out, so the common case is
    // a sign-in that already ended. A cancel for nothing would be a needless IPC
    // round-trip on every teardown.
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.cancelSignIn();
    expect(invokes).toEqual([]);
  });

  it("lets a second sign-in bind a port of its own", async () => {
    // `activePort` is cleared in the `finally`, so a finished attempt no longer
    // owns its port. If it did, the next `cancelSignIn` would tear down the
    // attempt that is not there and leave the live one uncancellable.
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
    // The silent one. `mail` is a top-level argument, so it *is* rewritten to
    // `mail`; the fields inside it are not. A struct with `#[serde(default)]` on
    // `message_ids` therefore accepted `messageIds` and deserialised to an empty
    // vec — no error, and a notification click that could never know which
    // conversation to open.
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
    // The asymmetry with `message_ids`, and the reason both cases are pinned: this
    // one *is* a top-level argument key, so camelCase reaches `interval_secs`.
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.setBackgroundSync(300);
    expect(invokes).toEqual([{ cmd: "set_background_sync", args: { intervalSecs: 300 } }]);
  });

  it("parks the ticker with an explicit null rather than omitting the key", async () => {
    // `Option<u64>` reads a missing key as `None` too, but an explicit null says
    // "parked" at the point the call is made.
    const { desktopPlatform } = await loadDesktop();
    await desktopPlatform.setBackgroundSync(null);
    expect(invokes).toEqual([{ cmd: "set_background_sync", args: { intervalSecs: null } }]);
  });
});

describe("saveFile()", () => {
  it("base64-encodes the bytes and returns the path Rust chose", async () => {
    const { desktopPlatform } = await loadDesktop();
    // Multi-byte and a NUL, so the encoding is actually exercised rather than
    // accidentally right for ASCII: `TextEncoder` output would not survive
    // `btoa` unchanged.
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
    // `String.fromCharCode(...bytes)` throws a `RangeError` past a certain
    // argument count, which is indistinguishable from a corrupted download — so
    // the encoding is chunked. A buffer over the chunk size is the only way that
    // loop is actually run.
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
    // The P0 in three lines: `unminimize` needs a capability the bundle did not
    // grant, it was the *first* call, so being rejected meant `show` and `setFocus`
    // never ran and every deep link did nothing visible.
    const { desktopPlatform } = await loadDesktop();
    windowReply = (call) => {
      if (call === "unminimize") throw new Error("unminimize not allowed");
    };
    await expect(desktopPlatform.focusWindow()).resolves.toBeUndefined();
    expect(windowCalls).toEqual(["unminimize", "show", "setFocus"]);
  });

  it("still focuses the window when showing it is refused", async () => {
    // Three permissions with three failure modes. One missing permission should
    // not cost the other two, and `focusWindow` has nothing to report a failure
    // to — so it swallows its own errors rather than raising an unhandled one.
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
    // These strings are a contract with `scheduler.rs`, `deep_link.rs` and
    // `tray.rs`. A rename on either side with no test is a listener that never
    // fires and an app that looks like it simply has no background sync.
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
    // The handler takes a string, not an event object: the Rust payload is the
    // URL and nothing else, and unwrapping it here keeps every call site from
    // doing it.
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
    // The app subscribes once at startup and holds the function for the life of
    // the process. A leaked listener keeps its closure — and its store — alive.
    const { desktopPlatform } = await loadDesktop();
    const unsubscribe = desktopPlatform.onBackgroundTick(() => {});
    await flush();
    unsubscribe();
    expect(unlistened).toEqual(["winnow://sync-tick"]);
  });

  it("unlistens even when `listen` resolves after the unsubscribe", async () => {
    // The race, and it is reachable: `onBackgroundTick` returns synchronously and
    // the IPC that produces the unlisten function resolves a tick or more later.
    // Without the `cancelled` flag, that listener is created and never freed.
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
    // The store and anything else both want ticks. One listener replacing the
    // other is a bug waiting for a second caller.
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
    // `listen` can be refused — the event is not in the capability list, or the
    // webview is not ready yet. An unhandled rejection in a startup path with
    // nothing to report it to is worse than not ticking at all.
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

/**
 * The boolean fields of a type.
 *
 * `boolean extends T[K]` rather than `T[K] extends boolean`, because the second
 * form also matches a field typed `true` — which would drop it out of the check
 * and let exactly the narrowest capability go undeclared.
 */
type BooleanFields<T> = {
  [K in keyof T]-?: boolean extends T[K] ? K : never;
}[keyof T];

type UndeclaredFlag = Exclude<BooleanFields<PlatformInfo>, PlatformKey>;

/**
 * Accepts `true` only while `PLATFORM_KEYS` covers every boolean field.
 *
 * An interface's keys cannot be enumerated at runtime, so completeness has to be
 * asserted in the type system: add a capability to `PlatformInfo` without adding
 * it to `PLATFORM_KEYS` and this stops compiling, which is the entire claim the
 * comment above `PLATFORM_KEYS` is making.
 */
function assertEveryFlagDeclared(
  _proof: UndeclaredFlag extends never ? true : UndeclaredFlag,
): void {
  void _proof;
}

describe("PLATFORM_KEYS", () => {
  it("names nothing that is not a field of PlatformInfo", () => {
    // Compile-time half: a key `PlatformInfo` does not have is a capability a
    // feature can ask for and never receive.
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
    // Spelled out so a deletion is a visible edit here rather than something a
    // later refactor does silently, leaving the docstring above it a lie.
    expect(PLATFORM_KEYS).toEqual([
      "nativeOAuth",
      "nativeSecrets",
      "backgroundSync",
      "saveFiles",
    ]);
  });
});

// ── The browser's token store ────────────────────────────────────────────────

/** A `localStorage` stand-in, since the store reaches for the global. */
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
    // The sign-in screen and the sync worker must not disagree about where the
    // session is, and a key derived from the flow is how they avoid it.
    const store = webTokenStore("winnow.gmail.other");
    await store.write({ accessToken: "a", expiresAt: 1 });
    expect(backing.has("winnow.gmail.other")).toBe(true);
    expect(await webTokenStore().read()).toBeNull();
  });

  it("reads back null for anything it cannot use, rather than throwing", async () => {
    // Private-mode Safari and a full quota both throw from `localStorage`, and a
    // blob written by a build whose `TokenSet` had different fields does not
    // parse. None of those is worth failing sign-in over; the user is simply not
    // signed in, and `TokenManager` can say so without an exception.
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
    // The browser is not the only thing that runs `core/`: a renderer with storage
    // blocked must degrade to signed-out rather than throw on the first read.
    Reflect.deleteProperty(globalThis, "localStorage");
    const store = webTokenStore();
    expect(await store.read()).toBeNull();
    await expect(store.write({ accessToken: "a", expiresAt: 1 })).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
