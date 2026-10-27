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
 * - Settings' category column is 15% of the window, 212–248px; on a phone
 *   Settings fills the screen behind the dock, with no mail showing round it.
 *
 * Its own module so it can run alone (`node scripts/smoke-motion.mjs`, serving `dist/`
 * itself on `WINNOW_PORT`, default 4323; `WINNOW_CPU_THROTTLE=4` to run it on a slowed CPU) as
 * well as inside `smoke.mjs`.
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

/**
 * Wait until the strip is at rest: scrollLeft unchanged over several frames and no rubber
 * band showing (a glide or spring in flight on a slow runner can outlast any fixed wait).
 * Gives up after `ms` and reports where it stood, unrounded.
 */
const railRest = (page, sel, ms = 3000) =>
  page.evaluate(
    ({ sel, ms }) =>
      new Promise((resolve) => {
        const el = document.querySelector(sel);
        const end = performance.now() + ms;
        let last = NaN;
        let still = 0;
        const step = () => {
          const left = el.scrollLeft;
          still = left === last && el.style.transform === "" ? still + 1 : 0;
          last = left;
          if (still >= 4 || performance.now() >= end) resolve({ left, rested: still >= 4, transform: el.style.transform });
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    { sel, ms },
  );

const listTop = (page) => page.evaluate(() => Math.round(document.querySelector("[data-row-count]").scrollTop));
const railLeft = (page, scope) =>
  page.evaluate((sel) => Math.round(document.querySelector(`${sel} [data-rail-scroller]`).scrollLeft), scope);

/**
 * Scroll the list `steps` frames by `by` px each, reading every frame the filters on the
 * strip's chips, their words, their frost and their liquid sheen (`::after`): what a motion blur would change.
 * Reports each distinct reading, so a crisp strip answers with exactly one.
 */
const flingList = (page, by, steps, scope = "[data-list-chrome]") =>
  page.evaluate(
    ({ by, steps, scope }) =>
      new Promise((resolve) => {
        const list = document.querySelector("[data-row-count]");
        const rail = document.querySelector(`${scope} [data-rail-scroller]`);
        const read = () =>
          JSON.stringify([...rail.querySelectorAll("[data-rail-item]")].slice(0, 4).map((item) => {
            const chip = item.matches("button") ? item : item.querySelector("button");
            const word = chip?.firstElementChild;
            const s = chip ? getComputedStyle(chip) : null;
            const before = chip ? getComputedStyle(item, "::after") : null;
            return [s?.filter, s?.backdropFilter, before?.backdropFilter, before?.filter, word ? getComputedStyle(word).filter : null, rail.getAttribute("style")];
          }));
        const seen = new Set([read()]);
        const start = list.scrollTop;
        let n = 0;
        const step = () => {
          list.scrollTop += by;
          n += 1;
          seen.add(read());
          if (n < steps) requestAnimationFrame(step);
          else resolve({ readings: [...seen], moved: Math.abs(list.scrollTop - start) });
        };
        requestAnimationFrame(step);
      }),
    { by, steps, scope },
  );

/**
 * Sample a chip's shape every frame for `ms`: its corner radius against half its height,
 * any transform, the sheen layer's clip and the tap highlight. Started before a press and
 * awaited after the release, so it covers press, hold and release.
 */
const sampleShape = (page, sel, ms) =>
  page.evaluate(
    ({ sel, ms }) =>
      new Promise((resolve) => {
        const el = document.querySelector(sel);
        const end = performance.now() + ms;
        const bad = [];
        let frames = 0;
        let pressedSeen = false;
        const step = () => {
          frames += 1;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const radius = parseFloat(cs.borderTopLeftRadius) || 0;
          const before = getComputedStyle(el, "::after").clipPath;
          pressedSeen ||= el.matches(":active, :has(:active)");
          const pill = radius >= r.height / 2 - 0.5;
          const flat = cs.transform === "none";
          const clipOk = before === "none" || /round/.test(before);
          const highlight = cs.webkitTapHighlightColor;
          const noHighlight = !highlight || /rgba\(0, 0, 0, 0\)|transparent/.test(highlight);
          if (!(pill && flat && clipOk && noHighlight) && bad.length < 3) bad.push({ radius, h: r.height, transform: cs.transform, before, highlight });
          if (performance.now() < end) requestAnimationFrame(step);
          else resolve({ frames, bad, pressedSeen });
        };
        requestAnimationFrame(step);
      }),
    { sel, ms },
  );

/** Hold a press on `sel`'s centre for `holdMs` (mouse or touch) while sampling its shape. */
async function heldPressShape(page, sel, { touch = false, holdMs = 900, cdp = null } = {}) {
  const box = await page.locator(sel).first().boundingBox();
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const sampling = sampleShape(page, sel, holdMs + 400);
  await page.waitForTimeout(50);
  if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  else {
    await page.mouse.move(x, y);
    await page.mouse.down();
  }
  await page.waitForTimeout(holdMs);
  if (touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  else await page.mouse.up();
  return sampling;
}

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
    // Each glide must land exactly on its target: a browser that snaps scrollLeft down to
    // whole pixels once left it a pixel short, still running, every time.
    const gapStart = await railLeft(p, scope);
    await p.mouse.move(gap.x, gap.y);
    await p.mouse.wheel(0, 300);
    await railRest(p, rail);
    const afterGap = { list: await listTop(p), rail: await railLeft(p, scope) };
    check("a wheel in a gap scrolls the strip sideways, the whole notch, and never the list", afterGap.list === 0 && afterGap.rail - gapStart === 300, JSON.stringify({ gapStart, ...afterGap }));

    // Over a chip, the same.
    const chip = await p.locator(`${rail} > [data-rail-item]`).nth(3).boundingBox();
    await p.mouse.move(chip.x + chip.width / 2, chip.y + chip.height / 2);
    await p.mouse.wheel(0, 200);
    await railRest(p, rail);
    const afterChip = { list: await listTop(p), rail: await railLeft(p, scope) };
    check("and over a chip", afterChip.list === 0 && afterChip.rail - afterGap.rail === 200, JSON.stringify({ afterGap, afterChip }));

    // Smoothed: one notch arrives over several frames rather than in one jump, and lands on
    // its target without passing it. Measured from where the strip starts (with room to
    // travel the whole notch), and only once the earlier glides have stopped.
    const NOTCH = 240;
    const glideStart = await p.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.scrollLeft = 200;
      return { start: el.scrollLeft, room: el.scrollWidth - el.clientWidth - el.scrollLeft };
    }, rail);
    const glideRest = await railRest(p, rail);
    // Every position the strip passes through, read once a frame: the first step is the
    // glide's first frame however slowly frames come, so one long frame cannot hide it.
    await p.evaluate((sel) => {
      const el = document.querySelector(sel);
      const path = [];
      let frame = 0;
      const tick = () => {
        if (el.scrollLeft !== (path.at(-1) ?? el.scrollLeft - 1)) path.push(el.scrollLeft);
        frame = requestAnimationFrame(tick);
      };
      tick();
      window.__railGlide = { path, stop: () => cancelAnimationFrame(frame) };
    }, rail);
    await p.mouse.wheel(0, NOTCH);
    const glideEnd = await railRest(p, rail);
    const glidePath = await p.evaluate(() => {
      const probe = window.__railGlide;
      probe.stop();
      delete window.__railGlide;
      return probe.path;
    });
    const steps = glidePath.map((x) => Math.round(x - glideRest.left)).slice(1);
    const early = steps[0] ?? 0;
    const late = Math.round(glideEnd.left - glideRest.left);
    const furthest = Math.max(0, ...steps);
    check(
      "a wheel notch glides: part of the way after a frame, all of it (and no further) after",
      glideStart.room >= NOTCH && glideRest.rested && glideRest.left === glideStart.start && early > 0 && early < NOTCH - 2 && late === NOTCH && furthest <= NOTCH,
      JSON.stringify({ ...glideStart, rest: glideRest.left, steps, late, settled: glideEnd.rested }),
    );

    // Moved by something else mid-glide (focus, a scrollbar, code), the strip stays where it
    // was put: the glide lets go instead of pulling it back to its old target.
    await p.mouse.wheel(0, NOTCH);
    await frames(p, 1);
    const yielded = await p.evaluate((sel) => {
      const el = document.querySelector(sel);
      const inFlight = el.scrollLeft;
      el.scrollLeft = 100;
      return { inFlight, put: el.scrollLeft };
    }, rail);
    const yieldEnd = await railRest(p, rail);
    check("moved mid-glide, the strip stays where it was put", yieldEnd.rested && yieldEnd.left === yielded.put, JSON.stringify({ ...yielded, after: yieldEnd.left }));

    // Rubber band at the start: pulled past, it shows a little and springs back. The pull is
    // recorded as it happens (every style write, plus each frame), so a slow frame between
    // the wheel and a sample cannot hide it.
    await p.evaluate((sel) => (document.querySelector(sel).scrollLeft = 0), rail);
    const bandRest = await railRest(p, rail);
    await p.evaluate((sel) => {
      const el = document.querySelector(sel);
      const probe = { max: 0, writes: 0, stop: null };
      const read = () => {
        const x = Number(/translate3d\(([-\d.]+)px/.exec(el.style.transform)?.[1] ?? 0);
        probe.max = Math.max(probe.max, x);
      };
      const observer = new MutationObserver(() => {
        probe.writes += 1;
        read();
      });
      observer.observe(el, { attributes: true, attributeFilter: ["style"] });
      let frame = 0;
      const tick = () => {
        read();
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      probe.stop = () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      };
      window.__railBand = probe;
    }, rail);
    await p.mouse.wheel(0, -200);
    const bandEnd = await railRest(p, rail);
    const band = await p.evaluate((sel) => {
      const probe = window.__railBand;
      probe.stop();
      delete window.__railBand;
      return { pulled: probe.max, writes: probe.writes, relaxed: document.querySelector(sel).style.transform, left: document.querySelector(sel).scrollLeft };
    }, rail);
    check(
      "past the start it gives a little (under 56px) and springs back",
      bandRest.left === 0 && band.pulled > 0 && band.pulled < 56 && band.relaxed === "" && bandEnd.rested && band.left === 0,
      JSON.stringify({ from: bandRest.left, ...band }),
    );
    check("and the list never moved", (await listTop(p)) === 0);

    // A scroll gesture in a gap does not reach the list either.
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(gap.x), y: Math.round(gap.y), yDistance: -300, gestureSourceType: "mouse", speed: 2000 });
    await settle(p, 300);
    check("a scroll gesture in a gap does not scroll the list", (await listTop(p)) === 0, `${await listTop(p)}px`);

    // ── No motion blur while the list scrolls (1.3.3: it read as smearing). The chips,
    //    their words and their frost keep one filter reading through a fast fling.
    section("filter strip: crisp while the list scrolls (no motion blur)");
    const restFilter = await p.evaluate((sel) => getComputedStyle(document.querySelector(`${sel} [data-rail-item] button > *`)).filter, rail);
    check("at rest the chips' words are crisp: no filter at all", restFilter === "none", restFilter);
    // Big steps: a headless page on a busy machine can draw ten frames a second.
    const fling = await flingList(p, 180, 10);
    check(
      "a fast list fling changes no filter or backdrop-filter on the chips (one reading)",
      fling.moved > 0 && fling.readings.length === 1 && !/blur\(0\.\d|data-rail-moving/.test(fling.readings[0]),
      `moved ${fling.moved}px, ${fling.readings.length} readings: ${fling.readings.join(" | ").slice(0, 400)}`,
    );
    const moving = await p.evaluate((sel) => document.querySelector(sel).hasAttribute("data-rail-moving"), rail);
    check("the strip never marks itself moving", moving === false);
    await settle(p, 300);

    // ── A held press keeps every chip a pill (1.3.3: they went square for a moment).
    section("filter strip: a held press keeps the chip a pill");
    await p.evaluate(() => (document.querySelector("[data-row-count]").scrollTop = 0));
    // The strip back at its start: the glide checks above left it scrolled, with the first
    // chip under the leading mark, where a press at its centre lands on something else.
    await p.evaluate((sel) => (document.querySelector(sel).scrollLeft = 0), rail);
    await settle(p, 300);
    {
      const chipSel = `${rail} > [data-rail-item].wn-pill`;
      const held = await heldPressShape(p, chipSel);
      check(
        "desktop: pressing and holding a chip with the mouse never changes its radius, transform or frost clip",
        held.frames > 5 && held.bad.length === 0 && held.pressedSeen,
        JSON.stringify(held),
      );
      await p.keyboard.press("Escape");
      // Undo the toggle the click made.
      await p.locator(chipSel).first().locator("button").first().click();
      await settle(p, 300);
    }

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

    // ── The sidebar shortcut, and its focus outline.
    section("sidebar shortcut and focus");
    await p.locator("[data-row-count]").click({ position: { x: 5, y: 400 } }).catch(() => undefined);
    await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await p.keyboard.press("[");
    await p.locator("[data-sidebar][data-open]").waitFor({ timeout: 5_000 });
    await settle(p, 300);
    const keyOpen = await p.evaluate(() => document.querySelector("[data-sidebar]").contains(document.activeElement));
    check("[ opens the sidebar, focus inside it", keyOpen);
    await p.keyboard.press("Tab");
    const ring = await p.evaluate(() => {
      const el = document.activeElement;
      const s = getComputedStyle(el);
      return { inside: Boolean(el.closest("[data-sidebar]")), style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, shadow: s.boxShadow, visible: el.matches(":focus-visible") };
    });
    check(
      "keyboard focus in the sidebar is a 2px outline drawn inside the button, not a ring shadow",
      ring.inside && ring.visible && ring.style === "solid" && ring.width === "2px" && ring.offset === "-2px" && ring.shadow === "none",
      JSON.stringify(ring),
    );
    await p.keyboard.press("[");
    await settle(p, 300);
    check("[ again closes it", (await p.locator("[data-sidebar][data-open]").count()) === 0);
    await p.locator("#winnow-search").focus();
    await p.keyboard.press("[");
    await settle(p, 200);
    check(
      "typing [ in search types it, and leaves the sidebar shut",
      (await p.locator("[data-sidebar][data-open]").count()) === 0 && (await p.locator("#winnow-search").inputValue()).includes("["),
    );
    await p.locator("#winnow-search").fill("");
    await p.keyboard.press("Escape");
    const hint = await p.locator("header [data-sidebar-toggle]").getAttribute("title");
    check("the toggle's tooltip names the key", hint === "Sidebar ([)", String(hint));
    await p.keyboard.press("?");
    await settle(p, 200);
    check("and the shortcut sheet lists it", /Open or close the sidebar/.test(await p.locator('[role="dialog"]').last().innerText()));
    await p.keyboard.press("Escape");
    await settle(p, 200);

    // ── Settings' category column.
    section("settings: the category column");
    for (const [width, layout, expected] of [
      [1440, "three", 216],
      [1000, "two", 212],
      [2200, "three", 248],
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
    for (const scheme of ["light", "dark"]) {
      await p.emulateMedia({ colorScheme: scheme });
      await settle(p, 200);
      const phoneFling = await flingList(p, 160, 10, scope);
      check(
        `phone (${scheme}): a fast list fling leaves the chips crisp (one filter reading, no blur)`,
        phoneFling.moved > 0 && phoneFling.readings.length === 1,
        `moved ${phoneFling.moved}px, ${phoneFling.readings.length} readings`,
      );
      await p.evaluate(() => (document.querySelector("[data-row-count]").scrollTop = 0));
      await settle(p, 300);
    }
    await p.emulateMedia({ colorScheme: "light" });
    for (const appearance of ["light", "dark", "oled"]) {
      await p.evaluate((appearance) => {
        const raw = localStorage.getItem("winnow.preferences.v1");
        localStorage.setItem("winnow.preferences.v1", JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), appearance }));
      }, appearance);
      await p.reload({ waitUntil: "networkidle" });
      await p.waitForSelector("[data-row-count] [data-row-id]");
      await settle(p, 300);
      const touchCdp = await ctx.newCDPSession(p);
      const chipSel = `${scope} [data-rail-scroller] > [data-rail-item].wn-pill`;
      const held = await heldPressShape(p, chipSel, { touch: true, holdMs: 1000, cdp: touchCdp });
      check(
        `phone (${appearance}): a long press on a chip keeps it a pill (radius, no transform, no tap highlight)`,
        held.frames > 5 && held.bad.length === 0,
        JSON.stringify(held),
      );
      await p.keyboard.press("Escape");
      await settle(p, 300);
    }
    await p.evaluate(() => {
      const raw = localStorage.getItem("winnow.preferences.v1");
      localStorage.setItem("winnow.preferences.v1", JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), appearance: "light" }));
    });
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    await settle(p, 300);
    await p.touchscreen.tap(gap.x, gap.y);
    await settle(p, 300);
    check("a tap in a gap opens nothing under it", (await p.locator("article h1").count()) === 0);
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(gap.x), y: Math.round(gap.y), yDistance: -320, gestureSourceType: "touch", speed: 1200 });
    await settle(p, 400);
    check("a vertical swipe starting in a gap does not scroll the list", (await listTop(p)) === 0, `${await listTop(p)}px`);
    // A chip whose middle is on screen: the tap in the gap above leaves the strip scrolled
    // (a pill's width decides how far), so a fixed index can sit off the left edge.
    const chip = await p.evaluate((sel) => {
      const r = [...document.querySelectorAll(`${sel} [data-rail-scroller] > [data-rail-item][data-rail-key]`)]
        .map((el) => el.getBoundingClientRect())
        .find((b) => b.width > 0 && b.left + b.width / 2 > 8 && b.left + b.width / 2 < innerWidth - 8);
      return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
    }, scope);
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
      before: getComputedStyle(document.querySelector("[data-phone-pill]"), "::after").content,
      inbox: document.querySelector('[data-sidebar] button[data-nav="inbox"]')?.getBoundingClientRect().height ?? 0,
    }));
    check("with the menu open, the pill's frost and sheen no longer cover the Inbox row", pill.before === "none" && pill.inbox >= 44, JSON.stringify(pill));

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
  // WINNOW_CPU_THROTTLE=4 slows every page's CPU that many times (as a busy CI runner).
  const throttle = Number(process.env.WINNOW_CPU_THROTTLE ?? 1);
  if (throttle > 1) {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const ctx = await newContext(...args);
      const newPage = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const page = await newPage();
        await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle });
        return page;
      };
      return ctx;
    };
    console.log(`CPU throttled ${throttle}x`);
  }
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
