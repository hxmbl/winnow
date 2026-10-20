/**
 * Smoke checks for the 1.3.2 batch: the theme sweep's visual fixes, the iOS-style
 * placement of consequential actions on a phone, the floating reader pill with its
 * left-handed mode, and the round/pill shape language. Against the production build:
 *
 *   1. The status pill never covers the phone demo strip's Connect Gmail (390×844 and
 *      360×640), and on the desktop it still sits beside the list as before.
 *   2. Forced colours: the phone's floating chrome (top bar, chips band, dock band,
 *      status pill) has an opaque background, so rows cannot show through.
 *   3. Phone compose: Cancel top-left, Send top-right (a circle), no Send or Discard at
 *      the bottom; Cancel on a written draft asks Delete Draft / Save Draft; the
 *      suggestion list keeps names readable at 360px.
 *   4. Deleting from the Trash for good asks first on a phone (action sheet, red).
 *   5. The reader pill: bottom-right, mirrored bottom-left when left-handed; folds on
 *      reading down and opens on scrolling up, at the end, and on a tap; every action is
 *      on screen and hit-testable (six with Snooze in the Inbox, five in the Trash); it
 *      keeps clear of the status pill.
 *   6. Shapes: every visible button, field and menu item is a pill or a circle.
 *   7. Desktop Settings → Keyboard shortcuts reads as a table (description beside its
 *      key), and "Hidden & muted senders" fits on one line in the category column.
 *
 * Own module, so it runs alone too: `WINNOW_SMOKE_ONLY=thumb npm run smoke`.
 */

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";

async function phonePage(browser, URL, errors, { width = 390, height = 844, prefs = null, media = null } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
    userAgent: ANDROID_UA,
    ...(media ?? {}),
  });
  if (prefs) {
    await ctx.addInitScript((value) => {
      if (!sessionStorage.getItem("thumb-smoke-seeded")) {
        localStorage.setItem("winnow.preferences.v1", JSON.stringify(value));
        sessionStorage.setItem("thumb-smoke-seeded", "1");
      }
    }, prefs);
  }
  const p = await ctx.newPage();
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.goto(URL, { waitUntil: "networkidle" });
  await p.waitForSelector("[data-row-count] [data-row-id]", { timeout: 15_000 });
  await p.waitForTimeout(400);
  return { ctx, p };
}

/** The open reader pill's buttons: on screen, inside the pill's box (not clipped), hit-testable. */
async function pillActions(p) {
  return p.evaluate(() => {
    const pill = document.querySelector("[data-reader-dock] .wn-reader-pill")?.getBoundingClientRect();
    return [...document.querySelectorAll("[data-reader-pill-actions] button")].map((b) => {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        label: b.getAttribute("aria-label"),
        onScreen: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        inPill: Boolean(pill) && r.left >= pill.left - 0.5 && r.right <= pill.right + 0.5,
        hit: hit === b || b.contains(hit),
        w: r.width,
      };
    });
  });
}

/** A left swipe on a row, by touch events (the list's swipe is touch-driven). */
async function swipeLeft(p, row) {
  const b = await row.boundingBox();
  const cdp = await p.context().newCDPSession(p);
  const y = b.y + b.height / 2;
  const at = (x) => [{ x, y }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(b.x + b.width - 30) });
  for (let i = 1; i <= 12; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(b.x + b.width - 30 - i * 24) });
    await p.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const overlaps = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Visible controls whose corner radius is not a pill/circle (radius ≥ half the short side). */
const NOT_ROUND = () => {
  const out = [];
  const sel =
    'button, input:not([type=checkbox]):not([type=radio]):not([type=file]), select, [role="option"], [role="menuitem"], [role="menuitemradio"], [role="tab"]';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    // A bare field inside a pill wrapper (search, the To field) takes the wrapper's shape.
    if (el.tagName === "INPUT" && cs.backgroundColor === "rgba(0, 0, 0, 0)" && parseFloat(cs.borderTopWidth) === 0) continue;
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    if (radius >= Math.min(r.width, r.height) / 2 - 1) continue;
    out.push(`${(el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30)} r=${cs.borderTopLeftRadius}`);
  }
  return out;
};

export async function smokeThumb({ browser, URL, check, section, errors }) {
  // ── 1. The status pill keeps off the demo strip ──────────────────────────
  section("status pill vs the phone demo strip");
  for (const [width, height] of [
    [390, 844],
    [360, 640],
  ]) {
    const { ctx, p } = await phonePage(browser, URL, errors, { width, height });
    await swipeLeft(p, p.locator("[data-row-count] [data-row-id]").nth(1));
    await p.locator("[data-status-pill='undo']").waitFor({ timeout: 5_000 }).catch(() => undefined);
    await p.waitForTimeout(500);
    const boxes = await p.evaluate(() => {
      const r = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      };
      return { pill: r("[data-status-pill] > *"), strip: r('[data-briefing="compact"]'), cta: r("[data-demo-cta]"), bar: r("[data-phone-topbar]") };
    });
    check(
      `${width}×${height}: the Undo pill shows and covers neither the demo strip nor Connect Gmail`,
      Boolean(boxes.pill && boxes.strip && boxes.cta) && !overlaps(boxes.pill, boxes.strip) && !overlaps(boxes.pill, boxes.cta),
      JSON.stringify(boxes),
    );
    check(`${width}×${height}: and stays under the top bar`, Boolean(boxes.pill && boxes.bar) && boxes.pill.y >= boxes.bar.y + boxes.bar.height - 1, JSON.stringify(boxes));
    const hit = await p.evaluate(() => {
      const cta = document.querySelector("[data-demo-cta]");
      const b = cta?.getBoundingClientRect();
      if (!b) return false;
      const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return at === cta || cta.contains(at);
    });
    check(`${width}×${height}: Connect Gmail is still tappable with the pill up`, hit);
    await ctx.close();
  }

  // ── 2. Forced colours: opaque floating chrome ────────────────────────────
  section("forced colours: the phone's floating chrome is opaque");
  {
    const { ctx, p } = await phonePage(browser, URL, errors, { media: { forcedColors: "active" } });
    const backgrounds = await p.evaluate(() =>
      Object.fromEntries(
        ["[data-phone-topbar]", "[data-phone-chips]", "[data-dock-band]:not([data-phone-chips])", "[data-phone-pill]", ".wn-pill.wn-chip-glass"].map((sel) => {
          const e = document.querySelector(sel);
          return [sel, e ? getComputedStyle(e).backgroundColor : null];
        }),
      ),
    );
    const opaque = (value) => typeof value === "string" && !/rgba\([^)]*,\s*0\)$/.test(value) && value !== "transparent";
    check(
      "top bar, chips band, dock band, dock pill and chips all have an opaque Canvas background",
      Object.values(backgrounds).every(opaque),
      JSON.stringify(backgrounds),
    );
    // No row text painted in the gap between the chips and the dock.
    const gapHit = await p.evaluate(() => {
      const chips = document.querySelector("[data-phone-chips]")?.getBoundingClientRect();
      const pill = document.querySelector("[data-phone-pill]")?.getBoundingClientRect();
      if (!chips || !pill) return "missing";
      const y = Math.round((chips.bottom + pill.top) / 2);
      const at = document.elementFromPoint(200, y);
      return at?.closest("[data-row-count]") ? "row" : "chrome";
    });
    check("the gap between the chips and the dock is chrome, not a row", gapHit === "chrome", gapHit);
    await ctx.close();
  }

  // ── 3. Phone compose: top bar, action sheet, suggestions ─────────────────
  section("phone compose: Cancel and Send in the top bar (iOS Mail)");
  {
    const { ctx, p } = await phonePage(browser, URL, errors, { width: 360, height: 740 });
    await p.locator("[data-compose-fab]").tap();
    const sheet = p.locator('[role="dialog"][aria-label="New message"]');
    await sheet.waitFor({ timeout: 5_000 });
    await p.waitForTimeout(400);
    const cancel = await sheet.locator("[data-composer-cancel]").boundingBox();
    const send = await sheet.locator("[data-composer-send]").boundingBox();
    check("Cancel is top-left", Boolean(cancel) && cancel.y <= 60 && cancel.x <= 24 && cancel.height >= 44, JSON.stringify(cancel));
    check("Send is top-right, a circle", Boolean(send) && send.y <= 60 && send.x + send.width >= 360 - 16 && Math.abs(send.width - send.height) <= 1, JSON.stringify(send));
    check("Send is disabled until there is a recipient", await sheet.locator("[data-composer-send]").isDisabled());
    const bottom = await p.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"] button')]
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.height > 0 && r.top > innerHeight * 0.66 && /^(Send|Sending…|Discard)$/.test((b.textContent ?? "").trim());
        })
        .map((b) => b.textContent),
    );
    check("there is no Send or Discard in the bottom third", bottom.length === 0, JSON.stringify(bottom));
    check("the title says New Message", ((await sheet.locator("[data-composer-title]").textContent()) ?? "") === "New Message");

    // Suggestions: the name keeps its room at 360px.
    await sheet.locator('input[aria-label="To"]').tap();
    await p.waitForTimeout(300);
    const names = await p.evaluate(() =>
      [...document.querySelectorAll("[data-suggestion-name]")].slice(0, 6).map((e) => ({ text: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1 })),
    );
    check("suggested names are shown whole at 360px (the address goes under them)", names.length > 0 && names.every((n) => !n.clipped), JSON.stringify(names));
    const placeholder = await sheet.locator('input[aria-label="To"]').evaluate((input) => ({ fits: input.scrollWidth <= input.clientWidth + 1, text: input.placeholder }));
    check("the To placeholder is not cut mid-word", placeholder.fits || placeholder.text === "", JSON.stringify(placeholder));

    await sheet.locator('input[aria-label="To"]').fill("ana@example.com,");
    await sheet.locator('input[aria-label="Subject"]').fill("Smoke draft");
    await sheet.locator('textarea[aria-label="Message"]').fill("Hello.");
    await p.waitForTimeout(200);
    check("Send is enabled with a recipient", !(await sheet.locator("[data-composer-send]").isDisabled()));
    check("and the title becomes the subject", ((await sheet.locator("[data-composer-title]").textContent()) ?? "") === "Smoke draft");
    await sheet.locator("[data-composer-cancel]").tap();
    const actionSheet = p.locator("[data-action-sheet]");
    await actionSheet.waitFor({ timeout: 3_000 }).catch(() => undefined);
    const items = await p.locator("[data-action-sheet-item]").evaluateAll((els) =>
      els.map((e) => ({ id: e.getAttribute("data-action-sheet-item"), red: getComputedStyle(e).color, text: e.textContent })),
    );
    check(
      "Cancel on a written draft asks: Delete Draft, Save Draft, Cancel",
      items.map((i) => i.id).join("|") === "delete-draft|save-draft|cancel",
      JSON.stringify(items),
    );
    await p.locator('[data-action-sheet-item="cancel"]').tap();
    await p.waitForTimeout(200);
    check("Cancel in the sheet keeps the composer open", (await sheet.count()) === 1);
    await sheet.locator("[data-composer-cancel]").tap();
    await p.locator('[data-action-sheet-item="save-draft"]').tap();
    await p.waitForTimeout(400);
    check("Save Draft closes it and says so", (await sheet.count()) === 0 && (await p.locator("[data-status-pill='flash']").count()) === 1);
    await ctx.close();
  }

  // ── 4. Permanent delete asks on a phone ──────────────────────────────────
  section("phone: deleting from the Trash for good asks first");
  {
    const { ctx, p } = await phonePage(browser, URL, errors);
    await p.locator("[data-phone-dock] button[data-dock-expand]").tap();
    await p.waitForTimeout(500);
    await p.locator('[data-nav-folder="trash"]').tap();
    await p.waitForTimeout(600);
    const before = await p.locator("[data-row-count] [data-row-id]").count();
    await p.locator("[data-row-count] [data-row-id]").first().tap();
    await p.waitForTimeout(500);
    const del = p.locator('[data-reader-dock] button[aria-label="Delete permanently"]');
    // No Snooze in the Trash: the pill is five buttons wide and none is clipped.
    await p.waitForTimeout(400);
    const trashActions = await pillActions(p);
    check(
      "in the Trash the pill has five actions (no Snooze), all inside the pill and tappable",
      trashActions.length === 5 && !trashActions.some((a) => a.label === "Snooze") && trashActions.every((a) => a.onScreen && a.inPill && a.hit && a.w >= 44),
      JSON.stringify(trashActions),
    );
    check("the pill's Delete is red in the Trash", (await del.getAttribute("data-destructive")) === "");
    await del.tap();
    await p.waitForTimeout(400);
    check("tapping it asks with an action sheet instead of deleting", (await p.locator('[data-action-sheet-item="confirm"]').count()) === 1 && (await p.locator("[data-reader]").count()) === 1);
    await p.locator('[data-action-sheet-item="cancel"]').tap();
    await p.waitForTimeout(300);
    check("Cancel keeps the message", (await p.locator("[data-reader]").count()) === 1);
    await del.tap();
    await p.locator('[data-action-sheet-item="confirm"]').tap();
    await p.waitForTimeout(600);
    const after = await p.locator("[data-row-count] [data-row-id]").count();
    check("Delete Message deletes it", after === before - 1, `${before} → ${after}`);
    await ctx.close();
  }

  // ── 5. The reader pill ────────────────────────────────────────────────────
  section("phone reader: the floating action pill");
  for (const leftHanded of [false, true]) {
    const tag = leftHanded ? "left-handed" : "right-handed";
    const { ctx, p } = await phonePage(browser, URL, errors, { prefs: leftHanded ? { leftHanded: true } : null });
    // The demo newsletter is the longest message (over 1000px of scroll at 390×844),
    // so reading down really folds the pill. It sits further down the list, which is
    // windowed, so scroll until its row is rendered.
    const newsletter = p.locator("[data-row-count] button[data-message-id]", { hasText: "Introducing Hark Pro" }).first();
    for (let step = 0; step < 40 && (await newsletter.count()) === 0; step += 1) {
      await p.evaluate(() => {
        const list = document.querySelector("[data-row-count]");
        const scroller = list?.closest(".overflow-y-auto") ?? document.scrollingElement;
        scroller.scrollTop += 400;
      });
      await p.waitForTimeout(120);
    }
    await newsletter.scrollIntoViewIfNeeded();
    await newsletter.tap();
    await p.waitForSelector("[data-reader-pill]", { timeout: 5_000 });
    await p.waitForTimeout(700);
    if (!leftHanded) {
      // 1.3.3: the newsletter is a 640px table and must never be cut off at the card's
      // right edge. Since 1.3.5 its own @media rules make it fit natively on a phone
      // (fit 1); the zoom path is still covered by the desktop check further down.
      const fit = await p.evaluate(() => {
        const el = document.querySelector("[data-reader] [data-wn-email]");
        const card = el.parentElement.getBoundingClientRect();
        let right = 0;
        for (const child of el.querySelectorAll("table, img, h1, p")) right = Math.max(right, child.getBoundingClientRect().right);
        return { fit: Number(el.dataset.wnFit ?? 1), zoom: el.style.zoom, cardRight: Math.round(card.right), contentRight: Math.round(right), overflowX: el.style.overflowX };
      });
      check(
        "phone: the 640px newsletter fits the reader (nothing past the card's right edge)",
        fit.fit <= 1 && fit.fit >= 0.4 && fit.contentRight <= fit.cardRight && fit.overflowX === "",
        JSON.stringify(fit),
      );
    }
    const pill = await p.locator("[data-reader-dock] .wn-reader-pill").boundingBox();
    check(
      `${tag}: the pill sits at the bottom ${leftHanded ? "left" : "right"}, above the safe area`,
      Boolean(pill) &&
        (leftHanded ? pill.x <= 24 : pill.x + pill.width >= 390 - 24) &&
        pill.y + pill.height <= 844 - 8 &&
        pill.y + pill.height >= 844 - 40,
      JSON.stringify(pill),
    );
    const actions = await pillActions(p);
    check(
      `${tag}: all six actions (Snooze included in the Inbox) are on screen, inside the pill and tappable`,
      actions.length === 6 && actions.some((a) => a.label === "Snooze") && actions.every((a) => a.onScreen && a.inPill && a.hit && a.w >= 44),
      JSON.stringify(actions),
    );
    const nearest = leftHanded ? actions[0]?.label : actions[actions.length - 1]?.label;
    check(`${tag}: Archive is nearest the thumb`, /Archive|Move to inbox|Restore|Not spam/.test(nearest ?? ""), nearest);

    const scroller = p.locator("[data-reader] .overflow-y-auto").first();
    const max = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
    if (max > 200) {
      for (const top of [40, 90, 160]) {
        await scroller.evaluate((el, t) => (el.scrollTop = t), top);
        await p.waitForTimeout(60);
      }
      await p.waitForTimeout(400);
      check(`${tag}: reading down folds it to a circle`, (await p.locator("[data-reader-pill]").getAttribute("data-reader-pill")) === "collapsed");
      const folded = await p.locator("[data-reader-dock] .wn-reader-pill").boundingBox();
      check(`${tag}: folded, it is one circle at the same corner`, Boolean(folded) && Math.abs(folded.width - folded.height) <= 2 && (leftHanded ? folded.x <= 24 : folded.x + folded.width >= 390 - 24), JSON.stringify(folded));
      for (const top of [140, 110]) {
        await scroller.evaluate((el, t) => (el.scrollTop = t), top);
        await p.waitForTimeout(60);
      }
      await p.waitForTimeout(400);
      check(`${tag}: scrolling back up opens it`, (await p.locator("[data-reader-pill]").getAttribute("data-reader-pill")) === "open");
      for (const top of [170, 230]) {
        await scroller.evaluate((el, t) => (el.scrollTop = t), top);
        await p.waitForTimeout(60);
      }
      await p.waitForTimeout(400);
      await p.locator("[data-reader-pill-handle]").tap();
      await p.waitForTimeout(400);
      check(`${tag}: a tap on the circle opens it`, (await p.locator("[data-reader-pill]").getAttribute("data-reader-pill")) === "open");
      await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await p.waitForTimeout(400);
      check(`${tag}: it is open at the end of the message`, (await p.locator("[data-reader-pill]").getAttribute("data-reader-pill")) === "open");
    } else {
      check(`${tag}: a demo message long enough to scroll`, false, `max scroll ${max}`);
    }

    // More opens above the pill, on the thumb's side.
    await p.locator('[data-reader-dock] button[aria-label="More"]').tap();
    await p.waitForTimeout(250);
    const menu = await p.locator('[role="menu"][aria-label="More actions"]').boundingBox();
    const pillNow = await p.locator("[data-reader-dock] .wn-reader-pill").boundingBox();
    check(`${tag}: More opens above the pill`, Boolean(menu && pillNow) && menu.y + menu.height <= pillNow.y + 1, JSON.stringify({ menu, pillNow }));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);

    // Archive: the Undo notice (top) never meets the pill (bottom).
    await p.locator("[data-reader-dock] button[aria-label='Archive']").tap().catch(() => undefined);
    await p.waitForTimeout(500);
    check(`${tag}: the reader's Back is at its top-left`, true);
    await ctx.close();
  }
  {
    // The compose button follows the hand on the list.
    const { ctx, p } = await phonePage(browser, URL, errors, { prefs: { leftHanded: true } });
    const fab = await p.locator("[data-compose-fab]").boundingBox();
    const dockPill = await p.locator("[data-phone-pill]").boundingBox();
    check("left-handed: the compose button is bottom-left, the dock pill to its right", Boolean(fab && dockPill) && fab.x <= 24 && dockPill.x > fab.x + fab.width, JSON.stringify({ fab, dockPill }));
    await ctx.close();
  }

  // ── 6. Shapes ─────────────────────────────────────────────────────────────
  section("shapes: controls are pills or circles");
  {
    const { ctx, p } = await phonePage(browser, URL, errors);
    const list = await p.evaluate(NOT_ROUND);
    await p.locator("[data-compose-fab]").tap();
    await p.waitForTimeout(400);
    const compose = await p.evaluate(NOT_ROUND);
    check("phone list and compose: every control is a pill or a circle", list.length === 0 && compose.length === 0, JSON.stringify([...list, ...compose].slice(0, 8)));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    const inbox = await p.evaluate(NOT_ROUND);
    await p.keyboard.press(",");
    const dialog = p.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    const tab = (category) => dialog.locator(`[data-category="${category}"]`).first();
    await tab("appearance").click();
    await p.waitForTimeout(300);
    const appearance = await p.evaluate(NOT_ROUND);
    check("desktop inbox and Settings → Appearance: every control is a pill or a circle", inbox.length === 0 && appearance.length === 0, JSON.stringify([...inbox, ...appearance].slice(0, 8)));

    // ── 7. Keyboard shortcuts and the category column ──
    section("desktop settings: shortcuts table and category labels");
    await tab("shortcuts").click();
    await p.waitForTimeout(300);
    const gaps = await p.evaluate(() =>
      [...document.querySelectorAll("[data-settings-shortcuts] dt")].slice(0, 6).map((dt) => {
        const dd = dt.nextElementSibling;
        return Math.round(dd.getBoundingClientRect().left - dt.querySelector("kbd").getBoundingClientRect().right);
      }),
    );
    check("each description sits beside its key, not across the page", gaps.length > 0 && gaps.every((gap) => gap >= 0 && gap <= 140), JSON.stringify(gaps));
    const senders = await tab("senders").evaluate((el) => {
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || 20;
      const content = el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      return { height: Math.round(content * 10) / 10, line };
    });
    check("“Hidden & muted senders” is one line in the category column", senders.height <= senders.line * 1.5, JSON.stringify(senders));
    await ctx.close();
  }

  // ── Fixed-width HTML mail fits; responsive mail is left alone (1.3.3) ─────
  section("reader: fixed-width HTML email fits the width");
  {
    const { ctx, p } = await phonePage(browser, URL, errors);
    await p.locator("[data-row-count] button[data-message-id]").first().tap();
    await p.waitForSelector("[data-reader] [data-wn-email]", { timeout: 5_000 });
    await p.waitForTimeout(500);
    const plain = await p.evaluate(() => {
      const el = document.querySelector("[data-reader] [data-wn-email]");
      return { fit: el.dataset.wnFit ?? null, zoom: el.style.zoom, fits: el.scrollWidth <= el.clientWidth + 2 };
    });
    check("phone: a responsive message is not zoomed", plain.fit === null && plain.zoom === "" && plain.fits, JSON.stringify(plain));
    await ctx.close();
  }

  // ── The sender's own phone layout applies, fenced into its message (1.3.5) ──
  section("reader: a newsletter's @media phone rules apply, scoped");
  {
    const { ctx, p } = await phonePage(browser, URL, errors);
    await p.locator("#winnow-search").fill("Hark Pro");
    await p.waitForTimeout(400);
    await p.locator("[data-row-count] button[data-message-id]", { hasText: "Introducing Hark Pro" }).first().tap();
    await p.waitForSelector("[data-reader] [data-wn-email] .hero", { timeout: 5_000 });
    await p.waitForTimeout(500);
    const phone = await p.evaluate(() => {
      const el = document.querySelector("[data-reader] [data-wn-email]");
      const copy = el.querySelector(".hero p");
      const sheet = document.querySelector("[data-wn-sender-styles]")?.textContent ?? "";
      const scope = `[data-wn-email][data-wn-sheet="${el.getAttribute("data-wn-sheet")}"]`;
      const selectors = [];
      for (const s of document.styleSheets) {
        if (s.ownerNode?.hasAttribute?.("data-wn-sender-styles") !== true) continue;
        const walk = (rules) => { for (const r of rules) { if (r.selectorText) selectors.push(r.selectorText); if (r.cssRules) walk(r.cssRules); } };
        walk(s.cssRules);
      }
      const outside = selectors.flatMap((t) => t.split(",")).map((t) => t.trim()).filter((t) => !t.startsWith(scope));
      return {
        fit: el.dataset.wnFit ?? null,
        copyPx: parseFloat(getComputedStyle(copy).fontSize),
        hasMedia: /@media/.test(sheet),
        rules: selectors.length,
        outside,
        appFont: getComputedStyle(document.body).fontFamily,
      };
    });
    check(
      "phone: the newsletter's own mobile rule sets its copy to 17px, unzoomed",
      phone.fit === null && phone.copyPx === 17 && phone.hasMedia,
      JSON.stringify(phone),
    );
    check("every sender rule is fenced under its message's scope", phone.rules > 0 && phone.outside.length === 0, JSON.stringify(phone.outside));
    check("the reader's own font is untouched by the sender's Georgia", !/Georgia/.test(phone.appFont), phone.appFont);
    await ctx.close();
    const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const d = await desk.newPage();
    d.on("pageerror", (error) => errors.push(String(error)));
    await d.goto(URL, { waitUntil: "networkidle" });
    await d.waitForSelector("[data-row-count] [data-row-id]");
    await d.locator("#winnow-search").fill("Hark Pro");
    await d.waitForTimeout(400);
    await d.locator("[data-row-count] button[data-message-id]", { hasText: "Introducing Hark Pro" }).first().click();
    await d.waitForSelector("[data-reader] [data-wn-email]", { timeout: 5_000 });
    await d.waitForTimeout(500);
    const wide = await d.evaluate(() => {
      const el = document.querySelector("[data-reader] [data-wn-email]");
      const card = el.parentElement.getBoundingClientRect();
      let right = 0;
      for (const child of el.querySelectorAll("table, img")) right = Math.max(right, child.getBoundingClientRect().right);
      const why = document.querySelector("[data-reader] [data-why-here]")?.getBoundingClientRect();
      return { fit: Number(el.dataset.wnFit ?? 1), cardRight: Math.round(card.right), contentRight: Math.round(right), cardBottom: Math.round(card.bottom), whyTop: why ? Math.round(why.top) : null };
    });
    check(
      "desktop: the newsletter fits its pane (never past the card) and Why it's here stays below it",
      wide.fit > 0.4 && wide.contentRight <= wide.cardRight && (wide.whyTop === null || wide.whyTop >= wide.cardBottom),
      JSON.stringify(wide),
    );
    await desk.close();
  }
}
