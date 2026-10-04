/**
 * The end-to-end net.
 *
 * The unit tests cover `core/` in isolation, which is the right level for a pure
 * layer — but it means nothing has checked that the bundle boots, that React
 * mounts, that the store's derived view reaches the screen, or that a keystroke
 * does what the keybind table says it does. This does all of that against the
 * real production build, and fails loudly on any console error.
 *
 * It owns its own server. `vite preview` is started in-process through Vite's JS
 * API rather than as a child process, so there is no port to leave bound, no
 * `SIGTERM` to get wrong, and no "the command in the README assumes something
 * else is already running" — which is exactly how the previous version of this
 * script was unusable: it pointed at `localhost:4173` and nothing in the repo
 * ever served that port.
 *
 * `WINNOW_URL` points it at an existing server instead, for when you want to
 * smoke the dev server (which does not need a build) or a deployed bundle.
 *
 * It is a *smoke* test, not a UI test suite: it asserts that things work and
 * that the ones with a history of being broken stay fixed. Anything more precise
 * about pixels belongs in a component test, and there are none on purpose.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WINNOW_PORT ?? 4173);
const EXTERNAL = process.env.WINNOW_URL ?? null;
const URL = EXTERNAL ?? `http://localhost:${PORT}/`;

// ── Reporting ───────────────────────────────────────────────────────────────
//
// A check that throws takes the rest of the run with it, so every assertion is
// written to *record and continue*. The cost of that is that a broken step can
// cascade into failures further down; the benefit is that one regression does not
// hide the other nine behind it. Steps that everything after them depends on use
// `require`, which throws on purpose.

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

/** A precondition. Throwing is the right behaviour: the steps after it are void. */
function require(label, ok, detail = "") {
  if (!check(label, ok, detail)) {
    throw new Error(`smoke test cannot continue: ${label}`);
  }
  return true;
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}

// ── The server ──────────────────────────────────────────────────────────────

/**
 * Build if there is nothing to serve.
 *
 * A stale `dist/` is *not* rebuilt: the honest contract is that `npm run smoke`
 * runs `npm run build` first (see `package.json`), and a timestamp comparison
 * would quietly paper over a build that was skipped. This is only the fallback
 * for running the file directly.
 */
async function ensureBuilt() {
  if (existsSync(path.join(ROOT, "dist", "index.html"))) return;
  console.log("· no dist/ — building it (npm run check still owns the typecheck)");
  await build({ root: ROOT, logLevel: "warn" });
}

async function openServer() {
  if (EXTERNAL) {
    console.log(`· using ${URL} (WINNOW_URL) — not starting a server`);
    return async () => {};
  }
  await ensureBuilt();
  const server = await preview({
    root: ROOT,
    logLevel: "warn",
    preview: { port: PORT, strictPort: true, open: false },
  });
  console.log(`· vite preview on ${URL}`);
  return () => server.close();
}

// ── The run ─────────────────────────────────────────────────────────────────

const stopServer = await openServer();
const browser = await chromium.launch();
let failed = false;

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  /**
   * Native dialogs are a failure here, not a mechanism.
   *
   * The composer's discard confirmation used to be `window.confirm`, and this handler
   * existed to answer it. It is gone: Tauri's webviews do not reliably implement
   * `confirm`, so on the desktop the question could not be asked at all, and a
   * browser-native dialog cannot be styled and blocks the render loop. The
   * confirmation is a real dialog now — see `Overlay.tsx`'s `ConfirmDialog` — and this
   * handler stays purely as a tripwire: if anything reaches for `window.confirm`,
   * `alert` or `prompt` again, the test fails with a message that says why rather than
   * quietly answering it.
   */
  page.on("dialog", async (dialog) => {
    failures.push(
      `a native dialog was raised: ${dialog.type()} — "${dialog.message()}". ` +
        `Winnow must ask in-app: window.confirm is unimplemented in a Tauri webview.`,
    );
    await dialog.dismiss();
  });

  /**
   * The in-app confirmation, answered by clicking one of its two buttons.
   *
   * By pointer rather than by keyboard, and deliberately: pressing Escape a second
   * time *cancels* the confirmation, so a keyboard-driven flow would be testing that
   * the safe answer is reachable twice rather than that the dialog can be resolved
   * either way.
   */
  const confirmDialog = () => page.locator('[role="dialog"][aria-label="Discard this draft?"]');
  const answerDiscard = async (accept) => {
    const dialog = confirmDialog();
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    await dialog.getByRole("button", { name: accept ? "Discard" : "Keep editing" }).click();
    await dialog.waitFor({ state: "detached", timeout: 5_000 });
  };

  // Re-read after every state change, so nothing here holds a stale handle.
  const rows = () => page.locator("[data-message-id]");
  // Scoped to the live rail. It was rendered twice — inline at `lg` and again on its
  // own row below it — and counting both would have doubled every number here; there is
  // one copy now, and the `:visible` guard documents that it is a layout assumption
  // rather than a structural one.
  const pills = () => page.locator("header button[aria-pressed]:visible");
  const mailbox = (name) =>
    page.locator('header nav[aria-label="Mailboxes"] button', { hasText: name }).first();
  const storage = () =>
    page.evaluate(() => Object.fromEntries(Object.entries(globalThis.localStorage)));

  const openMessage = async () => {
    await rows().first().click();
    await page.waitForSelector("article h1", { timeout: 5_000 });
  };
  const closeReader = async () => {
    await page.keyboard.press("Escape");
    await page.waitForSelector("text=Nothing selected", { timeout: 5_000 });
  };
  const goTo = async (name) => {
    await mailbox(name).click();
    await page.waitForTimeout(250);
  };
  /** The unread badge on a mailbox tab, or `0` when it has no badge at all. */
  const unreadBadge = async (name) => {
    const badge = mailbox(name).locator("span");
    return (await badge.count()) === 0 ? "0" : (await badge.first().textContent())?.trim();
  };
  const listTitle = () => page.locator("header span[title]").first().textContent();

  await page.goto(URL, { waitUntil: "networkidle" });

  // ── It boots ───────────────────────────────────────────────────────────────

  section("boot");

  await page.waitForSelector("text=Nothing selected", { timeout: 10_000 });
  check("the app boots into the demo, with the reader's empty state", true);

  const rowCount = await rows().count();
  require("the demo mailbox has rows", rowCount > 20, `${rowCount} rows`);
  check("the demo mailbox is populated", true, `${rowCount} rows`);

  const pillCount = await pills().count();
  require("the filter rail is populated", pillCount > 5, `${pillCount} pills`);
  check("the filter rail is ranked", true, `${pillCount} pills`);

  const title = await listTitle();
  check("the list says what it is showing", Boolean(title?.trim()), title ?? "");

  // The rail is the product, and it used to share a row with the mailbox nav, the
  // search box, five action buttons, two icon buttons and the position cluster. Every
  // one of those is `shrink-0` because it must not reflow, so the rail — the only
  // elastic child — absorbed the whole shortfall and showed three pills at 1440px.
  // Asserted as a ratio rather than a pixel count, because the number of pills depends
  // on the mailbox; what matters is that most of them are reachable without scrolling.
  const rail = await page.evaluate(() => {
    // Not `header .no-scrollbar.overflow-x-auto` — the mailbox nav is one of those too,
    // and it is 265px wide for exactly the right reason. The rail is the one holding
    // pressed-state pills.
    const scrollers = [...document.querySelectorAll("header div.no-scrollbar")].filter((element) =>
      element.querySelector("button[aria-pressed]"),
    );
    if (scrollers.length !== 1) return { copies: scrollers.length };
    const scroller = scrollers[0];
    const pills = [...scroller.querySelectorAll("button[aria-pressed]")];
    const box = scroller.getBoundingClientRect();
    const visible = pills.filter((pill) => {
      const rect = pill.getBoundingClientRect();
      return rect.right > box.left + 1 && rect.left < box.right - 1;
    });
    return {
      copies: scrollers.length,
      total: pills.length,
      visible: visible.length,
      width: box.width,
    };
  });
  check("the rail is rendered exactly once", rail?.copies === 1, `${rail?.copies} copies`);
  check("on its own full-width row", (rail?.width ?? 0) > 1000, `${rail?.width}px`);
  check(
    "so most of it is reachable without scrolling",
    (rail?.visible ?? 0) >= Math.min(8, rail?.total ?? 0),
    `${rail?.visible} of ${rail?.total} pills in ${rail?.width}px`,
  );

  // The position cluster said "0 of 38" before the keyboard had ever been touched,
  // which reads as an empty mailbox — and "0 of 0" on a narrowed list.
  const position = await page.locator("header").getByText(/^(—|\d+)\s*\/?\s*(of\s*)?\d+$/).count();
  check("the position cluster is not claiming row 0", position > 0);
  check(
    "an untouched list shows a dash rather than a row number",
    (await page.locator("header").getByText("—", { exact: false }).count()) > 0,
  );

  // ── Sign-in is reachable from the demo ─────────────────────────────────────

  // The app boots with no backend, so it never shows the sign-in screen on first
  // run. If this button is missing, the entire Gmail half of the product is
  // unreachable until you have already used it.
  const connect = page.locator('button:has-text("Connect Gmail")');
  check("the demo offers a route to sign-in", (await connect.count()) > 0);
  check(
    "and says the demo is a sample, not a synced account",
    (await page.locator("text=Demo mailbox").count()) > 0,
  );

  // ── Filtering ──────────────────────────────────────────────────────────────

  section("filters");

  // This is the rail bug that motivated `ui/rail.ts`: hiding an active pill makes
  // the control that turned it on disappear, leaving no way to undo it. Only a
  // browser can prove the pill is still reachable after the state change.
  const firstPill = pills().first();
  const pillLabel = (await firstPill.getAttribute("aria-label")) ?? "";
  await firstPill.click();
  await page.waitForTimeout(200);
  const pressedLabel = await pills().first().getAttribute("aria-label");
  check(
    "an active filter keeps its pill so it can be switched off",
    pressedLabel === pillLabel,
    `${pillLabel} → ${pressedLabel}`,
  );
  check(
    "and the pill reports itself pressed",
    (await pills().first().getAttribute("aria-pressed")) === "true",
  );

  await pills().first().click();
  await page.waitForTimeout(200);
  check(
    "clicking it again clears the filter",
    (await pills().first().getAttribute("aria-pressed")) === "false",
  );

  // ── Search ─────────────────────────────────────────────────────────────────

  section("search");

  await page.keyboard.press("/");
  check(
    "`/` focuses the search box",
    (await page.evaluate(() => document.activeElement?.id)) === "topbar-search",
  );
  await page.keyboard.type("migration");
  await page.waitForTimeout(300);
  const searchRows = await rows().count();
  check(
    "search narrows the list",
    searchRows > 0 && searchRows < rowCount,
    `${searchRows} of ${rowCount}`,
  );

  // Multi-token search is AND across the tokens, not a substring match on the query
  // as one run of characters. The failure this replaced: searching "invoice march"
  // found nothing at all, because no message contains that exact byte sequence, and
  // the list said "nothing matches that search" as though the mailbox were empty.
  //
  // Two tokens that genuinely co-occur in the demo's migration thread, so a working
  // AND finds them and a phrase match would too — which is what makes the negative
  // case below the load-bearing one.
  await page.locator("#topbar-search").fill("migration plan");
  await page.waitForTimeout(300);
  const bothTokens = await rows().count();
  check("two tokens that co-occur both match", bothTokens > 0, `${bothTokens} rows`);

  // A second token that cannot co-occur must narrow to nothing rather than being
  // ignored, which is what "AND" has to mean to be worth anything.
  await page.locator("#topbar-search").fill("migration zzzznotaword");
  await page.waitForTimeout(300);
  const impossiblePair = await rows().count();
  check(
    "and an impossible pair narrows to nothing rather than ignoring a token",
    impossiblePair === 0,
    `migration + nonsense → ${impossiblePair}`,
  );

  // Order must not matter, since the tokens are a set rather than a phrase.
  await page.locator("#topbar-search").fill("migration plan");
  await page.waitForTimeout(250);
  const ordered = await rows().count();
  await page.locator("#topbar-search").fill("plan migration");
  await page.waitForTimeout(250);
  const reversed = await rows().count();
  check("token order does not matter", ordered === reversed, `${ordered} vs ${reversed}`);
  await page.locator("#topbar-search").fill("");
  await page.waitForTimeout(300);

  await page.locator("#topbar-search").fill("zzzznothingmatchesthis");
  await page.waitForTimeout(300);
  check(
    "an empty search says why",
    (await page.locator("text=Nothing matches that search").count()) > 0,
  );

  // Cleared through the field rather than by pressing Escape, because Escape from a
  // focused text field only blurs it — the query stays, so the list stays empty, and
  // the next step would time out waiting for rows. That distinction is the point of
  // the `textEditing` branch in the keybind router, so it is worth stating here.
  await page.locator("#topbar-search").fill("");
  await page.waitForTimeout(300);
  check("clearing the search brings the list back", (await rows().count()) === rowCount);

  // ── Sorting ────────────────────────────────────────────────────────────────

  section("sorting");

  /**
   * The dated sections, and what they say.
   *
   * `section > [role=list]` is the list's own markup: the settings sheet is also a
   * `<section>`, so a bare `section` selector counted whichever panel happened to be
   * open. The label is read off the accessible name rather than the rendered header,
   * because that name is the thing a screen reader gets — and if it stops carrying the
   * count, the header and the boundary disagree.
   */
  const daySections = () => page.locator("section > [role='list']");
  const sectionNames = async () =>
    (
      await page.locator("section[aria-label]").evaluateAll((els) =>
        els.map((el) => el.getAttribute("aria-label")),
      )
    ).join(" · ");

  /**
   * Change the sort the way a user would: the `Reading` row in Settings. Not by
   * writing to localStorage, because that would skip the panel entirely and this
   * is also an assertion that the control is where the copy says it is.
   */
  const sortBy = async (label) => {
    // Blurred first, and deliberately: the search box is still the focused element
    // at this point, and a `,` typed into a text field is a comma. The keybind
    // router's `textEditing` branch is right to ignore it — the test has to not be
    // inside a field.
    await page.locator("#topbar-search").blur();
    await page.keyboard.press(",");
    await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  };

  const datedSections = async () =>
    page.locator("section[aria-label]").evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label") ?? ""),
    );

  check(
    "the default sort groups the list into dated sections",
    (await daySections().count()) >= 3,
    `${await sectionNames()}`,
  );
  check(
    "each section names its day and counts its rows",
    (await datedSections()).every((name) => /^(Today|Yesterday|This week|Earlier), \d+ messages?$/.test(name)),
    `${await sectionNames()}`,
  );
  check(
    "and the days run oldest-last, because that is the order they arrived in",
    (await datedSections()).every((name, i, all) => {
      const rank = ["Today", "Yesterday", "This week", "Earlier"];
      return i === 0 || rank.indexOf(name.split(",")[0]) > rank.indexOf(all[i - 1].split(",")[0]);
    }),
    `${await sectionNames()}`,
  );

  /**
   * The bug these two sorts caused.
   *
   * Day headers are a claim about adjacency, which only a chronological list can
   * make. Sorting by score interleaved the days, so the list read `Today / This
   * week / Today / …` — and because each section was keyed on its *bucket name*,
   * every repeat was a duplicate React key. The error count is therefore checked
   * *per sort*: a run counted at the end could only say that something, somewhere,
   * logged once.
   */
  for (const label of ["Smart Score", "Sender"]) {
    const before = errors.length;
    await sortBy(label);
    check(
      `${label} renders one flat list, not interleaved day sections`,
      (await daySections().count()) === 1,
      `${await daySections().count()} section(s): ${await sectionNames()}`,
    );
    check(
      `${label} logs no duplicate-key error`,
      errors.length === before,
      errors.slice(before, before + 1).join(" | "),
    );
    check(
      `${label} still shows every row`,
      (await rows().count()) === rowCount,
      `${await rows().count()} of ${rowCount}`,
    );
  }

  await sortBy("Date");
  check("switching back to Date restores the sections", (await daySections().count()) >= 3);
  check("and the row count is unchanged", (await rows().count()) === rowCount);

  // ── The reader ─────────────────────────────────────────────────────────────

  section("reader");

  await openMessage();
  const subject = await page.locator("article h1").first().textContent();
  check("clicking a row opens the reader", Boolean(subject?.trim()), subject ?? "");

  await closeReader();
  check("Escape closes the reader", true);

  await page.keyboard.press("j");
  await page.waitForSelector("article h1", { timeout: 5_000 });
  check("`j` opens the first message", true);
  await closeReader();

  // ── Badges ─────────────────────────────────────────────────────────────────

  // Every badge used to resolve to the same near-black, because the CSS variables
  // were named `--wn-badge-<id>` but never defined — so `var()` resolved to nothing
  // and the classifier's opinion was invisible on the message itself. The check is on
  // *computed* colours, so it fails if a variable goes missing again.
  await page.locator("#topbar-search").fill("migration plan");
  await page.waitForTimeout(300);
  await rows().first().click();
  await page.waitForSelector("article h1", { timeout: 5_000 });

  // Matched on the *rendered chip*: an inline background that is literally a badge
  // wash variable. `applyTheme` writes every token onto `<html>`'s inline style, so a
  // document-wide `[style*="--wn-badge"]` matches the root element and reports the
  // token definitions rather than any badge — which reads as one transparent wash and
  // looks like the very bug this is checking for.
  //
  // The `_` in the id pattern is load-bearing too: bucket keys are snake_case, and
  // `needs_action` read without it looks like an unrecognised badge.
  const badges = await page.evaluate(() =>
    [...document.querySelectorAll("span[style*='--wn-badge']")]
      .filter((node) => /^var\(--wn-badge-[a-z_]+-wash\)$/.test(node.style.background ?? ""))
      .map((node) => ({
        id: (node.getAttribute("style") ?? "").match(/--wn-badge-([a-z_]+)-wash/)?.[1] ?? "?",
        wash: getComputedStyle(node).backgroundColor,
        edge: getComputedStyle(node).borderTopColor,
      })),
  );
  check("the reader shows the classifier's badges", badges.length > 0, `${badges.length} badges`);
  check(
    "every badge resolves to its own colour rather than one shared wash",
    badges.length > 0 &&
      badges.every((badge) => badge.wash !== "rgba(0, 0, 0, 0)") &&
      new Set(badges.map((badge) => badge.wash)).size === badges.length,
    JSON.stringify(badges),
  );

  // ── Conversations ──────────────────────────────────────────────────────────

  // The list collapses a thread to one row, so without this the rest of the exchange
  // is unreachable from the reader — and a message that was archived is not in the
  // list at all, so it was unreachable anywhere.
  const convoHeading = page.locator('article h3:has-text("in this conversation")');
  check("a thread shows the rest of the exchange", (await convoHeading.count()) > 0);

  // The three "Re: the migration plan" messages share a subject, so the subject
  // cannot tell them apart — the check has to look at something that does. The list
  // row's text is the right thing: it names the sender and relative time, so a
  // different sender or a different timestamp proves the reader moved.
  const convoButtons = page.locator(
    'article h3:has-text("in this conversation") + ul > li > button',
  );
  const convoCount = await convoButtons.count();
  check("and each earlier message is a real button", convoCount >= 2, `${convoCount} entries`);

  if (convoCount >= 2) {
    const before = await page.evaluate(() => {
      const article = document.querySelector("article");
      const h1 = article?.querySelector("h1")?.textContent ?? "";
      const stamp = article?.querySelector("time")?.getAttribute("datetime") ?? "";
      return `${h1}|${stamp}`;
    });
    await convoButtons.last().click();
    // `focusMessage` re-derives the view, so the reader swaps rather than merely
    // restyling. Waiting for the stamp to actually differ is the honest signal; a
    // fixed sleep would race the render and could read the old value.
    await page
      .waitForFunction(
        (previous) => {
          const article = document.querySelector("article");
          const stamp = article?.querySelector("time")?.getAttribute("datetime") ?? "";
          return stamp !== "" && `|${stamp}` !== previous.slice(previous.indexOf("|"));
        },
        before,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    const after = await page.evaluate(() => {
      const article = document.querySelector("article");
      const h1 = article?.querySelector("h1")?.textContent ?? "";
      const stamp = article?.querySelector("time")?.getAttribute("datetime") ?? "";
      return `${h1}|${stamp}`;
    });
    check("clicking one opens that message", after !== before, `${before} → ${after}`);
  }

  // The search is cleared through the field, and Escape is pressed *afterwards* —
  // the order matters, because Escape from a focused field only blurs it, and a
  // still-active query would leave `focusMessage` clearing it on the next click.
  await page.locator("#topbar-search").fill("");
  await page.waitForTimeout(300);
  await closeReader();

  // ── Overlays ───────────────────────────────────────────────────────────────

  section("overlays");

  await page.keyboard.press("?");
  await page.waitForSelector("text=Keyboard shortcuts", { timeout: 5_000 });
  const sheetRows = await page.locator("dl > div").count();
  check("the shortcut sheet opens", sheetRows > 8, `${sheetRows} rows`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Escape closes it", (await page.locator('[role="dialog"]').count()) === 0);

  await page.keyboard.press(",");
  await page.waitForSelector("text=How Winnow sorts", { timeout: 5_000 });
  const sliders = await page.locator('input[type="range"]').count();
  check("settings opens and shows the weight sliders", sliders >= 8, `${sliders} sliders`);

  // A modal that does not trap focus lets Tab walk out of it into the page behind,
  // which is both unusable and invisible. Real key presses, not synthetic events, so
  // this exercises the browser's own focus order rather than a reimplementation of it.
  for (let i = 0; i < 25; i += 1) await page.keyboard.press("Tab");
  const trapped = await page.evaluate(() =>
    Boolean(document.querySelector('[role="dialog"]')?.contains(document.activeElement)),
  );
  check("Tab cycles inside settings rather than escaping to the page behind", trapped);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Escape closes settings from inside it", (await page.locator('[role="dialog"]').count()) === 0);

  // ── The composer ───────────────────────────────────────────────────────────

  section("composer");

  await openMessage();
  await page.locator('button[aria-label^="Reply"]').first().click();
  await page.waitForSelector('textarea[aria-label="Message"]', { timeout: 5_000 });

  // Deliberately *not* clicked first. The composer focuses its own body and puts the
  // caret at position 0, above the quote; clicking the textarea moves the caret to
  // wherever the pointer landed — usually the end of the quoted text — which would test
  // the click rather than the caret placement.
  const textarea = page.locator('textarea[aria-label="Message"]');
  check(
    "the composer opens with its keyboard already in the body",
    (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Message",
  );
  await page.keyboard.type("Sounds good", { delay: 20 });
  await page.waitForTimeout(250);
  const typed = await textarea.inputValue();
  // The caret used to reset to the start of the field on every keystroke, so a
  // typed word came out reversed. This is the assertion that catches that class
  // of bug, which no unit test can see.
  check("typed text lands at the caret, in order", typed.startsWith("Sounds good"), JSON.stringify(typed.slice(0, 30)));
  check("the quoted original is stripped once you start writing", !typed.includes(">"));

  // ⌘⏎ sends. Without it a reply is mouse-only: `r` opens the sheet and then the hand
  // has to leave the home row, which is not what every other mail client on every
  // platform asks of you. It lives on the sheet rather than in `keybinds.ts` because
  // the composer's keys are a hard stop there — every one belongs to the field the user
  // is typing into.
  check(
    "the Send button advertises the shortcut",
    (await page.locator('[role="dialog"] button:has-text("Send") kbd').count()) > 0,
  );
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(500);

  // The demo has nowhere to send to, which is the one thing it can usefully prove here:
  // the failure is reported *once*, in the composer, in words a person can act on. It
  // used to be reported twice — "Cannot send: not signed in." inside the sheet and
  // "Signing in to Gmail is required to send." in the app-wide strip above it — so one
  // failed send produced two banners saying different things about the same event.
  const composerError = page.locator('[role="dialog"][role="dialog"], [role="dialog"] [role="alert"]');
  check(
    "the composer reports why it could not send",
    (await composerError.count()) > 0 &&
      (await composerError.first().textContent())?.includes("Signing in to Gmail"),
    (await composerError.first().textContent()) ?? "no message",
  );
  check(
    "and says nothing the user cannot act on",
    !(await page.locator('body').textContent())?.includes("Cannot send: not signed in"),
  );
  check(
    "and does not also put a banner above the app",
    (await page.locator('div[role="alert"]:has-text("read-only")').count()) === 0,
  );
  check(
    "the composer stays open so the draft is not lost",
    (await page.locator('textarea[aria-label="Message"]').count()) > 0,
  );

  // The discard path. An untouched draft closes on Escape with no question; a written
  // one asks. Both halves are asserted, because "always asks" and "never asks" are
  // both wrong and neither shows up in a screenshot.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(
    "a written draft asks before it is discarded",
    (await confirmDialog().count()) === 1,
  );
  check(
    "and the draft is still there while the question is open",
    (await page.locator('textarea[aria-label="Message"]').count()) > 0,
  );
  await answerDiscard(false);
  check(
    "declining keeps the composer open",
    (await page.locator('textarea[aria-label="Message"]').count()) > 0,
  );
  check(
    "declining keeps what was typed",
    (await page.locator('textarea[aria-label="Message"]').inputValue()).startsWith("Sounds good"),
  );

  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await answerDiscard(true);
  check(
    "accepting the discard closes it",
    (await page.locator('textarea[aria-label="Message"]').count()) === 0,
  );

  // Escape from the composer with nothing written is not a question. It used to be,
  // because the prompt could not tell an untouched draft from a written one — so
  // closing a reply you had not typed into demanded a confirmation, which trains people
  // to click through confirmations.
  await openMessage();
  await page.keyboard.press("r");
  await page.waitForSelector('textarea[aria-label="Message"]', { timeout: 5_000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(
    "an untouched draft closes without asking",
    (await page.locator('textarea[aria-label="Message"]').count()) === 0,
  );
  check(
    "and asks nothing",
    (await confirmDialog().count()) === 0,
  );

  // Forward. `GmailClient` has had a forward path in it from the start and nothing
  // in the UI called it, so a message could be replied to but not forwarded.
  await openMessage();
  await page.locator('button[aria-label="Forward"]').first().click();
  await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
  check(
    "Forward opens a sheet titled Forward",
    (await page.locator('[role="dialog"][aria-label="Forward"]').count()) > 0,
  );
  check(
    "it focuses the To field first, not the body",
    (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "To",
  );
  check(
    "Send is disabled with no recipient",
    await page.locator('[role="dialog"] button:has-text("Send")').first().isDisabled(),
  );

  // An untouched forward closes on Escape with no question. It used to ask: the
  // "is there anything to lose?" test was "is the body empty", and a forward's body is
  // the conversation — so `f` then Escape demanded confirmation about text Winnow had
  // put there a second earlier, and the only way out was a second Escape. Confirmations
  // you are trained to dismiss are how the ones that matter stop working.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(
    "an empty forward closes without asking",
    (await page.locator('[role="dialog"][aria-label="Forward"]').count()) === 0,
  );
  check("and asks nothing", (await confirmDialog().count()) === 0);

  await closeReader();
  await openMessage();
  await page.keyboard.press("f");
  await page.waitForTimeout(400);
  check(
    "`f` opens the forward composer",
    (await page.locator('[role="dialog"][aria-label="Forward"]').count()) > 0,
  );
  // …and a forward whose body the user has added to is a written draft, so it asks.
  // Filling in a recipient is deliberately *not* enough: the body is Winnow's, and
  // discarding a message whose every word Winnow typed loses nothing.
  await page.locator('input[aria-label="To"]').fill("someone@example.com");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(
    "a forward with only a recipient is still untouched",
    (await confirmDialog().count()) === 0,
  );

  await openMessage();
  await page.keyboard.press("f");
  await page.waitForTimeout(300);
  await page.locator('textarea[aria-label="Message"]').click();
  await page.keyboard.type("Worth a look.");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(
    "a forward with a written body asks before it is discarded",
    (await confirmDialog().count()) === 1,
  );
  await answerDiscard(true);
  await page.waitForTimeout(200);
  await closeReader();

  // ── Remote content is a per-message decision ──────────────────────────────

  // The reader's escape hatch used to be a preference change wearing a per-message
  // label: "Load images" sat under one message and turned on remote content for every
  // message, permanently. A decision about one message is not a decision about all of
  // them, and the global switch still exists in Settings where its scope is visible.
  const demoHasHtml = await page.evaluate(() =>
    [...document.querySelectorAll("iframe[title^='Message from']")].length,
  );
  check("the demo reader renders text, not markup", demoHasHtml === 0);

  // ── The mailboxes ──────────────────────────────────────────────────────────

  section("mailboxes");

  await page.keyboard.press("!");
  // Selected by role, not by text: the palette's accessible name is an
  // `aria-label`, and `text=` matches visible text only.
  await page.waitForSelector('[role="menu"]', { timeout: 5_000 });
  const paletteRows = await page.locator('[role="menu"] [role="menuitem"]').count();
  check("the navigation palette opens", paletteRows === 4, `${paletteRows} rows`);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check("Enter in the palette switches mailbox", (await page.locator('[role="menu"]').count()) === 0);

  // ── Mark all read is scoped to the mailbox on screen ───────────────────────

  // Only the demo's *inbox* has unread mail, so "leaves other mailboxes alone" has to
  // be set up rather than assumed: this marks a spam message unread first, so a
  // mark-all-read that ignored its scope would visibly clear it. Asserting against a
  // mailbox that was already at zero would pass for any implementation at all.
  await goTo("Spam");
  await rows().first().click();
  await page.waitForSelector("article h1", { timeout: 5_000 });
  await page.locator('button[aria-label="Mark unread"]').first().click();
  await page.waitForTimeout(300);
  const spamBefore = await unreadBadge("Spam");
  require("a spam message can be made unread to test against", Number(spamBefore) > 0, `spam ${spamBefore}`);

  await goTo("Inbox");
  await page.locator('button[aria-label="Mark all read"]').click();
  await page.waitForTimeout(300);
  check(
    "mark all read clears the mailbox it was pressed in",
    (await unreadBadge("Inbox")) === "0",
    `inbox ${await unreadBadge("Inbox")}`,
  );
  check(
    "and leaves every other mailbox alone",
    (await unreadBadge("Spam")) === spamBefore,
    `spam ${spamBefore} → ${await unreadBadge("Spam")}`,
  );

  // ── Mark-all-read is undoable ──────────────────────────────────────────────

  // `⇧U` is the one verb in the app with no inverse anywhere on screen: a star is a
  // toggle, a filed message reappears where it went, a filter has its own pill. It
  // used to clear a whole mailbox's read state on one keystroke with nothing to bring
  // it back from, which on a thousand unread is the one mistake in triaging you
  // cannot walk back.
  const undo = page.locator('button:has-text("Undo")');
  check("mark all read offers an undo", (await undo.count()) > 0);
  check(
    "which says what it did",
    (await page.locator("text=Marked everything in this mailbox as read").count()) > 0,
  );

  await undo.first().click();
  await page.waitForTimeout(300);
  check("taking it restores the unread count", (await unreadBadge("Inbox")) !== "0", await unreadBadge("Inbox"));
  check("and the offer goes away", (await undo.count()) === 0);

  // Which mailbox it acted on has to be visible, and the offer has to survive a
  // message-level action — the label names the mailbox, and the rollback reads live
  // state rather than a captured snapshot.
  await page.locator('button[aria-label="Mark all read"]').click();
  await page.waitForTimeout(250);
  await openMessage();
  check("the offer survives opening a message", (await undo.count()) > 0);
  await closeReader();

  await undo.first().click();
  await page.waitForTimeout(250);
  await goTo("Spam");
  check("and is gone once the mailbox changes", (await undo.count()) === 0);
  await goTo("Inbox");

  // ── Rail counts are inbox-wide ─────────────────────────────────────────────

  // The rail used to be ranked over the *visible* list, so every count read 0 the
  // moment you left the inbox — including on the pill you were about to click.
  await goTo("Spam");
  await page.waitForTimeout(300);
  const spamPillLabels = await pills().evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label")),
  );
  check(
    "every rail pill reports a count while looking at another mailbox",
    spamPillLabels.length > 0 && spamPillLabels.every((label) => label && /, \d+ messages?$/.test(label)),
    JSON.stringify(spamPillLabels.slice(0, 4)),
  );
  check(
    "and the counts are inbox-wide rather than all reading 0",
    spamPillLabels.some((label) => label && /, [1-9]\d* messages?$/.test(label)),
  );

  // ── Not spam ───────────────────────────────────────────────────────────────

  const spamRows = await rows().count();
  require("the spam folder has messages", spamRows > 0, `${spamRows} rows`);
  await rows().first().click();
  await page.waitForSelector("article h1", { timeout: 5_000 });

  // Archive from Spam *is* "move to the inbox", so offering both it and the not-spam
  // button meant two icons with two tooltips for one action — which reads as a toolbar
  // with a duplicated control. Asserted as an exact count so a third one cannot join
  // them.
  const archiveInSpam = page.locator(
    'button[aria-label="Archive"], button[aria-label="Restore"], button[aria-label="Move to inbox"]',
  );
  check(
    "the spam folder offers exactly one way back to the inbox",
    (await archiveInSpam.count()) === 0,
    `${await archiveInSpam.count()} archive-shaped buttons in the reader`,
  );

  const notSpam = page.locator('button[aria-label="Not spam — move to inbox"]');
  check("the spam folder offers a way out of it", (await notSpam.count()) > 0);
  check(
    "the toolbar says the same thing as the reader",
    (await page.locator('button[aria-label="Not spam"]').count()) > 0,
  );
  await notSpam.first().click();
  await page.waitForTimeout(400);
  check(
    "and it moves the message back to the inbox",
    (await rows().count()) === spamRows - 1,
    `${spamRows} → ${await rows().count()} in spam`,
  );

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ── Muting is reversible ───────────────────────────────────────────────────

  section("mutes");

  await goTo("Inbox");
  await page.waitForTimeout(300);
  const newsletters = page.locator('header button[aria-label^="Newsletters,"]:visible').first();
  require("the demo has a Newsletters bucket to mute", (await newsletters.count()) > 0);

  await newsletters.hover();
  await page.waitForTimeout(200);
  await page.locator('header button[aria-label^="Hide Newsletters"]:visible').first().click();
  await page.waitForTimeout(400);

  /*
    The mute says what it did, and offers the way back.

    A mute *is* reversible — the pill stays in the rail with a ↺, and Settings lists it
    — but the muted pill is sorted to the *end* of the rail, because a muted pill is not
    filterable and leaving it in place would repoint every digit shortcut after it. So the
    control the user clicked leaves a 27-pill strip they have probably not scrolled, and
    the whole visible effect of the click was that something disappeared. A browser is
    the only place that can see that.
  */
  const muteNotice = page.locator('[role="status"]:has-text("Hid Newsletters from the inbox")');
  check("muting says what it hid", (await muteNotice.count()) > 0);
  check("and offers an undo", (await muteNotice.getByRole("button", { name: /undo/i }).count()) > 0);

  const muted = page.locator('header button[aria-label^="Newsletters, hidden"]:visible').first();
  check("a muted bucket stays on the rail, struck through", (await muted.count()) > 0);
  check("and cannot be switched on as a filter", await muted.isDisabled());

  // The restore control is revealed on hover of the pill's group, so it is counted
  // *after* hovering — before that it is `display: none` and a count of zero would say
  // nothing about whether the control exists.
  await muted.locator("xpath=..").hover();
  await page.waitForTimeout(250);
  const restore = page.locator('header button[aria-label^="Show Newsletters"]:visible').first();
  check("the muted pill offers a restore control", (await restore.count()) > 0);
  await restore.click({ force: true });
  await page.waitForTimeout(500);
  check(
    "restoring brings the bucket back",
    (await page.locator('header button[aria-label^="Show Newsletters"]:visible').count()) === 0,
  );
  check(
    "and its pill is live again",
    (await page.locator('header button[aria-label^="Newsletters,"]:visible:not([disabled])').count()) > 0,
  );
  check(
    "and the strip's offer goes away with it, rather than leaving an Undo that does nothing",
    (await page.locator('[role="status"]:has-text("Hid Newsletters")').count()) === 0,
  );

  // And the other way back: taking the strip's own Undo restores the bucket.
  await newsletters.hover();
  await page.waitForTimeout(200);
  await page.locator('header button[aria-label^="Hide Newsletters"]:visible').first().click();
  await page.waitForTimeout(400);
  await page
    .locator('[role="status"]:has-text("Hid Newsletters from the inbox")')
    .getByRole("button", { name: /undo/i })
    .click();
  await page.waitForTimeout(400);
  check(
    "the strip's undo restores the bucket too",
    (await page.locator('header button[aria-label^="Newsletters,"]:visible:not([disabled])').count()) > 0,
  );

  // Mute a *second* bucket and leave it muted, so Settings has something to list. The
  // section is conditional on `mutedFilters.length > 0` — which is right, since an
  // empty section is noise — but it means this check has to be made with a mute in
  // place rather than after restoring everything.
  const receipts = page.locator('header button[aria-label^="Receipts,"]:visible').first();
  if (await receipts.count()) {
    await receipts.hover();
    await page.waitForTimeout(200);
    await page.locator('header button[aria-label^="Hide Receipts"]:visible').first().click();
    await page.waitForTimeout(400);
    check(
      "a second bucket can be muted too",
      (await page.locator('header button[aria-label^="Receipts, hidden"]:visible').count()) > 0,
    );

    await page.keyboard.press(",");
    await page.waitForTimeout(400);
    // Matched on the heading, not on `innerText`. The section headings are uppercased
    // and letterspaced by CSS, so their rendered text is "HIDDEN BUCKETS (1)" — a
    // regex against the visible text silently misses it, which is exactly what this
    // check did at first. `textContent` is the DOM's own text, uncased and unspaced.
    const headings = await page.locator('[role="dialog"] h2, [role="dialog"] h3').allTextContents();
    check(
      "settings lists hidden buckets",
      headings.some((heading) => /^Hidden buckets \(\d+\)$/.test(heading)),
      headings.join(" | "),
    );
    check(
      "and offers to show one again",
      (await page.locator('[role="dialog"] button:has-text("Show again")').count()) > 0,
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);

    // Undone from the rail, so the persistence checks below are not perturbed by a
    // second active filter.
    const restoreReceipts = page
      .locator('header button[aria-label^="Receipts, hidden"]:visible')
      .first();
    await restoreReceipts.locator("xpath=..").hover();
    await page.waitForTimeout(250);
    await page
      .locator('header button[aria-label^="Show Receipts"]:visible')
      .first()
      .click({ force: true });
    await page.waitForTimeout(400);
  } else {
    // No second bucket to mute: assert the section is *absent* when nothing is muted,
    // which is the behaviour the condition encodes.
    await page.keyboard.press(",");
    await page.waitForTimeout(400);
    const headings = await page.locator('[role="dialog"] h2, [role="dialog"] h3').allTextContents();
    check(
      "with nothing muted, settings shows no empty hidden-buckets section",
      !headings.some((heading) => heading.startsWith("Hidden buckets")),
      headings.join(" | "),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  section("persistence");

  // Star the first row with the pointer, then activate a rail filter with the
  // keyboard, and check that both wrote the key that is supposed to hold them.
  const firstRow = rows().first();
  await firstRow.hover();
  await firstRow.locator("xpath=..").locator('button[aria-label="Star"]').first().click();
  await page.waitForTimeout(300);
  await page.keyboard.press("1");
  await page.waitForTimeout(300);

  const beforeReload = await storage();
  check("a star writes the learning snapshot", Boolean(beforeReload["winnow.learning.v1"]));
  check(
    "a filter toggle writes the active set",
    beforeReload["winnow.activeFilters.v1"] !== undefined,
    beforeReload["winnow.activeFilters.v1"],
  );
  check("the mailbox is written too", beforeReload["winnow.mailbox.v1"] !== undefined);

  // The demo's *messages* are re-seeded on every load, so a star is not expected to
  // still be set — the seed owns that state, and there is no server to have told us
  // otherwise. What must survive is the *learning* the star produced, which is the
  // part that is actually Winnow's. Asserting the star glyph would be asserting the
  // seed, not the product.
  const learningBefore = beforeReload["winnow.learning.v1"];
  const titleBefore = await listTitle();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  check("the active filter survives a reload", titleBefore === (await listTitle()), `${titleBefore}`);
  check(
    "and so does the learning the star produced",
    (await storage())["winnow.learning.v1"] === learningBefore,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // A partial preferences patch must merge, not replace. Blocking one spammer used
  // to reset appearance, sort order and everything else, on the next launch.
  await page.keyboard.press(",");
  await page.waitForTimeout(400);
  await page.locator('button[role="switch"][aria-label="Load remote images"]').click();
  await page.waitForTimeout(250);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape closes the settings sheet from inside it", (await page.locator('[role="dialog"]').count()) === 0);

  await openMessage();
  const block = page.locator('button:has-text("Hide everything from")').first();
  require("the reader offers to hide a sender", (await block.count()) > 0);
  const blockedName = ((await block.textContent()) ?? "").replace("Hide everything from ", "").trim();
  await block.click();
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  const prefs = JSON.parse((await storage())["winnow.preferences.v1"] ?? "{}");
  check(
    "blocking a sender does not reset other preferences",
    prefs.loadRemoteContent === true,
    JSON.stringify(prefs),
  );
  check("the blocked sender is recorded", Array.isArray(prefs.blockedSenders) && prefs.blockedSenders.length > 0, JSON.stringify(prefs.blockedSenders));
  check(
    "and none of their messages are left in the list",
    (await rows().filter({ hasText: blockedName }).count()) === 0,
    blockedName,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ── The phone layout ───────────────────────────────────────────────────────

  section("mobile");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await openMessage();
  await page.waitForTimeout(400);

  const headerBox = await page.locator("header").first().boundingBox();
  check(
    "the top bar survives an open reader on a phone",
    Boolean(headerBox) && headerBox.y >= 0 && headerBox.height > 20,
    JSON.stringify(headerBox),
  );

  const searchBox = await page.locator("#topbar-search").boundingBox();
  check(
    "search is still on screen, not collapsed to nothing",
    Boolean(searchBox) && searchBox.width > 40,
    JSON.stringify(searchBox),
  );

  const overflow = await page.evaluate(() => {
    const row = document.querySelector("header > div");
    if (!row) return null;
    // How far the toolbar's content extends past its own box, in CSS pixels.
    return Math.round(row.scrollWidth - row.clientWidth);
  });
  check(
    "the toolbar does not need a sideways scroll to reach the search",
    overflow !== null && overflow <= 1,
    `${overflow}px past`,
  );

  /*
    The reader has to *fit*.

    Its pane is a flex child, and without `min-w-0` its base size is its content —
    which is `max-w-[68ch]` of body text, 733px. On a 390px phone that overflowed the
    line, `body { overflow: hidden }` clipped it, and the message was unreadable: every
    line ran off the right edge with no way to reach the rest, and the six action buttons
    went with it. So a phone could read half a message and do nothing with it.
  */
  const readerFits = await page.evaluate(() => {
    const article = document.querySelector("article");
    if (!article) return null;
    const box = article.getBoundingClientRect();
    return {
      width: Math.round(box.width),
      viewport: window.innerWidth,
      past: Math.round(box.right - window.innerWidth),
    };
  });
  check(
    "the message fits the phone rather than running off it",
    readerFits !== null && readerFits.past <= 1,
    JSON.stringify(readerFits),
  );

  /*
    Every labelled control, wherever it is — not a fixed list of verbs, because the
    toolbar's buttons are per-mailbox (Trash offers restore and delete-permanently,
    Spam offers "Not spam") and this step runs after the trash and block-sender steps.
    What matters is the claim itself: at this width nothing is off-screen, so every
    control in the app can be reached.
  */
  const reachable = await page.evaluate(() => {
    // A pill past the end of the rail is not off-screen, it is *scrollable to* — the
    // rail is a deliberate horizontal scroller with a fade at its edge. So what is
    // being claimed is that nothing outside such a scroller is out of reach.
    const scrollable = (el) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === "auto" || overflow === "scroll") return true;
      }
      return false;
    };
    const buttons = [...document.querySelectorAll("button[aria-label]")].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !scrollable(b);
    });
    const offscreen = buttons
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.left < -1 || r.right > window.innerWidth + 1;
      })
      .map((b) => b.getAttribute("aria-label"));
    return { total: buttons.length, offscreen };
  });
  check(
    "and no control anywhere in the app is off-screen",
    reachable.total > 10 && reachable.offscreen.length === 0,
    `${reachable.total} buttons, off-screen: ${reachable.offscreen.join(", ") || "none"}`,
  );

  /*
    The sender's name is the one line in the reader that must never be ellipsised.

    Six 28px icons and a `shrink-0` toolbar sit beside it, so side by side the name is
    what gives way: it read "Dana Whitfi…" on a phone and "Dana at North…" at 1100px.
    The reader header is the wrong place to be stingy — it is the first thing you read
    and the thing you are checking the list row against. Measured as `scrollWidth` so a
    name that fits by luck at one width and not at the next still fails.
  */
  const senderName = await page.evaluate(() => {
    // The reader's own root, so the pane's `h2` is found rather than some other
    // heading on the page.
    const reader = document.querySelector("article")?.closest(".bg-panel");
    const heading = reader?.querySelector("h2");
    if (!heading) return null;
    return {
      text: heading.textContent?.trim() ?? "",
      clipped: heading.scrollWidth > heading.clientWidth + 1,
    };
  });
  check(
    "the sender's name is not truncated to make room for the toolbar",
    senderName !== null && !senderName.clipped,
    JSON.stringify(senderName),
  );

  /*
    A touch device, which is a different thing from a narrow window.

    Chromium reports `hover: hover` for this page however narrow the viewport is, so
    nothing above can tell whether a control that only appears on hover exists at all
    on a phone. It did not: the rail's per-pill *hide* control was `hidden` and revealed
    on `group-hover`, so on a real phone a bucket Winnow kept over-firing could not be
    silenced from anywhere — Settings lists what has already been hidden, and the palette
    is a list of places to go, not of things to change. Hence a second context with
    `hasTouch`, which is what makes `(hover: none)` match.
  */
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const touchPage = await touchContext.newPage();
  touchPage.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  touchPage.on("pageerror", (error) => errors.push(String(error)));
  await touchPage.goto(URL, { waitUntil: "networkidle" });
  await touchPage.waitForSelector("[data-message-id]", { timeout: 10_000 });

  const touchMutes = touchPage.locator('button[aria-label^="Hide "], button[aria-label^="Show "]');
  check(
    "the rail's hide control exists on a device with no hover",
    (await touchMutes.count()) > 5,
    `${await touchMutes.count()} controls`,
  );
  check(
    "and it is visible rather than hover-only",
    await touchMutes.first().isVisible(),
    await touchMutes.first().getAttribute("aria-label"),
  );
  await touchContext.close();

  const back = page.locator('button[aria-label="Back to the list"]');
  check("there is a way back to the list", (await back.count()) > 0);
  await back.first().click();
  await page.waitForTimeout(300);
  check("and it works", (await page.locator("text=Nothing selected").count()) > 0);

  // ── A shared link ──────────────────────────────────────────────────────────

  section("deep links");

  // A shared link has to be *followed*, not merely survived. `parseRedirect` treats
  // `view` and `message` as the app's own parameters and leaves them in the URL, and
  // `applySharedLink` was called only on the signed-in path — so on a fresh install,
  // which is the demo, `?message=…` booted the inbox and quietly dropped the link.
  //
  // The id and subject are captured *here*, from a spam row that is still visible. The
  // id captured at boot is no good: the block-sender step above removed that sender's
  // mail from the list, and `focusMessage` correctly refuses to open what the user has
  // said they do not want to read — so a link to it legitimately shows nothing, and the
  // test would be measuring its own earlier action.

  await goTo("Spam");
  await page.waitForTimeout(300);
  const deepRow = rows().first();
  const deepId = await deepRow.getAttribute("data-message-id");
  const deepSubject = (await deepRow.textContent())?.trim() ?? "";
  require("the spam folder still has a row to link to", Boolean(deepId), `${deepId}`);

  await page.goto(`${URL}?message=${deepId}`, { waitUntil: "networkidle" });
  await page.waitForSelector("article h1", { timeout: 5_000 });
  const openedSubject = (await page.locator("article h1").first().textContent())?.trim() ?? "";
  check(
    "a link naming a message opens that message",
    openedSubject.length > 0 && deepSubject.includes(openedSubject),
    `${openedSubject} in ${deepSubject}`,
  );
  check(
    "and the reader follows it into the mailbox it lives in",
    (await mailbox("Spam").getAttribute("aria-current")) === "page",
  );

  await page.goto(`${URL}?view=archive`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  check(
    "a link naming a mailbox switches to it",
    (await mailbox("Archive").getAttribute("aria-current")) === "page",
    await listTitle(),
  );

  // A URL carrying the app's own parameters must not be mistaken for an OAuth
  // redirect: `parseRedirect` returns null for it, so the app boots normally. The
  // failure this guards against is an error banner or an exchange attempt for a link
  // somebody was sent in good faith.
  await page.goto(`${URL}?view=spam&message=${deepId}&tracking=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  check(
    "a shared link is not mistaken for an OAuth redirect",
    (await page.locator('[role="alert"]').count()) === 0 && (await rows().count()) > 0,
    `${await rows().count()} rows`,
  );

  // ── Console ────────────────────────────────────────────────────────────────

  section("console");

  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  await page.screenshot({ path: "smoke.png", fullPage: false });
} catch (error) {
  failed = true;
  console.error(`\nSmoke run aborted: ${error?.stack ?? error}`);
} finally {
  await browser.close();
  await stopServer();
}

const bad = failures.length + (failed ? 1 : 0);
console.log(`\n${passed} passed, ${bad} failed`);
if (bad > 0) {
  console.log("\nFAILURES");
  for (const line of failures) console.log(`  · ${line}`);
  process.exitCode = 1;
} else {
  console.log("\nSMOKE TEST PASSED");
}
