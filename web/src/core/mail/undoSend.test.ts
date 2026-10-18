import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNDO_SEND_SECONDS,
  DelayedSend,
  UNDO_SEND_CHOICES,
  isUndoSendSeconds,
  undoSendLabel,
  type SendTimers,
} from "./undoSend";

/** Timers that fire only when told to, with a clock to match. */
function fakeTimers() {
  let now = 1_000;
  let next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: SendTimers = {
    set: (callback, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, job] of [...pending]) {
        if (job.at <= now) {
          pending.delete(id);
          job.callback();
        }
      }
    },
    get count() {
      return pending.size;
    },
  };
}

describe("undo send choices", () => {
  it("offers Off, 5, 10, 20 and 30 seconds, defaulting to 5", () => {
    expect([...UNDO_SEND_CHOICES]).toEqual([0, 5, 10, 20, 30]);
    expect(DEFAULT_UNDO_SEND_SECONDS).toBe(5);
  });

  it("accepts only those values", () => {
    for (const value of UNDO_SEND_CHOICES) expect(isUndoSendSeconds(value)).toBe(true);
    for (const value of [1, 15, -5, 60, "5", null, undefined, Number.NaN]) {
      expect(isUndoSendSeconds(value)).toBe(false);
    }
  });

  it("labels Off and seconds", () => {
    expect(undoSendLabel(0)).toBe("Off");
    expect(undoSendLabel(10)).toBe("10s");
  });
});

describe("DelayedSend", () => {
  it("sends when the delay ends, not before", () => {
    const t = fakeTimers();
    const sent: string[] = [];
    const delayed = new DelayedSend<string>(t.timers, t.now);
    delayed.schedule("hello", 5_000, (value) => sent.push(value));
    expect(delayed.pending).toBe("hello");
    expect(delayed.deadline).toBe(6_000);
    t.advance(4_999);
    expect(sent).toEqual([]);
    t.advance(1);
    expect(sent).toEqual(["hello"]);
    expect(delayed.pending).toBeNull();
    expect(delayed.deadline).toBeNull();
  });

  it("sends at once with a delay of zero", () => {
    const t = fakeTimers();
    const sent: string[] = [];
    new DelayedSend<string>(t.timers, t.now).schedule("now", 0, (value) => sent.push(value));
    expect(sent).toEqual(["now"]);
    expect(t.count).toBe(0);
  });

  it("gives the message back on Undo, and never sends it", () => {
    const t = fakeTimers();
    const sent: string[] = [];
    const delayed = new DelayedSend<string>(t.timers, t.now);
    delayed.schedule("oops", 5_000, (value) => sent.push(value));
    expect(delayed.undo()).toBe("oops");
    t.advance(10_000);
    expect(sent).toEqual([]);
    expect(t.count).toBe(0);
    expect(delayed.undo()).toBeNull();
  });

  it("has nothing to undo once the message went", () => {
    const t = fakeTimers();
    const delayed = new DelayedSend<string>(t.timers, t.now);
    delayed.schedule("gone", 5_000, () => undefined);
    t.advance(5_000);
    expect(delayed.undo()).toBeNull();
  });

  it("sends the waiting message first when another Send comes in", () => {
    const t = fakeTimers();
    const sent: string[] = [];
    const delayed = new DelayedSend<string>(t.timers, t.now);
    delayed.schedule("first", 5_000, (value) => sent.push(value));
    delayed.schedule("second", 5_000, (value) => sent.push(value));
    expect(sent).toEqual(["first"]);
    expect(delayed.pending).toBe("second");
    t.advance(5_000);
    expect(sent).toEqual(["first", "second"]);
  });

  it("sends now on request, once", () => {
    const t = fakeTimers();
    const sent: string[] = [];
    const delayed = new DelayedSend<string>(t.timers, t.now);
    delayed.schedule("hurry", 30_000, (value) => sent.push(value));
    delayed.sendNow();
    delayed.sendNow();
    t.advance(30_000);
    expect(sent).toEqual(["hurry"]);
  });
});
