/**
 * Drive links at dispatch (`driveSend.ts`): a draft reopened from Gmail's Drafts (which
 * has lost the composer's file list) still shares the links in its body; someone else's
 * Drive link is skipped without a warning; a missing `drive.file` grant asks before
 * anything is sent; and an abandoned send takes back exactly what it created — while a
 * send that fails and retries keeps its permissions. The offline queue's half (sharing at
 * replay, revoking a refused send) is pinned in `core/offline/queue.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { DemoDriveClient, DriveScopeMissing, driveLinkLine, revokeShares, type DriveApi } from "./drive";
import { needsDriveGrant, prepareDriveDispatch, prepareQueuedShare, queuedShareNotice } from "./driveSend";
import { reopenDraft } from "../mail/drafts";
import { toDraftEmail } from "./mapper";
import { LABEL, type GmailFullDraft } from "./dto";
import type { Draft, DraftDriveShare } from "../model/email";

function b64(text: string): string {
  return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const OWN = { id: "demo-drive-41", name: "film.mov", size: 26 * 1024 * 1024, link: "https://drive.google.com/file/d/demo-drive-41/view" };
const FOREIGN = "https://drive.google.com/file/d/someoneElse1234567/view?usp=sharing";

/** A Gmail draft as Gmail's Drafts returns it: text and, as Gmail's editor saves, HTML. */
function savedDraft(text: string, html?: string): GmailFullDraft {
  const headers = [
    { name: "To", value: "ada@example.com, who@example.invalid" },
    { name: "Subject", value: "The film" },
  ];
  const textPart = { mimeType: "text/plain", body: { data: b64(text), size: text.length } };
  return {
    id: "r-9",
    message: {
      id: "m-9",
      threadId: "t-9",
      labelIds: [LABEL.draft],
      internalDate: "1770000000000",
      snippet: text.slice(0, 40),
      payload: html
        ? {
            mimeType: "multipart/alternative",
            headers,
            parts: [textPart, { mimeType: "text/html", body: { data: b64(html), size: html.length } }],
          }
        : { ...textPart, headers },
    },
  };
}

/** The draft as the composer has it after reopening a Drafts row. */
function reopened(text: string, html?: string): Draft {
  const row = toDraftEmail(savedDraft(text, html))!;
  return reopenDraft(row, [])!.draft;
}

/** A Drive that records every call, over the demo's (own = `demo-drive-…`). */
function recording(): { api: DriveApi & { revoked: string[] }; calls: string[] } {
  const demo = new DemoDriveClient(0);
  const calls: string[] = [];
  const api = {
    upload: demo.upload.bind(demo),
    permissions: async (fileId: string) => {
      calls.push(`list ${fileId}`);
      return demo.permissions(fileId);
    },
    share: async (fileId: string, email: string) => {
      calls.push(`share ${fileId} ${email}`);
      return demo.share(fileId, email);
    },
    revoke: async (fileId: string, permissionId: string) => {
      calls.push(`revoke ${fileId} ${permissionId}`);
      return demo.revoke(fileId, permissionId);
    },
    revoked: demo.revoked,
  };
  return { api, calls };
}

describe("a draft reopened from Drafts", () => {
  it("gets its Drive files back from Winnow's own lines, and shares its body's links at dispatch", async () => {
    const draft = reopened(`Here it is.\n\n${driveLinkLine(OWN)}\n`);
    expect(draft.driveFiles).toEqual([OWN]);

    const { api, calls } = recording();
    const result = await prepareDriveDispatch(
      { ...draft, to: ["ada@example.com"], driveFiles: undefined }, // even with the list lost
      { api, online: true, allowed: true },
    );
    expect(result.kind).toBe("send");
    if (result.kind !== "send") return;
    expect(result.share?.state).toBe("shared");
    expect(result.share?.created.map((p) => [p.fileId, p.email])).toEqual([["demo-drive-41", "ada@example.com"]]);
    expect(calls).toEqual(["list demo-drive-41", "share demo-drive-41 ada@example.com"]);
  });

  it("reads the HTML Gmail's editor saved too", () => {
    const html = `<div>Here it is.</div><div>film.mov (26 MB) — <a href="${OWN.link}">${OWN.link}</a></div>`;
    const draft = reopened(`Here it is.\n\n${driveLinkLine(OWN)}\n`, html);
    expect(draft.driveFiles?.map((f) => f.id)).toEqual(["demo-drive-41"]);
  });

  it("warns about an address Drive refuses on Winnow's own link, holding what it already shared", async () => {
    const draft = reopened(`Here it is.\n\n${driveLinkLine(OWN)}\n`);
    const { api } = recording();
    const result = await prepareDriveDispatch(draft, { api, online: true, allowed: true });
    expect(result).toMatchObject({ kind: "hold", reason: "problems" });
    if (result.kind !== "hold") return;
    expect(result.problems.map((p) => p.email)).toEqual(["who@example.invalid"]);
    expect(result.created.map((p) => p.email)).toEqual(["ada@example.com"]);

    // Send anyway: goes, keeping what was shared, and makes nothing twice.
    const again = await prepareDriveDispatch(draft, { api, online: true, allowed: true, accepted: true, prior: result.created });
    expect(again.kind).toBe("send");
    if (again.kind === "send") expect(again.share?.created).toEqual(result.created);
  });
});

describe("someone else's Drive link", () => {
  it("is tried and skipped without a word when Drive refuses it", async () => {
    const { api, calls } = recording();
    const result = await prepareDriveDispatch(
      { to: ["ada@example.com", "who@example.invalid"], cc: [], bcc: [], body: `The deck: ${FOREIGN}` },
      { api, online: true, allowed: true },
    );
    expect(result.kind).toBe("send");
    if (result.kind === "send") expect(result.share?.created).toEqual([]);
    expect(calls).toEqual(["list someoneElse1234567"]);
  });

  it("never asks for the grant on its own", async () => {
    const draft = { to: ["ada@example.com"], cc: [], bcc: [], body: `The deck: ${FOREIGN}` };
    expect(needsDriveGrant(draft, false)).toBe(false);
    const result = await prepareDriveDispatch(draft, { api: null, online: true, allowed: false });
    expect(result).toEqual({ kind: "send", stale: [] });
  });
});

describe("a missing Drive grant", () => {
  const draft = { to: ["ada@example.com"], cc: [], bcc: [], body: `Here.\n\n${driveLinkLine(OWN)}\n` };

  it("asks at Send-tap, before anything is scheduled, when the message has Winnow's own links", () => {
    expect(needsDriveGrant(draft, false)).toBe(true);
    expect(needsDriveGrant(draft, true)).toBe(false);
    expect(needsDriveGrant({ body: "no links" }, false)).toBe(false);
  });

  it("holds the send at dispatch too, if the token lost drive.file in the meantime", async () => {
    const api: DriveApi = {
      upload: async () => OWN,
      permissions: async () => {
        throw new DriveScopeMissing();
      },
      share: async () => "p",
      revoke: async () => undefined,
    };
    expect(await prepareDriveDispatch(draft, { api, online: true, allowed: true })).toMatchObject({
      kind: "hold",
      reason: "grant",
    });
    expect(await prepareDriveDispatch(draft, { api: null, online: true, allowed: false })).toMatchObject({
      kind: "hold",
      reason: "grant",
    });
  });

  it("Send anyway shares nothing and says so on the message", async () => {
    const { api, calls } = recording();
    const result = await prepareDriveDispatch(draft, { api, online: true, allowed: false, waived: true });
    expect(result).toMatchObject({ kind: "send", share: { state: "waived", created: [] } });
    expect(calls).toEqual([]);
  });
});

describe("abandoning and retrying", () => {
  it("an abandoned send takes back exactly the permissions it created, and none it found", async () => {
    const { api } = recording();
    // An earlier message already shared the file with Ada.
    await api.share("demo-drive-41", "ada@example.com");
    const draft = { to: ["ada@example.com", "bo@example.com"], cc: [], bcc: [], body: driveLinkLine(OWN) };
    const result = await prepareDriveDispatch(draft, { api, online: true, allowed: true });
    expect(result.kind).toBe("send");
    if (result.kind !== "send") return;
    expect(result.share?.created.map((p) => p.email)).toEqual(["bo@example.com"]);
    // Undo / Keep editing / discarded: back go this send's permissions only.
    await revokeShares(api, result.share!.created);
    expect(api.revoked).toEqual([result.share!.created[0]!.permissionId]);
    expect((await api.permissions("demo-drive-41")).map((p) => p.emailAddress)).toEqual(["ada@example.com"]);
  });

  it("a retry keeps what the failed attempt shared, and lets go of a recipient taken off", async () => {
    const { api, calls } = recording();
    const first = await prepareDriveDispatch(
      { to: ["ada@example.com", "bo@example.com"], cc: [], bcc: [], body: driveLinkLine(OWN) },
      { api, online: true, allowed: true },
    );
    if (first.kind !== "send") throw new Error("expected a send");
    calls.length = 0;
    const retry = await prepareDriveDispatch(
      { to: ["ada@example.com"], cc: [], bcc: [], body: driveLinkLine(OWN) },
      { api, online: true, allowed: true, prior: first.share!.created },
    );
    if (retry.kind !== "send") throw new Error("expected a send");
    expect(retry.share?.created.map((p) => p.email)).toEqual(["ada@example.com"]);
    expect(retry.stale.map((p) => p.email)).toEqual(["bo@example.com"]);
    expect(calls.filter((call) => call.startsWith("share"))).toEqual([]);
  });

  it("offline at dispatch, the share waits for the queue (pending), and is done at replay", async () => {
    const { api } = recording();
    const draft = { to: ["ada@example.com", "who@example.invalid"], cc: [], bcc: [], body: driveLinkLine(OWN) };
    const result = await prepareDriveDispatch(draft, { api, online: false, allowed: true });
    expect(result).toMatchObject({ kind: "send", share: { state: "pending", created: [] } });
    const share = (result as { share: DraftDriveShare }).share;
    const replay = await prepareQueuedShare(api, share);
    expect(share.state).toBe("shared");
    expect(share.created.map((p) => p.email)).toEqual(["ada@example.com"]);
    expect(queuedShareNotice(replay)).toMatch(/who@example\.invalid/);
    // A second replay (the Gmail half failed and is retried) shares nothing again.
    expect(await prepareQueuedShare(api, share)).toEqual({ problems: [], failed: null });
  });

  it("Drive unreachable at replay is thrown, so the queue backs off", async () => {
    const api: DriveApi = {
      upload: async () => OWN,
      permissions: async () => {
        throw new TypeError("Failed to fetch");
      },
      share: async () => "p",
      revoke: async () => undefined,
    };
    const share: DraftDriveShare = {
      links: [{ id: OWN.id, link: OWN.link, own: true, name: OWN.name }],
      recipients: ["ada@example.com"],
      state: "pending",
      created: [],
    };
    await expect(prepareQueuedShare(api, share)).rejects.toThrow(/fetch/);
    expect(share.state).toBe("pending");
  });
});
