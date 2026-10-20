/**
 * Smoke checks for four fixes, against the real production build:
 *
 *   1. Settings on a phone covers the inbox to the bottom edge: an opaque backdrop, the
 *      mail not painted behind it, and no inbox pixel at the bottom at rest, scrolled to
 *      the end, or mid-entrance. The phone menu's last row (Inbox, on the dock pill's
 *      line) is fully visible and tappable, with no frost over it (the 1.3.0-beta bug).
 *   2. Undo beyond the swipes: desktop `e`/`#`, `z` and Ctrl+Z, the row menu, a
 *      multi-select batch ("Moved 3 to Trash.", Undo takes back all three), and the
 *      reader's action bar on desktop and phone.
 *   3. The status pill after the mail view mounts again (sign out → demo, the Android
 *      app's IPC stand-in, OLED): under the top bar, never over it, with its glass.
 *   4. The demo's "Back to your inbox" when a session is stored, Connect Gmail when not,
 *      and "Sign in again" with the reason when the stored session has expired.
 *
 * Own module, so it runs alone too: `WINNOW_SMOKE_ONLY=fixes npm run smoke`.
 */
import { signedInContext } from "./fake-gmail.mjs";

/** Count pixels in the bottom `band` px that differ from `ref`, outside `skip` boxes. */
async function strayPixels(browser, png, { band, skip = [], tolerance = 8, refAt }) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ data, band, skip, tolerance, refAt }) => {
        const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const g = canvas.getContext("2d");
        g.drawImage(bitmap, 0, 0);
        const { width, height } = bitmap;
        const pixels = g.getImageData(0, 0, width, height).data;
        const at = (x, y) => {
          const i = (y * width + x) * 4;
          return [pixels[i], pixels[i + 1], pixels[i + 2]];
        };
        const ref = at(refAt[0], refAt[1]);
        let stray = 0;
        let first = null;
        for (let y = height - band; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (skip.some(([l, t, r, b]) => x >= l && x <= r && y >= t && y <= b)) continue;
            const p = at(x, y);
            if (Math.max(Math.abs(p[0] - ref[0]), Math.abs(p[1] - ref[1]), Math.abs(p[2] - ref[2])) > tolerance) {
              stray += 1;
              first ??= [x, y, p];
            }
          }
        }
        return { stray, first, ref };
      },
      { data: png.toString("base64"), band, skip, tolerance, refAt },
    );
  } finally {
    await page.close();
  }
}

/** The dock's visible controls, padded for their shadow, as [l, t, r, b]. */
async function dockBoxes(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-phone-dock] [data-phone-pill], [data-phone-dock] button")]
      .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden")
      .map((element) => {
        const r = element.getBoundingClientRect();
        return [Math.floor(r.left - 16), Math.floor(r.top - 16), Math.ceil(r.right + 16), Math.ceil(r.bottom + 24)];
      }),
  );
}

async function openPhoneSettings(page) {
  await page.locator("[data-phone-dock] button[data-dock-expand]").tap();
  await page.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForTimeout(350);
  await page.locator('[data-sidebar] [data-nav-account] button[aria-label="Settings"]').tap();
  await page.locator('[role="dialog"][aria-label="Settings"]').waitFor({ timeout: 5_000 });
}

/** One finger from (x, y) by dx, the way the swipe smoke drags a row. */
async function swipeRow(page, cdp, locator, dx = -240) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2 + 60;
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 12; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 12, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(700);
}

/**
 * The stand-in for the Android app's Tauri IPC (as in `smoke-android.mjs`), with a
 * session already in its keychain so the app signs in by itself at launch.
 */
function fakeAndroidSignedIn() {
  let nextId = 1;
  const secrets = new Map([
    ["google.oauth-client", JSON.stringify({ clientId: "1234567890-abc123def.apps.googleusercontent.com" })],
    ["gmail.tokens", JSON.stringify({ accessToken: "fake-android-access", refreshToken: "1//r", expiresAt: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/gmail.modify" })],
  ]);
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(callback) {
      const id = nextId++;
      window[`_${id}`] = callback;
      return id;
    },
    unregisterCallback(id) {
      delete window[`_${id}`];
    },
    convertFileSrc: (file) => file,
    async invoke(cmd, args) {
      switch (cmd) {
        case "app_info":
          return { name: "Winnow", version: "1.3.0", os: "android", arch: "aarch64", kind: "desktop", nativeOAuth: true, nativeSecrets: true, backgroundSync: false, saveFiles: true };
        case "secrets_get":
          return secrets.get(args.name) ?? null;
        case "secrets_set":
          secrets.set(args.name, args.value);
          return null;
        case "secrets_delete":
          secrets.delete(args.name);
          return null;
        case "google_signin_info":
          return { packageName: "app.winnow.android", sha1: null, playServices: true };
        case "notify_kept_replies":
          // The real command answers a list; null would be a reply the app never gets.
          return [];
        case "plugin:event|listen":
          return nextId++;
        default:
          return null;
      }
    },
  };
}

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";

export async function smokeFixes({ browser, URL, check, section, errors, shots = null }) {
  if (process.env.WINNOW_FIXES_FROM === "demo") return demoChecks({ browser, URL, check, section, errors });
  // ── 1. Settings covers the inbox; the menu's last row is clear ─────────────
  section("phone settings cover the inbox to the bottom edge");
  for (const [width, height, scheme] of [
    [390, 844, "light"],
    [360, 800, "dark"],
  ]) {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, colorScheme: scheme });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    const cdp = await ctx.newCDPSession(p);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 40, bottom: 28 } }).catch(() => undefined);
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    const tag = `${width}x${height} ${scheme}`;

    // Mid-entrance: the panel rises in from transparent, slowed twentyfold.
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.05 });
    await p.locator("[data-phone-dock] button[data-dock-expand]").tap();
    await p.waitForTimeout(50);
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    await p.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    await p.waitForTimeout(400);
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.05 });
    await p.locator('[data-sidebar] [data-nav-account] button[aria-label="Settings"]').tap({ noWaitAfter: true });
    await p.waitForTimeout(120);
    const shape = await p.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Settings"]');
      const backdrop = dialog?.parentElement;
      const main = document.querySelector("main");
      const bg = backdrop ? getComputedStyle(backdrop).backgroundColor : "";
      return {
        opaque: backdrop?.getAttribute("data-backdrop") === "opaque" && !/rgba\(.*, 0(\.\d+)?\)$/.test(bg) && !/\/ 0(\.\d+)?\)$/.test(bg),
        covered: main?.hasAttribute("data-covered") === true && getComputedStyle(main).visibility === "hidden",
        opacity: dialog ? Number(getComputedStyle(dialog).opacity) : 1,
        bg,
      };
    });
    // The menu panel is still folding back into the pill (its own motion, over Settings):
    // its box is left out, the rest of the bottom must be Settings' chrome.
    const folding = await p.evaluate(() => {
      const r = document.querySelector("[data-sidebar]")?.getBoundingClientRect();
      return r && r.height > 0 ? [[Math.floor(r.left - 24), Math.floor(r.top - 24), Math.ceil(r.right + 24), Math.ceil(r.bottom + 32)]] : [];
    });
    const entering = await strayPixels(browser, await p.screenshot(), { band: 160, skip: [...(await dockBoxes(p)), ...folding], refAt: [4, 4] });
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    check(
      `${tag}: Settings' backdrop is opaque chrome and the mail behind it is not painted`,
      shape.opaque && shape.covered,
      JSON.stringify(shape),
    );
    check(
      `${tag}: mid-entrance (panel at ${shape.opacity.toFixed(2)} opacity) nothing of the inbox shows at the bottom`,
      shape.opacity < 0.95 && entering.stray === 0,
      JSON.stringify(entering),
    );
    await p.waitForTimeout(500);
    const rest = await strayPixels(browser, await p.screenshot(), { band: 160, skip: await dockBoxes(p), refAt: [4, height - 4] });
    const hits = await p.evaluate(() => {
      const strays = [];
      for (let y = innerHeight - 1; y > innerHeight - 160; y -= 4) {
        for (let x = 2; x < innerWidth; x += 8) {
          const top = document.elementFromPoint(x, y);
          if (!top || !(top.closest('[role="dialog"]') || top.closest("[data-phone-dock]"))) strays.push([x, y, top?.tagName ?? "none"]);
        }
      }
      return strays.length;
    });
    check(`${tag}: at rest nothing but Settings and the dock is at the bottom edge`, rest.stray === 0 && hits === 0, JSON.stringify({ rest, hits }));
    if (shots && scheme === "light") await p.screenshot({ path: `${shots}/after-settings-bottom-${width}x${height}-${scheme}.png`, clip: { x: 0, y: height - 260, width, height: 260 } });
    await p.locator('[role="dialog"] button[data-category="appearance"]').tap();
    await p.waitForTimeout(200);
    await p.evaluate(() => {
      const body = document.querySelector("[data-settings-body]");
      body.scrollTop = body.scrollHeight;
    });
    await p.waitForTimeout(150);
    const end = await strayPixels(browser, await p.screenshot(), { band: 160, skip: await dockBoxes(p), refAt: [4, height - 4] });
    check(`${tag}: scrolled to the end of a category, still nothing of the inbox below`, end.stray === 0, JSON.stringify(end));
    await p.locator('[data-phone-dock] button[data-dock-tab="inbox"]').tap();
    await p.waitForTimeout(250);
    check(
      `${tag}: leaving Settings paints the mail again, at its scroll position`,
      (await p.evaluate(() => getComputedStyle(document.querySelector("main")).visibility)) === "visible" &&
        (await p.locator("main[data-covered]").count()) === 0,
    );
    await ctx.close();
  }

  section("phone menu: the last row is clear of the dock");
  for (const [width, height] of [
    [390, 844],
    [360, 640],
  ]) {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, colorScheme: "dark", deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    await p.locator("[data-phone-dock] button[data-dock-expand]").tap();
    await p.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    await p.waitForTimeout(500);
    // Scrolled to its end, should the menu ever overflow.
    await p.evaluate(() => {
      for (const element of document.querySelectorAll("[data-sidebar], [data-sidebar] *")) {
        if (element.scrollHeight > element.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(element).overflowY)) element.scrollTop = element.scrollHeight;
      }
    });
    await p.waitForTimeout(150);
    const rows = await p.evaluate(() => {
      const all = [...document.querySelectorAll("[data-sidebar] button[data-nav], [data-sidebar] button[data-nav-folder]")];
      const last = all.at(-1);
      const sent = document.querySelector('[data-sidebar] button[data-nav-folder="sent"]');
      const panel = document.querySelector("[data-sidebar]").getBoundingClientRect();
      const pill = document.querySelector("[data-phone-pill]");
      const box = last.getBoundingClientRect();
      const points = [
        [box.left + 10, box.top + 4],
        [box.left + 10, box.bottom - 4],
        [box.left + box.width / 2, box.top + box.height / 2],
        [box.right - 10, box.top + box.height / 2],
      ];
      const label = (row) => {
        const r = (row.querySelector("span") ?? row).getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom];
      };
      return {
        order: all.map((row) => row.getAttribute("data-nav") ?? row.getAttribute("data-nav-folder")),
        last: last.getAttribute("data-nav") ?? last.getAttribute("data-nav-folder"),
        inside: box.top >= panel.top && box.bottom <= panel.bottom + 0.5 && box.bottom <= innerHeight,
        tappable: points.every(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return hit === last || last.contains(hit);
        }),
        noFrost:
          getComputedStyle(pill).backdropFilter === "none" &&
          getComputedStyle(pill, "::after").content === "none" &&
          /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(pill).backgroundColor),
        lastLabel: label(last),
        sentLabel: label(sent),
      };
    });
    // The label's contrast, read from the screen, against the row above it: frost over
    // the row (what 1.3.0-beta drew) blurs the word to a smudge, which no hit test sees.
    const png = await p.screenshot();
    const contrast = await (async () => {
      const page = await browser.newPage();
      try {
        return await page.evaluate(
          async ({ data, boxes }) => {
            const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const g = canvas.getContext("2d");
            g.drawImage(bitmap, 0, 0);
            return boxes.map(([l, t, r, b]) => {
              const s = 2;
              const d = g.getImageData(Math.round(l * s), Math.round(t * s), Math.max(1, Math.round((r - l) * s)), Math.max(1, Math.round((b - t) * s))).data;
              let lo = 255;
              let hi = 0;
              for (let i = 0; i < d.length; i += 4) {
                const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
                lo = Math.min(lo, y);
                hi = Math.max(hi, y);
              }
              return Math.round(hi - lo);
            });
          },
          { data: png.toString("base64"), boxes: [rows.lastLabel, rows.sentLabel] },
        );
      } finally {
        await page.close();
      }
    })();
    check(
      `${width}x${height}: the menu ends with Inbox nearest the thumb (the owner's reversed order), fully on screen and tappable at its edges`,
      rows.last === "inbox" && rows.order[0] === "spam" && rows.inside && rows.tappable,
      JSON.stringify({ order: rows.order, inside: rows.inside, tappable: rows.tappable }),
    );
    check(
      `${width}x${height}: no frost over it: the pill under it is see-through and its label is as crisp as Sent's`,
      rows.noFrost && contrast[0] >= contrast[1] * 0.8,
      JSON.stringify({ noFrost: rows.noFrost, contrast }),
    );
    if (shots && width === 390) await p.screenshot({ path: `${shots}/drawer-after-${width}x${height}.png` });
    await ctx.close();
  }

  // ── 2. Undo beyond the swipes ───────────────────────────────────────────────
  section("undo for desktop, batch and reader actions");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const d = await ctx.newPage();
    d.on("pageerror", (error) => errors.push(String(error)));
    await d.goto(URL, { waitUntil: "networkidle" });
    await d.waitForSelector("[data-row-count] [data-row-id]");
    const rowCount = async () => Number(await d.locator("[data-row-count]").getAttribute("data-row-count"));
    const label = async () => ((await d.locator("[data-status-pill='undo'] [data-undo-label]").textContent({ timeout: 1_500 }).catch(() => null)) ?? null);
    const firstId = () => d.locator("[data-row-count] [data-row-id]").first().getAttribute("data-row-id");
    let id;
    const has = async (id) => (await d.locator(`[data-row-count] [data-row-id="${id}"]`).count()) === 1;

    const ids = () => d.locator("[data-row-count] [data-row-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-row-id")));
    /** Press keys and report which row left the list. */
    const gone = async (keys) => {
      const before = await ids();
      for (const key of keys) {
        await d.keyboard.press(key);
        await d.waitForTimeout(120);
      }
      await d.waitForTimeout(350);
      const after = new Set(await ids());
      return before.filter((one) => !after.has(one));
    };

    await d.locator("body").click({ position: { x: 700, y: 5 } }).catch(() => undefined);
    let left = await gone(["j", "e"]);
    check("e archives with Undo in the status pill: \"Archived.\"", left.length === 1 && (await label()) === "Archived.", `${left} "${await label()}"`);
    if (shots) {
      const pill = await d.locator("[data-status-pill='undo']").boundingBox();
      await d.screenshot({ path: `${shots}/after-desktop-undo-pill.png`, clip: { x: Math.max(0, pill.x - 40), y: Math.max(0, pill.y - 90), width: Math.min(1440, pill.width + 80), height: 200 } });
    }
    await d.keyboard.press("z");
    await d.waitForTimeout(350);
    check("z takes it back", left.length === 1 && (await has(left[0])) && (await d.locator("[data-status-pill='undo']").count()) === 0);

    left = await gone(["#"]);
    check("# moves to Trash with Undo: \"Moved to Trash.\"", left.length === 1 && (await label()) === "Moved to Trash.", `${left} "${await label()}"`);
    await d.keyboard.press("Control+z");
    await d.waitForTimeout(350);
    check("Ctrl+Z takes it back", left.length === 1 && (await has(left[0])));

    // Ctrl+Z inside the search field is the field's own.
    left = await gone(["#"]);
    await d.keyboard.press("/");
    await d.keyboard.type("abc");
    await d.keyboard.press("Control+z");
    await d.waitForTimeout(200);
    check("Ctrl+Z in the search field leaves the pill's Undo alone", left.length === 1 && (await label()) === "Moved to Trash.");
    await d.keyboard.press("Control+a");
    await d.keyboard.press("Backspace");
    await d.keyboard.press("Escape");
    await d.locator("[data-status-pill='undo'] [data-pill-undo]").click();
    await d.waitForTimeout(350);
    check("and the pill's own Undo button still works", left.length === 1 && (await has(left[0])));
    await d.keyboard.press("Escape");
    await d.waitForTimeout(250);

    // A batch: three rows by ctrl-click, then the selection bar's Trash.
    const before = await rowCount();
    const batch = (await ids()).slice(1, 4);
    for (const one of batch) await d.locator(`[data-row-count] [data-row-id="${one}"] button[data-message-id]`).first().click({ modifiers: ["Control"] });
    await d.waitForTimeout(150);
    const selected = Number(await d.locator("[data-selection-bar='desktop'] [data-selection-count]").getAttribute("data-selection-count").catch(() => "0"));
    await d.locator("[data-selection-bar='desktop'] button", { hasText: /^Delete$/ }).click();
    await d.waitForTimeout(500);
    check(
      "a batch of three goes to the Trash under one notice: \"Moved 3 to Trash.\"",
      selected === 3 && (await label()) === "Moved 3 to Trash." && (await rowCount()) <= before - 1,
      `${selected} selected, ${before} → ${await rowCount()}, "${await label()}"`,
    );
    await d.locator("[data-status-pill='undo'] [data-pill-undo]").click();
    await d.waitForTimeout(400);
    check("Undo brings the whole batch back", (await rowCount()) === before && (await Promise.all(batch.map(has))).every(Boolean), `${await rowCount()} of ${before}`);

    // The row menu.
    id = await firstId();
    await d.locator(`[data-row-count] [data-row-id="${id}"]`).click({ button: "right" });
    await d.locator("[data-menu-item='archive']").click();
    await d.waitForTimeout(450);
    check("the row menu's Archive offers Undo too", !(await has(id)) && (await label()) === "Archived.", String(await label()));
    await d.locator("[data-status-pill='undo'] [data-pill-dismiss]").click();
    await d.waitForTimeout(200);

    // The reader's action bar.
    id = await firstId();
    await d.locator(`[data-row-count] [data-row-id="${id}"] button[data-message-id]`).first().click();
    await d.locator("[data-reader]").waitFor({ timeout: 5_000 });
    await d.locator("[data-reader-actions] button[aria-label^='Move to trash']").first().click();
    await d.waitForTimeout(450);
    check("the reader's Trash offers Undo", !(await has(id)) && (await label()) === "Moved to Trash.", String(await label()));
    await d.locator("[data-status-pill='undo'] [data-pill-undo]").click();
    await d.waitForTimeout(350);
    check("and Undo puts it back", await has(id));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    const id = await p.locator("[data-row-count] [data-row-id]").nth(1).getAttribute("data-row-id");
    await p.locator(`[data-row-count] [data-row-id="${id}"] button[data-message-id]`).first().tap();
    await p.locator("[data-reader-dock]").waitFor({ timeout: 5_000 });
    await p.locator("[data-reader-dock] button[aria-label='Archive']").tap();
    await p.waitForTimeout(500);
    const text = await p.locator("[data-status-pill='undo'] [data-undo-label]").textContent({ timeout: 1_500 }).catch(() => null);
    check("on a phone the reader's Archive offers Undo", text === "Archived.", String(text));
    await p.locator("[data-status-pill='undo'] [data-pill-undo]").tap().catch(() => undefined);
    await p.waitForTimeout(400);
    check("and Undo puts it back in the list", (await p.locator(`[data-row-count] [data-row-id="${id}"]`).count()) === 1);
    await ctx.close();
  }

  // ── 3. The status pill after the mail view mounts again ────────────────────
  section("status pill after a remount, on the Android app");
  {
    const { ctx } = await signedInContext(
      browser,
      { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark", userAgent: ANDROID_UA },
      { seed: false },
    );
    await ctx.addInitScript(fakeAndroidSignedIn);
    await ctx.addInitScript(() => {
      if (!localStorage.getItem("seeded-oled")) {
        localStorage.setItem("seeded-oled", "1");
        const key = "winnow.preferences.v1";
        const prefs = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...prefs, appearance: "oled" }));
      }
    });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.locator("[data-message-id]", { hasText: "Fake mail 2" }).first().waitFor({ timeout: 15_000 });
    await p.waitForTimeout(500);
    // Sign out (the main view unmounts), then back into the demo (it mounts again).
    await p.locator("[data-phone-dock] button[data-dock-expand]").tap();
    await p.waitForTimeout(500);
    await p.locator('[data-sidebar] [data-nav-account] button[aria-haspopup="menu"]').tap();
    await p.waitForTimeout(300);
    await p.locator('[data-menu-item="sign-out"]').dispatchEvent("click");
    // On a phone Sign out asks first (an action sheet); confirm it.
    const confirmSignOut = p.locator('[data-action-sheet-item="confirm"]');
    await confirmSignOut.waitFor({ timeout: 3_000 });
    check("on a phone Sign out asks first", (await confirmSignOut.textContent())?.trim() === "Sign Out", await confirmSignOut.textContent());
    await confirmSignOut.tap();
    await p.getByRole("button", { name: /demo/i }).first().waitFor({ timeout: 8_000 });
    await p.getByRole("button", { name: /demo/i }).first().tap();
    await p.waitForSelector("[data-row-count] [data-row-id]");
    await p.waitForTimeout(500);
    const cdp = await ctx.newCDPSession(p);
    await swipeRow(p, cdp, p.locator("[data-row-count] [data-row-id]").nth(2));
    const pill = await p.evaluate(() => {
      const host = document.querySelector("[data-status-pill='undo']");
      const face = host?.querySelector(".wn-glass");
      const bar = document.querySelector("[data-phone-topbar]");
      if (!face || !bar) return null;
      const style = getComputedStyle(face);
      const alpha = (() => {
        const m = /\/\s*([\d.]+)\)$/.exec(style.backgroundColor) ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(style.backgroundColor);
        return m ? Number(m[1]) : 1;
      })();
      return {
        theme: document.documentElement.dataset.theme,
        top: Math.round(face.getBoundingClientRect().top),
        barBottom: Math.round(bar.getBoundingClientRect().bottom),
        alpha,
        frost: style.backdropFilter !== "none",
        edge: style.borderTopWidth !== "0px",
      };
    });
    check(
      "after sign-out → demo on the Android app (OLED), the pill floats under the top bar, not over it",
      pill !== null && pill.top >= pill.barBottom + 8,
      JSON.stringify(pill),
    );
    check("and it is the glass pill: a tinted, frosted face with an edge", pill !== null && pill.alpha > 0.3 && pill.frost && pill.edge, JSON.stringify(pill));
    if (shots) await p.screenshot({ path: `${shots}/pill-after-android-oled-remount.png`, clip: { x: 0, y: 0, width: 412, height: 220 } });
    await ctx.close();
  }

  await demoChecks({ browser, URL, check, section, errors });
}

async function demoChecks({ browser, URL, check, section, errors }) {
  // ── 4. The demo's way back to a stored session ──────────────────────────────
  section("demo: back to your inbox");
  for (const viewport of [
    { width: 1280, height: 860 },
    { width: 390, height: 844 },
  ]) {
    const phone = viewport.width < 640;
    const where = phone ? "phone" : "desktop";
    const { ctx, state } = await signedInContext(browser, { viewport, hasTouch: phone, isMobile: phone });
    let googleSignIns = 0;
    await ctx.route("https://accounts.google.com/**", (route) => {
      googleSignIns += 1;
      return route.fulfill({ status: 200, contentType: "text/html", body: "<p>Google sign-in</p>" });
    });
    state.down = true;
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "domcontentloaded" });
    await p.getByRole("button", { name: "Use the demo inbox" }).waitFor({ timeout: 20_000 });
    await p.getByRole("button", { name: "Use the demo inbox" }).click();
    await p.waitForSelector("[data-row-count] [data-row-id]");
    const cta = p.locator("[data-demo-cta]").first();
    await p.waitForFunction(() => document.querySelector("[data-demo-cta]")?.getAttribute("data-demo-cta") === "resume", null, { timeout: 5_000 }).catch(() => undefined);
    check(`${where}: in the demo with a stored session, the button says Back to your inbox`, ((await cta.textContent()) ?? "").includes("Back to your inbox"), String(await cta.textContent()));
    // The sidebar's account menu says the same.
    if (phone) {
      await p.locator("[data-phone-dock] button[data-dock-expand]").tap();
      await p.waitForTimeout(450);
      await p.locator('[data-sidebar] [data-nav-account] button[aria-haspopup="menu"]').tap();
    } else {
      await p.keyboard.press("[");
      await p.waitForTimeout(300);
      await p.locator('[data-sidebar] [data-nav-account] button[aria-haspopup="menu"]').click();
    }
    await p.waitForTimeout(250);
    const menuText = await p.locator('[data-menu-item="connect"]').textContent().catch(() => null);
    check(`${where}: and so does the sidebar's account menu`, (menuText ?? "").includes("Back to your inbox"), String(menuText));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(150);
    if ((await p.locator("[data-sidebar][data-open]").count()) > 0) {
      if (phone) await p.locator("[data-phone-dock] button[data-dock-expand]").tap();
      else await p.keyboard.press("Escape");
      await p.waitForTimeout(400);
    }
    // Gmail is reachable again, and nothing in the demo may notice by itself: no poll,
    // focus or online sync reaches for the stored session until the button is pressed.
    // That is what proves the inbox below came from the resume.
    state.down = false;
    const gmailCallsInDemo = state.gmailCalls;
    await p.evaluate(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await p.waitForTimeout(2_500);
    check(
      `${where}: left alone, the demo stays the demo and makes no Gmail call`,
      state.gmailCalls === gmailCallsInDemo &&
        (await p.locator("[data-message-id]", { hasText: "Fake mail" }).count()) === 0 &&
        (await cta.getAttribute("data-demo-cta")) === "resume",
      JSON.stringify({ before: gmailCallsInDemo, after: state.gmailCalls }),
    );
    const tokenCallsBefore = state.tokenCalls;
    const profileCallsBefore = state.profileCalls;
    await cta.click();
    await p.locator("[data-message-id]", { hasText: "Fake mail 1" }).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
    check(
      `${where}: pressing it opens the account's own inbox with no Google sign-in and no new tokens`,
      (await p.locator("[data-message-id]", { hasText: "Fake mail 1" }).count()) > 0 &&
        state.profileCalls > profileCallsBefore &&
        state.gmailCalls > gmailCallsInDemo &&
        googleSignIns === 0 &&
        state.tokenCalls === tokenCallsBefore &&
        (await p.locator("[data-demo-cta]").count()) === 0 &&
        // 1.4.0: the tokens are the active account's, `<key>@<id>` in the registry.
        (await p.evaluate(() => {
          const id = JSON.parse(localStorage.getItem("winnow.accounts.v1") ?? "null")?.active;
          return Boolean(id && localStorage.getItem(`winnow.gmail.tokens@${id}`));
        })),
      JSON.stringify({ googleSignIns, tokenCalls: state.tokenCalls, profileCalls: state.profileCalls }),
    );
    await ctx.close();
  }
  {
    // An expired session: the reason, then "Sign in again" (the normal sign-in).
    const { ctx, state } = await signedInContext(browser, { viewport: { width: 1280, height: 860 } });
    let googleSignIns = 0;
    await ctx.route("https://accounts.google.com/**", (route) => {
      googleSignIns += 1;
      return route.fulfill({ status: 200, contentType: "text/html", body: "<p>Google sign-in</p>" });
    });
    state.down = true;
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "domcontentloaded" });
    await p.getByRole("button", { name: "Use the demo inbox" }).waitFor({ timeout: 20_000 });
    await p.getByRole("button", { name: "Use the demo inbox" }).click();
    await p.waitForFunction(() => document.querySelector("[data-demo-cta]")?.getAttribute("data-demo-cta") === "resume", null, { timeout: 5_000 }).catch(() => undefined);
    state.down = false;
    state.expired = true;
    await p.locator("[data-demo-cta]").first().click();
    await p.waitForFunction(() => document.querySelector("[data-demo-cta]")?.getAttribute("data-demo-cta") === "connect", null, { timeout: 8_000 }).catch(() => undefined);
    const text = await p.locator("[data-demo-cta]").first().textContent();
    const alert = (await p.locator('div[role="alert"]').allTextContents()).join(" ");
    check(
      "an expired session says so and the button becomes Sign in again, still in the demo",
      /Sign in again/.test(text ?? "") && /session has expired/.test(alert) && (await p.locator("[data-row-count] [data-row-id]").count()) > 0,
      JSON.stringify({ text, alert }),
    );
    await p.locator("[data-demo-cta]").first().click();
    await p.waitForTimeout(1_500);
    check("and that starts the normal Google sign-in", googleSignIns > 0 || /accounts\.google\.com/.test(p.url()), p.url());
    await ctx.close();
  }
  {
    // A genuine first run: no session, so Connect Gmail.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    await p.waitForTimeout(300);
    const cta = p.locator("[data-demo-cta]").first();
    check("with no stored session the demo still offers Connect Gmail", (await cta.getAttribute("data-demo-cta")) === "connect" && ((await cta.textContent()) ?? "").includes("Connect Gmail"));
    await ctx.close();
  }
}
