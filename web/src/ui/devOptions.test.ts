import { describe, expect, it } from "vitest";
import { DEV_OPTIONS_KEY, loadDevOptions, saveDevOptions, type DevOptionsStorage } from "./devOptions";

function memory(): DevOptionsStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

describe("Dev Options storage", () => {
  it("is off by default, with nothing saved", () => {
    const storage = memory();
    expect(loadDevOptions(storage)).toEqual({ purePlainText: false });
    expect(storage.map.size).toBe(0);
  });

  it("saves Pure Plain Text under its own key and reads it back", () => {
    const storage = memory();
    saveDevOptions({ purePlainText: true }, storage);
    expect(JSON.parse(storage.map.get(DEV_OPTIONS_KEY)!)).toEqual({ version: 1, purePlainText: true });
    expect(loadDevOptions(storage)).toEqual({ purePlainText: true });
  });

  it("saves off as no entry", () => {
    const storage = memory();
    saveDevOptions({ purePlainText: true }, storage);
    saveDevOptions({ purePlainText: false }, storage);
    expect(storage.map.has(DEV_OPTIONS_KEY)).toBe(false);
    expect(loadDevOptions(storage)).toEqual({ purePlainText: false });
  });

  it("is local only: one shared key, not an account-scoped or synced one", () => {
    expect(DEV_OPTIONS_KEY).toBe("winnow.devOptions.v1");
  });

  it("treats anything but a literal true as off", () => {
    const storage = memory();
    for (const raw of ["not json", "null", "42", '{"purePlainText":"yes"}', '{"purePlainText":1}']) {
      storage.map.set(DEV_OPTIONS_KEY, raw);
      expect(loadDevOptions(storage)).toEqual({ purePlainText: false });
    }
  });

  it("survives storage that is missing or refuses", () => {
    const refusing: DevOptionsStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadDevOptions(refusing)).toEqual({ purePlainText: false });
    expect(() => saveDevOptions({ purePlainText: true }, refusing)).not.toThrow();
    expect(loadDevOptions(null)).toEqual({ purePlainText: false });
    expect(() => saveDevOptions({ purePlainText: true }, null)).not.toThrow();
  });
});
