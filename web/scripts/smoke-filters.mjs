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
