/**
 * Attachments, from the session's side: a draft's file reopened from Drafts is read from
 * Gmail once and kept, because the draft's own attachment ids die with its next save.
 * And labels: Winnow has no way to change the account's labels (UI removed in 1.3.x; the
 * Gmail client and the backend were stripped of the calls with it), with one exception
 * since 1.4.0: its own `Winnow/Snoozed`, which snoozing makes and puts on (and nothing else).
 *
 * Google is a stub `fetch` routed by URL, as in `drafts.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailSession } from "./session";
import { GmailClient } from "../gmail/client";
import { COMPOSE_SCOPE, GMAIL_SCOPE, base64UrlDecode, type TokenSet } from "../gmail/dto";
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

const loose = { ...original, id: 2, gmailId: "g-loose", threadId: undefined } as Email;
const sibling = { ...original, id: 3, gmailId: "g-sib" } as Email;

const cache = {
  all: async () => [original, loose, sibling],
  clear: async () => {},
} as unknown as MailboxCache & CursorStore;

type Request = { method: string; path: string; body: Record<string, unknown> | null };

let requests: Request[];
let draftStatus: number;
let draftBody: string;
let grantedScope: string;
let labels: { id: string; name: string }[];

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
    if (path.includes("/attachments/")) {
      return new Response(JSON.stringify({ data: "SGVsbG8", size: 5 }), { status: 200 });
    }
    if (path === "/users/me/labels") {
      if (method === "POST") return new Response(JSON.stringify({ id: "Label_9", name: "Winnow/Snoozed" }), { status: 200 });
      return new Response(JSON.stringify({ labels }), { status: 200 });
    }
    if (/^\/users\/me\/messages\/[^/]+\/modify$/.test(path)) return new Response("{}", { status: 200 });
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

beforeEach(() => {
  storedClient = { clientId: "desktop.apps.googleusercontent.com" };
  requests = [];
  draftStatus = 200;
  draftBody = JSON.stringify({ id: "d-1", message: { id: "m-1", threadId: "t-1" } });
  grantedScope = `${GMAIL_SCOPE} ${COMPOSE_SCOPE}`;
  labels = [{ id: "INBOX", name: "INBOX" }];
  installGoogle();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("labels are not Winnow's to change, but for its own Winnow/Snoozed", () => {
  it("offers no way to list, make or change the account's labels", () => {
    const { session } = sessionWith();
    const backend = session.backend() as unknown as Record<string, unknown>;
    for (const name of ["listLabels", "createLabel", "modifyLabels"]) expect(backend[name]).toBeUndefined();
    const client = GmailClient.prototype as unknown as Record<string, unknown>;
    for (const name of ["labels", "createLabel", "modifyThread", "batchModify"]) expect(client[name]).toBeUndefined();
  });

  it("refuses to make any label but Winnow/Snoozed", async () => {
    const client = new GmailClient(async () => "access");
    await expect(client.ensureLabel("Receipts")).rejects.toThrow(/only makes its own Winnow\/Snoozed/);
    expect(requests.filter((r) => r.path === "/users/me/labels")).toEqual([]);
  });

  it("snoozing makes the label once, then labels the message and takes it out of the Inbox", async () => {
    const { session } = sessionWith();
    const backend = session.backend();
    await backend.setSnoozed!("g-orig", true);
    await backend.setSnoozed!("g-sib", true);
    const made = requests.filter((r) => r.path === "/users/me/labels");
    expect(made.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(made[1]!.body).toMatchObject({ name: "Winnow/Snoozed" });
    const modifies = requests.filter((r) => r.path.endsWith("/modify"));
    expect(modifies.map((r) => r.path)).toEqual(["/users/me/messages/g-orig/modify", "/users/me/messages/g-sib/modify"]);
    expect(modifies[0]!.body).toEqual({ addLabelIds: ["Label_9"], removeLabelIds: ["INBOX"] });
  });

  it("waking takes the label off and puts the message back in the Inbox, unread when asked", async () => {
    labels = [{ id: "Label_3", name: "Winnow/Snoozed" }];
    const { session } = sessionWith();
    const backend = session.backend();
    await backend.setSnoozed!("g-orig", false, { unread: true });
    await backend.setSnoozed!("g-sib", false, { toInbox: false });
    expect(requests.filter((r) => r.path === "/users/me/labels").map((r) => r.method)).toEqual(["GET"]);
    const modifies = requests.filter((r) => r.path.endsWith("/modify")).map((r) => r.body);
    expect(modifies).toEqual([
      { addLabelIds: ["INBOX", "UNREAD"], removeLabelIds: ["Label_3"] },
      { addLabelIds: [], removeLabelIds: ["Label_3"] },
    ]);
  });
});

describe("a draft's files", () => {
  const draft: Draft = {
    to: ["ana@example.com"],
    cc: [],
    bcc: [],
    subject: "Files",
    body: "Here.",
    attachments: [
      { id: "1", filename: "hello.txt", mimeType: "text/plain", size: 5, source: { gmailId: "m-old", attachmentId: "a-1" } },
      { id: "2", filename: "local.txt", mimeType: "text/plain", size: 3, data: "QUJD" },
    ],
  };
  const raw = (index: number) => {
    const message = requests.filter((r) => r.path.startsWith("/users/me/drafts"))[index]!.body?.message as { raw: string };
    return new TextDecoder().decode(base64UrlDecode(message.raw) ?? new Uint8Array());
  };

  it("are built into the saved draft, a Gmail-held one read once and then kept", async () => {
    const { session } = sessionWith();
    const api = session.backend().drafts!;
    const id = await api.create(draft);
    await api.update(id, draft);
    expect(requests.filter((r) => r.path.includes("/attachments/"))).toHaveLength(1);
    for (const index of [0, 1]) {
      const text = raw(index);
      expect(text).toContain('filename="hello.txt"');
      expect(text).toContain("SGVsbG8=");
      expect(text).toContain('filename="local.txt"');
      expect(text).toContain("QUJD");
    }
  });

  it("refuses a file with neither bytes nor a source, by name", async () => {
    const { session } = sessionWith();
    const broken: Draft = { ...draft, attachments: [{ id: "x", filename: "gone.pdf", mimeType: "application/pdf", size: 1 }] };
    await expect(session.backend().drafts!.create(broken)).rejects.toThrow(/gone\.pdf is no longer available/);
  });
});
