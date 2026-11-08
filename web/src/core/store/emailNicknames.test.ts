/**
 * Tests for email nicknames storage and utilities.
 */

import { describe, expect, it } from "vitest";
import {
  foldText,
  getNickname,
  loadEmailNicknames,
  normalizeAddress,
  persistEmailNicknames,
  setNickname,
} from "./emailNicknames";

describe("emailNicknames", () => {
  describe("normalizeAddress", () => {
    it("lowercases and folds accents", () => {
      expect(normalizeAddress("Ada@Example.com")).toBe("ada@example.com");
      expect(normalizeAddress("Ada@EXAMPLE.COM")).toBe("ada@example.com");
      expect(normalizeAddress("Ada@Example.com; Grace@example.com")).toBe("ada@example.com");
      expect(normalizeAddress("Tomás@ Example.com")).toBe("tomas@example.com");
      expect(normalizeAddress("Déborah@Example.com")).toBe("debora@example.com");
    });

    it("strips whitespace", () => {
      expect(normalizeAddress("  ada@example.com  ")).toBe("ada@example.com");
      expect(normalizeAddress("\tada@example.com\n")).toBe("ada@example.com");
    });

    it("keeps valid domain parts", () => {
      expect(normalizeAddress("user@example.com")).toBe("user@example.com");
      expect(normalizeAddress("user@sub.example.co.uk")).toBe("user@sub.example.co.uk");
    });
  });

  describe("foldText", () => {
    it("is an alias for normalizeAddress", () => {
      expect(foldText("Example@Email.com")).toBe(normalizeAddress("Example@Email.com"));
    });
  });

  describe("getNickname", () => {
    it("returns the nickname for a normalized address", () => {
      const nicknames = {
        "ada@example.com": "Personal",
        "work@gmail.com": "Work",
      };
      expect(getNickname(nicknames, "Ada@Example.com")).toBe("Personal");
      expect(getNickname(nicknames, "ada@example.com")).toBe("Personal");
      expect(getNickname(nicknames, "WORK@GMAIL.COM")).toBe("Work");
    });

    it("returns undefined when no nickname is set", () => {
      const nicknames = {
        "ada@example.com": "Personal",
      };
      expect(getNickname(nicknames, "work@gmail.com")).toBe(undefined);
      expect(getNickname(nicknames, "ada2@example.com")).toBe(undefined);
    });

    it("ignores the display name portion", () => {
      const nicknames = {
        "ada@example.com": "Personal",
      };
      expect(getNickname(nicknames, "\"Ada Lovelace\" <ada@example.com>")).toBe("Personal");
    });
  });

  describe("setNickname", () => {
    it("sets a nickname", () => {
      let nicknames = {};
      nicknames = setNickname(nicknames, "ada@example.com", "Personal");
      expect(nicknames).toEqual({
        "ada@example.com": "Personal",
      });
    });

    it("updates an existing nickname", () => {
      let nicknames: Record<string, string> = {
        "ada@example.com": "Old Name",
      };
      nicknames = setNickname(nicknames, "ada@example.com", "New Name");
      expect(nicknames).toEqual({
        "ada@example.com": "New Name",
      });
    });

    it("removes the nickname when null is provided", () => {
      let nicknames: Record<string, string> = {
        "ada@example.com": "Personal",
      };
      nicknames = setNickname(nicknames, "ada@example.com", null);
      expect(nicknames).toEqual({});
    });

    it("handles multiple addresses independently", () => {
      let nicknames = {};
      nicknames = setNickname(nicknames, "ada@example.com", "Personal");
      nicknames = setNickname(nicknames, "work@gmail.com", "Work");
      nicknames = setNickname(nicknames, "school.edu", "School");
      expect(nicknames).toEqual({
        "ada@example.com": "Personal",
        "work@gmail.com": "Work",
        "school.edu": "School",
      });
    });

    it("folds the address for lookup", () => {
      let nicknames = {};
      nicknames = setNickname(nicknames, "Ada@Example.com", "Personal");
      expect(nicknames).toEqual({
        "ada@example.com": "Personal",
      });
      expect(getNickname(nicknames, "ada@example.com")).toBe("Personal");
    });
  });

  describe("loadEmailNicknames and persistEmailNicknames", () => {
    it("returns empty object when storage is null or no data", () => {
      expect(loadEmailNicknames(null, "account123")).toEqual({});
      expect(loadEmailNicknames(null, null)).toEqual({});
      expect(loadEmailNicknames(null, null)).toEqual({});
      expect(loadEmailNicknames(null, "account123")).toEqual({});
    });

    it("parses and stores nicknames", () => {
      const testNicknames = {
        "ada@example.com": "Personal",
        "work@gmail.com": "Work",
      };
      const storage: any = {};
      persistEmailNicknames(storage, "account123", testNicknames);
      const loaded = loadEmailNicknames(storage, "account123");
      expect(loaded).toEqual(testNicknames);
    });

    it("handles storage errors gracefully", () => {
      // Storage that always throws on write
      const failingStorage = {
        setItem: () => {
          throw new Error("Quota exceeded");
        },
        getItem: () => null,
        removeItem: () => {},
        clear: () => {},
      };

      const testNicknames = { "ada@example.com": "Personal" };
      persistEmailNicknames(failingStorage, "account123", testNicknames);
      // Should not throw
      expect(loadEmailNicknames(failingStorage, "account123")).toEqual(testNicknames);
    });

    it("correctly handles empty string nicknames", () => {
      const storage: any = {};
      persistEmailNicknames(storage, "account123", {
        "ada@example.com": "",
        "work@gmail.com": "Work",
      });
      const loaded = loadEmailNicknames(storage, "account123");
      expect(loaded).toEqual({
        "ada@example.com": "",
        "work@gmail.com": "Work",
      });
    });

    it("replaces on write", () => {
      const storage: any = {};
      persistEmailNicknames(storage, "account123", { "ada@example.com": "Old" });
      persistEmailNicknames(storage, "account123", { "ada@example.com": "New" });
      const loaded = loadEmailNicknames(storage, "account123");
      expect(loaded).toEqual({ "ada@example.com": "New" });
    });
  });
});
