import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, WinnowStore } from "../core/store/store";
import { DEMO_EMAILS, DEMO_TRASH } from "../core/data/demo";
import { loadPreferences, persistPreferences, revivePreferences } from "../core/store/preferences";
import type { KeyValueStorage } from "../core/session/accounts";
import {
  exploreCopy,
  isExistingInstall,
  placeCard,
  shouldStartTour,
  spotlightBox,
  stepAfter,
  stepAnnouncement,
  tourKeyAction,
  tourSteps,
  TOUR_EDGE,
  TOUR_GAP,
  TOUR_STEP_COUNT,
  visibleTarget,
} from "./tour";

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter((part) => part.trim()).length;

describe("the tour's steps", () => {
  for (const phone of [false, true]) {
    const layout = phone ? "phone" : "desktop";

    it(`${layout}: five steps in the brief's order, ending on explore`, () => {
      const steps = tourSteps(phone);
      expect(steps.map((step) => step.id)).toEqual(["mailboxes", "reading", "filters", "menu", "explore"]);
      expect(steps).toHaveLength(TOUR_STEP_COUNT);
    });

    it(`${layout}: every pointing step has a target, and the last one points at nothing`, () => {
      const steps = tourSteps(phone);
      for (const step of steps.slice(0, -1)) expect(step.targets.length).toBeGreaterThan(0);
      expect(steps[steps.length - 1].targets).toEqual([]);
    });

    it(`${layout}: the menu is open for the mailboxes and the menu, and closed otherwise`, () => {
      expect(tourSteps(phone).map((step) => step.menu)).toEqual([true, false, false, true, false]);
    });

    it(`${layout}: each card says one or two sentences, in British spelling`, () => {
      for (const step of tourSteps(phone).slice(0, -1)) {
        expect(step.title.trim()).not.toBe("");
        expect({ id: step.id, n: sentences(step.body) <= 2 && sentences(step.body) >= 1 }).toEqual({ id: step.id, n: true });
        expect(step.body).not.toMatch(/\b(color|favorite|organize|behavior|center)\b/i);
      }
    });
  }

  it("speaks to the layout: tap on a phone, the keyboard on the desktop", () => {
    const [, phoneReading, phoneFilters] = tourSteps(true);
    const [, deskReading, deskFilters] = tourSteps(false);
    expect(phoneReading.body).toMatch(/^Tap a message/);
    expect(phoneFilters.body).toMatch(/Tap one/);
    expect(deskReading.body).toMatch(/j and k/);
    expect(deskFilters.body).toMatch(/Click one/);
  });

  it("points the phone's mailboxes at the open panel and the desktop's at the sidebar's list", () => {
    expect(tourSteps(true)[0].targets[0]).toBe("[data-sidebar][data-open]");
    expect(tourSteps(false)[0].targets[0]).toBe("[data-sidebar][data-open] [data-mail-nav]");
    // The menu step is the account row (account menu and the Settings gear) in both.
    expect(tourSteps(true)[3].targets[0]).toContain("[data-nav-account]");
    expect(tourSteps(false)[3].targets[0]).toContain("[data-nav-account]");
  });

  it("ends with Connect Gmail and Explore the demo in the demo, and Done with an account", () => {
    expect(exploreCopy("Connect Gmail")).toMatchObject({ primary: "Connect Gmail", secondary: "Explore the demo" });
    expect(exploreCopy("Connect Gmail").body).toMatch(/connect Gmail\.$/);
    expect(exploreCopy(null)).toMatchObject({ primary: "Done", secondary: null });
    expect(tourSteps(false)[4].title).toBe("Have fun — go and explore");
  });

  it("announces the step by number and title", () => {
    expect(stepAnnouncement(1, tourSteps(false)[1])).toBe("Step 2 of 5: Reading");
  });
});

describe("when the tour opens by itself", () => {
  const first = { tourDone: false, existingInstall: false, automated: false, optIn: false };

  it("opens on a true first launch", () => {
    expect(shouldStartTour(first)).toBe(true);
  });

  it("never for a device that has run Winnow before (an upgrade)", () => {
    expect(shouldStartTour({ ...first, existingInstall: true })).toBe(false);
  });

  it("not again once finished or skipped", () => {
    expect(shouldStartTour({ ...first, tourDone: true })).toBe(false);
  });

  it("not in an automated browser unless the page opts in", () => {
    expect(shouldStartTour({ ...first, automated: true })).toBe(false);
    expect(shouldStartTour({ ...first, automated: true, optIn: true })).toBe(true);
    // Opting in does not override a finished tour or an upgrade.
    expect(shouldStartTour({ ...first, automated: true, optIn: true, tourDone: true })).toBe(false);
  });

  it("reads any winnow.* key as an earlier install, and nothing else", () => {
    expect(isExistingInstall([])).toBe(false);
    expect(isExistingInstall(["something-else", "theme"])).toBe(false);
    expect(isExistingInstall(["winnow.preferences.v1"])).toBe(true);
    expect(isExistingInstall(["winnow.accounts.v1"])).toBe(true);
    expect(isExistingInstall(["winnow.gmail.tokens"])).toBe(true);
    expect(isExistingInstall(["winnow.updates.v1"])).toBe(true);
  });
});

describe("the tour's keys", () => {
  it("Escape skips, the arrows step, Enter goes on unless a button has focus", () => {
    expect(tourKeyAction("Escape", false)).toBe("skip");
    expect(tourKeyAction("Escape", true)).toBe("skip");
    expect(tourKeyAction("ArrowRight", true)).toBe("next");
    expect(tourKeyAction("ArrowDown", false)).toBe("next");
    expect(tourKeyAction("ArrowLeft", true)).toBe("back");
    expect(tourKeyAction("ArrowUp", false)).toBe("back");
    expect(tourKeyAction("Enter", false)).toBe("next");
    expect(tourKeyAction("Enter", true)).toBe("none");
    expect(tourKeyAction("j", false)).toBe("none");
    expect(tourKeyAction(" ", true)).toBe("none");
  });

  it("stays inside the tour going back, and finishes past the last step", () => {
    expect(stepAfter(0, "back")).toBe(0);
    expect(stepAfter(2, "back")).toBe(1);
    expect(stepAfter(0, "next")).toBe(1);
    expect(stepAfter(3, "next")).toBe(4);
    expect(stepAfter(4, "next")).toBeNull();
  });
});

describe("placing the card", () => {
  const viewport = { width: 1280, height: 820 };
  const card = { width: 340, height: 200 };

  it("centres the card with no target", () => {
    expect(placeCard(null, card, viewport)).toEqual({ top: 310, left: 470, side: "centre" });
  });

  it("puts it on the preferred side when it fits", () => {
    const hole = { top: 60, left: 8, width: 240, height: 290 };
    expect(placeCard(hole, card, viewport, "right")).toEqual({ top: 60, left: 8 + 240 + TOUR_GAP, side: "right" });
    expect(placeCard(hole, card, viewport, "below")).toMatchObject({ top: 60 + 290 + TOUR_GAP, side: "below" });
  });

  it("falls through to the next side that fits", () => {
    // A row near the bottom: no room below, so above.
    const hole = { top: 700, left: 0, width: 800, height: 60 };
    expect(placeCard(hole, card, viewport, "below")).toMatchObject({ side: "above", top: 700 - TOUR_GAP - 200 });
  });

  it("keeps the card inside the window's edges", () => {
    const hole = { top: 100, left: 1200, width: 70, height: 40 };
    const placed = placeCard(hole, card, viewport, "below");
    expect(placed.left + card.width).toBeLessThanOrEqual(viewport.width - TOUR_EDGE);
    expect(placed.left).toBeGreaterThanOrEqual(TOUR_EDGE);
  });

  it("centres when nothing fits around a target that fills the window", () => {
    const phone = { width: 390, height: 844 };
    const hole = { top: 10, left: 4, width: 382, height: 820 };
    expect(placeCard(hole, { width: 366, height: 220 }, phone, "above").side).toBe("centre");
  });

  it("keeps a too-tall card on screen", () => {
    const placed = placeCard(null, { width: 340, height: 900 }, viewport);
    expect(placed.top).toBe(TOUR_EDGE);
  });
});

describe("the spotlight", () => {
  const viewport = { width: 390, height: 844 };

  it("has no target for something missing, collapsed or off screen", () => {
    expect(visibleTarget(null, viewport)).toBeNull();
    expect(visibleTarget({ top: 10, left: 10, width: 0, height: 40 }, viewport)).toBeNull();
    expect(visibleTarget({ top: 900, left: 10, width: 100, height: 40 }, viewport)).toBeNull();
    expect(visibleTarget({ top: -80, left: 10, width: 100, height: 40 }, viewport)).toBeNull();
    expect(visibleTarget({ top: 10, left: 400, width: 100, height: 40 }, viewport)).toBeNull();
  });

  it("clips a target that runs off the window to the part on screen", () => {
    expect(visibleTarget({ top: 700, left: -10, width: 420, height: 400 }, viewport)).toEqual({
      top: 700,
      left: 0,
      width: 390,
      height: 144,
    });
  });

  it("grows the hole by its padding without leaving the window", () => {
    expect(spotlightBox({ top: 100, left: 100, width: 50, height: 20 }, viewport, 6)).toEqual({
      top: 94,
      left: 94,
      width: 62,
      height: 32,
    });
    const edge = spotlightBox({ top: 0, left: 0, width: 390, height: 844 }, viewport, 6);
    expect(edge).toEqual({ top: 2, left: 2, width: 386, height: 840 });
  });
});

describe("remembering the tour", () => {
  it("is not done by default", () => {
    expect(DEFAULT_PREFERENCES.tourDone).toBe(false);
    expect(new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH }).getSnapshot().preferences.tourDone).toBe(false);
  });

  it("persists finishing as a partial patch, keeping every other preference", () => {
    const storage = memoryStorage();
    persistPreferences(storage, { appearance: "dark" });
    const patches: unknown[] = [];
    const store = new WinnowStore({
      seed: [...DEMO_EMAILS],
      seedTrash: DEMO_TRASH,
      preferences: loadPreferences(storage) ?? undefined,
    });
    store.attach({
      onPersist: (patch) => {
        patches.push(patch);
        if (patch.preferences) persistPreferences(storage, patch.preferences);
      },
    });
    store.setPreferences({ tourDone: true });
    expect(patches).toEqual([{ preferences: { tourDone: true } }]);
    expect(loadPreferences(storage)).toMatchObject({ appearance: "dark", tourDone: true });
  });

  it("survives a restart only as a boolean", () => {
    expect(revivePreferences({ tourDone: true })?.tourDone).toBe(true);
    expect(revivePreferences({ tourDone: false })?.tourDone).toBe(false);
    expect(revivePreferences({ tourDone: "yes" })).not.toHaveProperty("tourDone");
    expect(revivePreferences({})).not.toHaveProperty("tourDone");
  });

  it("a restored store that finished the tour does not open it again", () => {
    const storage = memoryStorage();
    persistPreferences(storage, { tourDone: true });
    const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH, preferences: loadPreferences(storage) ?? undefined });
    expect(
      shouldStartTour({ tourDone: store.getSnapshot().preferences.tourDone, existingInstall: false, automated: false, optIn: false }),
    ).toBe(false);
  });
});
