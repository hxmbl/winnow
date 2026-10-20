/**
 * A small keyed storage helper for features that keep their own state on the device
 * (snooze, send later): one key per feature, read and written as JSON, every access
 * guarded the way the rest of the app's `localStorage` use is (private mode and a full
 * quota *throw*; a corrupt value reads as nothing).
 *
 * The key is built in one place, `storageKey`, so putting a feature's state under an
 * account later (multi-account) is a change to that one function: today every feature
 * has one key, `winnow.<feature>.v1`.
 *
 * Kept in `core/` with no `window`: the backing is `deviceStorage()` when there is
 * one, or whatever a test hands in.
 */

import { deviceStorage } from "./storage";

/** The part of `Storage` this needs. */
export type KeyValueBacking = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The key one feature's state lives under. The one place to add an account scope. */
export function storageKey(feature: string): string {
  return `winnow.${feature}.v1`;
}

export type KeyedStorage = {
  /** The full key, for tests and for the MAP. */
  readonly key: string;
  /** The stored value, parsed, or `null` when there is none (or it is not JSON). */
  read(): unknown;
  /** Store `value` as JSON. `false` when the write was refused. */
  write(value: unknown): boolean;
  /** Forget the feature's state. */
  clear(): void;
};

/** One feature's slot. `backing` is read on every access, so a test can swap it. */
export function keyedStorage(feature: string, backing: () => KeyValueBacking | null = deviceStorage): KeyedStorage {
  const key = storageKey(feature);
  return {
    key,
    read() {
      try {
        const raw = backing()?.getItem(key);
        return raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        return null;
      }
    },
    write(value) {
      const store = backing();
      if (!store) return false;
      try {
        store.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    clear() {
      try {
        backing()?.removeItem(key);
      } catch {
        // Nothing to do: storage refused, so there was nothing it could keep either.
      }
    },
  };
}

/** An in-memory backing, for tests and for hosts with no storage. */
export function memoryBacking(): KeyValueBacking & { dump(): Record<string, string> } {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    dump: () => Object.fromEntries(data),
  };
}
