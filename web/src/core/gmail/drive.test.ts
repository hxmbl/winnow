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
  driveFileId,
  driveLinksForSend,
  findDriveLinks,
  recoverDriveFiles,
  revokeShares,
  shareForSend,
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

  it("shares as reader, without Drive's email, and answers with the permission id", async () => {
    const { calls, client } = stub(() => ({ status: 200, body: '{"id":"perm-1"}' }));
    expect(await client.share("f1", "ada@x.co")).toBe("perm-1");
    expect(calls[0]!.url).toContain("sendNotificationEmail=false");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ type: "user", role: "reader", emailAddress: "ada@x.co" });
  });

  it("reads who can open a file, and takes one permission back (gone already is fine)", async () => {
    const { calls, client } = stub((call) =>
      call.method === "GET"
        ? { status: 200, body: '{"permissions":[{"id":"o","type":"user","emailAddress":"me@x.co"}]}' }
        : { status: call.url.endsWith("/gone") ? 404 : 204 },
    );
    expect(await client.permissions("f1")).toEqual([{ id: "o", type: "user", emailAddress: "me@x.co" }]);
    await client.revoke("f1", "p1");
    await client.revoke("f1", "gone");
    expect(calls[1]).toMatchObject({ method: "DELETE" });
    expect(calls[1]!.url).toBe("https://www.googleapis.com/drive/v3/files/f1/permissions/p1");
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

  it("does not report a whole-grant failure on Winnow's own link as one address", async () => {
    const api = {
      upload: async () => file,
      permissions: async () => { throw new DriveScopeMissing(); },
      share: async () => "p",
      revoke: async () => undefined,
    };
    await expect(
      shareForSend(api, [{ id: "f1", link: file.link, own: true, name: file.name }], ["ada@x.co"]),
    ).rejects.toBeInstanceOf(DriveScopeMissing);
  });

  it("words Google's refusals", () => {
    expect(shareFailureReason(403, "shareOutNotPermitted")).toMatch(/sharing policy/);
    expect(shareFailureReason(404, "")).toMatch(/gone/);
    expect(shareFailureReason(500, "")).toMatch(/refused/);
  });
});

describe("Drive links in a body", () => {
  const own = "holiday.mov (40 MB) — https://drive.google.com/file/d/f1AAAAAAAAAA/view?usp=drivesdk";

  it("reads the file id from every Drive and Docs URL shape, and nothing else", () => {
    expect(driveFileId("https://drive.google.com/file/d/1AbC_def-GHIJ/view?usp=sharing")).toBe("1AbC_def-GHIJ");
    expect(driveFileId("https://drive.google.com/open?id=1AbC_def-GHIJ")).toBe("1AbC_def-GHIJ");
    expect(driveFileId("https://drive.google.com/uc?export=download&id=1AbC_def-GHIJ")).toBe("1AbC_def-GHIJ");
    expect(driveFileId("https://drive.google.com/a/example.com/file/d/1AbC_def-GHIJ/view")).toBe("1AbC_def-GHIJ");
    expect(driveFileId("https://docs.google.com/document/d/1AbC_def-GHIJ/edit")).toBe("1AbC_def-GHIJ");
    expect(driveFileId("https://drive.usercontent.google.com/download?id=1AbC_def-GHIJ")).toBe("1AbC_def-GHIJ");
    expect(driveFileId("https://drive.google.com/drive/folders/1AbC_def-GHIJ")).toBeNull();
    expect(driveFileId("https://evil.example/file/d/1AbC_def-GHIJ/view")).toBeNull();
    expect(driveFileId("https://drive.google.com.evil.example/file/d/1AbC_def-GHIJ/view")).toBeNull();
  });

  it("knows Winnow's own lines from a link someone pasted, in plain text", () => {
    const body = `See below.\n\n${own}\nAnd the deck: https://drive.google.com/open?id=theirsXXXXXX.\n`;
    expect(findDriveLinks(body)).toEqual([
      { id: "f1AAAAAAAAAA", link: "https://drive.google.com/file/d/f1AAAAAAAAAA/view?usp=drivesdk", own: true, name: "holiday.mov" },
      { id: "theirsXXXXXX", link: "https://drive.google.com/open?id=theirsXXXXXX", own: false },
    ]);
  });

  it("reads the HTML body too: Winnow's line as Gmail's editor linked it, and every href", () => {
    const html =
      '<div>See below.</div><div>holiday.mov (40 MB) — <a href="https://drive.google.com/file/d/f1AAAAAAAAAA/view?usp=drivesdk">https://drive.google.com/file/d/f1AAAAAAAAAA/view?usp=drivesdk</a></div>' +
      '<div><a href="https://drive.google.com/uc?export=download&amp;id=theirsYYYYYY">the deck</a></div>';
    const links = findDriveLinks("See below.", html);
    expect(links.map((link) => [link.id, link.own])).toEqual([
      ["f1AAAAAAAAAA", true],
      ["theirsYYYYYY", false],
    ]);
  });

  it("rebuilds the composer's files from Winnow's lines, exactly, so the chip and its × work", () => {
    const recovered = recoverDriveFiles(`Hi\n\n${own}\nraw.wav (4.5 MB) — https://drive.google.com/file/d/f2BBBBBBBBBB/view\n`);
    expect(recovered.map((f) => [f.id, f.name, driveLinkLine(f)])).toEqual([
      ["f1AAAAAAAAAA", "holiday.mov", own],
      ["f2BBBBBBBBBB", "raw.wav", "raw.wav (4.5 MB) — https://drive.google.com/file/d/f2BBBBBBBBBB/view"],
    ]);
  });

  it("shares at send what the body carries, with or without the composer's list", () => {
    const body = `Hi\n\n${driveLinkLine(file)}\n${own}\nhttps://drive.google.com/file/d/theirsZZZZZZ/view`;
    expect(driveLinksForSend({ body, driveFiles: [file] }).map((l) => [l.id, l.own])).toEqual([
      ["f1", true],
      ["f1AAAAAAAAAA", true],
      ["theirsZZZZZZ", false],
    ]);
    expect(driveLinksForSend({ body: "nothing here" , driveFiles: [file] })).toEqual([]);
  });
});

describe("sharing at dispatch", () => {
  it("groups refusals on Winnow's own files by address, naming the files, for the warning", async () => {
    const demo = new DemoDriveClient(0);
    const a = { id: "demo-drive-1", link: "https://drive.google.com/file/d/demo-drive-1/view", own: true, name: "holiday.mov" };
    const b = { id: "demo-drive-2", link: "https://drive.google.com/file/d/demo-drive-2/view", own: true, name: "raw.wav" };
    const { created, problems } = await shareForSend(demo, [a, b], ["ada@x.co", "who@example.invalid"]);
    expect(problems).toEqual([
      { email: "who@example.invalid", reason: "has no Google account Drive can share with", files: ["holiday.mov", "raw.wav"] },
    ]);
    expect(created.map((p) => [p.fileId, p.email])).toEqual([
      ["demo-drive-1", "ada@x.co"],
      ["demo-drive-2", "ada@x.co"],
    ]);
    const warning = shareWarning(problems);
    expect(warning.title).toBe("One recipient can't open the Drive link");
    expect(warning.body).toMatch(/who@example\.invalid/);
    expect(warning.body).toMatch(/Send anyway/);
    expect((await shareForSend(demo, [a], [])).created).toEqual([]);
  });

  it("claims only the permissions it made: an address that can already open the file is left alone", async () => {
    const demo = new DemoDriveClient(0);
    const a = { id: "demo-drive-7", link: "x", own: true, name: "a" };
    const first = await shareForSend(demo, [a], ["ada@x.co"]);
    const second = await shareForSend(demo, [a], ["ada@x.co", "bob@x.co"]);
    expect(first.created).toHaveLength(1);
    expect(second.created.map((p) => p.email)).toEqual(["bob@x.co"]);
  });

  it("skips someone else's link without a word, whatever Drive says about it", async () => {
    const { calls, client } = stub((call) =>
      call.url.includes("theirs") ? { status: 404, body: '{"error":{"code":404,"message":"File not found"}}' } : { status: 403, body: "appNotAuthorizedToFile" },
    );
    const outcome = await shareForSend(
      client,
      [
        { id: "theirsAAAAAA", link: "x", own: false },
        { id: "otherBBBBBBB", link: "y", own: false },
      ],
      ["ada@x.co"],
    );
    expect(outcome).toEqual({ created: [], problems: [] });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("takes back exactly what it is given, and says which it could not", async () => {
    const demo = new DemoDriveClient(0);
    const left = await revokeShares(demo, [
      { fileId: "demo-drive-1", permissionId: "p1", email: "a@x.co" },
      { fileId: "demo-drive-2", permissionId: "p2", email: "a@x.co" },
    ]);
    expect(left).toEqual([]);
    expect(demo.revoked).toEqual(["p1", "p2"]);
    const failing = { ...demo, upload: demo.upload, permissions: demo.permissions, share: demo.share, revoke: async () => { throw new Error("offline"); } };
    expect(await revokeShares(failing, [{ fileId: "f", permissionId: "p", email: "a@x.co" }])).toHaveLength(1);
  });

  it("the demo uploads nothing and answers with a made-up link", async () => {
    const uploaded = await new DemoDriveClient(0).upload({ filename: "x.bin", mimeType: "", bytes: new Uint8Array(3) });
    expect(uploaded.link).toMatch(/^https:\/\/drive\.google\.com\/file\/d\/demo-drive-/);
  });
});
