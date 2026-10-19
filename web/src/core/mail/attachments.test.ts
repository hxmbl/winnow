import { describe, expect, it } from "vitest";
import {
  DEVICE_COPY_BUDGET,
  GMAIL_ATTACHMENT_LIMIT,
  addAttachments,
  attachmentKind,
  base64ToBytes,
  bytesToBase64,
  cleanFilename,
  forDeviceCopy,
  isPdf,
  isPreviewableImage,
  oversizedFiles,
  planAttachments,
  previewMimeType,
  removeAttachment,
  restorableAttachments,
  totalAttachmentSize,
} from "./attachments";
import type { DraftAttachment } from "../model/email";

const MB = 1024 * 1024;
let n = 0;
const id = () => `a${(n += 1)}`;
const file = (filename: string, size: number) => ({ filename, size, data: "QQ==" });

describe("the 25 MB cap", () => {
  it("takes files up to exactly the limit", () => {
    const { attachments, error } = addAttachments([], [file("a.pdf", 20 * MB), file("b.pdf", 5 * MB)], id);
    expect(error).toBeNull();
    expect(totalAttachmentSize(attachments)).toBe(GMAIL_ATTACHMENT_LIMIT);
  });

  it("refuses the file that would cross it, says why, and still takes a smaller one after", () => {
    const { attachments, error } = addAttachments(
      [{ id: "x", filename: "x.bin", mimeType: "application/octet-stream", size: 20 * MB, data: "" }],
      [file("video.mp4", 10 * MB), file("note.txt", 1 * MB)],
      id,
    );
    expect(attachments.map((a) => a.filename)).toEqual(["x.bin", "note.txt"]);
    expect(error).toContain("video.mp4 (10 MB) is too big to attach");
    expect(error).toContain("Gmail allows 25 MB");
    expect(error).toContain("4.0 MB is left");
  });

  it("says when the message is full", () => {
    const { error } = planAttachments([{ size: GMAIL_ATTACHMENT_LIMIT }], [{ filename: "a", size: 1 }]);
    expect(error).toContain("this message is full");
  });

  it("refuses an empty file (a dropped folder) without reading it", () => {
    const plan = planAttachments([], [{ filename: "Photos", size: 0 }, { filename: "a.png", size: 10 }]);
    expect(plan.accepted).toEqual([1]);
    expect(plan.error).toContain("Photos is empty or a folder");
  });

  it("types a file from its name when the browser gives none", () => {
    const { attachments } = addAttachments([], [{ filename: "scan.PNG", size: 3, data: "AAAA", mimeType: "" }], id);
    expect(attachments[0]!.mimeType).toBe("image/png");
  });

  it("removes by id", () => {
    const list: DraftAttachment[] = [
      { id: "1", filename: "a", mimeType: "x/y", size: 1, data: "" },
      { id: "2", filename: "b", mimeType: "x/y", size: 1, data: "" },
    ];
    expect(removeAttachment(list, "1").map((a) => a.id)).toEqual(["2"]);
  });
});

describe("filenames", () => {
  it("keeps the name and drops paths, quotes and control characters", () => {
    expect(cleanFilename("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(cleanFilename('a"b\r\nc.txt')).toBe("abc.txt");
    expect(cleanFilename("  ")).toBe("attachment");
    expect(cleanFilename("..")).toBe("attachment");
  });
});

describe("the device copy", () => {
  const big: DraftAttachment = { id: "1", filename: "big.pdf", mimeType: "application/pdf", size: 3 * MB, data: "A".repeat(DEVICE_COPY_BUDGET + 1) };
  const small: DraftAttachment = { id: "2", filename: "small.txt", mimeType: "text/plain", size: 3, data: "QUJD" };
  const remote: DraftAttachment = { id: "3", filename: "r.pdf", mimeType: "application/pdf", size: 9, source: { gmailId: "m", attachmentId: "x" } };

  it("keeps bytes only within the budget, names always", () => {
    const kept = forDeviceCopy([big, small, remote])!;
    expect(kept.map((a) => a.filename)).toEqual(["big.pdf", "small.txt", "r.pdf"]);
    expect(kept[0]!.data).toBeUndefined();
    expect(kept[1]!.data).toBe("QUJD");
    expect(kept[2]!.source).toEqual({ gmailId: "m", attachmentId: "x" });
    expect(forDeviceCopy([])).toBeUndefined();
  });

  it("restores what can still be sent, and names what has to be attached again", () => {
    const { kept, lost } = restorableAttachments(forDeviceCopy([big, small, remote]));
    expect(kept.map((a) => a.filename)).toEqual(["small.txt", "r.pdf"]);
    expect(lost).toEqual(["big.pdf"]);
  });
});

describe("kinds", () => {
  it("reads the type first and the extension second", () => {
    expect(attachmentKind("application/pdf", "x")).toBe("pdf");
    expect(attachmentKind("application/octet-stream", "Q3.xlsx")).toBe("spreadsheet");
    expect(attachmentKind("application/vnd.openxmlformats-officedocument.presentationml.presentation", "deck")).toBe("slides");
    expect(attachmentKind("application/zip", "a.zip")).toBe("archive");
    expect(attachmentKind("text/calendar", "invite.ics")).toBe("calendar");
    expect(attachmentKind("application/octet-stream", "mystery")).toBe("other");
    expect(isPdf("application/octet-stream", "return.PDF")).toBe(true);
  });

  it("previews raster pictures only, never SVG", () => {
    expect(isPreviewableImage("image/png", "a.png")).toBe(true);
    expect(isPreviewableImage("image/jpeg", "a")).toBe(true);
    expect(isPreviewableImage("image/svg+xml", "logo.svg")).toBe(false);
    expect(isPreviewableImage("application/octet-stream", "logo.svg")).toBe(false);
    expect(isPreviewableImage("application/octet-stream", "photo.JPG")).toBe(true);
    expect(isPreviewableImage("text/html", "photo.jpg")).toBe(false);
    expect(previewMimeType("application/octet-stream", "photo.jpg")).toBe("image/jpeg");
  });
});

describe("bytes", () => {
  it("round-trips through base64, including past one chunk", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    const back = base64ToBytes(bytesToBase64(bytes));
    expect(back).toEqual(bytes);
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
  });
});

describe("files offered as a Drive link", () => {
  it("are the ones refused for size, not the empty ones", () => {
    const MB = 1024 * 1024;
    const files = [
      { filename: "small.pdf", size: 2 * MB },
      { filename: "huge.mov", size: 30 * MB },
      { filename: "folder", size: 0 },
      { filename: "fits.txt", size: 1 * MB },
    ];
    expect(oversizedFiles([], files)).toEqual([1]);
    expect(oversizedFiles([{ size: 24 * MB }], files)).toEqual([0, 1]);
    expect(oversizedFiles([], [{ filename: "a", size: GMAIL_ATTACHMENT_LIMIT }])).toEqual([]);
  });
});
