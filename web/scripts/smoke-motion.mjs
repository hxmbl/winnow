/**
 * Smoke checks for the filter strip's input and motion, the small animations, the
 * sidebar across breakpoints, and the Settings layouts (desktop width, phone bleed).
 *
 * - The strip owns every wheel, swipe and tap over it, the gaps between chips included:
 *   none of them scrolls the list under it or opens a row. A vertical wheel moves the
 *   strip sideways, smoothed, and past an end it gives a little and springs back.
 * - While the list scrolls fast the chips blur slightly, crisp at rest, never under
 *   reduced motion.
 * - Archiving a row leaves a short-lived ghost that nothing can find; menus pop in.
 * - Crossing the phone breakpoint with the sidebar open keeps focus inside it; the
 *   phone's menu shows its Inbox row (the pill's frost used to cover it).
 * - Settings' category column is about an eighth of the window, 160–240px; on a phone
 *   Settings fills the screen behind the dock, with no mail showing round it.
 *
 * Its own module so it can run alone (`node scripts/smoke-motion.mjs`, serving `dist/`
 * itself on `WINNOW_PORT`, default 4323) as well as inside `smoke.mjs`.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Wait `n` animation frames in the page (a headless page only advances on frames). */
const frames = (page, n = 2) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const step = (k) => (k <= 0 ? resolve() : requestAnimationFrame(() => step(k - 1)));
        step(count);
      }),
    n,
  );

/** Wait `ms` while producing frames, so transitions and rAF loops run. */
const settle = (page, ms) =>
  page.evaluate(
    (wait) =>
      new Promise((resolve) => {
        const end = performance.now() + wait;
        const step = () => (performance.now() >= end ? resolve() : requestAnimationFrame(step));
        step();
      }),
    ms,
  );

/** The middle of the gap between the 2nd and 3rd chips of the strip under `scope`. */
const gapPoint = (page, scope) =>
  page.evaluate((sel) => {
    const items = [...document.querySelectorAll(`${sel} [data-rail-scroller] > [data-rail-item]`)].filter(
      (el) => el.getBoundingClientRect().width > 0,
    );
    const [a, b] = [items[1], items[2]].map((el) => el?.getBoundingClientRect());
    if (!a || !b) return null;
    const x = (a.right + b.left) / 2;
    const y = (a.top + a.bottom) / 2;
    const under = document.elementFromPoint(x, y);
    return { x, y, gap: b.left - a.right, catcher: Boolean(under?.closest("[data-rail-catcher]")) };
  }, scope);

const listTop = (page) => page.evaluate(() => Math.round(document.querySelector("[data-row-count]").scrollTop));
const railLeft = (page, scope) =>
  page.evaluate((sel) => Math.round(document.querySelector(`${sel} [data-rail-scroller]`).scrollLeft), scope);

/** Scroll the list `steps` frames by `by` px each; report the strip's state at frame `at`. */
const flingList = (page, by, steps, at) =>
  page.evaluate(
    ({ by, steps, at }) =>
      new Promise((resolve) => {
        const list = document.querySelector("[data-row-count]");
        const rail = document.querySelector("[data-list-chrome] [data-rail-scroller]");
        let n = 0;
        let seen = null;
        let ever = false;
        const step = () => {
          list.scrollTop += by;
          n += 1;
          ever ||= rail.hasAttribute("data-rail-moving");
          if (n === at) {
            const span = rail.querySelector("[data-rail-item] button > *");
            seen = { moving: rail.hasAttribute("data-rail-moving"), filter: getComputedStyle(span).filter, blur: rail.style.getPropertyValue("--wn-rail-blur") };
          }
          if (n < steps) requestAnimationFrame(step);
          else resolve({ seen, ever });
        };
        requestAnimationFrame(step);
      }),
    { by, steps, at },
  );

export async function smokeMotion({ browser, url, check, section, errors = [] }) {
  section("filter strip: input stays on the strip");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    const scope = "[data-list-chrome]";
    const rail = `${scope} [data-rail-scroller]`;
    const gap = await gapPoint(p, scope);
    check("desktop: the gap between two chips belongs to the strip (its catcher)", Boolean(gap?.catcher && gap.gap > 0), JSON.stringify(gap));
    const touchAction = await p.evaluate((sel) => {
      const s = getComputedStyle(document.querySelector(sel));
      return { touch: s.touchAction, over: s.overscrollBehaviorX };
    }, rail);
    check("the strip pans sideways only and keeps its overscroll", touchAction.touch === "pan-x" && touchAction.over === "contain", JSON.stringify(touchAction));

    // A vertical wheel in a gap: the strip glides sideways, the list stays put.
    await p.mouse.move(gap.x, gap.y);
    await p.mouse.wheel(0, 300);
    await settle(p, 500);
    const afterGap = { list: await listTop(p), rail: await railLeft(p, scope) };
    check("a wheel in a gap scrolls the strip sideways and never the list", afterGap.list === 0 && afterGap.rail > 100, JSON.stringify(afterGap));

    // Over a chip, the same.
    const chip = await p.locator(`${rail} > [data-rail-item]`).nth(3).boundingBox();
    await p.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
    await p.mouse.wheel(0, 200);
    await settle(p, 500);
    const afterChip = { list: await listTop(p), rail: await railLeft(p, scope) };
    check("and over a chip", afterChip.list === 0 && afterChip.rail > afterGap.rail, JSON.stringify({ afterGap, afterChip }));

    // Smoothed: one notch arrives over several frames rather than in one jump.
    await p.evaluate((sel) => (document.querySelector(sel).scrollLeft = 200), rail);
    await frames(p, 2);
    await p.mouse.wheel(0, 240);
    await frames(p, 1);
    const early = await railLeft(p, scope);
    await settle(p, 700);
    const late = await railLeft(p, scope);
    check("a wheel notch glides: part of the way after a frame, all of it after", early > 200 && early < 440 && late >= 438, JSON.stringify({ early, late }));

    // Rubber band at the start: pulled past, it shows a little and springs back.
    await p.evaluate((sel) => (document.querySelector(sel).scrollLeft = 0), rail);
    await frames(p, 2);
    await p.mouse.wheel(0, -200);
    await frames(p, 2);
    const stretched = await p.evaluate((sel) => document.querySelector(sel).style.transform, rail);
    const pulled = Number(/translate3d\(([-\d.]+)px/.exec(stretched)?.[1] ?? 0);
    await settle(p, 700);
    const relaxed = await p.evaluate((sel) => document.querySelector(sel).style.transform, rail);
    check("past the start it gives a little (under 56px) and springs back", pulled > 0 && pulled < 56 && relaxed === "", JSON.stringify({ stretched, relaxed }));
    check("and the list never moved", (await listTop(p)) === 0);

    // A scroll gesture in a gap does not reach the list either.
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(gap.x), y: Math.round(gap.y), yDistance: -300, gestureSourceType: "mouse", speed: 2000 });
    await settle(p, 300);
    check("a scroll gesture in a gap does not scroll the list", (await listTop(p)) === 0, `${await listTop(p)}px`);

    // ── Motion blur while the list scrolls.
    section("filter strip: motion blur while the list scrolls");
    const restFilter = await p.evaluate((sel) => getComputedStyle(document.querySelector(`${sel} [data-rail-item] button > *`)).filter, rail);
    check("at rest the chips are crisp: no filter at all", restFilter === "none", restFilter);
    // Big steps: a headless page on a busy machine can draw ten frames a second.
    const { seen: during } = await flingList(p, 180, 8, 6);
    const blurPx = parseFloat(/blur\(([\d.]+)px\)/.exec(during?.filter ?? "")?.[1] ?? "0");
    check("scrolling fast, the chips' words blur a little (under 1px)", Boolean(during?.moving) && blurPx > 0 && blurPx <= 1, JSON.stringify(during));
    await settle(p, 900);
    const after = await p.evaluate((sel) => {
      const el = document.querySelector(sel);
      return { moving: el.hasAttribute("data-rail-moving"), filter: getComputedStyle(el.querySelector("[data-rail-item] button > *")).filter };
    }, rail);
    check("and crisp again once the list stops", !after.moving && after.filter === "none", JSON.stringify(after));
    await p.emulateMedia({ reducedMotion: "reduce" });
    const { ever } = await flingList(p, -180, 8, 0);
    check("with reduced motion there is no blur", ever === false);
    await p.emulateMedia({ reducedMotion: "no-preference" });

    // ── Animations.
    section("small animations");
    await p.evaluate(() => (document.querySelector("[data-row-count]").scrollTop = 0));
    await settle(p, 200);
    const rows = p.locator("[data-row-count] button[data-message-id]");
    await rows.nth(1).click({ button: "right" });
    const menu = p.locator('[role="menu"]').first();
    await menu.waitFor({ timeout: 5_000 });
    const pop = await menu.evaluate((el) => ({ name: getComputedStyle(el).animationName, duration: getComputedStyle(el).animationDuration }));
    check("a menu pops in: a 140ms fade and grow", pop.name === "menu" && pop.duration === "0.14s", JSON.stringify(pop));
    await p.keyboard.press("Escape");
    await settle(p, 200);

    await rows.first().click();
    await settle(p, 300);
    await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    const before = await p.evaluate(() => document.querySelectorAll("[data-row-count] [data-row-id]").length);
    await p.keyboard.press("e");
    const ghost = await p.evaluate(() => {
      const ghosts = [...document.querySelectorAll("[data-row-ghost]")];
      return {
        count: ghosts.length,
        findable: ghosts.some((g) => g.querySelector("[data-message-id], [data-row-id], [aria-label]") !== null),
        hidden: ghosts.every((g) => g.getAttribute("aria-hidden") === "true" && g.inert),
        inList: ghosts.some((g) => g.closest("[data-row-count]") !== null),
      };
    });
    check(
      "archiving a row leaves a ghost of it, hidden from tests, readers and clicks, outside the list",
      ghost.count === 1 && !ghost.findable && ghost.hidden && !ghost.inList,
      JSON.stringify(ghost),
    );
    await settle(p, 450);
    check("which is gone within a fifth of a second or so", (await p.locator("[data-row-ghost]").count()) === 0);
    check("and the row itself left at once", (await p.evaluate(() => document.querySelectorAll("[data-row-count] [data-row-id]").length)) <= before);
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.keyboard.press("e");
    check("with reduced motion no ghost", (await p.locator("[data-row-ghost]").count()) === 0);
    await p.emulateMedia({ reducedMotion: "no-preference" });

    // ── The sidebar across the phone breakpoint.
    section("sidebar across breakpoints");
    await p.keyboard.press("Escape");
    await settle(p, 200);
    await p.locator("header [data-sidebar-toggle]").click();
    await p.locator("[data-sidebar][data-open]").waitFor({ timeout: 5_000 });
    await settle(p, 300);
    await p.setViewportSize({ width: 390, height: 844 });
    await settle(p, 400);
    const phoneSide = await p.evaluate(() => {
      const side = document.querySelector("[data-sidebar]");
      return { open: side.hasAttribute("data-open"), morph: side.hasAttribute("data-morph"), focusIn: side.contains(document.activeElement) };
    });
    check("open sidebar, window narrowed to a phone: it becomes the dock's panel and keeps focus", phoneSide.open && phoneSide.morph && phoneSide.focusIn, JSON.stringify(phoneSide));
    await p.setViewportSize({ width: 1440, height: 900 });
    await settle(p, 400);
    const deskSide = await p.evaluate(() => {
      const side = document.querySelector("[data-sidebar]");
      const r = side.getBoundingClientRect();
      return { open: side.hasAttribute("data-open"), morph: side.hasAttribute("data-morph"), left: Math.round(r.left), focusIn: side.contains(document.activeElement) };
    });
    check("and widened back: the floating sidebar again, focus still inside", deskSide.open && !deskSide.morph && deskSide.left === 8 && deskSide.focusIn, JSON.stringify(deskSide));
    await p.keyboard.press("Escape");
    await settle(p, 300);
    check("Escape still closes it", (await p.locator("[data-sidebar][data-open]").count()) === 0);

    // ── Settings' category column.
    section("settings: the category column");
    for (const [width, layout, expected] of [
      [1440, "three", 180],
      [1000, "two", 160],
      [2200, "three", 240],
    ]) {
      await p.setViewportSize({ width, height: 900 });
      await settle(p, 200);
      if ((await p.locator('[role="dialog"][aria-label="Settings"]').count()) === 0) await p.keyboard.press(",");
      await p.locator(`[data-settings-layout="${layout}"]`).waitFor({ timeout: 5_000 });
      await settle(p, 200);
      const nav = await p.evaluate(() => {
        const column = document.querySelector('[data-settings-column="nav"]');
        const tabs = [...column.querySelectorAll('[role="tab"]')];
        return {
          width: Math.round(column.getBoundingClientRect().width),
          clipped: tabs.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent),
          outside: tabs.filter((t) => t.getBoundingClientRect().right > column.getBoundingClientRect().right).length,
        };
      });
      check(
        `at ${width}px the category column is ${expected}px, every name whole`,
        Math.abs(nav.width - expected) <= 2 && nav.clipped.length === 0 && nav.outside === 0,
        JSON.stringify(nav),
      );
    }
    await p.keyboard.press("Escape");
    await ctx.close();
  }

  section("phone: the strip, the menu and Settings");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    const scope = "[data-phone-dock]";
    const gap = await gapPoint(p, scope);
    check("phone: the gap between two chips belongs to the strip", Boolean(gap?.catcher), JSON.stringify(gap));
    await p.touchscreen.tap(gap.x, gap.y);
    await settle(p, 300);
    check("a tap in a gap opens nothing under it", (await p.locator("article h1").count()) === 0);
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(gap.x), y: Math.round(gap.y), yDistance: -320, gestureSourceType: "touch", speed: 1200 });
    await settle(p, 400);
    check("a vertical swipe starting in a gap does not scroll the list", (await listTop(p)) === 0, `${await listTop(p)}px`);
    const chip = await p.locator(`${scope} [data-rail-scroller] > [data-rail-item]`).nth(1).boundingBox();
    await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(chip.x + chip.width / 2), y: Math.round(chip.y + chip.height / 2), yDistance: -320, gestureSourceType: "touch", speed: 1200 });
    await settle(p, 400);
    check("nor one starting on a chip", (await listTop(p)) === 0, `${await listTop(p)}px`);
    await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(gap.x), y: Math.round(gap.y), xDistance: -260, gestureSourceType: "touch", speed: 1200 });
    await settle(p, 500);
    check("a sideways swipe in a gap moves the strip", (await railLeft(p, scope)) > 50, `${await railLeft(p, scope)}px`);

    // The menu's Inbox row is visible: the pill's frost steps aside with its tint.
    await p.locator("[data-phone-dock] button[data-dock-expand]").tap();
    await p.locator("[data-sidebar][data-open]").waitFor({ timeout: 5_000 });
    await settle(p, 400);
    const pill = await p.evaluate(() => ({
      before: getComputedStyle(document.querySelector("[data-phone-pill]"), "::before").content,
      inbox: document.querySelector('[data-sidebar] button[data-nav="inbox"]')?.getBoundingClientRect().height ?? 0,
    }));
    check("with the menu open, the pill's frost no longer covers the Inbox row", pill.before === "none" && pill.inbox >= 44, JSON.stringify(pill));

    // Settings fills the screen behind the dock: nothing of the inbox around the pill.
    await p.locator('[data-sidebar] [data-nav-account] button[aria-label="Settings"]').tap();
    const dialog = p.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    await settle(p, 400);
    const bleed = await p.evaluate(() => {
      const pillBox = document.querySelector("[data-phone-pill]").getBoundingClientRect();
      const probes = [
        [4, 841],
        [386, 841],
        [195, 842],
        [Math.round(pillBox.right + 4), Math.round(pillBox.top + 6)],
        [4, Math.round(pillBox.top - 4)],
      ];
      return {
        leaks: probes
          .map(([x, y]) => [x, y, document.elementFromPoint(x, y)])
          .filter(([, , el]) => !el || el.closest("[data-row-count], [data-list-chrome], [data-phone-chrome]"))
          .map(([x, y, el]) => [x, y, el?.tagName ?? null]),
        sheetBottom: Math.round(document.querySelector('[role="dialog"][aria-label="Settings"]').getBoundingClientRect().bottom),
        pillTop: Math.round(pillBox.top),
        tabs: document.querySelector("[data-phone-dock] button[data-dock-tab]")?.getBoundingClientRect().height ?? 0,
      };
    });
    check(
      "phone Settings fills to the screen's bottom behind the dock, no mail showing anywhere round the pill",
      bleed.leaks.length === 0 && bleed.sheetBottom >= 843 && bleed.tabs > 0,
      JSON.stringify(bleed),
    );
    await dialog.locator('button[data-category="appearance"]').tap();
    await settle(p, 300);
    const end = await p.evaluate(() => {
      const body = document.querySelector("[data-settings-body]");
      body.scrollTop = body.scrollHeight;
      const last = body.lastElementChild?.getBoundingClientRect();
      return {
        overscroll: getComputedStyle(body).overscrollBehaviorY,
        lastBottom: Math.round(last?.bottom ?? 0),
        pillTop: Math.round(document.querySelector("[data-phone-pill]").getBoundingClientRect().top),
      };
    });
    check("a category's last setting scrolls clear of the pill, and overscroll stays in the sheet", end.lastBottom <= end.pillTop && end.overscroll === "contain", JSON.stringify(end));
    await ctx.close();
  }
}

// ── Standalone ────────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { chromium } = await import("playwright");
  const { preview } = await import("vite");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (!existsSync(path.join(root, "dist", "index.html"))) {
    console.error("No dist/: run `npm run build` first.");
    process.exit(1);
  }
  const port = Number(process.env.WINNOW_PORT ?? 4323);
  const server = await preview({ root, logLevel: "warn", preview: { port, strictPort: true, open: false } });
  const browser = await chromium.launch(
    process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM, args: ["--no-sandbox"] } : {},
  );
  let passed = 0;
  const failures = [];
  const errors = [];
  const check = (label, ok, detail = "") => {
    const line = `${label}${detail ? ` — ${detail}` : ""}`;
    if (ok) passed += 1;
    else failures.push(line);
    console.log(`${ok ? "  ok  " : " FAIL "} ${line}`);
    return ok;
  };
  const section = (title) => console.log(`\n── ${title}`);
  try {
    await smokeMotion({ browser, url: `http://localhost:${port}/`, check, section, errors });
    check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (error) {
    failures.push(`aborted: ${error?.stack ?? error}`);
    console.error(error);
  } finally {
    await browser.close();
    server.httpServer.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}
