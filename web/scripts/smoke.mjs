/**
 * A smoke test that actually runs the app.
 *
 * The unit tests cover `core/` in isolation, which is the right level for a
 * pure layer — but it means nothing has yet checked that the bundle boots, that
 * React mounts, or that the store's derived view reaches the screen. This does
 * that, against the real production build, and fails loudly on any console
 * error.
 *
 * It is a *smoke* test, not a UI test: it asserts that the app rendered, that the
 * mailbox is populated, and that a few interactions do not throw. Anything more
 * precise about layout or pixels belongs in a component test, and there are
 * none on purpose.
 */
import { chromium } from "playwright";

const URL = process.env.WINNOW_URL ?? "http://localhost:4173/";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

/** Console errors are failures: a React warning in production is a bug. */
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(String(error)));

function check(label, condition, detail = "") {
  const status = condition ? "  ok  " : " FAIL ";
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) process.exitCode = 1;
}

await page.goto(URL, { waitUntil: "networkidle" });

// ── It renders ─────────────────────────────────────────────────────────────

await page.waitForSelector("text=Nothing selected", { timeout: 10_000 });
check("the app boots and the reader's empty state renders", true);

// ── The demo mailbox is populated ──────────────────────────────────────────

const rows = page.locator("[data-message-id]");
const rowCount = await rows.count();
check("the demo mailbox has rows", rowCount > 20, `${rowCount} rows`);

// ── Day sections ───────────────────────────────────────────────────────────

const sections = await page.locator("section").count();
check("rows are grouped into dated sections", sections >= 3, `${sections} sections`);

// ── The rail is ranked ─────────────────────────────────────────────────────
// Scoped past the `aria-hidden` copy: the strip renders twice (inline on a wide
// screen, on its own row on a narrow one) and the narrow copy is hidden from
// assistive tech precisely so it is not a second live control list.
const pills = page.locator('header button[aria-pressed]:not([aria-hidden="true"] * *)');
const pillCount = await pills.count();
check("the filter rail is populated", pillCount > 5, `${pillCount} pills`);

// ── The list says what it is showing ───────────────────────────────────────
// "3 of 40" is not answerable without knowing what the 40 are.
const listTitle = await page
  .locator('header [title]')
  .filter({ hasText: /Inbox|Archive|Trash|Spam|Important|Filtered|From / })
  .first()
  .textContent();
check("the list reports its own title", Boolean(listTitle?.trim()), listTitle ?? "");

// ── A filter can be turned on and back off with the pointer ────────────────
// This is the rail bug that motivated `ui/rail.ts`: hiding an active pill makes
// the control that turned it on disappear, leaving no way to undo it. Only a
// browser can prove the pill is actually reachable after the state change.
const firstPill = pills.first();
const pillLabel = (await firstPill.getAttribute("aria-label")) ?? "";
await firstPill.click();
await page.waitForTimeout(200);
const stillThere = await pills
  .first()
  .getAttribute("aria-label");
check(
  "an active filter keeps its pill so it can be switched off",
  stillThere === pillLabel,
  `${pillLabel} → ${stillThere}`,
);

await pills.first().click();
await page.waitForTimeout(200);
check(
  "clicking it again clears the filter",
  (await pills.first().getAttribute("aria-pressed")) === "false",
);

// ── Clicking a row opens the reader ───────────────────────────────────────

await rows.first().click();
await page.waitForSelector("article h1", { timeout: 5_000 });
const subject = await page.locator("article h1").first().textContent();
check("clicking a row opens the reader", Boolean(subject?.trim()), subject ?? "");

await page.keyboard.press("Escape");
await page.waitForSelector("text=Nothing selected", { timeout: 5_000 });
check("Escape closes the reader", true);

await page.keyboard.press("j");
await page.waitForSelector("article h1", { timeout: 5_000 });
check("j opens the first message", true);

await page.keyboard.press("Escape");

// ── The cheat sheet renders and is generated from the bindings ─────────────

await page.keyboard.press("?");
await page.waitForSelector("text=Keyboard shortcuts", { timeout: 5_000 });
const sheetRows = await page.locator("dl > div").count();
check("the shortcut sheet opens", sheetRows > 8, `${sheetRows} rows`);
await page.keyboard.press("Escape");

// ── The mailbox palette ────────────────────────────────────────────────────

await page.keyboard.press("!");
// Selected by role, not by text: the palette's accessible name is an
// `aria-label`, and `text=` matches visible text only.
await page.waitForSelector('[role="menu"]', { timeout: 5_000 });
const paletteRows = await page.locator('[role="menu"] [role="menuitem"]').count();
check("the navigation palette opens", paletteRows === 4, `${paletteRows} rows`);

await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
check(
  "Enter in the palette switches mailbox",
  (await page.locator('[role="menu"]').count()) === 0,
);

// ── Settings ──────────────────────────────────────────────────────────────

await page.keyboard.press(",");
await page.waitForSelector("text=How Winnow sorts", { timeout: 5_000 });
const sliders = await page.locator('input[type="range"]').count();
check("settings shows the weight sliders", sliders >= 8, `${sliders} sliders`);
await page.keyboard.press("Escape");

// ── Search ────────────────────────────────────────────────────────────────
// Back to the inbox first: the palette step above moved to Spam, where an
// "invoice" search legitimately finds nothing.
await page.keyboard.press("!");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);

await page.keyboard.press("/");
await page.keyboard.type("invoice");
await page.waitForTimeout(300);
const searchRows = await page.locator("[data-message-id]").count();
check("search narrows the list", searchRows > 0 && searchRows < rowCount, `${searchRows} of ${rowCount}`);

// ── Empty state explains itself ────────────────────────────────────────────

// Captured before the search is narrowed, while the list still has rows.
const linkedId = await rows.first().getAttribute("data-message-id");

await page.keyboard.press("Escape");
await page.locator("#topbar-search").fill("zzzznothingmatchesthis");
await page.waitForTimeout(250);
const emptyText = await page.locator("text=Nothing matches that search").count();
check("an empty search says why", emptyText > 0);

// ── A shared link boots cleanly ────────────────────────────────────────────
// Last, because it reloads the page and everything above is order-dependent.
//
// The point being checked is that a URL carrying a message id is not mistaken
// for an OAuth redirect. `parseRedirect` returns `null` for it, so the app boots
// normally — the failure this guards against is a sign-in loop or an error
// banner for a link someone was sent in good faith.
await page.goto(`${URL}?view=spam&message=${linkedId}`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);
check(
  "a shared link is not mistaken for a sign-in redirect",
  (await page.locator("text=Keyboard shortcuts").count()) === 0 &&
    (await page.locator("[data-message-id]").count()) > 0,
);

// ── No console errors ─────────────────────────────────────────────────────

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await page.screenshot({ path: "smoke.png", fullPage: false });
await browser.close();

console.log(process.exitCode ? "\nSMOKE TEST FAILED" : "\nSMOKE TEST PASSED");
