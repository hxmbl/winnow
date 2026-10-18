/**
 * Attachments through the draft's life: the device copy keeps what fits, a restore says
 * what it could not bring back, a draft reopened from Drafts keeps its files by Gmail id,
 * and the MIME builder writes them out without letting a filename reach the headers.
 */

import { describe, expect, it } from "vitest";
import {
  DraftAutosaver,
  LocalDrafts,
  lostAttachmentsMessage,
  reopenDraft,
  restoreLocalDraft,
  type StorageLike,
} from "./drafts";
import { DEVICE_COPY_BUDGET } from "./attachments";
import { isUntouchedNewDraft } from "./compose";
import { buildMime } from "../gmail/mime";
import type { Draft, Email } from "../model/email";

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const base: Draft = { to: ["ana@example.com"], cc: [], bcc: [], subject: "Files", body: "Here." };
const small = { id: "1", filename: "notes.txt", mimeType: "text/plain", size: 3, data: "QUJD" };
const big = { id: "2", filename: "scan.pdf", mimeType: "application/pdf", size: 2_000_000, data: "A".repeat(DEVICE_COPY_BUDGET + 4) };

describe("the device copy of a draft with files", () => {
  it("keeps small files whole and big ones by name, and the restore says which to attach again", () => {
    const local = new LocalDrafts(memoryStorage(), "me@example.com");
    const saver = new DraftAutosaver({ context: "new", mode: "new", api: null, local, timers: { set: () => 0, clear: () => undefined } });
    saver.change({ ...base, attachments: [small, big] });
    const kept = local.get("new")!;
    expect(kept.draft.attachments?.map((a) => a.filename)).toEqual(["notes.txt", "scan.pdf"]);
    expect(kept.draft.attachments?.[1]?.data).toBeUndefined();
    const { draft, lost } = restoreLocalDraft(kept);
    expect(draft.attachments?.map((a) => a.filename)).toEqual(["notes.txt"]);
    expect(lost).toEqual(["scan.pdf"]);
    expect(lostAttachmentsMessage(lost)).toBe("scan.pdf was too big to keep on this device. Attach it again.");
    expect(lostAttachmentsMessage([])).toBeNull();
  });

  it("hands a Gmail save the whole draft, files and all", async () => {
    const saved: Draft[] = [];
    const saver = new DraftAutosaver({
      context: "new",
      mode: "new",
      api: { create: async (d) => (saved.push(d), "d1"), update: async () => "d1", delete: async () => undefined },
      local: null,
      timers: { set: () => 0, clear: () => undefined },
    });
    saver.change({ ...base, attachments: [big] });
    await saver.flush();
    expect(saved[0]!.attachments?.[0]?.data?.length).toBe(big.data.length);
  });

  it("counts a file as something written", () => {
    expect(isUntouchedNewDraft({ ...base, to: [], subject: "", body: "", attachments: [small] }, { to: [], cc: [], bcc: [], subject: "" })).toBe(false);
  });
});

describe("a draft reopened from Drafts", () => {
  it("keeps its files by where Gmail holds them", () => {
    const row = {
      id: 9,
      gmailId: "m-draft",
      sender: "me@example.com",
      mailbox: "drafts",
      receivedAt: 1,
      subject: "Files",
      body: "Here.",
      category: "primary",
      starred: false,
      unread: false,
      urgent: false,
      to: [{ address: "ana@example.com" }],
      attachments: [{ id: "att-1", partId: "1", filename: "plan.pdf", mimeType: "application/pdf", size: 10, inline: false }],
      gmailDraft: { id: "r-1" },
    } as Email;
    const reopened = reopenDraft(row, [])!;
    expect(reopened.draft.attachments).toEqual([
      {
        id: "gmail-0-att-1",
        filename: "plan.pdf",
        mimeType: "application/pdf",
        size: 10,
        source: { gmailId: "m-draft", attachmentId: "att-1" },
      },
    ]);
  });
});

describe("MIME with attachments", () => {
  const from = { address: "me@example.com" };

  it("writes a base64 file as it is, wrapped at 76", () => {
    const raw = buildMime(base, { from, attachments: [{ filename: "a.txt", mimeType: "text/plain", base64: "QUJD".repeat(40) }] });
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="');
    expect(raw).toContain('Content-Disposition: attachment; filename="a.txt"');
    const lines = raw.split("\r\n");
    expect(lines.some((line) => line === "QUJD".repeat(19))).toBe(true);
  });

  it("keeps a hostile filename and type inside their header", () => {
    const raw = buildMime(base, {
      from,
      attachments: [{ filename: 'evil"\r\nBcc: x@evil.test\r\n.txt', mimeType: "text/plain\r\nX-Evil: 1", bytes: new Uint8Array([65]) }],
    });
    expect(raw).not.toMatch(/^Bcc: x@evil\.test/m);
    expect(raw).not.toMatch(/^X-Evil/m);
    expect(raw).toContain('filename="evilBcc: x@evil.test.txt"');
    expect(raw).toContain("Content-Type: application/octet-stream;");
  });

  it("encodes a big file without overflowing the stack", () => {
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(7);
    const raw = buildMime(base, { from, attachments: [{ filename: "big.bin", bytes }] });
    expect(raw.length).toBeGreaterThan(4 * 1024 * 1024);
  });
});
