/**
 * Large attachments as Drive links: the scope, the words before consent, the link line,
 * the resumable upload, reader sharing (no Drive email, per-address report), the API-off
 * classification and the demo client.
 */

import { describe, expect, it } from "vitest";
import {
  DRIVE_API_LIBRARY_URL,
  DRIVE_CONSENT,
  DRIVE_FILE_SCOPE,
  DemoDriveClient,
  DriveApiDisabled,
  DriveClient,
  DriveScopeMissing,
  driveFailureNotice,
  driveFilesToShare,
  driveLinkLine,
  driveLinksStatus,
  hasDriveScope,
  insertDriveLinks,
  recipientAddresses,
  removeDriveLink,
  shareDriveFiles,
  shareFailureReason,
  shareWarning,
  type DriveFetch,
} from "./drive";

const file = { id: "f1", name: "holiday.mov", size: 40 * 1024 * 1024, link: "https://drive.google.com/file/d/f1/view" };

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A Drive stub: answers by URL, records every request. */
function stub(answer: (call: Call) => { status: number; body?: string; location?: string }) {
  const calls: Call[] = [];
  const fetchImpl: DriveFetch = async (url, init) => {
    const call = { url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body };
    calls.push(call);
    const { status, body = "", location } = answer(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      headers: { get: (name: string) => (name.toLowerCase() === "location" ? (location ?? null) : null) },
    };
  };
  return { calls, client: new DriveClient(async () => "token", { fetchImpl }) };
}

describe("the Drive scope", () => {
  it("is drive.file and nothing broader", () => {
    expect(DRIVE_FILE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
    expect(hasDriveScope(`https://www.googleapis.com/auth/gmail.modify ${DRIVE_FILE_SCOPE}`)).toBe(true);
    expect(hasDriveScope("https://www.googleapis.com/auth/drive")).toBe(false);
    expect(hasDriveScope("https://www.googleapis.com/auth/drive.file.extra")).toBe(false);
    expect(hasDriveScope(undefined)).toBe(false);
  });

  it("is explained in plain words before Google is asked: what it allows and what it doesn't", () => {
    expect(DRIVE_CONSENT.allows.join(" ")).toMatch(/choose to send/);
    expect(DRIVE_CONSENT.allows.join(" ")).toMatch(/view/);
    expect(DRIVE_CONSENT.doesNot.join(" ")).toMatch(/anything else in your Drive/);
    expect(DRIVE_CONSENT.footnote).toMatch(/Settings → Privacy/);
  });

  it("has a status line for Settings in every state", () => {
    expect(driveLinksStatus("granted", true)).toMatch(/only for the files Winnow uploads/);
    expect(driveLinksStatus("not_granted", true)).toMatch(/asks the first time/);
    expect(driveLinksStatus("demo", true)).toMatch(/nothing is uploaded/);
    expect(driveLinksStatus(null, true)).toMatch(/once a Gmail account/);
    expect(driveLinksStatus("granted", false)).toMatch(/Stopped/);
  });
});

describe("the link line", () => {
  it("reads File name (size) — link", () => {
    expect(driveLinkLine(file)).toBe("holiday.mov (40 MB) — https://drive.google.com/file/d/f1/view");
  });

  it("goes after what was written, once, and comes out again", () => {
    const body = insertDriveLinks("Here it is.\n\n", [file]);
    expect(body).toBe(`Here it is.\n\n${driveLinkLine(file)}\n`);
    expect(insertDriveLinks(body, [file])).toBe(body);
    expect(insertDriveLinks("", [file])).toBe(`${driveLinkLine(file)}\n`);
    expect(removeDriveLink(body, file)).toBe("Here it is.\n");
  });

  it("is shared only while its line is still in the body", () => {
    expect(driveFilesToShare(insertDriveLinks("Hi", [file]), [file])).toEqual([file]);
    expect(driveFilesToShare("Hi", [file])).toEqual([]);
    expect(driveFilesToShare("Hi", undefined)).toEqual([]);
  });

  it("collects recipient addresses from To, Cc and Bcc", () => {
    expect(recipientAddresses("Ada <Ada@x.co>, bob@y.co", "bob@y.co", undefined)).toEqual(["ada@x.co", "bob@y.co"]);
  });
});

describe("the Drive client", () => {
  it("uploads resumably: metadata first, then the bytes to the address Google gives", async () => {
    const { calls, client } = stub((call) =>
      call.method === "POST"
        ? { status: 200, location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=abc" }
        : { status: 200, body: JSON.stringify({ id: "f9", name: "big.zip", webViewLink: "https://drive.google.com/file/d/f9/view" }) },
    );
    const progress: number[] = [];
    const uploaded = await client.upload(
      { filename: "big.zip", mimeType: "application/zip", bytes: new Uint8Array(10) },
      (fraction) => progress.push(fraction),
    );
    expect(uploaded).toEqual({ id: "f9", name: "big.zip", size: 10, link: "https://drive.google.com/file/d/f9/view" });
    expect(calls[0]!.url).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=resumable/);
    expect(calls[0]!.headers["X-Upload-Content-Length"]).toBe("10");
    expect(calls[0]!.headers.Authorization).toBe("Bearer token");
    expect(calls[1]!.method).toBe("PUT");
    expect(progress).toEqual([0, 1]);
  });

  it("refuses an upload address that is not Google's", async () => {
    const { client } = stub(() => ({ status: 200, location: "https://evil.example/upload" }));
    await expect(client.upload({ filename: "a", mimeType: "", bytes: new Uint8Array(1) })).rejects.toThrow(/did not say where/);
  });

  it("shares as reader, without Drive's email, and reports the addresses that failed", async () => {
    const { calls, client } = stub((call) =>
      JSON.stringify(call.body).includes("nobody@")
        ? { status: 400, body: '{"error":{"errors":[{"reason":"invalidSharingRequest"}]}}' }
        : { status: 200, body: '{"id":"p"}' },
    );
    const failures = await client.shareWith("f1", ["ada@x.co", "nobody@nowhere.example"]);
    expect(failures).toEqual([{ email: "nobody@nowhere.example", reason: "has no Google account Drive can share with" }]);
    expect(calls[0]!.url).toContain("sendNotificationEmail=false");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ type: "user", role: "reader", emailAddress: "ada@x.co" });
  });

  it("classifies the Drive API being off, with Google's switch", async () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "Google Drive API has not been used in project 123 before or it is disabled.",
        details: [{ reason: "SERVICE_DISABLED", metadata: { activationUrl: "https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=123" } }],
        errors: [{ reason: "accessNotConfigured" }],
      },
    });
    const { client } = stub(() => ({ status: 403, body }));
    const error = await client.upload({ filename: "a", mimeType: "", bytes: new Uint8Array(1) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriveApiDisabled);
    const notice = driveFailureNotice(error);
    expect(notice.label).toBe("Turn on the Drive API");
    expect(notice.url).toMatch(/^https:\/\/console\./);
    expect(driveFailureNotice(new DriveApiDisabled(null)).url).toBe(DRIVE_API_LIBRARY_URL);
  });

  it("does not report a whole-grant failure as one address", async () => {
    const client = { shareWith: async () => { throw new DriveScopeMissing(); } };
    await expect(
      shareDriveFiles({ upload: async () => file, ...client }, [file], ["ada@x.co"]),
    ).rejects.toBeInstanceOf(DriveScopeMissing);
  });

  it("words Google's refusals", () => {
    expect(shareFailureReason(403, "shareOutNotPermitted")).toMatch(/sharing policy/);
    expect(shareFailureReason(404, "")).toMatch(/gone/);
    expect(shareFailureReason(500, "")).toMatch(/refused/);
  });
});

describe("sharing at send time", () => {
  it("groups failures by address, naming the files, and warns before send", async () => {
    const demo = new DemoDriveClient(0);
    const second = { ...file, id: "f2", name: "raw.wav" };
    const problems = await shareDriveFiles(demo, [file, second], ["ada@x.co", "who@example.invalid"]);
    expect(problems).toEqual([
      { email: "who@example.invalid", reason: "has no Google account Drive can share with", files: ["holiday.mov", "raw.wav"] },
    ]);
    const warning = shareWarning(problems);
    expect(warning.title).toBe("One recipient can't open the Drive link");
    expect(warning.body).toMatch(/who@example\.invalid/);
    expect(warning.body).toMatch(/Send anyway/);
    expect(await shareDriveFiles(demo, [file], [])).toEqual([]);
  });

  it("the demo uploads nothing and answers with a made-up link", async () => {
    const uploaded = await new DemoDriveClient(0).upload({ filename: "x.bin", mimeType: "", bytes: new Uint8Array(3) });
    expect(uploaded.link).toMatch(/^https:\/\/drive\.google\.com\/file\/d\/demo-drive-/);
  });
});
