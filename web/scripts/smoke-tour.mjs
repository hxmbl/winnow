/**
 * Smoke checks for the first-run tour (1.5, `ui/tour.ts`, `components/Tour.tsx`),
 * against the production build, on the desktop and phone layouts:
 *
 *   1. It never opens by itself in an automated browser (every other smoke part relies on
 *      that), nor for a device that has run Winnow before, even when the page opts in.
 *   2. Opted in (`window.__WINNOW_TOUR__`), a first launch walks five steps: the menu opens
 *      for the mailboxes and the menu and closes between, the spotlight sits on each
 *      step's control, the card stays on screen and off the spotlight, focus is held in
 *      the card, the app's shortcuts are held off, and the arrows, Enter and Escape work.
 *   3. Connect Gmail on the last card starts the sign-in path (the Google account setup,
 *      with no client stored) and remembers the tour; a reload does not show it again.
 *   4. Skip remembers it too; Settings › About › "Show the tour again" replays it.
 *   5. A rotation mid-tour (phone to landscape, which is the desktop layout) re-places
 *      the card on screen; reduced motion stops the spotlight's glide.
 *
 * `WINNOW_SMOKE_SHOTS=<dir>` also saves a screenshot of every step on both layouts
 * (`tour-desktop-1.png` … `tour-phone-5.png`), in light mode.
 */

import path from "node:path";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";

const DESKTOP = { viewport: { width: 1280, height: 820 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: ANDROID_UA };

async function open(browser, URL, errors, options, { optIn = true, seed = null, colorScheme = "light", reducedMotion } = {}) {
  const ctx = await browser.newContext({ ...options, colorScheme, ...(reducedMotion ? { reducedMotion } : {}) });
  await ctx.addInitScript(
    ({ optIn, seed }) => {
      if (optIn) window.__WINNOW_TOUR__ = true;
      // Seeded once per context, so a reload sees what the app itself wrote since.
      if (seed && !sessionStorage.getItem("tour-smoke-seeded")) {
        for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
        sessionStorage.setItem("tour-smoke-seeded", "1");
      }
    },
    { optIn, seed },
  );
  const p = await ctx.newPage();
  p.on("pageerror", (error) => errors.push(String(error)));
  p.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await p.goto(URL, { waitUntil: "networkidle" });
  await p.waitForSelector("[data-row-count] [data-row-id]", { timeout: 15_000 });
  return { ctx, p };
}

/** Where everything is for the step on screen: card, spotlight, target, focus, menu. */
function readTour(p) {
  return p.evaluate(() => {
    const box = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const tour = document.querySelector("[data-tour]");
    const card = document.querySelector("[data-tour-card]");
    return {
      open: tour !== null,
      step: tour?.getAttribute("data-tour-step") ?? null,
      index: Number(tour?.getAttribute("data-tour-index") ?? -1),
      card: box(card),
      side: card?.getAttribute("data-tour-side") ?? null,
      spotlight: box(document.querySelector("[data-tour-spotlight]")),
      focusInCard: card !== null && card.contains(document.activeElement),
      role: card?.getAttribute("role") ?? null,
      modal: card?.getAttribute("aria-modal") ?? null,
      announcement: document.querySelector("[data-tour-announcement]")?.textContent ?? "",
      title: document.querySelector("[data-tour-title]")?.textContent ?? "",
      body: document.querySelector("[data-tour-body]")?.textContent ?? "",
      menuOpen: document.querySelector("[data-sidebar][data-open]") !== null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      targets: {
        nav: box(document.querySelector("[data-sidebar][data-open] [data-mail-nav]")),
        panel: box(document.querySelector("[data-sidebar][data-open]")),
        row: box(document.querySelector("[data-row-count] [data-row-id]")),
        rail: box(document.querySelector("[data-list-chrome] [data-rail]")),
        chips: box(document.querySelector("[data-phone-chips] [data-rail]")),
        account: box(document.querySelector("[data-sidebar][data-open] [data-nav-account]")),
      },
      reader: document.querySelector("[data-reader-pane] [data-message-subject], [data-reader] h1") !== null,
      tourDone: (() => {
        try {
          return JSON.parse(localStorage.getItem("winnow.preferences.v1") ?? "{}").tourDone === true;
        } catch {
          return false;
        }
      })(),
    };
  });
}

const inside = (outer, inner, slack = 1) =>
  Boolean(outer && inner) &&
  inner.left >= outer.left - slack &&
  inner.top >= outer.top - slack &&
  inner.right <= outer.right + slack &&
  inner.bottom <= outer.bottom + slack;

const overlaps = (a, b) => Boolean(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const onScreen = (s) =>
  Boolean(s.card) && s.card.left >= 0 && s.card.top >= 0 && s.card.right <= s.viewport.width && s.card.bottom <= s.viewport.height;

/** Wait for the spotlight to settle (the menu's slide, the glide between steps). */
const settle = (p) => p.waitForTimeout(800);

const STEP_TARGET = {
  desktop: { mailboxes: "nav", reading: "row", filters: "rail", menu: "account" },
  phone: { mailboxes: "panel", reading: "row", filters: "chips", menu: "account" },
};

/** Walk every step with Next, checking each one, and screenshot it when asked. */
async function walk(p, layout, { check, shots }) {
  const seen = [];
  for (let i = 0; i < 5; i++) {
    await settle(p);
    let s = await readTour(p);
    // On a slow runner the glide can outlast the pause: give the spotlight up to 3 s
    // more to land around its control before checking it.
    for (const deadline = Date.now() + 3000; Date.now() < deadline; ) {
      const t = STEP_TARGET[layout][s.step];
      if (!t || (inside(s.spotlight, s.targets[t], 2) && !overlaps(s.card, s.spotlight))) break;
      await p.waitForTimeout(100);
      s = await readTour(p);
    }
    seen.push(s.step);
    if (shots) await p.screenshot({ path: path.join(shots, `tour-${layout}-${i + 1}.png`) });
    check(`${layout} step ${i + 1} (${s.step}): the card is fully on screen`, onScreen(s), JSON.stringify(s.card));
    check(
      `${layout} step ${i + 1}: announced, focus in the card`,
      s.announcement === `Step ${i + 1} of 5: ${s.title}` && s.focusInCard,
      `${s.announcement} / focus ${s.focusInCard}`,
    );
    const target = STEP_TARGET[layout][s.step];
    if (target) {
      check(
        `${layout} step ${i + 1}: the spotlight is around its control (${target}) and the card is off it`,
        inside(s.spotlight, s.targets[target], 2) && !overlaps(s.card, s.spotlight),
        JSON.stringify({ spot: s.spotlight, target: s.targets[target], card: s.card }),
      );
      check(
        `${layout} step ${i + 1}: the menu is ${s.step === "mailboxes" || s.step === "menu" ? "open" : "closed"}`,
        s.menuOpen === (s.step === "mailboxes" || s.step === "menu"),
      );
    } else {
      check(`${layout} last step: centred, no spotlight, menu closed`, s.side === "centre" && s.spotlight === null && !s.menuOpen);
    }
    if (i < 4) await p.locator("[data-tour-next]").click();
  }
  check(`${layout}: five steps in order`, seen.join(",") === "mailboxes,reading,filters,menu,explore", seen.join(","));
}

export async function smokeTour({ browser, URL, check, section, errors, shots = null }) {
  section("first-run tour: when it opens");
  {
    const { ctx, p } = await open(browser, URL, errors, DESKTOP, { optIn: false });
    await p.waitForTimeout(600);
    check("an automated browser gets no tour unless it opts in", (await p.locator("[data-tour]").count()) === 0);
    await ctx.close();
  }
  {
    // An upgrade: this device already holds Winnow's keys (no tourDone in them).
    const { ctx, p } = await open(browser, URL, errors, DESKTOP, {
      seed: { "winnow.preferences.v1": JSON.stringify({ appearance: "light" }), "winnow.updates.v1": "{}" },
    });
    await p.waitForTimeout(600);
    check("a device that has run Winnow before gets no tour, even opted in", (await p.locator("[data-tour]").count()) === 0);
    await ctx.close();
  }

  section("first-run tour: desktop");
  {
    const { ctx, p } = await open(browser, URL, errors, DESKTOP);
    await p.locator("[data-tour-card]").waitFor({ timeout: 5_000 });
    let s = await readTour(p);
    check(
      "a first launch opens the tour over the demo, as a modal dialog",
      s.open && s.step === "mailboxes" && s.role === "dialog" && s.modal === "true",
      JSON.stringify({ step: s.step, role: s.role }),
    );
    // The app's shortcuts are held off: j would open the first message.
    await settle(p);
    await p.keyboard.press("j");
    await p.keyboard.press("c");
    await p.waitForTimeout(250);
    s = await readTour(p);
    check(
      "the app's keyboard shortcuts do nothing behind the tour (j, c)",
      s.open && s.step === "mailboxes" && (await p.locator('[role="dialog"][aria-label*="ompose"], [data-composer]').count()) === 0,
    );
    // Focus is held in the card through Tab and Shift+Tab.
    let held = true;
    for (let i = 0; i < 4; i++) {
      await p.keyboard.press("Tab");
      held &&= (await readTour(p)).focusInCard;
    }
    for (let i = 0; i < 4; i++) {
      await p.keyboard.press("Shift+Tab");
      held &&= (await readTour(p)).focusInCard;
    }
    check("Tab and Shift+Tab stay inside the card", held);
    // The keys: arrows step, Enter goes on from the card itself.
    await p.locator("[data-tour-card]").focus();
    await p.keyboard.press("ArrowRight");
    await settle(p);
    s = await readTour(p);
    check("→ goes to the next step, and the menu closes", s.step === "reading" && !s.menuOpen, s.step);
    await p.keyboard.press("ArrowLeft");
    await settle(p);
    s = await readTour(p);
    check("← goes back, and the menu opens again", s.step === "mailboxes" && s.menuOpen, s.step);
    await p.locator("[data-tour-card]").focus();
    await p.keyboard.press("Enter");
    await settle(p);
    check("Enter on the card goes on", (await readTour(p)).step === "reading");
    await p.locator("[data-tour-back]").click();
    await walk(p, "desktop", { check, shots });
    s = await readTour(p);
    check(
      "the last card offers Connect Gmail and Explore the demo",
      (await p.locator("[data-tour-primary='connect']").textContent()) === "Connect Gmail" &&
        (await p.locator("[data-tour-explore]").textContent()) === "Explore the demo",
    );
    // Connect Gmail starts the sign-in path: with no client stored, the Google setup.
    await p.locator("[data-tour-primary='connect']").click();
    const setup = p.locator('[role="dialog"][aria-label="Google account"]');
    await setup.waitFor({ timeout: 5_000 }).catch(() => undefined);
    s = await readTour(p);
    check(
      "Connect Gmail closes the tour, opens the Google account setup and remembers the tour",
      !s.open && (await setup.count()) === 1 && s.tourDone,
      JSON.stringify({ open: s.open, setup: await setup.count(), done: s.tourDone }),
    );
    await p.keyboard.press("Escape");
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    await p.waitForTimeout(600);
    check("after a reload the tour does not open again", (await p.locator("[data-tour]").count()) === 0);

    // Settings › About › Show the tour again, then Escape skips it.
    await p.keyboard.press(",");
    const dialog = p.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.locator('[role="tab"][data-category="about"]').click();
    const replay = dialog.locator("[data-show-tour]");
    check("Settings › About offers Show the tour again", (await replay.count()) === 1);
    await replay.click();
    await p.locator("[data-tour-card]").waitFor({ timeout: 5_000 });
    check(
      "it replays the tour from the first step, with Settings closed",
      (await readTour(p)).step === "mailboxes" && (await dialog.count()) === 0,
    );
    await settle(p);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    s = await readTour(p);
    check("Escape skips: the tour and the menu close", !s.open && !s.menuOpen && s.tourDone);
    await ctx.close();
  }

  section("first-run tour: phone");
  {
    const { ctx, p } = await open(browser, URL, errors, PHONE);
    await p.locator("[data-tour-card]").waitFor({ timeout: 5_000 });
    await settle(p);
    let s = await readTour(p);
    check(
      "a phone's first launch opens the tour on the dock's menu, expanded",
      s.step === "mailboxes" && s.menuOpen && (await p.locator("[data-phone-dock][data-menu-open]").count()) === 1,
    );
    await walk(p, "phone", { check, shots });
    // Back to the start (the last card has no Back button; ← does it): four steps.
    for (let i = 0; i < 4; i++) {
      await p.keyboard.press("ArrowLeft");
      await p.waitForTimeout(80);
    }
    check("← from the last card steps back to the first", (await readTour(p)).step === "mailboxes");
    await p.locator("[data-tour-next]").tap();
    await settle(p);
    check("Next works from a tap", (await readTour(p)).step === "reading");

    // A rotation mid-tour: landscape is the desktop layout, and the card follows.
    await p.setViewportSize({ width: 844, height: 390 });
    await settle(p);
    s = await readTour(p);
    check("turned to landscape mid-tour, the card is re-placed on screen", s.open && onScreen(s), JSON.stringify(s.card));
    await p.setViewportSize({ width: 390, height: 844 });
    await settle(p);
    s = await readTour(p);
    check("and back to portrait", s.open && onScreen(s), JSON.stringify(s.card));

    await p.locator("[data-tour-skip]").tap();
    await p.waitForTimeout(300);
    s = await readTour(p);
    check("Skip tour closes it, closes the menu and remembers it", !s.open && !s.menuOpen && s.tourDone);
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    await p.waitForTimeout(600);
    check("phone: after a reload the tour does not open again", (await p.locator("[data-tour]").count()) === 0);
    await ctx.close();
  }

  section("first-run tour: reduced motion, dark");
  {
    const { ctx, p } = await open(browser, URL, errors, DESKTOP, { reducedMotion: "reduce", colorScheme: "dark" });
    await p.locator("[data-tour-card]").waitFor({ timeout: 5_000 });
    await p.locator("[data-tour-next]").click();
    await settle(p);
    const motion = await p.evaluate(() => {
      const spot = document.querySelector("[data-tour-spotlight]");
      const card = document.querySelector("[data-tour-card]");
      const seconds = (value) => Math.max(...value.split(",").map((part) => parseFloat(part) || 0));
      return {
        glide: spot ? seconds(getComputedStyle(spot).transitionDuration) : null,
        theme: document.documentElement.dataset.theme,
        cardBg: card ? getComputedStyle(card).backgroundColor : null,
        chrome: getComputedStyle(document.documentElement).getPropertyValue("--wn-chrome").trim(),
      };
    });
    check("reduced motion: the spotlight jumps rather than glides", motion.glide !== null && motion.glide <= 0.001, JSON.stringify(motion));
    check("dark: the card is drawn on the theme's chrome", motion.theme === "dark" && motion.cardBg !== "rgb(255, 255, 255)", JSON.stringify(motion));
    await ctx.close();
  }
}
