import { describe, expect, it } from "vitest";
import { RAW_DISPLAY_LIMIT, decodeRawMessage, demoRawSource, mimeOutline, rawSourceText } from "./rawSource";

const RAW = [
  "Received: from mx.example.com by mx.google.com",
  "From: Sender <sender@example.com>",
  "To: you@example.com",
  "Subject: A long",
  " folded subject",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "preamble",
  "--outer",
  'Content-Type: multipart/alternative; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hello =E2=80=94 there",
  "--inner",
  "Content-Type: text/html; charset=UTF-8",
  "",
  "<p>Hello</p><script>alert(1)</script>",
  "--inner--",
  "--outer",
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "--outer--",
  "",
].join("\r\n");

function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("View Original", () => {
  it("outlines the MIME tree, one entity per line", () => {
    const lines = mimeOutline(RAW);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^1 multipart\/mixed/);
    expect(lines[1]).toMatch(/^ {2}1\.1 multipart\/alternative/);
    expect(lines[2]).toMatch(/^ {4}1\.1\.1 text\/plain · charset=UTF-8 · quoted-printable · \d+ B$/);
    expect(lines[3]).toMatch(/^ {4}1\.1\.2 text\/html · charset=UTF-8/);
    expect(lines[4]).toMatch(/^ {2}1\.2 application\/pdf · base64 · attachment · "report\.pdf"/);
  });

  it("shows every header and every part as sent, unrendered", () => {
    const { text, truncated } = rawSourceText(RAW);
    expect(truncated).toBe(false);
    expect(text).toContain("Received: from mx.example.com by mx.google.com");
    expect(text).toContain("Subject: A long\r\n folded subject");
    // The HTML part is characters, not markup: it is shown as written, never decoded.
    expect(text).toContain("<p>Hello</p><script>alert(1)</script>");
    expect(text).toContain("Hello =E2=80=94 there");
    expect(text.endsWith(RAW)).toBe(true);
  });

  it("caps what is shown, never what is copied", () => {
    const big = `Subject: big\r\n\r\n${"x".repeat(RAW_DISPLAY_LIMIT + 10)}`;
    const { text, truncated } = rawSourceText(big);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(big.length + 500);
    expect(text).toContain("Copy copies all of it");
  });

  it("decodes Gmail's base64url raw field, tolerating junk", () => {
    expect(decodeRawMessage(b64url(RAW))).toBe(RAW);
    expect(decodeRawMessage(b64url("Subject: é\r\n\r\nü"))).toBe("Subject: é\r\n\r\nü");
    expect(decodeRawMessage("!!!")).toBe("");
  });

  it("builds a labelled source for the demo, which has no server", () => {
    const raw = demoRawSource({
      sender: "a@example.com",
      name: "A",
      subject: "Hi",
      receivedAt: 0,
      gmailId: "demo-1",
      body: "text",
      bodyHtml: "<p>html</p>",
    });
    expect(raw).toContain("X-Winnow-Demo:");
    expect(mimeOutline(raw).map((line) => line.trim().split(" ")[1])).toEqual([
      "multipart/alternative",
      "text/plain",
      "text/html",
    ]);
  });
});
