/**
 * Smoke checks for the top email under the floating chrome, against the demo mailbox.
 *
 * The desktop's header (the glass bar and the smart-filter chips) and the phone's top bar
 * float over the list. The first day header and the first row must always start below
 * them, with a small gap: at rest, after the Top pill or Home, after `j`/`k` back to the
 * first message, in a smart-filter view, a search and another mailbox, and when the chrome's
 * height changes. Desktop 1440x900 and phone 390x844, light and dark.
 *
 * Its own module so it can run alone (`node scripts/smoke-top-email.mjs`, which serves
 * `dist/` itself on `WINNOW_PORT`, default 4322) as well as inside `smoke.mjs`.
 * `WINNOW_SHOTS=<dir>` saves a screenshot of each layout at rest when run alone.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The first day and row against the chrome's bottom edge, and the scroller's state. */
const GEOMETRY = () => {
  const scroller = document.querySelector("[data-row-count]");
  const parts = [
    "[data-list-chrome]",
    "[data-phone-chrome]",
    "[data-masthead-bar]",
    "[data-masthead-rail] [data-rail-item]",
    "[data-phone-topbar]",
  ].flatMap((sel) => [...document.querySelectorAll(sel)]);
  const chromeBottom = Math.max(
    0,
    ...parts.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => r.bottom),
  );
  if (!scroller) return { missing: true, chromeBottom: Math.round(chromeBottom) };
  const header = scroller.querySelector("[data-item-key]:not([data-row-id])");
  const row = scroller.querySelector("[data-row-id]");
  const h = header?.getBoundingClientRect() ?? null;
  const r = row?.getBoundingClientRect() ?? null;
  const box = scroller.getBoundingClientRect();
  return {
    scrollTop: Math.round(scroller.scrollTop),
    chromeBottom: Math.round(chromeBottom),
    chromeVar: parseFloat(getComputedStyle(scroller).getPropertyValue("--wn-top-chrome")) || 0,
    headerTop: h ? Math.round(h.top) : null,
    rowTop: r ? Math.round(r.top) : null,
    rowBottom: r ? Math.round(r.bottom) : null,
    viewBottom: Math.round(box.bottom),
  };
};

/** The first row (and day, when there is one) fully below the chrome with a gap of 2px+. */
function clears(g, gap = 2) {
  if (!g || g.missing || g.rowTop === null) return false;
  const headerOk = g.headerTop === null || g.headerTop >= g.chromeBottom + gap;
  return headerOk && g.rowTop >= g.chromeBottom + gap && g.rowBottom <= g.viewBottom;
}

export async function topEmail({ browser, url, check, section, shots = null }) {
  section("the top email clears the floating chrome");
  for (const [kind, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    const phone = kind === "phone";
    for (const mode of ["light", "dark"]) {
      const tag = `${kind} ${mode}`;
      const ctx = await browser.newContext({ viewport, hasTouch: phone });
      await ctx.addInitScript((m) => localStorage.setItem("winnow.preferences.v1", JSON.stringify({ appearance: m })), mode);
      const p = await ctx.newPage();
      const errors = [];
      p.on("pageerror", (error) => errors.push(String(error)));
      await p.goto(url, { waitUntil: "networkidle" });
      await p.waitForSelector("[data-row-count] [data-row-id]");
      await p.waitForTimeout(300);
      const geometry = () => p.evaluate(GEOMETRY);
      const scrollList = async (y) => {
        await p.evaluate((y) => (document.querySelector("[data-row-count]").scrollTop = y), y);
        await p.waitForTimeout(250);
      };
      /**
       * Wait for the list to settle: a (smooth) scroll finished and the chrome offset
       * unchanged across a few rendered frames.
       *
       * Counted in frames, not timer ticks. The offset follows the chrome through a
       * ResizeObserver, whose callbacks are only delivered in a frame's rendering steps, and
       * a smooth scroll only advances in frames too. Headless Chromium can go half a second
       * without painting a frame over the glass chrome, so timer polls across such a gap
       * read "unchanged" before the app has seen a change that moves no scroll offset (the
       * rail hidden) or while a scroll is paused mid-way. Each frame and the whole wait
       * are capped, so a page that never paints fails the check instead of hanging the run.
       */
      const settle = () =>
        p.evaluate(async () => {
          const scroller = () => document.querySelector("[data-row-count]");
          const frame = () =>
            new Promise((resolve) => {
              requestAnimationFrame(() => resolve());
              setTimeout(resolve, 2_000);
            });
          const read = () => {
            const el = scroller();
            return el ? `${el.scrollTop}|${getComputedStyle(el).getPropertyValue("--wn-top-chrome")}` : "";
          };
          const deadline = performance.now() + 6_000;
          await frame();
          let last = read();
          let still = 0;
          while (still < 6 && performance.now() < deadline) {
            await frame();
            const now = read();
            still = now === last ? still + 1 : 0;
            last = now;
          }
        });

      const rest = await geometry();
      check(
        `${tag}: at scroll 0 the first day and the first row sit fully below the chrome, with a gap`,
        rest.scrollTop === 0 && clears(rest) && rest.chromeVar >= rest.chromeBottom,
        JSON.stringify(rest),
      );
      if (shots) await p.screenshot({ path: path.join(shots, `${kind}-top-email-${mode}.png`) });

      // Back to the top: the phone's Top pill, the desktop's Home key.
      await scrollList(900);
      if (phone) {
        const pill = p.locator("[data-phone-dock] button[data-back-to-top]");
        await pill.click({ timeout: 3_000 }).catch(() => undefined);
      } else {
        await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await p.keyboard.press("Home");
      }
      await settle();
      const top = await geometry();
      check(
        `${tag}: ${phone ? "the Top pill" : "Home"} goes back to scroll 0 with the first row clear of the chrome`,
        top.scrollTop === 0 && clears(top),
        JSON.stringify(top),
      );

      // j/k to the first message. The desktop walks down from the fourth row, scrolls away
      // and walks back; the phone opens the first message with j from halfway down and
      // comes back to the list.
      if (phone) {
        await scrollList(900);
        await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await p.keyboard.press("j");
        await p.waitForTimeout(400);
        await p.keyboard.press("Escape");
        await settle();
      } else {
        await p.locator("[data-row-count] button[data-message-id]").nth(3).click();
        await p.waitForTimeout(250);
        await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await scrollList(2000);
        for (let i = 0; i < 5; i += 1) {
          await p.keyboard.press("k");
          await p.waitForTimeout(80);
        }
        await settle();
      }
      const first = await geometry();
      check(
        `${tag}: ${phone ? "j to the first message and Back" : "k back to the first message"} leaves the first row fully below the chrome`,
        clears(first),
        JSON.stringify(first),
      );
      if (!phone) {
        // And from there, k at the first message keeps it where it is.
        await p.keyboard.press("ArrowUp");
        await p.waitForTimeout(200);
        check(`${tag}: and ↑ at the first message keeps it clear`, clears(await geometry()));
        await p.keyboard.press("Escape");
        await p.waitForTimeout(200);
      }

      // A new view starts at its top: a smart filter switched on from halfway down.
      await scrollList(900);
      await p.locator("[data-rail-key]", { hasText: "Important" }).first().click();
      await settle();
      const filtered = await geometry();
      check(`${tag}: a smart filter switched on from halfway down opens at its top email`, filtered.scrollTop === 0 && clears(filtered), JSON.stringify(filtered));
      await p.locator("[data-rail-key]", { hasText: "Important" }).first().click();
      await p.waitForTimeout(250);

      if (mode === "light") {
        // A search typed from halfway down.
        await scrollList(900);
        const field = p.locator(phone ? "[data-phone-search] input" : "[data-masthead-bar] input").first();
        await field.fill("the");
        await settle();
        const searched = await geometry();
        check(`${tag}: search results start at their top email`, searched.scrollTop === 0 && clears(searched), JSON.stringify(searched));
        await field.fill("");
        await p.keyboard.press("Escape");
        await p.waitForTimeout(250);
      }

      if (!phone && mode === "light") {
        // Another mailbox, and back, from halfway down.
        const browse = async (selector) => {
          await scrollList(900);
          await p.locator("[data-sidebar-toggle]:visible").first().click();
          const sidebar = p.locator("[data-sidebar][data-open]");
          await sidebar.waitFor({ timeout: 5_000 });
          await sidebar.locator(selector).first().click();
          await settle();
          return geometry();
        };
        const archive = await browse('[data-nav-folder="archive"]');
        check("desktop: another mailbox starts with its top email clear of the chrome", archive.scrollTop === 0 && clears(archive), JSON.stringify(archive));
        const inbox = await browse('[data-nav="inbox"]');
        check("desktop: and back to the Inbox, its top email is clear again", inbox.scrollTop === 0 && clears(inbox), JSON.stringify(inbox));

        // The chrome's height changes: the rail gone, then the window narrower. The offset
        // follows the measured chrome, not a fixed number.
        await p.addStyleTag({ content: "[data-masthead-rail]{display:none !important}" });
        await settle();
        const noRail = await geometry();
        check(
          "desktop: with the chip rail hidden the offset shrinks with the chrome, and the first row still clears it",
          clears(noRail) && noRail.chromeVar < rest.chromeVar && noRail.chromeVar >= noRail.chromeBottom,
          JSON.stringify({ rest: rest.chromeVar, noRail }),
        );
        await p.evaluate(() => document.querySelectorAll("style").forEach((s) => s.textContent?.includes("data-masthead-rail") && s.remove()));
        await p.setViewportSize({ width: 1100, height: 760 });
        await settle();
        const narrow = await geometry();
        check("desktop: after a resize the first row still clears the chrome", narrow.scrollTop === 0 && clears(narrow), JSON.stringify(narrow));
      }

      if (phone && mode === "light") {
        // A taller top bar (a safe-area inset, say) moves the list's start with it.
        await p.addStyleTag({ content: "[data-phone-topbar]{padding-top:44px !important}" });
        await settle();
        const inset = await geometry();
        check(
          "phone: a taller top bar (as with a safe-area inset) pushes the first row down with it",
          clears(inset) && inset.chromeVar > rest.chromeVar,
          JSON.stringify({ rest: rest.chromeVar, inset }),
        );
      }

      check(`${tag}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
      await ctx.close();
    }
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
  const port = Number(process.env.WINNOW_PORT ?? 4322);
  const server = await preview({ root, logLevel: "warn", preview: { port, strictPort: true, open: false } });
  const browser = await chromium.launch(
    process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM, args: ["--no-sandbox"] } : {},
  );
  let passed = 0;
  const failures = [];
  const check = (label, ok, detail = "") => {
    const line = `${label}${detail ? ` — ${detail}` : ""}`;
    if (ok) passed += 1;
    else failures.push(line);
    console.log(`${ok ? "  ok  " : " FAIL "} ${line}`);
    return ok;
  };
  const section = (title) => console.log(`\n── ${title}`);
  try {
    await topEmail({ browser, url: `http://localhost:${port}/`, check, section, shots: process.env.WINNOW_SHOTS ?? null });
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
