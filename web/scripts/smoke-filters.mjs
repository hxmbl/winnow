/**
 * Targeted smoke for "Change smart filters…", "Why it's here" and Settings → Smart
 * filters, against the production build in demo mode.
 *
 * Separate from `smoke.mjs` so it can run on its own in a minute: `npm run build`, then
 * `node scripts/smoke-filters.mjs`. Same conventions — its own `vite preview` on
 * `WINNOW_PORT` (default 4350), `WINNOW_CHROMIUM` for a system browser, record-and-
 * continue checks — and `WINNOW_SHOTS=dir` writes the picker and the reader's "Why it's
 * here" as PNGs for review.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WINNOW_PORT ?? 4350);
const URL = `http://localhost:${PORT}/`;
const SHOTS = process.env.WINNOW_SHOTS ?? null;

let passed = 0;
const failures = [];
function check(label, ok, detail = "") {
  const line = `${label}${detail ? ` — ${detail}` : ""}`;
  if (ok) {
    passed += 1;
    console.log(`  ok   ${line}`);
  } else {
    failures.push(line);
    console.log(` FAIL  ${line}`);
  }
  return ok;
}
function require(label, ok, detail = "") {
  if (!check(label, ok, detail)) throw new Error(`cannot continue: ${label}`);
}
const section = (title) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);

if (!existsSync(path.join(ROOT, "dist", "index.html"))) await build({ root: ROOT, logLevel: "warn" });
const server = await preview({ root: ROOT, logLevel: "warn", preview: { port: PORT, strictPort: true, open: false } });
const browser = await chromium.launch(process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM } : {});
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const MISSED = "Your Evri delivery is coming today";
const SIBLING = "We've got it from Northwind Books";

try {
  section("desktop: the miss, corrected");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-row-count] [data-row-id]");

  const row = (subject) => page.locator("[data-message-id]").filter({ hasText: subject }).first();
  const pill = (name) => page.locator("header button[aria-pressed]:not([data-version-toggle]):visible").filter({ hasText: name }).first();
  const search = page.locator('input[type="search"]:visible').first();
  const picker = page.locator("[data-filter-picker]");
  const option = (id) => picker.locator(`[data-filter-option="${id}"]`);

  // Narrow to Evri so both demo rows are mounted in the windowed list.
  await search.fill("Evri");
  await page.waitForTimeout(250);
  require("the demo has the missed Evri delivery", (await row(MISSED).count()) === 1);
  require("and its sibling", (await row(SIBLING).count()) === 1);
  await pill("Deliveries").click();
  await page.waitForTimeout(200);
  check("the built-in rules miss it: not in Deliveries", (await row(MISSED).count()) === 0 && (await row(SIBLING).count()) === 0);
  await pill("Deliveries").click();
  await page.waitForTimeout(200);

  await row(MISSED).click({ button: "right" });
  const menuItem = page.locator("[data-menu-item='change-filters']");
  check("the row menu offers Change smart filters…", (await menuItem.count()) === 1 && /Change smart filters…/.test((await menuItem.textContent()) ?? ""));
  await menuItem.click();
  await picker.waitFor({ timeout: 5_000 });
  const options = await picker.locator("[data-filter-option]").count();
  check("the picker lists every learnable smart filter", options === 12, `${options}`);
  check("pre-ticked with where it is now: not Deliveries", (await option("shipping").getAttribute("aria-checked")) === "false");
  await option("shipping").click();
  await page.waitForTimeout(250);
  check("a tick moves it at once", (await option("shipping").getAttribute("aria-checked")) === "true");
  check(
    "and says so",
    ((await picker.locator("[data-filter-picker-status]").textContent()) ?? "").includes("Moved into Deliveries."),
  );
  check(
    "the picker explains, in words, why it is where it is",
    ((await picker.locator("[data-why-line='shipping']").textContent()) ?? "").includes("you put it here"),
  );
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "filters-change-picker.png") });
  await picker.locator("[data-filter-picker-done]").click();
  await picker.waitFor({ state: "detached", timeout: 5_000 });

  await pill("Deliveries").click();
  await page.waitForTimeout(250);
  check("now in Deliveries", (await row(MISSED).count()) === 1);
  check("and the sibling followed, by the sender rule", (await row(SIBLING).count()) === 1);

  section("desktop: why it's here");
  await row(SIBLING).click();
  await page.waitForSelector("[data-reader] [data-why-here]");
  const why = (await page.locator("[data-reader] [data-why-line='shipping']").textContent()) ?? "";
  check("the reader shows one line per filter", /In Deliveries because: from noreply@evri\.com, has an Evri tracking number, you moved 1 email here/.test(why), why);
  check("with no scores", !/\d+(\.\d+)?\s*%|score/i.test(await page.locator("[data-reader] [data-why-here]").innerText()));
  check("the reader shows the Deliveries tag", (await page.locator("[data-reader] [data-filter-tag='shipping']").count()) === 1);
  {
    // 1.3.3: at the bottom of the email, grouped with "Not where it belongs?", not under the sender.
    const place = await page.evaluate(() => {
      const why = document.querySelector("[data-reader] [data-why-here]");
      const footer = why?.closest("[data-reader-filters-footer]");
      const article = why?.closest("article");
      const date = document.querySelector("[data-reader] [data-reader-date]");
      return {
        inFooter: Boolean(footer),
        inArticle: Boolean(article),
        withChange: Boolean(footer?.querySelector("[data-why-change]")),
        belowDate: Boolean(why && date && why.getBoundingClientRect().top > date.getBoundingClientRect().bottom),
      };
    });
    check(
      "desktop: Why it's here is at the bottom of the email, grouped with Change smart filters",
      place.inFooter && place.inArticle && place.withChange && place.belowDate,
      JSON.stringify(place),
    );
  }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "filters-why.png") });
  await page.locator('[data-reader] [aria-label="More"]').first().click();
  check("the reader overflow offers it too", (await page.locator("[data-reader-change-filters]").count()) === 1);
  await page.keyboard.press("Escape");

  section("desktop: multiselect, and taking a message out");
  await pill("Deliveries").click();
  await search.fill("Evri");
  await page.waitForTimeout(250);
  const a = await row(MISSED).boundingBox();
  const b = await row(SIBLING).boundingBox();
  const top = a.y < b.y ? a : b;
  const bottom = a.y < b.y ? b : a;
  await page.mouse.move(top.x + 300, top.y + top.height / 2);
  await page.mouse.down();
  await page.mouse.move(top.x + 300, top.y + top.height / 2 + 12, { steps: 3 });
  await page.mouse.move(bottom.x + 300, bottom.y + bottom.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const bar = page.locator("[data-selection-bar='desktop']");
  check("two rows selected", (await bar.locator("[data-selection-count='2']").count()) === 1);
  await bar.locator("[data-selection-filters]").click();
  await picker.waitFor({ timeout: 5_000 });
  check("the selection bar opens the picker for both", ((await picker.textContent()) ?? "").includes("Smart filters for 2 messages"));
  check("Deliveries is ticked for both", (await option("shipping").getAttribute("aria-checked")) === "true");
  await option("important").click();
  await page.waitForTimeout(200);
  check("a tick applies to both", (await option("important").getAttribute("aria-checked")) === "true");
  await option("important").click();
  await page.waitForTimeout(200);
  check("and an untick takes both out", (await option("important").getAttribute("aria-checked")) === "false");
  await picker.locator("[data-filter-picker-done]").click();
  await page.keyboard.press("Escape");

  section("desktop: persisted locally, and read back");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("winnow.filterLearning.v1") ?? "null"));
  check("stored under its own versioned key", stored?.version === 1 && Array.isArray(stored?.corrections), JSON.stringify(stored)?.slice(0, 80));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("[data-row-count] [data-row-id]");
  await search.fill("Evri");
  await pill("Deliveries").click();
  await page.waitForTimeout(250);
  check("after a reload the sibling is still in Deliveries", (await row(SIBLING).count()) === 1);
  await pill("Deliveries").click();

  section("desktop: Settings → Smart filters");
  await page.keyboard.press(",");
  const dialog = page.locator('[role="dialog"][aria-label="Settings"]');
  await dialog.waitFor({ timeout: 5_000 });
  await dialog.locator('[role="tab"][data-category="filters"]').click();
  await page.waitForTimeout(150);
  const learnt = dialog.locator("[data-filter-learnt-row='shipping']");
  check("lists Deliveries with its corrections", /Deliveries.*1 correction/.test((await learnt.textContent()) ?? ""), await learnt.textContent());
  // One correction makes a rule for that exact address, never for all of evri.com.
  check("and the noreply@evri.com sender rule", (await learnt.locator("[data-sender-rule='noreply@evri.com']").count()) === 1);
  check("but no domain-wide rule from one correction", (await learnt.locator("[data-sender-rule='evri.com']").count()) === 0);
  check(
    "the multiselect untick is remembered for Important too",
    /Important.*2 corrections/.test((await dialog.locator("[data-filter-learnt-row='important']").textContent()) ?? ""),
  );
  check("no scores in Settings either", !/score|%/i.test(await dialog.locator("[data-setting='filterLearning']").innerText()));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "filters-settings.png") });
  await learnt.locator("[data-sender-rule-remove='noreply@evri.com']").click();
  await page.waitForTimeout(150);
  check("a sender rule can be removed", (await learnt.locator("[data-sender-rule='noreply@evri.com']").count()) === 0);
  check("only that one", (await dialog.locator("[data-filter-learnt-row='important'] [data-sender-rule='noreply@evri.com']").count()) === 1);
  await dialog.locator("[data-filter-reset='important']").click();
  await dialog.locator("[data-filter-reset-confirm='important']").click();
  await page.waitForTimeout(150);
  check("a single filter can be reset", (await dialog.locator("[data-filter-learnt-row='important']").count()) === 0 && (await learnt.count()) === 1);
  await dialog.locator("[data-filter-reset-all]").click();
  check("reset asks first", (await dialog.locator("[data-filter-reset-confirm='all']").count()) === 1);
  await dialog.locator("[data-filter-reset-confirm='all']").click();
  await page.waitForTimeout(150);
  check("and then forgets everything", /^Nothing yet/.test(((await dialog.locator("[data-filter-learnt-summary]").textContent()) ?? "").trim()));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await search.fill("Evri");
  await pill("Deliveries").click();
  await page.waitForTimeout(250);
  check("and the Evri mail is back where the built-in rules put it", (await row(MISSED).count()) === 0);
  check("no console errors on desktop", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();

  section("phone: long-press, then Filters");
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await phone.newPage();
  const pErrors = [];
  p.on("pageerror", (error) => pErrors.push(String(error)));
  await p.goto(URL, { waitUntil: "networkidle" });
  await p.waitForSelector("[data-row-count] [data-row-id]");
  await p.locator('input[type="search"]:visible').first().fill("Evri");
  await p.waitForTimeout(300);
  const prow = p.locator("[data-message-id]").filter({ hasText: MISSED }).first();
  const box = await prow.boundingBox();
  const cdp = await phone.newCDPSession(p);
  const point = { x: box.x + 200, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await p.waitForTimeout(650);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await p.waitForTimeout(200);
  const pbar = p.locator("[data-selection-bar='phone']");
  check("a long-press shows the phone selection bar", (await pbar.count()) === 1);
  await pbar.locator("[data-selection-filters]").click();
  const ppicker = p.locator("[data-filter-picker]");
  await ppicker.waitFor({ timeout: 5_000 });
  check("with the picker one tap away", (await ppicker.locator("[data-filter-option]").count()) === 12);
  check("and why it is where it is", (await ppicker.locator("[data-why-here]").count()) === 1);
  await ppicker.locator("[data-filter-option='shipping']").click();
  await p.waitForTimeout(200);
  check("a tap moves it", (await ppicker.locator("[data-filter-option='shipping']").getAttribute("aria-checked")) === "true");
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "filters-phone-picker.png") });
  {
    // The reader on a phone: Why it's here at the bottom, clear of the floating reader pill.
    await ppicker.locator("[data-filter-picker-done]").click();
    await ppicker.waitFor({ state: "detached", timeout: 5_000 });
    if ((await pbar.count()) > 0) await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    await p.locator("[data-message-id]").filter({ hasText: SIBLING }).first().click();
    await p.waitForSelector("[data-reader] [data-why-here]", { timeout: 5_000 });
    await p.evaluate(() => {
      const body = document.querySelector("[data-reader] article")?.parentElement;
      if (body) body.scrollTop = body.scrollHeight;
    });
    await p.waitForTimeout(500);
    const place = await p.evaluate(() => {
      const why = document.querySelector("[data-reader] [data-why-here]");
      const footer = why?.closest("[data-reader-filters-footer]");
      const pill = document.querySelector("[data-reader-pill]");
      const f = footer?.getBoundingClientRect();
      const pl = pill?.getBoundingClientRect();
      return {
        inFooter: Boolean(footer?.closest("article")),
        footerBottom: f ? Math.round(f.bottom) : null,
        pillTop: pl ? Math.round(pl.top) : null,
        pillLeft: pl ? Math.round(pl.left) : null,
        footerRight: f ? Math.round(f.right) : null,
      };
    });
    check(
      "phone: Why it's here is at the bottom of the email, and scrolled to the end it clears the reader pill",
      place.inFooter && place.footerBottom !== null && place.pillTop !== null && place.footerBottom <= place.pillTop,
      JSON.stringify(place),
    );
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "filters-phone-why.png") });
  }
  check("no console errors on phone", pErrors.length === 0, pErrors.slice(0, 3).join(" | "));
  await phone.close();

  // ── Faceted counts (1.4.0) ──────────────────────────────────────────────
  section("desktop: chip counts facet on the active filters");
  {
    const fctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const f = await fctx.newPage();
    const fErrors = [];
    f.on("pageerror", (error) => fErrors.push(String(error)));
    await f.goto(URL, { waitUntil: "networkidle" });
    await f.waitForSelector("[data-row-count] [data-row-id]");
    const chips = () =>
      f.evaluate(() =>
        [...document.querySelectorAll("[data-list-chrome] [data-rail-scroller] > [data-rail-item].wn-pill")].map((item) => ({
          key: item.getAttribute("data-rail-key"),
          count: Number(item.querySelector(".wn-pill-count")?.textContent ?? "0"),
          on: item.hasAttribute("data-on"),
          empty: item.hasAttribute("data-empty"),
        })),
      );
    const rows = () => f.locator("[data-row-count] button[data-message-id]").count();
    const tap = async (key) => {
      await f.locator(`[data-list-chrome] [data-rail-item][data-rail-key="${key}"] button`).first().click();
      await f.waitForTimeout(350);
    };
    const plain = await chips();
    const first = plain.find((c) => c.key === "unread" && c.count > 0) ?? plain.find((c) => c.count > 1 && c.key !== "unsafe");
    require("a chip to start from", Boolean(first));
    await tap(first.key);
    const faceted = await chips();
    const self = faceted.find((c) => c.key === first.key);
    check(
      `${first.key} on: the rail keeps the same chips (narrowed ones dim, none vanish)`,
      JSON.stringify(faceted.map((c) => c.key)) === JSON.stringify(plain.map((c) => c.key)),
      faceted.map((c) => `${c.key}:${c.count}`).join(" "),
    );
    check(
      `${first.key} on: other chips count within the current result`,
      faceted.filter((c) => !c.on && c.key !== "unsafe").every((c) => c.count <= self.count),
    );
    check(
      `${first.key} on: some chip's number changed from its plain count`,
      faceted.some((c) => !c.on && c.key !== "unsafe" && c.count !== plain.find((p) => p.key === c.key)?.count),
    );
    check(
      "a chip faceted to 0 is drawn empty",
      faceted.filter((c) => !c.on).every((c) => (c.count === 0) === c.empty),
    );
    let tried = 0;
    for (const chip of faceted.filter((c) => !c.on && c.key !== "unsafe").slice(0, 5)) {
      await tap(chip.key);
      const both = await chips();
      const onCounts = both.filter((c) => c.on).map((c) => c.count);
      const shown = await rows();
      check(
        `${first.key} + ${chip.key}: the chip's ${chip.count} is the new result, on both active chips`,
        onCounts.length === 2 && onCounts.every((n) => n === chip.count) && (shown > 0) === (chip.count > 0) && shown <= chip.count,
        `active ${JSON.stringify(onCounts)}, ${shown} row(s)`,
      );
      await tap(chip.key);
      tried += 1;
    }
    check("at least two combinations were tried", tried >= 2);
    await tap(first.key);
    check(
      "with nothing on again, the plain counts are back",
      JSON.stringify(await chips()) === JSON.stringify(plain),
    );
    if (SHOTS) {
      await tap(first.key);
      await f.screenshot({ path: path.join(SHOTS, "filters-faceted-desktop.png") });
    }
    check("no page errors with facets", fErrors.length === 0, fErrors.slice(0, 3).join(" | "));
    await fctx.close();
  }

  // ── Chip counts under a search (1.4.0) ──────────────────────────────────
  section("chip counts respect an active search (desktop, then phone)");
  for (const kind of ["desktop", "phone"]) {
    const phoneKind = kind === "phone";
    const sctx = await browser.newContext(
      phoneKind ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } },
    );
    const s = await sctx.newPage();
    const sErrors = [];
    s.on("pageerror", (error) => sErrors.push(String(error)));
    await s.goto(URL, { waitUntil: "networkidle" });
    await s.waitForSelector("[data-row-count] [data-row-id]");
    const railSel = "[data-rail-item][data-rail-key].wn-pill";
    const chips = () =>
      s.evaluate((sel) => {
        const seen = new Set();
        const out = [];
        for (const item of document.querySelectorAll(sel)) {
          if (item.getClientRects().length === 0) continue;
          const key = item.getAttribute("data-rail-key");
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            key,
            count: Number(item.querySelector(".wn-pill-count")?.textContent ?? "0"),
            on: item.hasAttribute("data-on"),
            empty: item.hasAttribute("data-empty"),
          });
        }
        return out;
      }, railSel);
    // Rows the list shows: one per conversation, which is what a chip counts (a thread of
    // three replies is one row and 1 on its chip). The search keeps the list short enough
    // to be all mounted.
    const listed = () =>
      s.evaluate(() => document.querySelectorAll("[data-row-count] button[data-message-id]").length);
    // The masthead's readout ("11", or "3 of 11"): the same rows, so it must agree with an on chip.
    const readout = () =>
      s.evaluate(() => {
        const el = [...document.querySelectorAll("[data-position]")].find((e) => e.getClientRects().length > 0);
        const m = /(\d+)\s*$/.exec(el?.textContent ?? "");
        return m ? Number(m[1]) : null;
      });
    const tap = async (key) => {
      await s.locator(`${railSel}[data-rail-key="${key}"]:visible button`).first().click();
      await s.waitForTimeout(350);
    };
    const box = s.locator(phoneKind ? "[data-phone-search] input" : 'input[type="search"]:visible').first();
    const plain = await chips();
    require(`${kind}: a rail to start from`, plain.length > 2);
    await box.click();
    await box.pressSequentially("order", { delay: 30 });
    await s.waitForTimeout(400);
    if (phoneKind) {
      await s.keyboard.press("Enter").catch(() => undefined);
      await s.locator("[data-row-count] button[data-message-id]").first().waitFor({ timeout: 5_000 });
    }
    const searched = await chips();
    check(
      `${kind}: typing a search keeps the same chips in the same order`,
      JSON.stringify(searched.map((c) => c.key)) === JSON.stringify(plain.map((c) => c.key)),
      searched.map((c) => `${c.key}:${c.count}`).join(" "),
    );
    check(
      `${kind}: and changes their numbers`,
      searched.some((c) => c.count !== plain.find((p) => p.key === c.key)?.count),
      searched.map((c) => `${c.key}:${c.count}`).join(" "),
    );
    check(`${kind}: a chip the search empties is drawn empty`, searched.every((c) => (c.count === 0) === c.empty));
    if (phoneKind && SHOTS) await s.screenshot({ path: path.join(SHOTS, "phone-search-counts.png") });
    let tried = 0;
    for (const chip of searched.filter((c) => c.count > 0).slice(0, phoneKind ? 3 : 6)) {
      await tap(chip.key);
      const shown = await listed();
      const self = (await chips()).find((c) => c.key === chip.key);
      check(
        `${kind}: "order" + ${chip.key}: the chip's ${chip.count} is what tapping it lists`,
        shown === chip.count && self?.on && self.count === chip.count,
        `${shown} row(s) listed, chip now ${self?.count}`,
      );
      if (!phoneKind) {
        const total = await readout();
        check(`${kind}: "order" + ${chip.key}: the masthead counts what the chip does`, total === self?.count, `masthead ${total}, chip ${self?.count}`);
      }
      await tap(chip.key);
      tried += 1;
    }
    check(`${kind}: at least two chips were tapped`, tried >= 2);
    if (!phoneKind) {
      await box.fill("");
      await s.waitForTimeout(350);
      check(`${kind}: clearing the search brings the plain counts back`, JSON.stringify(await chips()) === JSON.stringify(plain));
    }
    check(`${kind}: no page errors`, sErrors.length === 0, sErrors.slice(0, 3).join(" | "));
    await sctx.close();
  }

  // ── Smart filters in another mailbox (1.3.3) ─────────────────────────────
  section("desktop: smart filters apply to the open mailbox (Trash)");
  {
    const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const b = await bctx.newPage();
    const bErrors = [];
    b.on("pageerror", (error) => bErrors.push(String(error)));
    await b.goto(URL, { waitUntil: "networkidle" });
    await b.waitForSelector("[data-row-count] [data-row-id]");
    const chips = () =>
      b.evaluate(() =>
        [...document.querySelectorAll("[data-list-chrome] [data-rail-scroller] > [data-rail-item].wn-pill")].map((item) => ({
          key: item.getAttribute("data-rail-key"),
          count: Number(item.querySelector(".wn-pill-count")?.textContent ?? "0"),
          on: item.hasAttribute("data-on"),
        })),
      );
    const subjects = () =>
      b.evaluate(() => [...document.querySelectorAll("[data-row-count] button[data-message-id]")].map((el) => el.getAttribute("data-message-id")));
    const inboxChips = await chips();
    // Bin four inbox messages, so the bin holds a known mix.
    for (let i = 0; i < 4; i += 1) {
      await b.locator("[data-row-count] button[data-message-id]").first().click();
      await b.waitForTimeout(150);
      await b.keyboard.press("#");
      await b.waitForTimeout(350);
    }
    await b.keyboard.press("Escape");
    await b.locator("[data-sidebar-toggle]:visible").first().click();
    await b.locator('[data-nav-folder="trash"]').first().click();
    await b.waitForTimeout(600);
    if ((await b.locator("[data-sidebar][data-open]").count()) > 0) await b.keyboard.press("Escape");
    await b.waitForTimeout(300);
    const binAll = new Set(await subjects());
    const binChips = await chips();
    check(
      "Trash: the chips count Trash's mail, not the inbox's",
      binAll.size > 0 && binChips.some((c) => c.count > 0) && JSON.stringify(binChips) !== JSON.stringify(inboxChips),
      `${binAll.size} in Trash; ${JSON.stringify(binChips.map((c) => `${c.key}:${c.count}`))}`,
    );
    // The binned junk: a chip's count leaves it out, and the filters that state a fact
    // about the message (Promos, contacts, Security…) still list it, by design
    // (`matchesBuiltin`), so the list is the chip's count plus any junk.
    const unsafe = new Set();
    if (binChips.some((c) => c.key === "unsafe" && c.count > 0)) {
      await b.locator('[data-list-chrome] [data-rail-item][data-rail-key="unsafe"] button').first().click();
      await b.waitForTimeout(400);
      for (const id of await subjects()) unsafe.add(id);
      await b.locator('[data-list-chrome] [data-rail-item][data-rail-key="unsafe"] button').first().click();
      await b.waitForTimeout(300);
    }
    let checked = 0;
    for (const chip of binChips.filter((c) => c.count > 0 && c.key !== "unsafe").slice(0, 4)) {
      await b.locator(`[data-list-chrome] [data-rail-item][data-rail-key="${chip.key}"] button`).first().click();
      await b.waitForTimeout(400);
      const shown = await subjects();
      check(
        `Trash + ${chip.key}: the list is the chip's ${chip.count} (plus any junk), all of it from Trash`,
        shown.filter((id) => !unsafe.has(id)).length === chip.count && shown.every((id) => binAll.has(id)),
        `${shown.length} shown, ${unsafe.size} junk in Trash`,
      );
      await b.locator(`[data-list-chrome] [data-rail-item][data-rail-key="${chip.key}"] button`).first().click();
      await b.waitForTimeout(300);
      checked += 1;
    }
    check("at least one filter was tried in Trash", checked > 0);
    // Why it's here, in Trash: a message a filter lists says why.
    const first = binChips.find((c) => c.count > 0 && c.key !== "unsafe" && !c.key.startsWith("sender:"));
    if (first) {
      await b.locator(`[data-list-chrome] [data-rail-item][data-rail-key="${first.key}"] button`).first().click();
      await b.waitForTimeout(400);
      await b.locator("[data-row-count] button[data-message-id]").first().click();
      await b.waitForTimeout(600);
      const why = await b.locator("[data-reader] [data-why-here]").count();
      check(`Trash + ${first.key}: the open message has Why it's here`, why === 1, `${why} block(s)`);
    }
    check("no page errors in Trash", bErrors.length === 0, bErrors.slice(0, 3).join(" | "));
    await bctx.close();
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.log(String(error?.stack ?? error));
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(` - ${failure}`);
  process.exit(1);
}
