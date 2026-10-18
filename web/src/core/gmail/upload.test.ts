/**
 * A message too big for a JSON body goes through the media upload endpoint as
 * `multipart/related`, carrying its thread and draft id in the metadata part.
 */

import { describe, expect, it } from "vitest";
import { GmailClient, UPLOAD_THRESHOLD, uploadBody, type FetchLike } from "./client";

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

function stubFetch(): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => '{"id":"d1"}' };
  };
  return { fetchImpl, calls };
}

const client = (fetchImpl: FetchLike) => new GmailClient(async () => "token-1", { fetchImpl });
const big = () => "Subject: big\r\n\r\n" + "A".repeat(UPLOAD_THRESHOLD + 10);

describe("uploads", () => {
  it("keeps a small message on the JSON endpoint", async () => {
    const { fetchImpl, calls } = stubFetch();
    await client(fetchImpl).send("Subject: hi\r\n\r\nbody", "t1");
    expect(calls[0]!.url).toMatch(/\/gmail\/v1\/users\/me\/messages\/send$/);
    expect(calls[0]!.init?.headers?.["Content-Type"]).toBe("application/json");
  });

  it("sends a big message as multipart/related to the upload endpoint, thread and all", async () => {
    const { fetchImpl, calls } = stubFetch();
    const raw = big();
    await client(fetchImpl).send(raw, "t9");
    const call = calls[0]!;
    expect(call.url).toBe("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart");
    expect(call.init?.headers?.["Content-Type"]).toMatch(/^multipart\/related; boundary=/);
    const body = call.init?.body ?? "";
    expect(body).toContain('{"threadId":"t9"}');
    expect(body).toContain("Content-Type: message/rfc822");
    expect(body).toContain(raw);
  });

  it("uploads draft create, update and send with the draft's id in the metadata", async () => {
    const { fetchImpl, calls } = stubFetch();
    const c = client(fetchImpl);
    await c.createDraft(big(), "t1");
    await c.updateDraft("d 7", big());
    await c.sendDraft("d7", big(), "t2");
    expect(calls.map((call) => `${call.init?.method} ${call.url.replace("https://gmail.googleapis.com", "")}`)).toEqual([
      "POST /upload/gmail/v1/users/me/drafts?uploadType=multipart",
      "PUT /upload/gmail/v1/users/me/drafts/d%207?uploadType=multipart",
      "POST /upload/gmail/v1/users/me/drafts/send?uploadType=multipart",
    ]);
    expect(calls[0]!.init?.body).toContain('{"message":{"threadId":"t1"}}');
    expect(calls[1]!.init?.body).toContain('{"id":"d 7","message":{}}');
    expect(calls[2]!.init?.body).toContain('{"id":"d7","message":{"threadId":"t2"}}');
  });

  it("picks a boundary the message does not contain", () => {
    const raw = "--winnow_upload_boundary\r\nhello";
    const { contentType, body } = uploadBody({}, raw);
    const boundary = contentType.split("boundary=")[1]!;
    expect(raw.includes(boundary)).toBe(false);
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });
});
