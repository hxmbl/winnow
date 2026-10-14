import { describe, expect, it } from "vitest";
import { CODE_CHIP_MS, codeChipVisible, detectCode, formatCode } from "./otp";

describe("detectCode: finds the code", () => {
  const cases: [string, string, string, string][] = [
    ["grouped with a space", "Your verification code", "Your verification code is 418 902. It expires in 10 minutes.", "418902"],
    ["grouped with a hyphen, code first", "", "418-902 is your Acme verification code.", "418902"],
    ["in the subject", "Sign-in code 7741", "Use it to continue. This code is valid for 15 minutes.", "7741"],
    ["after a colon", "Your OTP", "OTP: 12345678", "12345678"],
    ["four digits after security code", "Security", "Your security code is 5521.", "5521"],
    ["a PIN with a leading zero", "Your one-time PIN", "PIN 0042", "0042"],
    ["alphanumeric after a keyword", "2FA", "Your 2FA code: AB12CD", "AB12CD"],
    ["alphanumeric before a keyword", "Your login code", "Enter K7Q2X9 to log in.", "K7Q2X9"],
    ["Google's G- prefix", "G-482913 is your Google verification code", "", "482913"],
    ["a year-like code right after 'passcode is'", "", "Your passcode is 2048", "2048"],
    ["the snippet only, with a nearby keyword", "Sign in to Acme", "Hi! 734021 Use this to finish signing in.", "734021"],
    ["eight digits grouped 4-4", "Login", "Your login code is 4189 0211", "41890211"],
  ];
  for (const [name, subject, text, code] of cases) {
    it(name, () => expect(detectCode(subject, text)).toBe(code));
  }
});

describe("detectCode: false positives", () => {
  const cases: [string, string, string][] = [
    ["no keyword at all", "Lunch?", "Shall we meet at 1230 by gate 4? My extension is 5521."],
    ["an order and a tracking number", "Your order has shipped", "Order number 12345678. Tracking 1Z999AA10123456784."],
    ["a price", "Your bill is ready", "Your bill for April is ready. Total due £84.20 or $1299."],
    ["dates and times next to a sign-in", "New sign-in", "We noticed a sign-in from London on 14/10/2026 at 10:30."],
    ["an ISO date and an IP", "New login", "New login to your account from 192.168.1.1 at 2026-10-14 10:30 UTC."],
    ["a phone number", "Your sign-in", "Did you sign in? Call 0800 123 4567 or +1 415 555 0100 if not."],
    ["a year", "Security alert", "A sign-in attempt was blocked in 2026. Review your security settings."],
    ["an account number by a verify link", "Verify your email", "Your account number is 55512345. Verify your email to continue."],
    ["an order number by a verification notice", "Verification", "Your verification is complete. Order 98765432 ships in 2 days."],
    ["a zip code", "Sign-in from a new place", "Signed in near San Francisco, CA 94107."],
    ["a promo code", "Your code", "Use promo code SAVE20 for 20% off."],
    ["a checkout code", "48% off everything", "Use code SPRING48 at checkout. Free shipping on orders over £50."],
    ["a percentage", "Login streak", "Your login streak beat 2500% of members."],
    ["a login ID", "Your login details", "Your login ID is JSMITH01."],
    ["a reference number", "Verify your booking", "Booking reference 884213. Please verify your details."],
  ];
  for (const [name, subject, text] of cases) {
    it(name, () => expect(detectCode(subject, text)).toBeNull());
  }
});

describe("formatCode", () => {
  it("groups six and eight digits the way people read them", () => {
    expect(formatCode("418902")).toBe("418 902");
    expect(formatCode("41890211")).toBe("4189 0211");
    expect(formatCode("7741")).toBe("7741");
    expect(formatCode("AB12CD")).toBe("AB12CD");
  });
});

describe("codeChipVisible", () => {
  const now = 1_000_000_000;
  it("shows for five minutes from arrival, then not", () => {
    expect(codeChipVisible({ code: "418902", receivedAt: now - 60_000 }, now)).toBe(true);
    expect(codeChipVisible({ code: "418902", receivedAt: now - CODE_CHIP_MS + 1 }, now)).toBe(true);
    expect(codeChipVisible({ code: "418902", receivedAt: now - CODE_CHIP_MS }, now)).toBe(false);
    expect(codeChipVisible({ receivedAt: now }, now)).toBe(false);
  });
});

describe("codes on the email model", () => {
  it("detects once, keeps a settled answer, and re-reads a loaded body", async () => {
    const { withCode, withLoadedBody, keepLoadedBody } = await import("../model/email");
    const { DEMO_EMAILS } = await import("../data/demo");
    const base = DEMO_EMAILS.find((email) => email.gmailId === "demo-codes-1")!;
    expect(base.code).toBe("418902");

    const fresh = { ...base, code: undefined, body: "Sign in to Acme", subject: "Your code" };
    expect(withCode(fresh).code).toBeNull();
    const settled = { ...fresh, code: null };
    expect(withCode(settled)).toBe(settled);

    // The snippet missed it; the body has it.
    const metadata = { ...settled, bodyLoaded: false };
    const loaded = withLoadedBody(metadata, { body: "Your login code is 552 107.", attachments: [] });
    expect(loaded.code).toBe("552107");
    // A re-fetch of the metadata keeps the body and its code.
    expect(keepLoadedBody(metadata, loaded).code).toBe("552107");
  });

  it("puts the demo's Okta code inside the row chip's window when the demo opens", async () => {
    const { demoMailbox } = await import("../data/demo");
    const demo = demoMailbox(Date.UTC(2026, 9, 14, 20, 0, 0));
    const okta = demo.emails.find((email) => email.gmailId === "demo-codes-1")!;
    expect(codeChipVisible(okta, demo.now)).toBe(true);
    expect(codeChipVisible(okta, demo.now + CODE_CHIP_MS)).toBe(false);
    // Only the code messages carry one.
    expect(demo.emails.filter((email) => email.code).map((email) => email.gmailId).sort()).toEqual([
      "demo-codes-1",
      "demo-codes-2",
    ]);
  });
});
