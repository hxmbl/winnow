import { describe, expect, it } from "vitest";
import { mailtoAddress, parseListUnsubscribe } from "./unsubscribe";

describe("parseListUnsubscribe", () => {
  it("keeps one https link and one mailto, in header order", () => {
    expect(
      parseListUnsubscribe(
        "<mailto:leave@list.example?subject=unsubscribe>, <https://list.example/u?id=1>, <https://other.example/x>",
      ),
    ).toEqual({ mailto: "mailto:leave@list.example?subject=unsubscribe", url: "https://list.example/u?id=1" });
  });

  it("marks one-click only when the POST header says so and there is a link", () => {
    expect(parseListUnsubscribe("<https://a.example/u>", "List-Unsubscribe=One-Click")?.oneClick).toBe(true);
    expect(parseListUnsubscribe("<https://a.example/u>")?.oneClick).toBeUndefined();
    expect(parseListUnsubscribe("<mailto:x@a.example>", "List-Unsubscribe=One-Click")?.oneClick).toBeUndefined();
  });

  it("refuses plain http, junk and an absent header", () => {
    expect(parseListUnsubscribe("<http://a.example/u>")).toBeUndefined();
    expect(parseListUnsubscribe("unsubscribe please")).toBeUndefined();
    expect(parseListUnsubscribe("<javascript:alert(1)>")).toBeUndefined();
    expect(parseListUnsubscribe("<mailto:nobody>")).toBeUndefined();
    expect(parseListUnsubscribe(undefined)).toBeUndefined();
  });

  it("reads the bare address out of a mailto", () => {
    expect(mailtoAddress("mailto:leave@list.example?subject=unsubscribe")).toBe("leave@list.example");
  });
});
