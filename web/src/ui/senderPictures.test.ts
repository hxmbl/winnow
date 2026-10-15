import { describe, expect, it } from "vitest";
import { isRelayedName } from "./senderPictures";

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
