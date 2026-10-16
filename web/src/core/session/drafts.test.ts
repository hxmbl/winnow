/**
 * Gmail drafts, from the session's side: the scope check, the opt-in, and the exact
 * request sequence the composer's autosave produces — create, update under the same id,
 * then either `drafts.send` (no orphan left in Drafts) or `drafts.delete`.
 *
 * Google is a stub `fetch` routed by URL, as in `contacts.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailSession } from "./session";
import {
  COMPOSE_SCOPE,
  DraftsScopeMissing,
  GMAIL_SCOPE,
  base64UrlDecode,
  hasDraftScopes,
  type TokenSet,
} from "../gmail/dto";
import { DraftAutosaver, type Timers } from "../mail/drafts";
import type { Draft, Email } from "../model/email";
import type { CursorStore, MailboxCache } from "../gmail/sync";
import type { TokenStore } from "../gmail/tokens";
import type { Platform, PlatformInfo, SignInRequest, SignInResult } from "../../platform/types";
import type { OAuthClientCredentials } from "./credentials";

let storedClient: OAuthClientCredentials | null = null;

const info: PlatformInfo = {
  name: "Winnow",
  version: "0.1.0",
  os: "macos",
  arch: "unknown",
  kind: "desktop",
  nativeOAuth: true,
  nativeSecrets: true,
  backgroundSync: true,
  saveFiles: true,
};

function memoryTokens(initial: TokenSet | null) {
  let current = initial;
  const store: TokenStore = {
    read: async () => current,
    write: async (tokens) => void (current = tokens),
    clear: async () => void (current = null),
  };
  return { store, current: () => current };
}

function platformFor(tokens: TokenStore): { platform: Platform; opened: string[] } {
  const opened: string[] = [];
  const platform = {
    info: async () => info,
    tokenStore: () => tokens,
    credentialStore: () => ({
      read: async () => storedClient,
      write: async (next: OAuthClientCredentials) => void (storedClient = next),
      clear: async () => void (storedClient = null),
    }),
    async beginSignIn(request: SignInRequest): Promise<SignInResult> {
      opened.push(request.authorizeUrl);
      const state = new URL(request.authorizeUrl).searchParams.get("state") ?? "";
      return { kind: "code", code: "auth-code", state, redirectUri: "http://127.0.0.1:5555/winnow-oauth" };
    },
    cancelSignIn: async () => {},
  } as unknown as Platform;
  return { platform, opened };
}

/** The message a reply answers, in the cache so the draft can be threaded. */
const original: Email = {
  id: 1,
  gmailId: "g-orig",
  threadId: "t-1",
  sender: "ana@example.com",
  address: "ana@example.com",
  name: "Ana",
  to: [{ address: "me@example.com" }],
  cc: [],
  bcc: [],
  mailbox: "inbox",
  receivedAt: 1_700_000_000_000,
  subject: "Lunch",
  body: "Thursday?",
  category: "primary",
  starred: false,
  unread: false,
  urgent: false,
  attachments: [],
  messageId: "<orig@example.com>",
} as Email;

const cache = {
  all: async () => [original],
  clear: async () => {},
} as unknown as MailboxCache & CursorStore;

type Request = { method: string; path: string; body: Record<string, unknown> | null };

let requests: Request[];
let draftStatus: number;
let draftBody: string;
let grantedScope: string;

function installGoogle(): void {
  vi.stubGlobal("fetch", async (input: string, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.origin === "https://oauth2.googleapis.com") {
      return new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "r", expires_in: 3600, scope: grantedScope }),
        { status: 200 },
      );
    }
    const path = url.pathname.replace("/gmail/v1", "");
    if (path === "/users/me/profile") {
      return new Response(JSON.stringify({ emailAddress: "me@example.com", historyId: "1" }), { status: 200 });
    }
    requests.push({ method, path, body: init?.body ? JSON.parse(init.body) : null });
    if (path.startsWith("/users/me/drafts")) {
      return new Response(draftBody, { status: draftStatus });
    }
    if (path === "/users/me/messages/send") {
      return new Response(JSON.stringify({ id: "m-2", threadId: "t-2" }), { status: 200 });
    }
    return new Response("not stubbed", { status: 500 });
  });
}

const signedIn = (scope = GMAIL_SCOPE): TokenSet => ({
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 3_600_000,
  scope,
});

function sessionWith(scope = GMAIL_SCOPE) {
  const tokens = memoryTokens(signedIn(scope));
  const { platform, opened } = platformFor(tokens.store);
  return { session: new GmailSession(platform, cache), tokens, opened };
}

/** Timers driven by hand: `fire()` runs whatever is scheduled. */
function manualTimers(): Timers & { fire: () => void; pending: () => number } {
  let queue: { id: number; callback: () => void }[] = [];
  let next = 0;
  return {
    set(callback) {
      next += 1;
      queue.push({ id: next, callback });
      return next;
    },
    clear(handle) {
      queue = queue.filter((entry) => entry.id !== handle);
    },
    fire() {
      const due = queue;
      queue = [];
      for (const entry of due) entry.callback();
    },
    pending: () => queue.length,
  };
}

const reply = (body: string): Draft => ({
  to: ["ana@example.com"],
  cc: [],
  bcc: [],
  subject: "Re: Lunch",
  body,
  inReplyTo: "g-orig",
  threadId: "t-1",
});

/** The raw RFC 822 text a request carried. */
function rawOf(request: Request): string {
  const message = request.body?.message as { raw: string } | undefined;
  return new TextDecoder().decode(base64UrlDecode(message?.raw ?? "") ?? new Uint8Array());
}

beforeEach(() => {
  storedClient = { clientId: "desktop.apps.googleusercontent.com" };
  requests = [];
  draftStatus = 200;
  draftBody = JSON.stringify({ id: "d-1", message: { id: "m-1", threadId: "t-1" } });
  grantedScope = `${GMAIL_SCOPE} ${COMPOSE_SCOPE}`;
  installGoogle();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the drafts scope check", () => {
  it("accepts any scope that allows drafts, and the sign-in scope is one", () => {
    expect(hasDraftScopes(GMAIL_SCOPE)).toBe(true);
    expect(hasDraftScopes(COMPOSE_SCOPE)).toBe(true);
    expect(hasDraftScopes("https://mail.google.com/")).toBe(true);
    expect(hasDraftScopes("https://www.googleapis.com/auth/gmail.readonly")).toBe(false);
    expect(hasDraftScopes("")).toBe(false);
  });

  it("reads the grant off the stored token", async () => {
    expect(await sessionWith().session.draftsAccess()).toBe("granted");
    expect(await sessionWith("https://www.googleapis.com/auth/gmail.readonly").session.draftsAccess()).toBe(
      "not_granted",
    );
  });

  it("asks for gmail.compose on top of the existing grant when it is missing", async () => {
    const { session, opened } = sessionWith("https://www.googleapis.com/auth/gmail.readonly");
    expect(await session.grantDrafts()).toBe("granted");
    const query = new URL(opened[0]).searchParams;
    expect(query.get("scope")).toBe(COMPOSE_SCOPE);
    expect(query.get("include_granted_scopes")).toBe("true");
    expect(query.get("login_hint")).toBe("me@example.com");
  });
});

describe("the autosave's request sequence", () => {
  it("creates once, updates under the same id, then sends that draft", async () => {
    const { session } = sessionWith();
    const backend = session.backend();
    const timers = manualTimers();
    const saver = new DraftAutosaver({
      context: "reply:g-orig",
      mode: "reply",
      replyTo: "g-orig",
      api: backend.drafts!,
      local: null,
      timers,
    });

    saver.change(reply("H"));
    saver.change(reply("Hi"));
    // Debounced: two keystrokes, one pending save, nothing sent yet.
    expect(requests).toHaveLength(0);
    timers.fire();
    await saver.settle();
    saver.change(reply("Hi Ana"));
    timers.fire();
    const id = await saver.settle();
    expect(id).toBe("d-1");

    await backend.sendReply(reply("Hi Ana, yes."), "g-orig", id!);
    saver.finish();

    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /users/me/drafts",
      "PUT /users/me/drafts/d-1",
      "POST /users/me/drafts/send",
    ]);
    // Threaded: the thread id on every request, and the reply headers in the raw text.
    for (const request of requests) {
      expect((request.body?.message as { threadId?: string }).threadId).toBe("t-1");
    }
    expect(rawOf(requests[0])).toContain("In-Reply-To: <orig@example.com>");
    expect(rawOf(requests[0])).toContain("References: <orig@example.com>");
    expect(requests[2].body?.id).toBe("d-1");
    // The send carries the latest text, not the last autosave.
    expect(rawOf(requests[2])).toContain(btoa("Hi Ana, yes."));
  });

  it("deletes the draft on discard, after a save still in flight", async () => {
    const { session } = sessionWith();
    const timers = manualTimers();
    const saver = new DraftAutosaver({
      context: "new",
      mode: "new",
      api: session.backend().drafts!,
      local: null,
      timers,
    });
    saver.change({ ...reply("Draft"), inReplyTo: undefined, threadId: undefined });
    timers.fire();
    // Discard straight away: the create is still out.
    await saver.discard();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /users/me/drafts",
      "DELETE /users/me/drafts/d-1",
    ]);
  });

  it("a new message without a draft still sends through messages.send", async () => {
    const { session } = sessionWith();
    await session.backend().sendNew!({ ...reply("Hello"), inReplyTo: undefined, threadId: undefined });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /users/me/messages/send"]);
  });

  it("turns Google's insufficient-scope refusal into DraftsScopeMissing", async () => {
    draftStatus = 403;
    draftBody = JSON.stringify({
      error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
    });
    const { session } = sessionWith();
    await expect(session.backend().drafts!.create(reply("x"), "g-orig")).rejects.toBeInstanceOf(DraftsScopeMissing);
  });
});
