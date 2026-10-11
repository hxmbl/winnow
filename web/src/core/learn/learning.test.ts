/**
 * The learning model.
 *
 * *Direction* is the first thing worth pinning: a sign error is the one bug here the
 * app cannot show — the weights move, the ranking simply gets worse for as long as
 * feedback continues — so each nudge is checked by name rather than by "it went up".
 *
 * The second is that `fromSnapshot` reads untrusted input (`localStorage`, which a
 * user can edit and which can hold half a write), so "never throws" is a requirement:
 * a thrown error costs the user the app rather than their tuning.
 */

import { describe, expect, it } from "vitest";
import {
  LearningModel,
  LEARNING_STEP,
  MAX_EVENTS,
  SPAM_CONTRADICTION,
  type FeedbackEvent,
  type LearningSnapshot,
} from "./learning";
import {
  SIGNAL_KEYS,
  STANDARD_WEIGHTS,
  defaultWeights,
  signalMeta,
  type SignalKey,
} from "../classify/weights";
import {
  BUILTIN_FILTERS,
  NEUTRAL_SIGNALS,
  type BuiltinSmartFilter,
  type EmailSignals,
} from "../model/signals";
import type { Email } from "../model/email";

function email(over: Partial<Email> = {}): Email {
  return {
    id: 1,
    gmailId: "g1",
    sender: "someone@northwind.example",
    mailbox: "inbox",
    receivedAt: 0,
    subject: "",
    body: "",
    category: "primary",
    starred: false,
    unread: false,
    attachments: [],
    urgent: false,
    ...over,
  };
}

/** The all-clear classification with some signals lit, rather than a classifier run. */
function sig(over: Partial<EmailSignals> = {}): EmailSignals {
  return { ...NEUTRAL_SIGNALS, ...over };
}

const SECURITY = sig({ security: true, importanceScore: 71 });
const NEWSLETTER = sig({ newsletter: true, importanceScore: 12 });
const ACTION_NEEDED = sig({ needsAction: true, urgentText: true, importanceScore: 64 });
const EVERY_SIGNAL = sig({
  security: true,
  urgentText: true,
  needsAction: true,
  finance: true,
  newsletter: true,
  promotional: true,
});
const PLAIN = sig({ importanceScore: 50 });

/** The weights that actually moved, in catalog order. */
function moved(model: LearningModel, before: LearningSnapshot): SignalKey[] {
  const keys: SignalKey[] = [];
  for (const meta of SIGNAL_KEYS) {
    if (model.weights[meta.key] !== before.weights[meta.key]) keys.push(meta.key);
  }
  return keys;
}

describe("a fresh model", () => {
  it("starts at the shipped weights, learning on, with no history", () => {
    const model = LearningModel.initial();
    expect(model.weights).toEqual(STANDARD_WEIGHTS);
    expect(model.adaptive).toBe(true);
    expect(model.events).toHaveLength(0);
  });

  it("holds its step and its cap at the values the design fixed", () => {
    // One star moves one point: twenty stars should change a ranking and one
    // mis-click should not. The cap is what stops the log becoming a second copy
    // of the inbox.
    expect(LEARNING_STEP).toBe(1);
    expect(MAX_EVENTS).toBe(400);
  });
});

describe("immutability", () => {
  it("leaves the receiver untouched across a run of operations", () => {
    // The store, the settings panel and these tests all hold this model. If a
    // mutating method wrote through, the panel would show a weight the store never
    // applied, with no way for either to tell the other is wrong.
    const original = LearningModel.initial();
    const before = original.toSnapshot();

    const after = original
      .recordStar(email({ id: 4 }), SECURITY, true, 1_000)
      .rejectFilter("newsletters", null, null, 1_001)
      .setWeight("security", 30)
      .setAdaptive(false);

    expect(after).not.toBe(original);
    expect(after.weights).not.toBe(original.weights);
    expect(original.weights).toEqual(before.weights);
    expect(original.adaptive).toBe(true);
    expect(original.events).toHaveLength(0);
    expect(original.toSnapshot()).toEqual(before);

    // And the copy really did take the edits, so the assertions above cannot pass
    // by nothing having happened.
    expect(after.weights.security).toBe(30);
    expect(after.adaptive).toBe(false);
    expect(after.events).toHaveLength(2);
  });

  it("gives each copy its own weight object", () => {
    // `nudgeWeight` returns a fresh object per move. A shared one would leave two
    // branches of the app disagreeing about the same instant's ranking.
    const one = LearningModel.initial().recordStar(email({ id: 1 }), SECURITY, true, 1);
    const two = one.recordStar(email({ id: 2 }), SECURITY, true, 2);
    expect(one.weights).not.toBe(two.weights);
    expect(one.weights.security).toBe(STANDARD_WEIGHTS.security + LEARNING_STEP);
    expect(two.weights.security).toBe(STANDARD_WEIGHTS.security + 2 * LEARNING_STEP);
  });
});

describe("starring", () => {
  it("raises a boosting signal by exactly one step", () => {
    // "This is what I wanted to see" means the weight for that signal was too low.
    const before = LearningModel.initial().toSnapshot();
    const after = LearningModel.initial().recordStar(email(), SECURITY, true, 1_000);
    expect(after.weights.security).toBe(before.weights.security + LEARNING_STEP);
    expect(moved(after, before)).toEqual(["security"]);
  });

  it("lowers a penalty signal, because the mail was worth reading anyway", () => {
    // The sign is the whole content of this rule and the easiest thing in the
    // file to get backwards: starring a newsletter does not mean "more
    // newsletters", it means the label that called it bulk was wrong. Growing the
    // penalty would push the very message the user kept further down.
    const before = LearningModel.initial().toSnapshot();
    const after = LearningModel.initial().recordStar(email(), NEWSLETTER, true, 1_000);
    expect(after.weights.newsletterPenalty).toBe(
      before.weights.newsletterPenalty - LEARNING_STEP,
    );
    expect(moved(after, before)).toEqual(["newsletterPenalty"]);
  });

  it("moves every signal the message carries", () => {
    const before = LearningModel.initial().toSnapshot();
    const after = LearningModel.initial().recordStar(email(), EVERY_SIGNAL, true, 1_000);
    expect(moved(after, before)).toEqual([
      "security",
      "urgency",
      "actionNeeded",
      "finance",
      "newsletterPenalty",
      "promoPenalty",
    ]);
    expect(after.weights.actionNeeded).toBe(before.weights.actionNeeded + LEARNING_STEP);
    expect(after.weights.promoPenalty).toBe(before.weights.promoPenalty - LEARNING_STEP);
  });

  it("moves nothing for a message with no active signals, and still logs it", () => {
    // The log is the audit trail. A user who starred a message the classifier saw
    // as ordinary still made a decision worth recording, and a history that
    // quietly omits those is a history that cannot explain itself.
    const model = LearningModel.initial();
    const after = model.recordStar(email({ id: 9 }), PLAIN, true, 1_000);
    expect(after.weights).toEqual(model.weights);
    expect(after.events).toHaveLength(1);
    expect(after.events[0].activeSignals).toEqual([]);
  });

  it("records enough of the moment to explain it later", () => {
    // The panel shows "you rated this 42, we predicted 71", which is the only way
    // a user can tell whether the weights are working for them. That comparison
    // needs the *pre*-feedback score, so it is pinned here rather than assumed.
    const after = LearningModel.initial().recordStar(
      email({ id: 42, sender: "billing@acme.example" }),
      SECURITY,
      true,
      1_700_000_000_000,
    );
    expect(after.events[0]).toEqual({
      id: "1700000000000-42-s",
      emailId: 42,
      sender: "billing@acme.example",
      action: "starred",
      predictedImportance: 71,
      activeSignals: ["security"],
      at: 1_700_000_000_000,
    });
  });

  it("softens spam sensitivity when the user starred something called unsafe", () => {
    // Starring mail the classifier called spam is the clearest possible statement
    // that the spam call was wrong.
    const before = LearningModel.initial().toSnapshot();
    const spam = sig({ security: true, spamLikelihood: 0.4, importanceScore: 8 });
    const after = LearningModel.initial().recordStar(email(), spam, true, 1_000);
    expect(after.weights.spamSensitivity).toBe(
      before.weights.spamSensitivity - LEARNING_STEP,
    );
    expect(moved(after, before)).toEqual(["security", "spamSensitivity"]);
  });

  it("leaves spam sensitivity alone below the unsafe threshold", () => {
    // The threshold is the one the rest of the app uses, so learning must not
    // draw it somewhere the badge and the inbox do not.
    const before = LearningModel.initial().toSnapshot();
    const clean = sig({ security: true, spamLikelihood: 0.39 });
    const after = LearningModel.initial().recordStar(email(), clean, true, 1_000);
    expect(after.weights.spamSensitivity).toBe(before.weights.spamSensitivity);
    expect(moved(after, before)).toEqual(["security"]);
  });

  it("softens spam sensitivity for a bare spam lure", () => {
    // A plain spam lure carries no security, urgency, finance or bulk signal, which
    // is exactly the message whose spam call the user has just contradicted.
    const before = LearningModel.initial().toSnapshot();
    const lure = sig({ spamLikelihood: 0.9, importanceScore: 3 });
    const after = LearningModel.initial().recordStar(email(), lure, true, 1_000);

    expect(after.weights.spamSensitivity).toBe(before.weights.spamSensitivity - LEARNING_STEP);
    // Only that one. A lure has no other signal to move, and moving anything else on
    // its behalf would be the model guessing at the user's reason.
    expect(moved(after, before)).toEqual(["spamSensitivity"]);
    expect(after.events).toHaveLength(1);
  });

  it("logs the event but moves no weights when learning is off", () => {
    // Turning learning off is a pause, not an amnesia: the user still gets the
    // history that explains the ranking in front of them.
    const model = LearningModel.initial().setAdaptive(false);
    const before = model.toSnapshot();
    const after = model.recordStar(email(), SECURITY, true, 1_000);
    expect(after.weights).toEqual(before.weights);
    expect(after.events).toHaveLength(1);
    expect(after.events[0].action).toBe("starred");
  });

  it("never moves the star boost, so a star cannot feed its own signal", () => {
    // This is why the caller must record before flipping `email.starred`: after the
    // flip the star's own contribution is inside `signals`, and any weight derived
    // from it would compound on every press.
    const before = LearningModel.initial().toSnapshot();
    const after = LearningModel.initial().recordStar(
      email(),
      EVERY_SIGNAL,
      true,
      1_000,
    );
    expect(after.weights.starBoost).toBe(before.weights.starBoost);
    expect(moved(after, before)).not.toContain("starBoost");
  });

  it("gives every event its own id, and never reuses one for the other direction", () => {
    const model = LearningModel.initial();
    let next = model;
    // Rapid calls: the ids cannot come from a counter, or a reload would reset it.
    for (let i = 0; i < 5; i += 1) {
      next = next.recordStar(email({ id: 100 + i }), SECURITY, true, 5_000);
    }
    const ids = next.events.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Star then unstar in the same millisecond, on the same message: the ids
    // differ only in their suffix, and that suffix is all that keeps them apart.
    const round = model
      .recordStar(email({ id: 7 }), SECURITY, true, 5_000)
      .recordStar(email({ id: 7 }), SECURITY, false, 5_000);
    expect(round.events.map((event) => event.id)).toEqual(["5000-7-s", "5000-7-u"]);
  });

  it("mirrors itself when unstarring", () => {
    // Every nudge on the way down is the negation of the nudge on the way up, so
    // un-starring something starred twice returns the weight to where it started.
    // That is the only property that makes undo honest.
    const message = email({ id: 11 });
    const up = LearningModel.initial().recordStar(message, ACTION_NEEDED, true, 1_000);
    const back = up.recordStar(message, ACTION_NEEDED, false, 2_000);
    expect(back.weights).toEqual(STANDARD_WEIGHTS);
    expect(back.events.map((event) => event.action)).toEqual(["starred", "unstarred"]);
  });

  it("restores spam sensitivity on the way back", () => {
    // Starring junk says "your spam call was wrong"; unstarring it again says the
    // opposite, and the two must cancel — star, see it was junk, unstar is the most
    // reflexive correction in the product.
    const scored = sig({ security: true, spamLikelihood: 0.8 });
    const message = email({ id: 12 });
    const up = LearningModel.initial().recordStar(message, scored, true, 1_000);
    expect(up.weights.spamSensitivity).toBe(STANDARD_WEIGHTS.spamSensitivity - LEARNING_STEP);

    const back = up.recordStar(message, scored, false, 2_000);
    expect(back.weights.spamSensitivity).toBe(STANDARD_WEIGHTS.spamSensitivity);
    expect(back.weights).toEqual(STANDARD_WEIGHTS);
  });

  it("softens spam sensitivity for a message with no other signal", () => {
    // A spam lure is *defined* by carrying none of the touchable signals — no
    // security, no urgency, no finance — so gating the spam nudge on
    // `touched.length > 0` excluded precisely the message that contradicts the call.
    const pureSpamLure = sig({ spamLikelihood: 0.9 });

    const after = LearningModel.initial().recordStar(
      email({ id: 13 }),
      pureSpamLure,
      true,
      1_000,
    );
    expect(after.weights.spamSensitivity).toBe(STANDARD_WEIGHTS.spamSensitivity - LEARNING_STEP);
    // …and nothing else moved, because there was nothing else on the message.
    expect({ ...after.weights, spamSensitivity: STANDARD_WEIGHTS.spamSensitivity }).toEqual(
      STANDARD_WEIGHTS,
    );

    // Below the threshold it stays out of it entirely: a star on ordinary mail is
    // an opinion about that mail, not evidence about the spam boundary.
    const borderline = sig({ spamLikelihood: SPAM_CONTRADICTION - 0.01 });
    const untouched = LearningModel.initial().recordStar(email({ id: 14 }), borderline, true, 1_000);
    expect(untouched.weights).toEqual(STANDARD_WEIGHTS);
  });
});

describe("muting a bucket", () => {
  // Bucket → driving weight, and the direction a mute pulls it. A boosting signal
  // steps down (this mail was not important); a penalty steps up (the label
  // under-fired).
  const DRIVING: { filter: BuiltinSmartFilter; key: SignalKey; delta: number }[] = [
    { filter: "important", key: "actionNeeded", delta: -LEARNING_STEP },
    { filter: "needs_action", key: "actionNeeded", delta: -LEARNING_STEP },
    { filter: "urgent", key: "urgency", delta: -LEARNING_STEP },
    { filter: "security", key: "security", delta: -LEARNING_STEP },
    { filter: "receipts", key: "finance", delta: -LEARNING_STEP },
    { filter: "newsletters", key: "newsletterPenalty", delta: LEARNING_STEP },
    { filter: "promotional", key: "promoPenalty", delta: LEARNING_STEP },
  ];

  it("pulls each bucket's driving signal the right way, and nothing else", () => {
    for (const row of DRIVING) {
      const before = LearningModel.initial().toSnapshot();
      const after = LearningModel.initial().rejectFilter(row.filter, null, null, 1_000);
      expect(after.weights[row.key], `${row.filter} → ${row.key}`).toBe(
        before.weights[row.key] + row.delta,
      );
      expect(moved(after, before), `${row.filter} moved the wrong weights`).toEqual([
        row.key,
      ]);
    }
  });

  it("logs an event and moves nothing for a bucket with no driving signal", () => {
    // Codes, deliveries and social are matched by their own signals, none of which
    // the user can retune. Guessing a weight for them would teach the model
    // something untrue, so the event is recorded and the weights are left alone.
    const undriven = BUILTIN_FILTERS.filter(
      (id) => !DRIVING.some((row) => row.filter === id),
    );
    expect(undriven).toContain("codes");
    expect(undriven).toContain("shipping");
    expect(undriven).toContain("social");
    expect(undriven).toContain("unsafe");

    for (const filter of undriven) {
      const before = LearningModel.initial().toSnapshot();
      const after = LearningModel.initial().rejectFilter(filter, null, null, 1_000);
      expect(after.weights, `${filter} moved a weight`).toEqual(before.weights);
      expect(after.events, `${filter} logged nothing`).toHaveLength(1);
    }
  });

  it("records which bucket was rejected, and invents no message for a pill", () => {
    // Two shapes arrive here: a muted bucket from the rail, which has no message
    // behind it, and one from the reader, which does. The first must not borrow
    // an email id.
    const global = LearningModel.initial().rejectFilter("newsletters", null, null, 1_000);
    expect(global.events[0]).toEqual({
      id: "1000-newsletters-r",
      emailId: undefined,
      sender: undefined,
      action: "filter_rejected",
      predictedImportance: undefined,
      // The bucket, not the message, decides what a mute moves — so this is set even
      // with no message behind the mute. Muting Newsletters means the newsletter
      // signal over-fired, whether or not one particular message triggered the click.
      activeSignals: ["newsletterPenalty"],
      rejectedFilter: "newsletters",
      at: 1_000,
    });

    const scoped = LearningModel.initial().rejectFilter(
      "receipts",
      email({ id: 8, sender: "billing@acme.example" }),
      ACTION_NEEDED,
      1_001,
    );
    expect(scoped.events[0].emailId).toBe(8);
    expect(scoped.events[0].sender).toBe("billing@acme.example");
    expect(scoped.events[0].predictedImportance).toBe(64);
    expect(scoped.events[0].rejectedFilter).toBe("receipts");
    // `receipts` is driven by `finance`, not by the urgency this message happened to
    // carry — the weight that moved is a property of the bucket being muted.
    expect(scoped.events[0].activeSignals).toEqual(["finance"]);
  });

  it("records the weights the mute moved, and nothing else", () => {
    // `activeSignals` means "what this event changed", not "what was on the message".
    // Muting a bucket with no driving weight moves nothing, so an empty array is the
    // honest record — an audit trail that overstates what it did is worse than one
    // that is silent, because it is believed.
    const scoped = LearningModel.initial().rejectFilter(
      "travel",
      email({ id: 3 }),
      ACTION_NEEDED,
      1_000,
    );
    expect(scoped.events[0].activeSignals).toEqual([]);

    // And where the mute *does* drive a weight, that is what gets recorded.
    const driven = LearningModel.initial().rejectFilter(
      "receipts",
      email({ id: 3 }),
      sig({ finance: true, importanceScore: 40 }),
      1_000,
    );
    expect(driven.events[0].activeSignals).toEqual(["finance"]);
  });

  it("never touches spam sensitivity, because unsafe is not muted", () => {
    // The store refuses to mute `unsafe`; if that ever changed, the mute must not
    // teach the model to trust spam.
    const before = LearningModel.initial().toSnapshot();
    const after = LearningModel.initial().rejectFilter("unsafe", email(), SECURITY, 1_000);
    expect(after.weights).toEqual(before.weights);
    expect(after.events[0].rejectedFilter).toBe("unsafe");
  });

  it("moves no weights when learning is off, and still logs", () => {
    const model = LearningModel.initial().setAdaptive(false);
    const before = model.toSnapshot();
    const after = model.rejectFilter("urgent", null, null, 1_000);
    expect(after.weights).toEqual(before.weights);
    expect(after.events).toHaveLength(1);
  });
});

describe("nudging stops at the ends of the range", () => {
  it("walks a boosting weight to its ceiling and holds there", () => {
    // A runaway feedback loop must not be able to make one signal dominate
    // everything else, so the value stops at the range rather than at wherever the
    // loop happened to stop being called.
    const meta = signalMeta("security");
    const message = email();
    let model = LearningModel.initial();
    for (let i = 0; i < 60; i += 1) {
      model = model.recordStar(message, SECURITY, true, 1_000 + i);
      expect(model.weights.security).toBeGreaterThanOrEqual(meta.min);
      expect(model.weights.security).toBeLessThanOrEqual(meta.max);
    }
    expect(model.weights.security).toBe(meta.max);
  });

  it("walks a penalty weight to its floor and holds there", () => {
    const meta = signalMeta("newsletterPenalty");
    const message = email();
    let model = LearningModel.initial();
    for (let i = 0; i < 60; i += 1) {
      model = model.recordStar(message, NEWSLETTER, true, 1_000 + i);
    }
    expect(model.weights.newsletterPenalty).toBe(meta.min);
  });

  it("walks a muted bucket's weight to its floor and holds there", () => {
    const meta = signalMeta("actionNeeded");
    let model = LearningModel.initial();
    for (let i = 0; i < 60; i += 1) {
      model = model.rejectFilter("important", null, null, 1_000 + i);
    }
    expect(model.weights.actionNeeded).toBe(meta.min);
  });

  it("walks an unstarred penalty to its ceiling and holds there", () => {
    const meta = signalMeta("newsletterPenalty");
    const message = email();
    let model = LearningModel.initial();
    for (let i = 0; i < 60; i += 1) {
      model = model.recordStar(message, NEWSLETTER, false, 1_000 + i);
    }
    expect(model.weights.newsletterPenalty).toBe(meta.max);
  });

  it("keeps every weight inside its own range after a mixed run", () => {
    // The invariant rather than any one number: nothing may invert or run away,
    // whichever direction the feedback came from.
    const message = email();
    const fixtures: EmailSignals[] = [SECURITY, NEWSLETTER, ACTION_NEEDED, PLAIN];
    let model = LearningModel.initial();
    for (let i = 0; i < 120; i += 1) {
      model = model.recordStar(message, fixtures[i % fixtures.length], i % 3 !== 0, i);
      model = model.rejectFilter(BUILTIN_FILTERS[i % BUILTIN_FILTERS.length], null, null, i);
    }
    for (const meta of SIGNAL_KEYS) {
      const value = model.weights[meta.key];
      expect(Number.isInteger(value), `${meta.key} is not an integer`).toBe(true);
      expect(value, `${meta.key} is outside its range`).toBeGreaterThanOrEqual(meta.min);
      expect(value, `${meta.key} is outside its range`).toBeLessThanOrEqual(meta.max);
    }
  });
});

describe("the event log", () => {
  it("drops the oldest events once it is full", () => {
    // Ids are `${at}-${emailId}-s`, so the retained window is checkable by
    // timestamp rather than by trusting the slice to have kept the right end.
    const message = email({ id: 7 });
    let model = LearningModel.initial();
    for (let i = 0; i < MAX_EVENTS + 5; i += 1) {
      model = model.recordStar(message, SECURITY, true, i);
    }
    expect(model.events).toHaveLength(MAX_EVENTS);
    expect(model.events[0].id).toBe("5-7-s");
    expect(model.events[MAX_EVENTS - 1].id).toBe(`${MAX_EVENTS + 4}-7-s`);
  });

  it("reads newest first, because that is the event explaining this inbox", () => {
    // The panel reads top-down, and the ranking the user is looking at right now
    // is the one the last event moved.
    let model = LearningModel.initial();
    for (const id of [1, 2, 3]) {
      model = model.recordStar(email({ id }), SECURITY, true, 1_000 + id);
    }
    expect(model.history.map((event) => event.emailId)).toEqual([3, 2, 1]);
    expect(model.events.map((event) => event.emailId)).toEqual([1, 2, 3]);
  });

  it("hands back a copy of the history rather than the log", () => {
    const model = LearningModel.initial().recordStar(email(), SECURITY, true, 1);
    const history = model.history;
    history.length = 0;
    expect(model.history).toHaveLength(1);
  });
});

describe("setting a weight by hand", () => {
  it("rounds and clamps into the signal's own range", () => {
    // The panel renders the value straight onto a slider, so a fractional or
    // out-of-range number puts a thumb somewhere the control cannot represent.
    const meta = signalMeta("spamSensitivity");
    const model = LearningModel.initial();
    expect(model.setWeight("spamSensitivity", 20.6).weights.spamSensitivity).toBe(21);
    expect(model.setWeight("spamSensitivity", 9_999).weights.spamSensitivity).toBe(meta.max);
    expect(model.setWeight("spamSensitivity", -50).weights.spamSensitivity).toBe(meta.min);
  });

  it("returns the same model when the rounded value is the current one", () => {
    // A slider tick that lands on the value already set must not trigger a
    // reclassify. The docstring promises identity here, so it is asserted rather
    // than inferred from an unchanged number.
    const model = LearningModel.initial();
    expect(model.setWeight("security", 16.4)).toBe(model);
    expect(model.setWeight("security", 16)).toBe(model);
    expect(model.setWeight("security", 17)).not.toBe(model);
  });

  it("leaves the other weights, the events and the flag alone", () => {
    const model = LearningModel.initial().recordStar(email(), SECURITY, true, 1_000);
    const after = model.setWeight("urgency", 25);
    expect(after.weights.security).toBe(model.weights.security);
    expect(after.weights.urgency).toBe(25);
    expect(after.events).toHaveLength(1);
    expect(after.adaptive).toBe(true);
  });

  it("still applies when automatic learning is off", () => {
    // Turning learning off is about the loop, not about the user's own hand.
    const model = LearningModel.initial().setAdaptive(false);
    expect(model.setWeight("security", 30).weights.security).toBe(30);
  });
});

describe("turning learning off and on", () => {
  it("returns the same model when nothing changed", () => {
    const model = LearningModel.initial();
    expect(model.setAdaptive(true)).toBe(model);
    const off = model.setAdaptive(false);
    expect(off).not.toBe(model);
    expect(off.setAdaptive(false)).toBe(off);
  });

  it("keeps the events and the weights across the switch", () => {
    const model = LearningModel.initial().recordStar(email(), SECURITY, true, 1_000);
    const off = model.setAdaptive(false);
    expect(off.events).toHaveLength(1);
    expect(off.weights).toEqual(model.weights);
    expect(off.setAdaptive(true).weights).toEqual(model.weights);
  });
});

describe("resetting the adjustments", () => {
  it("returns the weights to factory and keeps the log", () => {
    // "The event log is kept: it is the audit trail." Resetting the tuning does
    // not delete the history that explains how the tuning happened.
    const model = LearningModel.initial()
      .setWeight("security", 30)
      .recordStar(email(), ACTION_NEEDED, true, 1_000);
    const reset = model.resetAdjustments();
    expect(reset.weights).toEqual(defaultWeights());
    expect(reset.events).toHaveLength(1);
    expect(reset.events[0].id).toBe("1000-1-s");
    expect(reset.adaptive).toBe(true);
  });

  it("hands back a new weights object rather than the shared default", () => {
    // Otherwise a caller holding the reset model would be holding the module's own
    // default object, and the first nudge anywhere would rewrite it for everyone.
    const reset = LearningModel.initial().resetAdjustments();
    expect(reset.weights).not.toBe(defaultWeights());
    expect(reset.weights).toEqual(defaultWeights());
  });
});

describe("reading a persisted snapshot", () => {
  it("falls back to the defaults for anything unusable, and never throws", () => {
    // Every one of these is reachable in practice. A thrown error here costs the
    // user the app; a fallback costs them their tuning.
    const junk: unknown[] = [
      undefined,
      null,
      {},
      "nope",
      42,
      { weights: "nope" },
      { weights: 7 },
      { events: "not an array" },
      { events: [null, 42, "x"] },
      { adaptive: "false", weights: {}, events: [] },
    ];
    for (const input of junk) {
      const label = JSON.stringify(input) ?? "undefined";
      let model: LearningModel | null = null;
      expect(() => {
        model = LearningModel.fromSnapshot(input);
      }, `${label} threw`).not.toThrow();
      expect(model!.weights, label).toEqual(defaultWeights());
      expect(model!.adaptive, label).toBe(true);
      expect(model!.events, label).toEqual([]);
    }
  });

  it("merges a partial weight set over the defaults", () => {
    // A snapshot from a build that knew fewer weights must still load, or the
    // weight it never heard of becomes `undefined` arithmetic downstream.
    const model = LearningModel.fromSnapshot({
      weights: { security: 30 },
      adaptive: true,
      events: [],
    });
    expect(model.weights.security).toBe(30);
    expect(model.weights.spamSensitivity).toBe(defaultWeights().spamSensitivity);
    expect(Object.keys(model.weights)).toHaveLength(SIGNAL_KEYS.length);
  });

  it("drops a weight it cannot use, and clamps one it can", () => {
    // Three failures with three different treatments: a value that is not a
    // number at all keeps the default, an unknown key is removed, and a finite
    // number out of range is brought back inside its own range.
    const model = LearningModel.fromSnapshot({
      weights: {
        security: "overrated",
        spamSensitivity: Number.NaN,
        topSenderBoost: Number.POSITIVE_INFINITY,
        someFutureWeight: 99,
        urgency: 9_999,
        finance: -50,
        actionNeeded: 12.6,
      },
    });
    expect(model.weights.security).toBe(defaultWeights().security);
    expect(model.weights.spamSensitivity).toBe(defaultWeights().spamSensitivity);
    expect(model.weights.topSenderBoost).toBe(defaultWeights().topSenderBoost);
    expect("someFutureWeight" in model.weights).toBe(false);
    expect(model.weights.urgency).toBe(signalMeta("urgency").max);
    expect(model.weights.finance).toBe(signalMeta("finance").min);
    expect(model.weights.actionNeeded).toBe(13);
    expect(Object.keys(model.weights).sort()).toEqual(
      SIGNAL_KEYS.map((meta) => meta.key).sort(),
    );
  });

  it("honours `adaptive: false`, and falls back to on for anything else", () => {
    // Reading `undefined` as *off* would silently stop the learning loop the user
    // never turned off, so only a real boolean counts.
    expect(LearningModel.fromSnapshot({ adaptive: false }).adaptive).toBe(false);
    expect(LearningModel.fromSnapshot({}).adaptive).toBe(true);
    expect(LearningModel.fromSnapshot({ adaptive: undefined }).adaptive).toBe(true);
    expect(LearningModel.fromSnapshot({ adaptive: "yes" }).adaptive).toBe(true);
    expect(LearningModel.fromSnapshot({ adaptive: 0 }).adaptive).toBe(true);
  });

  it("keeps only the events the panel can render", () => {
    // The panel renders `event.sender` and `event.at` directly, so a malformed
    // entry is dropped rather than allowed through to become a blank row or an
    // "Invalid Date".
    const good: FeedbackEvent = {
      id: "1000-1-s",
      emailId: 1,
      sender: "a@b.example",
      action: "starred",
      predictedImportance: 50,
      activeSignals: ["security"],
      at: 1_000,
    };
    const dropped: unknown[] = [
      null,
      42,
      "starred",
      {},
      { id: 7, action: "starred", activeSignals: [] },
      { id: 7, at: "1000", action: "starred", activeSignals: [] },
      { id: 7, at: Number.NaN, action: "starred", activeSignals: [] },
      { id: 7, at: 1, action: "archived", activeSignals: [] },
      { id: 7, at: 1, action: "starred", activeSignals: [], sender: 42 },
      { id: 7, at: 1, action: "starred", activeSignals: [], emailId: "1" },
      { id: 7, at: 1, action: "starred", activeSignals: "security" },
    ];

    const model = LearningModel.fromSnapshot({
      weights: {},
      adaptive: true,
      events: [...dropped.slice(0, 6), good, ...dropped.slice(6)],
    });
    expect(model.events).toEqual([good]);
  });

  it("keeps the newest events when the snapshot is over the cap", () => {
    // A snapshot from a build with a larger cap, or one written before this one,
    // must not be able to grow the log past `MAX_EVENTS` on load.
    const events: FeedbackEvent[] = [];
    for (let i = 0; i < MAX_EVENTS + 20; i += 1) {
      events.push({ id: `${i}-1-s`, action: "starred", activeSignals: [], at: i });
    }
    const model = LearningModel.fromSnapshot({ weights: {}, events });
    expect(model.events).toHaveLength(MAX_EVENTS);
    expect(model.events[0].at).toBe(20);
    expect(model.events[MAX_EVENTS - 1].at).toBe(MAX_EVENTS + 19);
  });

  it("does not share the caller's weights object", () => {
    // The snapshot belongs to the caller and may be edited afterwards — including
    // by a second tab restoring from the same key. A model holding that reference
    // would change under a React tree that never re-read it.
    const raw: { weights: Record<string, number>; adaptive: boolean; events: unknown[] } = {
      weights: { security: 30 },
      adaptive: true,
      events: [],
    };
    const model = LearningModel.fromSnapshot(raw);
    expect(model.weights).not.toBe(raw.weights);

    raw.weights.security = 4;
    raw.weights.finance = 1;
    expect(model.weights.security).toBe(30);
    expect(model.weights.finance).toBe(defaultWeights().finance);
  });

  it("round-trips its own snapshot", () => {
    // This is the real persistence path: `toSnapshot` is what gets written and
    // `fromSnapshot` is what reads it back after a reload. Anything lost in this
    // hop is lost for good, so it is done through JSON rather than by identity.
    const model = LearningModel.initial()
      .setWeight("security", 30)
      .recordStar(email({ id: 1 }), ACTION_NEEDED, true, 1_000)
      .recordStar(email({ id: 2 }), NEWSLETTER, false, 2_000)
      .rejectFilter("urgent", email({ id: 3 }), SECURITY, 3_000)
      .setAdaptive(false);
    const snapshot: LearningSnapshot = JSON.parse(JSON.stringify(model.toSnapshot()));
    const restored = LearningModel.fromSnapshot(snapshot);

    expect(restored.weights).toEqual(model.weights);
    expect(restored.adaptive).toBe(false);
    expect(restored.events.map((event) => event.id)).toEqual(
      model.events.map((event) => event.id),
    );
    expect(restored.events).toEqual([...model.events]);
    expect(restored.toSnapshot()).toEqual(snapshot);
  });

  it("keeps learning from where it left off", () => {
    const model = LearningModel.initial().recordStar(email(), SECURITY, true, 1_000);
    const restored = LearningModel.fromSnapshot(model.toSnapshot());
    const after = restored.recordStar(email({ id: 2 }), SECURITY, true, 2_000);
    expect(after.weights.security).toBe(model.weights.security + LEARNING_STEP);
    expect(after.events).toHaveLength(2);
  });
});
