import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEV_OPTIONS,
  DEV_SWITCHES,
  DEV_OPTIONS_KEY,
  DEV_UNLOCK_TAPS,
  devUnlockTap,
  hiddenDevOptions,
  loadDevOptions,
  saveDevOptions,
  type DevOptionsStorage,
} from "./devOptions";

const o = (patch: Partial<typeof DEFAULT_DEV_OPTIONS>) => ({ ...DEFAULT_DEV_OPTIONS, ...patch });

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
  it("is locked and off by default, with nothing saved", () => {
    const storage = memory();
    expect(loadDevOptions(storage)).toEqual(o({ unlocked: false, purePlainText: false }));
    expect(storage.map.size).toBe(0);
  });

  it("saves the unlock and Pure Plain Text under its own key and reads them back", () => {
    const storage = memory();
    saveDevOptions(o({ unlocked: true, purePlainText: true }), storage);
    expect(JSON.parse(storage.map.get(DEV_OPTIONS_KEY)!)).toEqual({ version: 1, ...o({ unlocked: true, purePlainText: true }) });
    expect(loadDevOptions(storage)).toEqual(o({ unlocked: true, purePlainText: true }));
  });

  it("keeps the unlock with every switch off", () => {
    const storage = memory();
    saveDevOptions(o({ unlocked: true, purePlainText: false }), storage);
    expect(loadDevOptions(storage)).toEqual(o({ unlocked: true, purePlainText: false }));
  });

  it("hiding locks it, turns every switch off and leaves no entry", () => {
    const storage = memory();
    saveDevOptions(o({ unlocked: true, purePlainText: true }), storage);
    saveDevOptions(hiddenDevOptions(), storage);
    expect(storage.map.has(DEV_OPTIONS_KEY)).toBe(false);
    expect(loadDevOptions(storage)).toEqual(o({ unlocked: false, purePlainText: false }));
    expect(Object.entries(hiddenDevOptions()).every(([, value]) => value === false)).toBe(true);
  });

  it("never reads a switch as on while Dev Options is locked", () => {
    const storage = memory();
    storage.map.set(DEV_OPTIONS_KEY, JSON.stringify({ version: 1, purePlainText: true }));
    expect(loadDevOptions(storage)).toEqual(o({ unlocked: false, purePlainText: false }));
    saveDevOptions(o({ unlocked: false, purePlainText: true }), storage);
    expect(storage.map.has(DEV_OPTIONS_KEY)).toBe(false);
  });

  it("saves and reads back every switch, and hiding turns every one off", () => {
    const storage = memory();
    for (const key of DEV_SWITCHES) {
      saveDevOptions(o({ unlocked: true, [key]: true }), storage);
      expect(loadDevOptions(storage)[key]).toBe(true);
      saveDevOptions(hiddenDevOptions(), storage);
      expect(loadDevOptions(storage)[key]).toBe(false);
    }
    expect(DEV_SWITCHES.every((key) => hiddenDevOptions()[key] === false)).toBe(true);
  });

  it("is local only: one shared key, not an account-scoped or synced one", () => {
    expect(DEV_OPTIONS_KEY).toBe("winnow.devOptions.v1");
  });

  it("treats anything but a literal true as off", () => {
    const storage = memory();
    for (const raw of ["not json", "null", "42", '{"unlocked":"yes"}', '{"unlocked":true,"purePlainText":1}']) {
      storage.map.set(DEV_OPTIONS_KEY, raw);
      expect(loadDevOptions(storage).purePlainText).toBe(false);
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
    expect(loadDevOptions(refusing)).toEqual(o({ unlocked: false, purePlainText: false }));
    expect(() => saveDevOptions(o({ unlocked: true, purePlainText: true }), refusing)).not.toThrow();
    expect(loadDevOptions(null)).toEqual(o({ unlocked: false, purePlainText: false }));
  });
});

describe("unlocking Dev Options from About's version", () => {
  function tapTimes(count: number) {
    let taps = 0;
    const toasts: Array<string | null> = [];
    let unlocked = false;
    for (let i = 0; i < count; i++) {
      const step = devUnlockTap(taps, unlocked);
      taps = step.taps;
      toasts.push(step.toast);
      if (step.unlock) unlocked = true;
    }
    return { toasts, unlocked };
  }

  it("takes ten taps", () => {
    expect(DEV_UNLOCK_TAPS).toBe(10);
    expect(tapTimes(9).unlocked).toBe(false);
    expect(tapTimes(10).unlocked).toBe(true);
  });

  it("says nothing for the first six taps, then counts down, then says it is unlocked", () => {
    expect(tapTimes(10).toasts).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      "3 taps away from Dev Options",
      "2 taps away from Dev Options",
      "1 tap away from Dev Options",
      "Dev Options unlocked",
    ]);
  });

  it("only says so once it is unlocked", () => {
    expect(devUnlockTap(0, true)).toEqual({ taps: 0, unlock: false, toast: "Dev Options already unlocked" });
  });
});
