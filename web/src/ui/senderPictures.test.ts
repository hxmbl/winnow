import { describe, expect, it } from "vitest";
import { isRelayedName, orderPictures } from "./senderPictures";

describe("relayed senders get no brand logo", () => {
  it("spots a list or group relay", () => {
    expect(isRelayedName("Ana via Book Club")).toBe(true);
    expect(isRelayedName("Ana Lima via Google Docs")).toBe(true);
    expect(isRelayedName("ana VIA lists")).toBe(true);
  });

  it("leaves a brand called VIA, and names that only contain the letters, alone", () => {
    expect(isRelayedName("VIA Rail Canada")).toBe(false);
    expect(isRelayedName("Viacom")).toBe(false);
    expect(isRelayedName("Olivia")).toBe(false);
    expect(isRelayedName("Trivia Night")).toBe(false);
  });

  it("is false with no name", () => {
    expect(isRelayedName(undefined)).toBe(false);
    expect(isRelayedName("")).toBe(false);
  });
});

describe("picture order", () => {
  const photo = "https://lh3.googleusercontent.com/a/photo=s96-c";
  const base = `https://gravatar.com/avatar/${"a".repeat(64)}`;
  const logo = { kind: "logo", url: "https://brand.example/logo.svg" } as const;
  const gravatar = { kind: "logo", url: base } as const;
  const none = { kind: "none" } as const;
  const unknown = { kind: "unknown" } as const;

  it("puts the contact photo first, then Gravatar, then the brand logo", () => {
    expect(orderPictures(photo, gravatar, logo, 32)).toEqual([photo, `${base}?d=404&s=64`, logo.url]);
    expect(orderPictures(undefined, gravatar, logo, 32)).toEqual([`${base}?d=404&s=64`, logo.url]);
  });

  it("sizes Gravatar at twice the avatar", () => {
    expect(orderPictures(undefined, gravatar, none, 36)).toEqual([`${base}?d=404&s=72`]);
  });

  it("falls to the logo when there is no Gravatar, and holds the monogram while Gravatar is unknown", () => {
    expect(orderPictures(undefined, none, logo, 32)).toEqual([logo.url]);
    expect(orderPictures(undefined, unknown, logo, 32)).toEqual([]);
  });

  it("is the monogram when nothing is known", () => {
    expect(orderPictures(undefined, none, none, 32)).toEqual([]);
  });
});
