/**
 * The account-state codec: which keys it owns, what it accepts back, and where it
 * reads them from.
 *
 * The mailbox test is the one that matters after moving navigation order out of the
 * store: "snoozed" and "scheduled" are views, not places, but they are legitimate
 * restored navigation targets, so the codec validates them against the model's
 * vocabulary rather than against the sidebar's row order.
 */

import { describe, expect, it } from "vitest";
import { ACCOUNT_STATE_KEYS, keyFor, loadAccountState, persistAccountState } from "./accountState";
import { ACCOUNT_SCOPED_KEYS } from "../session/accounts";
import { memoryBacking } from "./keyedStorage";

describe("account state storage", () => {
  it("keeps every key it owns inside the account-scoped set", () => {
    // `ACCOUNT_SCOPED_KEYS` decides what sign-out wipes and what the 1.3.5 migration
    // moves. A key added here but not there would survive both, silently.
    for (const key of Object.values(ACCOUNT_STATE_KEYS)) {
      expect(ACCOUNT_SCOPED_KEYS).toContain(key);
    }
  });

  it("accepts a mailbox or a view back, and refuses anything else", () => {
    const storage = memoryBacking();
    persistAccountState(storage, null, { mailbox: "snoozed" });
    expect(loadAccountState(storage, null).mailbox).toBe("snoozed");

    for (const junk of ["outbox", "Inbox", "", 7, null]) {
      storage.setItem(keyFor(ACCOUNT_STATE_KEYS.mailbox, null), JSON.stringify(junk));
      expect(loadAccountState(storage, null).mailbox).toBeNull();
    }
  });

  it("normalises stored filters through the model's one spelling", () => {
    const storage = memoryBacking();
    storage.setItem(
      keyFor(ACCOUNT_STATE_KEYS.filters, null),
      JSON.stringify(["urgent", "sender:ADA@one.example", 7, null]),
    );

    // Sender keys are lowercased on the way back out, and junk is dropped.
    expect(loadAccountState(storage, null).activeFilters).toEqual(["urgent", "sender:ada@one.example"]);
  });

  it("reads an account's own namespace, not the device's", () => {
    const storage = memoryBacking();
    persistAccountState(storage, "acct2xx", { mailbox: "archive" });

    expect(loadAccountState(storage, "acct2xx").mailbox).toBe("archive");
    expect(loadAccountState(storage, null).mailbox).toBeNull();
  });
});
