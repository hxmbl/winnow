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
// `WINNOW_CHROMIUM` points at a system Chromium, for machines where Playwright's own
// download is not available (linux-arm64 sandboxes, for one). CI uses the bundled one.
const browser = await chromium.launch(
  process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM } : {},
);
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
  //
  // Two different questions, and conflating them is the trap: `rows` counts what is
  // *mounted*, which since the list was windowed is a viewport-sized window rather
  // than the whole mailbox. `rowTotal` counts what the mailbox *holds*, read from the
  // attribute the list publishes for exactly this. Anything asserting "how many
  // messages match" wants `rowTotal`; anything that needs to click or await a
  // specific row wants `rows`.
  const rows = () => page.locator("[data-message-id]");
  // Zero when the list is empty: the empty state replaces the list wholesale, so there
  // is no `[data-row-count]` element to read. `count()` returns without waiting, which
  // is what keeps this from hanging for the 30s a `getAttribute` would.
  const rowTotal = async () => {
    const locator = page.locator("[data-row-count]").first();
    if ((await locator.count()) === 0) return 0;
    const raw = await locator.getAttribute("data-row-count");
    return raw === null ? 0 : Number(raw);
  };
  // Scoped to the live rail. It was rendered twice — inline at `lg` and again on its
  // own row below it — and counting both would have doubled every number here; there is
  // one copy now, and the `:visible` guard documents that it is a layout assumption
  // rather than a structural one.
  const pills = () => page.locator("header button[aria-pressed]:visible");
  /**
   * The mailbox menu, which the logo opens.
   *
   * Mailboxes used to be four always-visible pills, so every assertion about them
   * went straight at `header nav`. They are now a drawer behind the mark, which means
   * the navigation has to be *opened* before it can be asserted on — and that opening
   * it is itself a thing worth asserting.
   */
  const drawer = () => page.locator('[role="dialog"][aria-label="Navigation"]');
  /**
   * Open the drawer, and be idempotent about it.
   *
   * Two things it has to survive. It may already be open — several callers read a
   * mailbox count and then switch, and clicking the mark behind its own panel does
   * nothing. And a sheet that closed on the previous line can still have its
   * `role="presentation"` backdrop mounted for a frame, which swallows the click and
   * reports the mark as unclickable.
   */
  const openDrawer = async () => {
    if ((await drawer().count()) > 0) return;
    await page
      .waitForFunction(() => !document.querySelector('[role="presentation"]'), null, { timeout: 5_000 })
      .catch(() => undefined);
    await page.locator('button[aria-label="Open navigation"]').click();
    await drawer().waitFor({ state: "visible", timeout: 5_000 });
  };
  const closeDrawer = async () => {
    await page.keyboard.press("Escape");
    await drawer().waitFor({ state: "detached", timeout: 5_000 });
  };
  const mailbox = (name) =>
    page.locator('[role="dialog"][aria-label="Navigation"] nav[aria-label="Mailboxes"] button', {
      hasText: name,
    }).first();
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
    await openDrawer();
    await mailbox(name).click();
    await drawer().waitFor({ state: "detached", timeout: 5_000 });
    await page.waitForTimeout(250);
  };
  /**
   * The unread count on a mailbox row, or `0` when it has none.
   *
   * The counts live in the drawer now, so this opens it, reads, and closes. The old
   * version read a `span` out of an always-visible tab and returned `"0"` for a mailbox
   * that was simply not on screen — which is indistinguishable from a real zero, and
   * made the mark-all-read scoping checks assert against a number that was never read.
   */
  const unreadBadge = async (name) => {
    await openDrawer();
    const row = mailbox(name);
    await row.waitFor({ state: "visible", timeout: 5_000 });
    const text = await row.getAttribute("data-unread");
    await closeDrawer();
    // Absent means zero: a mailbox with nothing unread shows no count at all, which
    // is the same thing to a reader as "0".
    return text ?? "0";
  };
  const listTitle = () => page.locator("header span[title]").first().textContent();
  const search = () => page.locator("#winnow-search");

  await page.goto(URL, { waitUntil: "networkidle" });


  // ── It boots ───────────────────────────────────────────────────────────────

  section("boot");

  await page.waitForSelector("text=Nothing selected", { timeout: 10_000 });
  check("the app boots into the demo, with the reader's empty state", true);

  const rowCount = await rowTotal();
  require("the demo mailbox has rows", rowCount > 20, `${rowCount} rows`);
  check("the demo mailbox is populated", true, `${rowCount} rows`);

  // The windowing itself. The list publishes its true size and mounts only what the
  // viewport needs; a large mailbox must not become one DOM subtree per message, which
  // is what it used to do — 5,000 rows meant 5,000 row components in the tree.
  const mounted = await rows().count();
  check(
    "and mounts only a window of them",
    mounted > 0 && mounted <= rowCount,
    `${mounted} mounted of ${rowCount}`,
  );
  check(
    "the mounted window is smaller than the mailbox",
    mounted < rowCount,
    `${mounted} mounted of ${rowCount}`,
  );

  const pillCount = await pills().count();
  require("the filter rail is populated", pillCount > 5, `${pillCount} pills`);
  check("the filter rail is ranked", true, `${pillCount} pills`);

  const title = await listTitle();
  check("the list says what it is showing", Boolean(title?.trim()), title ?? "");

  // The rail is the product. It used to share a row with the mailbox nav, the search
  // box, five action buttons, two icon buttons and the position cluster, and every one
  // of those was `shrink-0`, so the rail — the only elastic child — absorbed the whole
  // shortfall and showed three pills at 1440px.
  //
  // It is now in the masthead, absolutely positioned across the whole row and inset by
  // the logo on the left and the search cluster on the right, so the filters pass
  // *underneath* the mark. Asserted as a ratio rather than a pixel count, because the
  // number of pills depends on the mailbox; what matters is that most of them are
  // reachable without scrolling, and that the rail has not been squeezed out of
  // existence by the two things it now shares a row with.
  const rail = await page.evaluate(() => {
    // Not `header .no-scrollbar.overflow-x-auto` — there is no other one now, but the
    // rail is defined by holding pressed-state pills rather than by its class list.
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
  check("it has real width to work with", (rail?.width ?? 0) > 900, `${rail?.width}px`);
  /**
   * Six, not eight.
   *
   * The rail used to have a row to itself and showed a dozen pills. It now shares the
   * masthead row with the search field and the position cluster — which is the whole
   * point of the redesign — and those two take ~360px of a 1440px window, so the rail
   * sees ~1015px and shows seven of its twenty-seven pills without scrolling.
   *
   * The trade is deliberate and it is recorded here rather than engineered away: one row
   * with seven visible filters beats three stacked rows with twelve, because the thing
   * being removed was the stack. The digit shortcut is on every pill and the rail
   * scrolls, so nothing is unreachable — it just takes a scroll rather than a glance.
   */
  check(
    "so a useful run of it is reachable without scrolling",
    (rail?.visible ?? 0) >= Math.min(6, rail?.total ?? 0),
    `${rail?.visible} of ${rail?.total} pills in ${rail?.width}px`,
  );

  /**
   * The filters pass *under* the logo rather than the logo moving out of their way.
   *
   * This is the masthead's one novel behaviour and it is invisible in a screenshot of
   * the resting state, because at rest the first pill clears the mark anyway. Scrolling
   * the rail is what makes it observable: a pill has to end up underneath the mark, and
   * the mark has to still be there, and still be the logo.
   */
  const underTheLogo = await page.evaluate(async () => {
    const scroller = [...document.querySelectorAll("header div.no-scrollbar")].find((element) =>
      element.querySelector("button[aria-pressed]"),
    );
    const logo = document.querySelector('button[aria-label="Open navigation"]');
    if (!scroller || !logo) return null;
    const logoBox = logo.getBoundingClientRect();
    scroller.scrollLeft = 260;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pills = [...scroller.querySelectorAll("button[aria-pressed]")];
    // A pill whose box reaches under the mark while the mark is still in place.
    const crossing = pills.filter((pill) => {
      const r = pill.getBoundingClientRect();
      return r.left < logoBox.right && r.right > logoBox.left;
    });
    return {
      scrolled: scroller.scrollLeft,
      crossing: crossing.length,
      logoStillThere: Boolean(document.querySelector('button[aria-label="Open navigation"] svg')),
      pillUnderneath: crossing.some((pill) => {
        const r = pill.getBoundingClientRect();
        return r.left < logoBox.left + logoBox.width / 2;
      }),
    };
  });
  check(
    "scrolling the filters carries them under the logo",
    underTheLogo !== null && underTheLogo.scrolled > 0 && underTheLogo.crossing > 0,
    JSON.stringify(underTheLogo),
  );
  check(
    "and the logo does not move to get out of the way",
    underTheLogo?.logoStillThere === true,
    JSON.stringify(underTheLogo),
  );
  check(
    "and a pill really does end up beneath it",
    underTheLogo?.pillUnderneath === true,
    JSON.stringify(underTheLogo),
  );
  await page.evaluate(() => {
    const scroller = [...document.querySelectorAll("header div.no-scrollbar")].find((element) =>
      element.querySelector("button[aria-pressed]"),
    );
    if (scroller) scroller.scrollLeft = 0;
  });
  await page.waitForTimeout(150);

  // The position cluster said "0 of 38" before the keyboard had ever been touched,
  // which reads as an empty mailbox — and "0 of 0" on a narrowed list.
  const position = await page.locator("header").getByText(/^(—|\d+)\s*\/?\s*(of\s*)?\d+$/).count();
  check("the position cluster is not claiming row 0", position > 0);
  // It used to be "— / 39": a dash for "no row", then a slash that read as a fraction.
  // An untouched list now shows the total and nothing else; "3 of 39" once it moves.
  const readout = ((await page.locator("header [data-position]").first().textContent()) ?? "").trim();
  check(
    "an untouched list shows the total rather than a row number",
    /^\d+$/.test(readout) && Number(readout) === (await rowTotal()),
    JSON.stringify(readout),
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

  // ── The triage line ────────────────────────────────────────────────────────

  // The inbox opens with a sentence about what needs you, built from the classifier's
  // own signals. The demo seed has unread asks in it, so the sentence must count
  // something rather than fall back to "Nothing needs you right now".
  const attention = ((await page.locator("[data-attention]").first().textContent()) ?? "").trim();
  check(
    "the inbox leads with what needs attention, as a sentence",
    /^\d+ waiting on you\b/.test(attention),
    JSON.stringify(attention),
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
    (await page.evaluate(() => document.activeElement?.id)) === "winnow-search",
  );
  await page.keyboard.type("migration");
  await page.waitForTimeout(300);
  const searchRows = await rowTotal();
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
  await page.locator("#winnow-search").fill("migration plan");
  await page.waitForTimeout(300);
  const bothTokens = await rowTotal();
  check("two tokens that co-occur both match", bothTokens > 0, `${bothTokens} rows`);

  // A second token that cannot co-occur must narrow to nothing rather than being
  // ignored, which is what "AND" has to mean to be worth anything.
  await page.locator("#winnow-search").fill("migration zzzznotaword");
  await page.waitForTimeout(300);
  const impossiblePair = await rowTotal();
  check(
    "and an impossible pair narrows to nothing rather than ignoring a token",
    impossiblePair === 0,
    `migration + nonsense → ${impossiblePair}`,
  );

  // Order must not matter, since the tokens are a set rather than a phrase.
  await page.locator("#winnow-search").fill("migration plan");
  await page.waitForTimeout(250);
  const ordered = await rowTotal();
  await page.locator("#winnow-search").fill("plan migration");
  await page.waitForTimeout(250);
  const reversed = await rowTotal();
  check("token order does not matter", ordered === reversed, `${ordered} vs ${reversed}`);
  await page.locator("#winnow-search").fill("");
  await page.waitForTimeout(300);

  await page.locator("#winnow-search").fill("zzzznothingmatchesthis");
  await page.waitForTimeout(300);
  check(
    "an empty search says why",
    (await page.locator("text=Nothing matches that search").count()) > 0,
  );

  // Cleared through the field rather than by pressing Escape, because Escape from a
  // focused text field only blurs it — the query stays, so the list stays empty, and
  // the next step would time out waiting for rows. That distinction is the point of
  // the `textEditing` branch in the keybind router, so it is worth stating here.
  await page.locator("#winnow-search").fill("");
  await page.waitForTimeout(300);
  check("clearing the search brings the list back", (await rowTotal()) === rowCount);

  /**
   * The list is still scrollable after coming back from empty.
   *
   * Not a redundant restatement of the row count above: an empty result *unmounts* the
   * scroller and renders the empty state in its place, so clearing the search mounts a
   * **different** element. Anything the list attached to the old one — the scroll
   * listener, the viewport measurement — is attached to an element that no longer
   * exists, and the list then looks entirely correct while scrolling does nothing. It
   * showed up here as a list that reported 38 rows and a window stuck at the first
   * message, and it is invisible to any check that only counts.
   */
  const scroller = page.locator("[data-row-count]").first();
  const firstMounted = () =>
    scroller.evaluate((el) => el.querySelector("[data-message-id]")?.getAttribute("data-message-id") ?? null);

  const rowBeforeScroll = await firstMounted();
  const scrollAfter = await scroller.evaluate((el) => {
    el.scrollTop = Math.min(el.scrollTop + el.clientHeight, el.scrollHeight);
    return el.scrollTop;
  });
  await page.waitForTimeout(250);
  const rowAfterScroll = await firstMounted();

  check("and the list still scrolls after coming back from empty", scrollAfter > 0, `scrollTop ${scrollAfter}`);
  check(
    "and the mounted window followed it, rather than staying pinned to the top",
    rowAfterScroll !== null && rowAfterScroll !== rowBeforeScroll,
    `${rowBeforeScroll} → ${rowAfterScroll}`,
  );

  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);

  // ── Sorting ────────────────────────────────────────────────────────────────

  section("sorting");

  /**
   * The dated sections, and what they say.
   *
   * `section[aria-label]` rather than a bare `section`, because the settings sheet is
   * also a `<section>` and a bare selector counted whichever panel happened to be open.
   * The label is read off the accessible name rather than the rendered header, because
   * that name is the thing a screen reader gets — and if it stops carrying the count,
   * the header and the boundary disagree.
   */
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
    await page.locator("#winnow-search").blur();
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

  /**
   * Every day boundary in the list, collected by scrolling from the top to the bottom.
   *
   * The list is windowed, so the days that happen to intersect the viewport are the
   * only ones mounted at any moment — asking "how many days does this list have" from
   * the DOM once measures the window, not the list, and it silently became a weaker
   * assertion the moment windowing landed. Walking the scroll position is how the
   * question gets asked of the whole list, and it exercises the scrolling path while
   * doing it.
   *
   * Deduplicated by name, because a day whose rows straddle a window edge renders as
   * two sections with the same accessible name — correct, and invisible to a user.
   */
  const allDaySections = async () => {
    const scroller = page.locator("[data-row-count]").first();
    if ((await scroller.count()) === 0) return [];
    const seen = new Set();
    const collect = async () => {
      for (const name of await datedSections()) seen.add(name);
    };

    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    await collect();

    // Step by roughly a viewport each way, so no day is skipped between two
    // positions even when the list is much taller than the window.
    for (let guard = 0; guard < 40; guard += 1) {
      const moved = await scroller.evaluate((el) => {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + el.clientHeight, el.scrollHeight);
        return el.scrollTop !== before;
      });
      await page.waitForTimeout(120);
      await collect();
      if (!moved) break;
    }

    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    return [...seen];
  };

  check(
    "the default sort groups the list into dated sections",
    (await allDaySections()).length >= 3,
    `${await allDaySections()}`,
  );
  check(
    "each section names its day and counts its rows",
    (await datedSections()).every((name) => /^(Today|Yesterday|This week|Earlier), \d+ messages?$/.test(name)),
    `${await sectionNames()}`,
  );
  check(
    "and the days run oldest-last, because that is the order they arrived in",
    (await allDaySections()).every((name, i, all) => {
      const rank = ["Today", "Yesterday", "This week", "Earlier"];
      return i === 0 || rank.indexOf(name.split(",")[0]) > rank.indexOf(all[i - 1].split(",")[0]);
    }),
    `${await allDaySections()}`,
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
      // Zero *labelled* sections, which is the claim: day headers are an assertion
      // about adjacency, and a score- or sender-sorted list interleaves the days, so
      // there must be none. Counted across the whole list by scrolling, because a
      // single position only shows the part of it that is mounted.
      (await allDaySections()).length === 0,
      `${(await allDaySections()).length} dated section(s)`,
    );
    check(
      `${label} logs no duplicate-key error`,
      errors.length === before,
      errors.slice(before, before + 1).join(" | "),
    );
    check(
      `${label} still shows every row`,
      (await rowTotal()) === rowCount,
      `${await rowTotal()} of ${rowCount}`,
    );
  }

  await sortBy("Date");
  check("switching back to Date restores the sections", (await allDaySections()).length >= 3);
  check("and the row count is unchanged", (await rowTotal()) === rowCount);

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

  // ── Smart filters in the reader ───────────────────────────────────────────

  // These were colour chips: an eleven-hue wash whose whole identity was the fill,
  // with a label in a derived ink on top. Nothing about that was readable without
  // knowing the ramp, it vanished for a colour-blind reader, in dark mode, and in a
  // screenshot — and `theme.ts` spent a hundred lines deriving label colours that
  // clear AA *on their own wash*, which is a measure of how much of the design was
  // committed to keeping a colour legible rather than saying what it meant.
  //
  // So the reader states them as an icon and a word. Asserted on the word and on the
  // explanation, because that is the claim being made: not "this message has a colour"
  // but "Winnow thinks this message is important, and here is why".
  await page.locator("#winnow-search").fill("migration plan");
  await page.waitForTimeout(300);
  await rows().first().click();
  await page.waitForSelector("article h1", { timeout: 5_000 });

  const filters = await page.evaluate(() =>
    [...document.querySelectorAll("[data-filter-tag]")].map((tag) => ({
      id: tag.getAttribute("data-filter-tag"),
      label: (tag.childNodes[1]?.textContent ?? "").trim(),
      title: tag.getAttribute("title"),
      hasGlyph: Boolean(tag.querySelector("svg")),
      // The word must be real text, not a colour.
      srText: (tag.querySelector(".sr-only")?.textContent ?? "").trim(),
    })),
  );
  check("the reader names the smart filters", filters.length > 0, `${filters.length} filters`);
  check(
    "each one is an icon and a word, not a colour",
    filters.every((f) => f.hasGlyph && f.label.length > 0),
    JSON.stringify(filters),
  );
  check(
    "and hovering one explains the classification",
    filters.every((f) => (f.title ?? "").length > f.label.length + 8),
    JSON.stringify(filters.map((f) => f.title)),
  );
  check(
    "and the explanation reaches assistive technology too",
    filters.every((f) => f.srText.includes(f.title)),
    JSON.stringify(filters.map((f) => f.srText)),
  );

  /**
   * The same vocabulary in the list, said once.
   *
   * Rows used to carry a cluster of glyphs — bookmark, bolt, shield — on most messages.
   * A row now says at most one thing, as a word (unsafe, urgent or security, else "New"),
   * from the same `ui/filterIcons` explanations the reader uses, so hovering it still
   * says *why*.
   */
  const rowFilters = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-message-id]")].slice(0, 12);
    return rows.map((row) => ({
      glyphs: row.querySelectorAll("svg").length,
      labels: [...row.querySelectorAll("span[title]")].map((s) => ({
        text: (s.textContent ?? "").trim(),
        title: s.getAttribute("title"),
      })),
    }));
  });
  check(
    "list rows carry one signal at most, as a word rather than an icon cluster",
    rowFilters.every((row) => row.glyphs === 0 && row.labels.length <= 1) &&
      rowFilters.some((row) => row.labels.length === 1),
    JSON.stringify(rowFilters.filter((r) => r.labels.length > 0).slice(0, 3)),
  );
  check(
    "and every row signal explains itself on hover",
    rowFilters.every((row) => row.labels.every((l) => (l.title ?? "").length > l.text.length + 8)),
    JSON.stringify(rowFilters.flatMap((r) => r.labels).slice(0, 4)),
  );

  // ── The reader holds its message when the filters change ──────────────────

  /**
   * The regression this redesign had to not introduce, and which the app used to have.
   *
   * Changing a smart filter is a statement about which rows to *show*. It used to also
   * replace or close whatever was open in the reader, because the open message was
   * resolved out of the filtered rows: toggling a bucket mid-triage silently threw away
   * the email being read and put a different one on screen.
   *
   * So: open a message, turn on a filter that excludes it, and the reader must not
   * move. The list is allowed to change — that is what was asked for.
   */
  const openBefore = await page.locator("article h1").textContent();
  const excludingPill = pills().filter({ hasText: "Deliveries" }).first();
  if ((await excludingPill.count()) > 0) {
    await excludingPill.click();
    await page.waitForTimeout(350);
    const openAfter = await page.locator("article h1").textContent();
    check(
      "changing a smart filter does not replace the open email",
      openAfter === openBefore,
      `${openBefore} → ${openAfter}`,
    );
    check(
      "and does not close it either",
      (await page.locator("article h1").count()) > 0,
    );
    // Cleared through the rail's own "All" rather than by clicking the pill again:
    // an active pill is hoisted to the front of the rail, so the second `Deliveries`
    // lookup can land on a different element than the first.
    const all = page.locator('header button:has-text("All")').first();
    if ((await all.count()) > 0) await all.click();
    await page.waitForTimeout(300);
  }

  // And it *does* let go when the message genuinely goes away — asserted below, after
  // the conversation checks, because trashing it moves the reader on and that would
  // change what those are looking at.

  // ── Conversations ──────────────────────────────────────────────────────────

  // The list collapses a thread to one row, so without this the rest of the exchange
  // is unreachable from the reader — and a message that was archived is not in the
  // list at all, so it was unreachable anywhere.
  const convoHeading = page.locator('article h3:has-text("earlier message")');
  check("a thread shows the rest of the exchange", (await convoHeading.count()) > 0);

  // The three "Re: the migration plan" messages share a subject, so the subject
  // cannot tell them apart — the check has to look at something that does. The list
  // row's text is the right thing: it names the sender and relative time, so a
  // different sender or a different timestamp proves the reader moved.
  const convoButtons = page.locator(
    'article h3:has-text("earlier message") + ul > li > button',
  );
  const convoCount = await convoButtons.count();
  check("and each earlier message is a real button", convoCount >= 2, `${convoCount} entries`);

  if (convoCount >= 2) {
    // Read the pane, not the article. The sender's `<time>` is in the reader's header,
    // so `article.querySelector("time")` was always null — which meant the only part
    // of this comparison that could have differed was the subject, and a thread's
    // three messages share one. The check was passing or failing on nothing.
    const readOpen = () =>
      page.evaluate(() => {
        const reader = document.querySelector("[data-reader]");
        const article = reader?.querySelector("article");
        return {
          h1: article?.querySelector("h1")?.textContent ?? "",
          stamp: reader?.querySelector("time")?.getAttribute("datetime") ?? "",
        };
      });
    const before = await readOpen();
    check("the open message has a timestamp to compare against", before.stamp !== "", JSON.stringify(before));
    await convoButtons.last().click();
    // `focusMessage` re-derives the view, so the reader swaps rather than merely
    // restyling. Waiting for the stamp to actually differ is the honest signal; a
    // fixed sleep would race the render and could read the old value.
    await page
      .waitForFunction(
        (previous) => {
          const reader = document.querySelector("[data-reader]");
          const stamp = reader?.querySelector("time")?.getAttribute("datetime") ?? "";
          return stamp !== "" && stamp !== previous;
        },
        before.stamp,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    const after = await readOpen();
    check("clicking one opens that message", after.stamp !== before.stamp, `${before.stamp} → ${after.stamp}`);
  }

  // The search is cleared through the field, and Escape is pressed *afterwards* —
  // the order matters, because Escape from a focused field only blurs it, and a
  // still-active query would leave `focusMessage` clearing it on the next click.
  await page.locator("#winnow-search").fill("");
  await page.waitForTimeout(300);

  /**
   * The other half of "the reader survives a filter change": it must still let go.
   *
   * The distinction the store now draws is between a message that has *left* and one
   * that is merely *not being shown*. Only a move between folders counts as leaving —
   * so filtering keeps the reader, and filing does not.
   *
   * Note what "does not keep" means here, because it is not "closes": with a cursor on
   * a row, a filed message hands the reader to whatever took its place, which is what
   * a triage loop wants. The assertion is therefore that the reader is no longer on the
   * filed message — not that it went blank.
   */
  await openMessage();
  const beforeFiling = await page.locator("article h1").textContent();
  const binButton = page.locator(
    'button[aria-label="Move to trash"], button[aria-label="Delete permanently"]',
  );
  check("the open message can be filed from the reader", (await binButton.count()) > 0);
  await binButton.first().click();
  await page.waitForTimeout(500);
  const afterFiling = (await page.locator("article h1").count())
    ? await page.locator("article h1").textContent()
    : null;
  check(
    "filing the open message releases the reader from it",
    afterFiling !== beforeFiling,
    `${beforeFiling} → ${afterFiling ?? "(closed)"}`,
  );
  /*
   * Where it went, rather than a count.
   *
   * The mailbox is a thread list, so filing one message of a four-message thread does
   * not remove the row — the subject is shared and the thread still has three. Which
   * means both "the subject left the list" and "the row count went down" are wrong
   * here, and the only honest check is that the message is where it was put.
   */
  await goTo("Trash");
  await page.fill("#winnow-search", beforeFiling ?? "");
  await page.waitForTimeout(400);
  check(
    "and it is in the bin",
    (await rowTotal()) > 0,
    `${await rowTotal()} rows in the bin matching ${JSON.stringify(beforeFiling)}`,
  );

  /*
   * Back to the inbox, and the search cleared.
   *
   * Not tidiness. The navigation palette opens on whichever row matches the mailbox
   * already on screen, so leaving the run in the bin made the two ArrowDowns that
   * follow land on *Settings* rather than a mailbox, and the next assertion opened
   * with a settings sheet on screen. The palette being context-sensitive is correct
   * behaviour; the test is what has to put the world back how it found it.
   */
  await page.fill("#winnow-search", "");
  await closeReader();
  await goTo("Inbox");

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
  //
  // The To field now opens its suggestions on focus, so the first Escape closes that
  // list and the second closes the composer. The property under test is that *neither*
  // asks, not how many keys it takes — and both halves are asserted separately, because
  // a list that swallowed Escape entirely would pass the first and fail the second.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(
    "Escape over an open suggestion list closes the list, not the composer",
    (await page.locator('[role="listbox"]').count()) === 0 &&
      (await page.locator('[role="dialog"][aria-label="Forward"]').count()) > 0,
  );
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

  // ── Recipient autocomplete ───────────────────────────────────────────────────
  //
  // Sourced from the mail already in the store — senders, and the recipients on the
  // user's own sent mail, which is why that folder exists at all — plus, in the demo, a
  // seeded stand-in for the Google contacts a real account can opt in to. No network.
  section("recipient autocomplete");

  const toField = page.locator('input[aria-label="To"]');
  const suggestions = page.locator('[role="listbox"] [role="option"]');
  const chips = page.locator('[role="dialog"] button[aria-label^="Remove"]');
  const sendButton = page.locator('[role="dialog"] button:has-text("Send")').first();

  await page.keyboard.press("f");
  await page.waitForSelector('input[aria-label="To"]', { timeout: 5_000 });
  await page.waitForTimeout(300);

  // The list opens on the field itself, before anything is typed. What somebody
  // reaching for the To line before they have decided who it is for wants is the people
  // they correspond with most.
  check(
    "the To field is a combobox and says it is open",
    (await toField.getAttribute("aria-expanded")) === "true",
    (await toField.getAttribute("aria-expanded")) ?? "",
  );
  const offered = await suggestions.count();
  check("and offers people straight away", offered > 0 && offered <= 8, `${offered} rows`);

  // The demo's seeded Google address book: a saved contact the mailbox has never seen
  // is still offered, with no network, which is what the offline demo promises.
  await toField.type("jonah");
  await page.waitForTimeout(300);
  check(
    "a saved Google contact with no mail is offered in the demo",
    (await suggestions.count()) === 1 &&
      (await suggestions.first().innerText()).includes("Jonah Mercer"),
    JSON.stringify((await suggestions.first().innerText().catch(() => "")).trim()),
  );
  await toField.fill("");
  await page.waitForTimeout(200);

  // The demo's own cast. "Helena Ruiz" is one correspondent, reached both as a sender
  // and on a sent message, so this cannot be satisfied by an address that merely shares
  // a prefix with somebody else.
  await toField.type("helena");
  await page.waitForTimeout(300);
  check(
    "a seeded sender is found by name",
    (await suggestions.count()) === 1 &&
      (await suggestions.first().innerText()).includes("Helena Ruiz"),
    JSON.stringify((await suggestions.first().innerText().catch(() => "")).trim()),
  );

  // Selecting by keyboard, which is the whole claim: a recipient list that needs a
  // mouse is not much use in an app whose shortcuts sheet opens with `j` and `k`.
  check(
    "nothing is highlighted until the user asks for it",
    (await toField.getAttribute("aria-activedescendant")) === null,
  );
  await page.keyboard.press("ArrowDown");
  const active = await toField.getAttribute("aria-activedescendant");
  check("an arrow key highlights a row and names it", active !== null, active ?? "none");
  check(
    "and the row knows it is the active one",
    (await suggestions.first().getAttribute("aria-selected")) === "true",
  );

  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  check("Enter turns it into a chip", (await chips.count()) === 1);
  check(
    "named from the index, so the chip is readable",
    (await chips.first().getAttribute("aria-label")) === "Remove Helena Ruiz",
    (await chips.first().getAttribute("aria-label")) ?? "",
  );
  check("and enables Send", !(await sendButton.isDisabled()));
  check("with the typed text consumed", (await toField.inputValue()) === "");

  // Somebody already on the message. Offering to send it to them again is offering the
  // same mistake twice.
  await toField.type("helena");
  await page.waitForTimeout(300);
  check("and is not offered a second time", (await suggestions.count()) === 0, `${await suggestions.count()} rows`);

  // An address that cannot be delivered. The comma-separated input this replaced had no
  // way to say so, and sent whatever was in it.
  await toField.type("not an address,");
  await page.waitForTimeout(300);
  check(
    "a committed chip can be invalid",
    (await page.locator('[role="dialog"] [aria-invalid="true"]').count()) > 0,
  );
  check("Send is disabled while one is", await sendButton.isDisabled());
  check(
    "and says which, in words as well as colour",
    (await page.locator("#winnow-composer-to-error").innerText()).includes("not an address"),
  );

  // Escape is the composer's most-used key, so the list must not swallow it twice.
  await toField.click();
  await page.waitForTimeout(200);
  check("the list reopens on click", (await suggestions.count()) > 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check("Escape dismisses the suggestions", (await suggestions.count()) === 0);
  check(
    "…without closing the composer or losing the draft",
    (await page.locator('textarea[aria-label="Message"]').count()) > 0 && (await chips.count()) === 2,
  );

  // Backspace on an empty field is the token field's verb for "remove the last one".
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(250);
  check("Backspace on an empty field removes the last chip", (await chips.count()) === 1);
  check("and Send is enabled again once nothing invalid is left", !(await sendButton.isDisabled()));

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(
    "Escape with no list up still closes the composer",
    (await page.locator('textarea[aria-label="Message"]').count()) === 0,
  );
  await closeReader();

  // ── Remote content is a per-message decision ──────────────────────────────

  // The reader's escape hatch used to be a preference change wearing a per-message
  // label: "Load images" sat under one message and turned on remote content for every
  // message, permanently. A decision about one message is not a decision about all of
  // them, and the global switch still exists in Settings where its scope is visible.
  // With the new rich HTML rendering, demo messages now have HTML bodies that render
  // inline by default. The check is now that the rich view is available when a
  // message is opened.
  await page.keyboard.press("j");
  await page.waitForTimeout(200);
  // The forms live in the reader's ⋯ menu.
  await page.locator('[data-reader] button[aria-label="More"]:visible').first().click();
  const demoHasRichView = await page
    .locator('[role="menu"] [role="menuitemradio"]', { hasText: "Rich" })
    .count();
  await page.keyboard.press("Escape");
  check("the demo reader offers a rich view for HTML messages", demoHasRichView > 0);

  /*
   * The rich view, on the one demo message that has markup.
   *
   * This is the assertion the whole feature exists to be able to make. It used to be
   * impossible to write: a newsletter rendered as a column of words with its URLs
   * spelled out, so there was nothing about it to assert beyond "no iframe". Now the
   * assertions are about what actually reached the document — the table layout is
   * there, the embedded image loaded, the remote ones are placeholders with no `src`,
   * and nothing a sender could have put in it survived.
   */
  // Reached by search rather than by scrolling for it. The list is windowed, so a row
  // that is not inside the current viewport does not exist in the DOM to be clicked,
  // and a locator waiting on one hangs for the full timeout. Search is also the more
  // honest route: it is how a reader finds a message four days old.
  await page.keyboard.press("/");
  await page.locator("#winnow-search").fill("Hark Pro");
  await page.waitForTimeout(400);
  await openMessage();
  await page.waitForTimeout(700);

  const rendered = await page.evaluate(() => {
    const host = document.querySelector("[data-wn-email]");
    if (!host) return null;
    const images = [...host.querySelectorAll("img")];
    return {
      tables: host.querySelectorAll("table").length,
      headings: [...host.querySelectorAll("h1")].map((h) => h.textContent.trim()),
      // The inline logo and the embedded illustration are bytes already inside the
      // message, so they render. The tracking pixel and the CDN hero are remote, so
      // they do not — and they do not carry a `src` a browser could follow.
      loaded: images.filter((i) => (i.getAttribute("src") ?? "").startsWith("data:")).length,
      withheld: images.filter((i) => i.hasAttribute("data-wn-blocked-src")).length,
      fetchable: images.filter((i) => (i.getAttribute("src") ?? "").startsWith("http")).length,
      scripts: host.querySelectorAll("script, iframe, object, embed, form").length,
      handlers: host.querySelectorAll("[onclick], [onerror], [onload]").length,
      // A `javascript:` link must not survive as an `href` either.
      jsLinks: [...host.querySelectorAll("a")].filter((a) =>
        (a.getAttribute("href") ?? "").toLowerCase().startsWith("javascript:")).length,
    };
  });

  check("a message with markup renders its layout, not a column of words", rendered?.tables > 0,
    `${rendered?.tables} tables`);
  check("the sender's own typography reaches the document", rendered?.headings.join(" ") === "hark pro is here",
    JSON.stringify(rendered?.headings));
  check("the message's own images render", rendered?.loaded === 2, `${rendered?.loaded} loaded`);
  check("and its remote ones do not, with nothing left a browser could fetch",
    rendered?.fetchable === 0 && rendered?.withheld === 2,
    `${rendered?.fetchable} fetchable, ${rendered?.withheld} withheld`);
  check("no script, frame, object or form survives sanitising", rendered?.scripts === 0,
    `${rendered?.scripts} found`);
  check("no event handler survives", rendered?.handlers === 0, `${rendered?.handlers} found`);
  check("no javascript: link survives", rendered?.jsLinks === 0, `${rendered?.jsLinks} found`);

  // The other two forms, picked from the reader's ⋯ menu.
  const moreButton = page.locator('[data-reader] button[aria-label="More"]:visible').first();
  const forms = page.locator('[role="menu"] [role="menuitemradio"]');
  const pickForm = async (index) => {
    await moreButton.click();
    await forms.nth(index).click();
  };
  await moreButton.click();
  const labels = (await forms.allTextContents()).map((label) => label.trim());
  check("the body offers rich, plain and the original", labels.join("|") === "Rich|Plain text|As sent",
    labels.join("|"));
  await page.keyboard.press("Escape");

  await pickForm(1);
  await page.waitForTimeout(300);
  const plainShown = await page.evaluate(() => {
    const host = document.querySelector("[data-wn-email]");
    return host === null && document.body.innerText.includes("Hark Pro is here.");
  });
  check("plain text is the extracted prose, with no markup", plainShown);

  await pickForm(2);
  await page.waitForTimeout(600);
  const sent = await page.evaluate(() => {
    const frame = [...document.querySelectorAll("iframe")].find((f) => f.title === "Message as sent");
    if (!frame) return null;
    const doc = frame.getAttribute("srcdoc") ?? "";
    return {
      sandbox: frame.getAttribute("sandbox"),
      referrer: frame.getAttribute("referrerpolicy"),
      hasSenderCss: doc.includes("Georgia"),
      noScript: !/<script/i.test(doc),
      noRemoteInHead: !/@import|url\(\s*['"]?https?:/i.test(doc),
    };
  });
  check("the original is sandboxed with nothing granted", sent?.sandbox === "", JSON.stringify(sent?.sandbox));
  check("and sends no referrer", sent?.referrer === "no-referrer", String(sent?.referrer));
  check("and keeps the sender's own stylesheet, which the rich view has to drop", sent?.hasSenderCss === true);
  check("with no script and no remote reference in its document",
    sent?.noScript === true && sent?.noRemoteInHead === true, JSON.stringify(sent));

  await pickForm(0);
  await page.waitForTimeout(300);

  // A link in a message must leave the app rather than navigate it.
  const navigated = await page.evaluate(() => {
    let opened = null;
    const real = window.open;
    window.open = (url) => { opened = url; return null; };
    const link = document.querySelector("[data-wn-email] a[href^='https://']");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    window.open = real;
    return { opened, href: link?.getAttribute("href") ?? null };
  });
  check("a link in a message is handed to the system browser, not followed in place",
    navigated.opened === navigated.href && String(navigated.href).startsWith("https://"),
    JSON.stringify(navigated));

  await closeReader();
  // Clear the search, because the mailbox is handed back to the rest of the run.
  await page.locator("#winnow-search").fill("");
  await page.waitForTimeout(250);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ── The mailboxes ──────────────────────────────────────────────────────────

  section("mailboxes");

  await page.keyboard.press("!");
  // Selected by role, not by text: the palette's accessible name is an
  // `aria-label`, and `text=` matches visible text only.
  await page.waitForSelector('[role="menu"]', { timeout: 5_000 });
  const paletteRows = await page.locator('[role="menu"] [role="menuitem"]').count();
  check("the navigation palette opens", paletteRows === 5, `${paletteRows} rows`);
  // Sent is a folder now, and this palette is the only place it is reachable on a phone
  // — so a row that is missing here is a mailbox that cannot be opened at all.
  check(
    "and it carries Sent",
    (await page.locator('[role="menu"] [role="menuitem"]:has-text("Sent")').count()) === 1,
  );
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check("Enter in the palette switches mailbox", (await page.locator('[role="menu"]').count()) === 0);

  // …and Sent is a mailbox with mail in it, not an empty row. This is also the only
  // place the demo can show mail the user wrote.
  await page.keyboard.press("!");
  await page.waitForSelector('[role="menu"]', { timeout: 5_000 });
  await page.getByRole("menuitem", { name: "Sent" }).click();
  await page.waitForTimeout(300);
  check("Sent opens", (await page.locator('[role="menu"]').count()) === 0);
  check(
    "and holds what the user wrote",
    (await page.locator('[data-message-id]').count()) > 0,
    `${await page.locator('[data-message-id]').count()} rows`,
  );
  await goTo("Inbox");

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

  const spamRows = await rowTotal();
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
  /*
   * There used to be a second "not spam" button in the app chrome, next to a
   * copy of every other email action. The reader is now the only place an email action
   * lives — that was the point of taking them out of the bar — so this asserts there is
   * exactly one way out of Spam in the whole window rather than that two surfaces
   * agree on a label.
   */
  check(
    "and exactly one, in the reader, rather than one per surface",
    (await page.locator('button[aria-label^="Not spam"]').count()) === 1,
    `${await page.locator('button[aria-label^="Not spam"]').count()} not-spam buttons`,
  );
  await notSpam.first().click();
  await page.waitForTimeout(400);
  check(
    "and it moves the message back to the inbox",
    (await rowTotal()) === spamRows - 1,
    `${spamRows} → ${await rowTotal()} in spam`,
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
  const hideAgain = page.locator('header button[aria-label^="Hide Newsletters"]:visible').first();
  await hideAgain.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await hideAgain.click({ force: true });
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
  /*
   * Scrolled into view first, and this is not incidental tidiness.
   *
   * A muted bucket is moved to the *end* of the rail, so its restore control sits at
   * the far right of a horizontally scrolling strip — measured at x=3025 on a 1440px
   * window. `force: true` skips Playwright's actionability checks, which includes
   * scrolling the target into view, so the click was dispatched at a coordinate
   * outside the viewport and hit nothing. The count assertions after it then reported
   * a still-muted bucket as though the restore had failed.
   */
  await restore.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
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
  /*
   * The image setting is a radio group of three, not a switch.
   *
   * A boolean has two positions and the decision has three: ask each time, always,
   * never. "Stop asking" is not "never" — somebody who has been asked three times wants
   * their mail to look like mail — and with two positions the only way to say that was
   * to decline on every message, forever. So this is one setting with three values,
   * and the assertion is that picking one of them writes a value rather than a boolean.
   */
  const imageChoices = page.locator('[role="radiogroup"][aria-label="Remote images"] [role="radio"]');
  check(
    "the image policy is a three-way choice, not a toggle",
    (await imageChoices.count()) === 3,
    `${await imageChoices.count()} choices`,
  );
  await imageChoices.filter({ hasText: "Always" }).click();
  await page.waitForTimeout(250);
  check(
    "and it reports which one is in force",
    (await imageChoices.filter({ hasText: "Always" }).getAttribute("aria-checked")) === "true",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape closes the settings sheet from inside it", (await page.locator('[role="dialog"]').count()) === 0);
  const imagePrefs = JSON.parse((await storage())["winnow.preferences.v1"] ?? "{}");
  check(
    "and the choice is persisted as a policy, not a flag",
    imagePrefs.imagePolicy === "always",
    JSON.stringify(imagePrefs.imagePolicy),
  );

  // ── Themes ─────────────────────────────────────────────────────────────────

  section("themes");

  /*
   * The picker: two radio groups in Settings → Appearance, Mode and Accent.
   *
   * Driven the way a user would — a click, then the arrow keys a screen-reader user
   * would use — and asserted on what reaches the page: `data-theme` / `data-accent` on
   * `<html>`, the canvas actually painted, and what is written to storage. Then a reload
   * with the bundle *blocked*, which is the only way to see what `theme-boot.js` and the
   * `index.css` fallbacks paint on their own: the frame a user sees before the app loads.
   */
  await page.keyboard.press(",");
  await page.waitForSelector('[role="radiogroup"][data-picker="winnow-theme-mode"]', { timeout: 5_000 });
  const modeGroup = page.locator('[role="radiogroup"][data-picker="winnow-theme-mode"]');
  const accentGroup = page.locator('[role="radiogroup"][data-picker="winnow-theme-accent"]');
  const modeRadios = modeGroup.locator('[role="radio"]');
  const accentRadios = accentGroup.locator('[role="radio"]');
  check(
    "the mode picker offers System, Light, Dark and OLED",
    JSON.stringify(await modeRadios.allTextContents()) === JSON.stringify(["System", "Light", "Dark", "OLED"]),
    JSON.stringify(await modeRadios.allTextContents()),
  );
  check(
    "the accent picker offers the curated accents, Space first",
    (await accentRadios.count()) >= 3 && ((await accentRadios.first().textContent()) ?? "").trim() === "Space",
    JSON.stringify(await accentRadios.allTextContents()),
  );
  check(
    "both groups are labelled by a visible heading",
    (await page.evaluate(() =>
      [...document.querySelectorAll('[role="radiogroup"][data-picker]')].every((group) => {
        const label = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
        return Boolean(label && label.textContent?.trim() && label.offsetParent !== null);
      }),
    )),
  );
  check(
    "each group is one tab stop: only the checked radio is focusable",
    (await page.evaluate(() =>
      [...document.querySelectorAll('[role="radiogroup"][data-picker]')].every((group) => {
        const stops = [...group.querySelectorAll('[role="radio"]')].filter((radio) => radio.tabIndex === 0);
        return stops.length === 1 && stops[0].getAttribute("aria-checked") === "true";
      }),
    )),
  );
  const themeState = () =>
    page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      accent: document.documentElement.dataset.accent,
      canvas: getComputedStyle(document.body).backgroundColor,
    }));

  await modeRadios.filter({ hasText: "OLED" }).click();
  await page.waitForTimeout(150);
  let state = await themeState();
  check(
    "choosing OLED paints true black",
    state.theme === "oled" && state.canvas === "rgb(0, 0, 0)" &&
      (await modeRadios.filter({ hasText: "OLED" }).getAttribute("aria-checked")) === "true",
    JSON.stringify(state),
  );

  // The keyboard: arrows move the choice and the focus together, as a radio group should.
  await accentRadios.first().focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100);
  const secondAccent = ((await accentRadios.nth(1).getAttribute("data-value")) ?? "").trim();
  check(
    "ArrowRight selects and focuses the next accent",
    (await accentRadios.nth(1).getAttribute("aria-checked")) === "true" &&
      (await page.evaluate(() => document.activeElement?.getAttribute("data-value"))) === secondAccent,
    secondAccent,
  );
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  const lastAccent = (await accentRadios.last().getAttribute("data-value")) ?? "";
  check("End jumps to the last accent", (await themeState()).accent === lastAccent, lastAccent);

  await accentRadios.filter({ hasText: "Ember" }).click();
  await page.waitForTimeout(150);
  state = await themeState();
  const emberAccent = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--wn-accent").trim().toUpperCase(),
  );
  check("choosing Ember changes the accent on the page", state.accent === "ember" && emberAccent === "#F0964F", `${JSON.stringify(state)} ${emberAccent}`);

  const themePrefs = JSON.parse((await storage())["winnow.preferences.v1"] ?? "{}");
  check(
    "the mode and accent are persisted, without disturbing other preferences",
    themePrefs.appearance === "oled" && themePrefs.accent === "ember" && themePrefs.imagePolicy === "always",
    JSON.stringify(themePrefs),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Before the bundle: answer every script but the boot one with an empty file, and see
  // what paints. Fulfilled rather than aborted, so the run's console stays clean.
  await page.route(/\/assets\/.*\.js$/, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(300);
  state = await themeState();
  check(
    "before the app loads, the stored mode is already on the page (no flash of light)",
    state.theme === "oled" && state.accent === "ember" && state.canvas === "rgb(0, 0, 0)",
    JSON.stringify(state),
  );
  await page.unroute(/\/assets\/.*\.js$/);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  state = await themeState();
  check("and after a reload the app keeps OLED and Ember", state.theme === "oled" && state.accent === "ember", JSON.stringify(state));

  // Put the world back: the rest of the run assumes the default theme.
  await page.keyboard.press(",");
  await page.waitForSelector('[role="radiogroup"][data-picker="winnow-theme-mode"]', { timeout: 5_000 });
  await modeRadios.filter({ hasText: "System" }).click();
  await accentRadios.filter({ hasText: "Space" }).click();
  await page.waitForTimeout(150);
  state = await themeState();
  check("System and Space restore the default", state.theme === "light" && state.accent === "space", JSON.stringify(state));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  await openMessage();
  await page.locator('[data-reader] button[aria-label="More"]:visible').first().click();
  const block = page.locator('[role="menu"] button:has-text("Hide everything from")').first();
  require("the reader offers to hide a sender", (await block.count()) > 0);
  const blockedName = ((await block.textContent()) ?? "").replace("Hide everything from ", "").trim();
  await block.click();
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  const prefs = JSON.parse((await storage())["winnow.preferences.v1"] ?? "{}");
  check(
    "blocking a sender does not reset other preferences",
    // The image policy specifically: it was set a moment ago through Settings, so it is
    // the one preference whose survival this proves. Asserting the whole object instead
    // would only pass while nothing else had changed in between.
    prefs.imagePolicy === "always",
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

  // ── The rail against the search field ─────────────────────────────────────

  section("rail edges");

  /*
    The rail is ~3,700px of tabs in a third of that, so at every desktop width one tab
    meets its end — and with the reader open it was "Unread" at 1440px, sliced mid-word
    beside the search box, which read as the search field covering it. What is claimed
    here, across the common widths with and without a message open: the rail stops short
    of the search field, nothing of it reaches under the field, and wherever it overflows
    the end is a wide fade with a step button over it, so the tab meeting the edge
    dissolves rather than being cut.
  */
  const RAIL_WIDTHS = [1024, 1280, 1366, 1440, 1536, 1680, 1920];
  const EDGE_MIN = 48;
  const railReport = [];
  for (const width of RAIL_WIDTHS) {
    for (const reading of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      if (reading) await openMessage();
      else if ((await page.locator("article h1").count()) > 0) await page.keyboard.press("Escape");
      await page.locator("header [data-rail-scroller]").evaluate((element) => (element.scrollLeft = 0));
      await page.waitForTimeout(150);
      const shape = await page.evaluate(() => {
        const scroller = document.querySelector("header [data-rail-scroller]");
        const search = document.querySelector("#winnow-search")?.closest("label");
        if (!scroller || !search) return null;
        const rail = scroller.getBoundingClientRect();
        const field = search.getBoundingClientRect();
        const tabs = [...scroller.querySelectorAll("[data-rail-item]")].map((item) => item.getBoundingClientRect());
        const edge = document.querySelector('header [data-rail-edge="end"]')?.getBoundingClientRect() ?? null;
        // What actually paints at the search field's left edge, mid-height: it must be
        // the field (or something inside it), never a tab.
        const probe = document.elementFromPoint(field.left + 2, field.top + field.height / 2);
        return {
          gap: Math.round(field.left - rail.right),
          underField: tabs.filter((t) => t.right > field.left + 0.5 && t.left < field.right && rail.right > field.left).length,
          probeIsField: Boolean(probe && search.contains(probe)),
          overflows: scroller.scrollWidth > scroller.clientWidth + 1,
          edge: edge && { left: Math.round(edge.left), right: Math.round(edge.right), width: Math.round(edge.width) },
          railRight: Math.round(rail.right),
        };
      });
      railReport.push({ width, reading, shape });
    }
  }
  const railOk = (predicate) => railReport.every(({ shape }) => shape !== null && predicate(shape));
  const railDetail = (pick) =>
    railReport.map(({ width, reading, shape }) => `${width}${reading ? "r" : ""}:${shape ? pick(shape) : "?"}`).join(" ");
  check(
    "the rail stops short of the search field at every desktop width, reader open or not",
    railOk((shape) => shape.gap >= 8),
    railDetail((shape) => shape.gap),
  );
  check(
    "and no tab reaches under the field",
    railOk((shape) => shape.underField === 0 && shape.probeIsField),
    railDetail((shape) => `${shape.underField}/${shape.probeIsField}`),
  );
  check(
    "wherever the rail overflows, its end is a fade with a step button rather than a cut",
    railOk((shape) => !shape.overflows || (shape.edge !== null && shape.edge.width >= EDGE_MIN && Math.abs(shape.edge.right - shape.railRight) <= 1)),
    railDetail((shape) => (shape.edge ? shape.edge.width : shape.overflows ? "missing" : "fits")),
  );

  // Back to the case that was reported: 1440px with a message open.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  if ((await page.locator("article h1").count()) === 0) await openMessage();
  const railScroller = page.locator("header [data-rail-scroller]");
  await railScroller.evaluate((element) => (element.scrollLeft = 0));
  await page.waitForTimeout(100);

  /*
    The keyboard still reaches every tab, and a tab it lands on is never left under the
    fade. The step buttons are out of the tab order on purpose, so Tab goes straight from
    tab to tab; this walks past the edge and checks the focused tab is fully in the clear.
  */
  await page.locator("header [data-rail-scroller] button[aria-pressed]").first().focus();
  let clearOfFade = true;
  let walkedPastEdge = false;
  const focusTrail = [];
  for (let i = 0; i < 24; i += 1) {
    await page.keyboard.press("Tab");
    const spot = await page.evaluate(() => {
      const scroller = document.querySelector("header [data-rail-scroller]");
      const active = document.activeElement;
      if (!scroller || !active || !scroller.contains(active)) return null;
      const rail = scroller.getBoundingClientRect();
      const r = active.getBoundingClientRect();
      return { fromEnd: Math.round(rail.right - r.right), scrolled: scroller.scrollLeft > 0 };
    });
    if (!spot) break;
    focusTrail.push(spot.fromEnd);
    if (spot.scrolled) walkedPastEdge = true;
    if (spot.fromEnd < EDGE_MIN) clearOfFade = false;
  }
  check(
    "Tab walks the rail past its edge, scrolling as it goes",
    walkedPastEdge,
    `${focusTrail.length} stops`,
  );
  check(
    "and every focused tab is fully clear of the fade",
    clearOfFade,
    focusTrail.join(","),
  );
  check(
    "the step buttons stay out of the tab order",
    (await page.locator('header [data-rail-edge] button:not([tabindex="-1"])').count()) === 0,
  );
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));

  await railScroller.evaluate((element) => (element.scrollLeft = 0));
  await page.waitForTimeout(150);
  const beforeStep = await railScroller.evaluate((element) => element.scrollLeft);
  await page.locator('header button[aria-label="Scroll filters right"]').click();
  await page.waitForTimeout(700);
  const afterStep = await railScroller.evaluate((element) => element.scrollLeft);
  check("the step button moves the rail on", afterStep > beforeStep + 100, `${beforeStep} → ${afterStep}`);
  check(
    "and a back button appears once there is something behind",
    (await page.locator('header button[aria-label="Scroll filters left"]').count()) === 1,
  );
  await page.locator('header button[aria-label="Scroll filters left"]').click();
  await page.waitForTimeout(700);
  check(
    "which steps back",
    (await railScroller.evaluate((element) => element.scrollLeft)) < afterStep,
  );

  // The desktop keeps its selection exactly as it was: the open row is marked.
  const openRow = page.locator('[data-row-count] button[data-message-id][aria-current="true"]');
  check("on the desktop the open message's row is still marked current", (await openRow.count()) === 1);
  check(
    "and still drawn selected",
    (await page.locator("[data-row-count] .bg-surface-selected").count()) === 1,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ── The phone layout ───────────────────────────────────────────────────────

  section("mobile");

  /*
    The phone layout.

    Below 640px the masthead is replaced, not squeezed: a top bar (the mark, search, and
    the account/menu circle), the list, and one dock at the bottom edge holding the
    streams and smart filters above four tabs. The reader brings its own action bar to the
    same edge. What is claimed here is the ergonomics — that the controls a thumb uses
    most are at the bottom, that every one is a real touch target, and that nothing the
    desktop could do is unreachable.
  */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);

  const MIN_TARGET = 44;
  const box = (locator) => locator.first().boundingBox();
  const topBar = page.locator("[data-phone-topbar]");
  const dock = page.locator("[data-phone-dock]");

  require("the phone top bar replaces the masthead", (await topBar.count()) === 1);
  check("and the masthead is gone rather than hidden", (await page.locator("header").count()) === 1);

  const logoBox = await box(topBar.locator("[data-phone-mark]").first());
  const accountBox = await box(topBar.locator('button[aria-label="Open navigation"]'));
  check(
    "the mark sits top-left and the account/menu circle top-right",
    Boolean(logoBox && accountBox) && logoBox.x < 40 && accountBox.x + accountBox.width > 350,
    JSON.stringify({ logoBox, accountBox }),
  );
  check(
    "both circles are touch-sized",
    Boolean(logoBox && accountBox) &&
      Math.min(logoBox.width, logoBox.height, accountBox.width, accountBox.height) >= MIN_TARGET,
    JSON.stringify({ logoBox, accountBox }),
  );

  const searchBox = await page.locator("#winnow-search").boundingBox();
  check(
    "search is on screen, not collapsed to nothing",
    Boolean(searchBox) && searchBox.width > 120,
    JSON.stringify(searchBox),
  );
  const overflow = await page.evaluate(() => {
    const row = document.querySelector("[data-phone-topbar] > div");
    return row ? Math.round(row.scrollWidth - row.clientWidth) : null;
  });
  check("the top bar does not need a sideways scroll", overflow !== null && overflow <= 1, `${overflow}px past`);

  const dockBox = await box(dock);
  check(
    "the dock sits on the bottom edge",
    Boolean(dockBox) && Math.abs(dockBox.y + dockBox.height - 844) <= 1,
    JSON.stringify(dockBox),
  );

  const tabs = dock.locator('nav[aria-label="Primary"] button');
  const tabLabels = (await tabs.allTextContents()).map((t) => t.replace(/\d+/g, "").trim());
  check(
    "four tabs: Inbox, Sent, Archive, Settings",
    JSON.stringify(tabLabels) === JSON.stringify(["Inbox", "Sent", "Archive", "Settings"]),
    JSON.stringify(tabLabels),
  );
  const tabBoxes = await Promise.all((await tabs.all()).map((tab) => tab.boundingBox()));
  check(
    "every tab is a full touch target",
    tabBoxes.every((b) => b && b.width >= MIN_TARGET && b.height >= MIN_TARGET),
    JSON.stringify(tabBoxes.map((b) => b && [Math.round(b.width), Math.round(b.height)])),
  );

  const dockChips = dock.locator("button[aria-pressed]");
  const chipBox = await box(dockChips);
  check(
    "the streams and smart filters sit in the dock, above the tabs",
    (await dockChips.count()) > 3 && Boolean(chipBox) && chipBox.y < tabBoxes[0].y && chipBox.height >= 40,
    JSON.stringify(chipBox),
  );
  check(
    "and none of them are left in the top bar",
    (await topBar.locator("button[aria-pressed]").count()) === 0,
  );

  // A chip filters the list, from the dock.
  const beforeChip = await rowTotal();
  const firstLive = dock.locator("button[aria-pressed]:not([disabled])").first();
  await firstLive.click();
  await page.waitForTimeout(300);
  check(
    "a chip in the dock narrows the list",
    (await firstLive.getAttribute("aria-pressed")) === "true" && (await rowTotal()) < beforeChip,
    `${beforeChip} → ${await rowTotal()}`,
  );
  await dock.locator("button", { hasText: /^All$/ }).click();
  await page.waitForTimeout(300);
  check("and All clears it", (await rowTotal()) === beforeChip, `${await rowTotal()} rows`);

  // The tabs switch mailbox and open Settings.
  await tabs.filter({ hasText: "Sent" }).click();
  await page.waitForTimeout(300);
  check(
    "the Sent tab opens Sent",
    (await listTitle())?.trim() === "Sent" &&
      (await tabs.filter({ hasText: "Sent" }).getAttribute("aria-current")) === "page",
    await listTitle(),
  );
  await tabs.filter({ hasText: "Settings" }).click();
  await page.waitForTimeout(300);
  check(
    "the Settings tab opens Settings",
    (await page.locator('[role="dialog"][aria-label="Settings"]').count()) === 1,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await tabs.filter({ hasText: "Inbox" }).click();
  await page.waitForTimeout(300);
  check("and the Inbox tab comes back", (await listTitle())?.trim() === "Inbox", await listTitle());

  // Trash and Spam have no tab; the account circle's drawer still reaches them.
  await openDrawer();
  check(
    "the drawer still lists every mailbox",
    (await mailbox("Trash").count()) === 1 && (await mailbox("Spam").count()) === 1,
  );
  await closeDrawer();

  // ── The reader, on a phone ──
  await openMessage();
  await page.waitForTimeout(400);

  check("the list's bars step aside for the reader", (await topBar.count()) === 0 && (await dock.count()) === 0);

  const readerDock = page.locator("[data-reader-dock]");
  const readerDockBox = await box(readerDock);
  check(
    "the reader's actions sit on the bottom edge",
    Boolean(readerDockBox) && Math.abs(readerDockBox.y + readerDockBox.height - 844) <= 1,
    JSON.stringify(readerDockBox),
  );
  const readerButtons = await Promise.all(
    (await readerDock.locator("button").all()).map(async (b) => ({
      label: await b.getAttribute("aria-label"),
      box: await b.boundingBox(),
    })),
  );
  check(
    "back, reply, forward, archive, trash and more, each a full touch target",
    readerButtons.length === 6 &&
      readerButtons[0].label === "Back to the list" &&
      readerButtons.every(({ box: b }) => b && b.width >= MIN_TARGET && b.height >= MIN_TARGET),
    JSON.stringify(readerButtons.map(({ label, box: b }) => [label, b && Math.round(b.width), b && Math.round(b.height)])),
  );

  // Star and read moved into More on the phone, so prove they are still there.
  await readerDock.locator('button[aria-label="More"]').click();
  await page.waitForTimeout(200);
  const moreMenu = page.locator('[role="menu"][aria-label="More actions"]');
  const moreBox = await box(moreMenu);
  check(
    "More opens upward, with star and read in it",
    Boolean(moreBox) &&
      moreBox.y + moreBox.height <= (readerDockBox?.y ?? 0) + 1 &&
      (await moreMenu.getByRole("menuitem", { name: /^(Star|Unstar)$/ }).count()) === 1 &&
      (await moreMenu.getByRole("menuitem", { name: /^Mark (read|unread)$/ }).count()) === 1,
    JSON.stringify(moreBox),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  /*
    The reader has to *fit*.

    Its pane is a flex child, and without `min-w-0` its base size is its content —
    which is `max-w-[68ch]` of body text, 733px. On a 390px phone that overflowed the
    line, `body { overflow: hidden }` clipped it, and the message was unreadable.
  */
  const readerFits = await page.evaluate(() => {
    const article = document.querySelector("article");
    if (!article) return null;
    const rect = article.getBoundingClientRect();
    return { width: Math.round(rect.width), viewport: window.innerWidth, past: Math.round(rect.right - window.innerWidth) };
  });
  check(
    "the message fits the phone rather than running off it",
    readerFits !== null && readerFits.past <= 1,
    JSON.stringify(readerFits),
  );

  /*
    Every labelled control, wherever it is: at this width nothing outside a deliberate
    horizontal scroller may be off-screen, so every control in the app can be reached.
  */
  const reachable = await page.evaluate(() => {
    const scrollable = (el) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") return true;
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
    reachable.total >= 6 && reachable.offscreen.length === 0,
    `${reachable.total} buttons, off-screen: ${reachable.offscreen.join(", ") || "none"}`,
  );

  // The sender's name is the one line in the reader that must never be ellipsised.
  const senderName = await page.evaluate(() => {
    const heading = document.querySelector("[data-reader]")?.querySelector("h2");
    if (!heading) return null;
    return { text: heading.textContent?.trim() ?? "", clipped: heading.scrollWidth > heading.clientWidth + 1 };
  });
  check(
    "the sender's name is not truncated",
    senderName !== null && !senderName.clipped,
    JSON.stringify(senderName),
  );

  /*
    A touch device, which is a different thing from a narrow window.

    Chromium reports `hover: hover` for this page however narrow the viewport is, so
    nothing above can tell whether a control that only appears on hover exists at all
    on a phone. The rail's per-pill *hide* control once did not. Hence a second context
    with `hasTouch`, which is what makes `(hover: none)` match.
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
  const starTarget = await touchPage
    .locator('main button[aria-label="Star"], main button[aria-label="Unstar"]')
    .first()
    .boundingBox();
  check(
    "a row's star is a full touch target on a touch device",
    Boolean(starTarget) && starTarget.width >= MIN_TARGET && starTarget.height >= MIN_TARGET,
    JSON.stringify(starTarget),
  );
  await touchContext.close();

  /*
   * The composer and the recipient field, on a phone.
   *
   * In its own context, because the thing being checked is that the whole interaction is
   * reachable *by touch*: nothing here depends on `hover: hover`, and every assertion is
   * about a tap.
   */
  const touchComposer = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const phone = await touchComposer.newPage();
  phone.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  phone.on("pageerror", (error) => errors.push(String(error)));
  await phone.goto(URL, { waitUntil: "networkidle" });
  await phone.waitForSelector("[data-message-id]", { timeout: 10_000 });

  await phone.locator("[data-message-id]").first().tap();
  await phone.waitForSelector("article h1", { timeout: 5_000 });
  await phone.locator('[data-reader-dock] button[aria-label="Forward"]').tap();
  await phone.waitForSelector('input[aria-label="To"]', { timeout: 5_000 });
  // Past the sheet's 160ms rise, which scales it by a hair while it runs.
  await phone.waitForTimeout(400);

  const composerBox = await phone.locator('[role="dialog"][aria-label="Forward"]').boundingBox();
  check(
    "the composer takes the whole phone screen",
    Boolean(composerBox) && composerBox.width >= 389 && composerBox.height >= 840,
    JSON.stringify(composerBox),
  );
  const phoneSend = phone.locator('[role="dialog"] button', { hasText: /^Send$/ });
  const sendBox = await phoneSend.boundingBox();
  check(
    "and Send sits at its bottom edge, a full touch target",
    Boolean(sendBox) && sendBox.height >= MIN_TARGET && sendBox.y + sendBox.height >= 844 - 16,
    JSON.stringify(sendBox),
  );
  check(
    "its fields are 16px, so iOS does not zoom into them",
    await phone.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"] input, [role="dialog"] textarea')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .every((el) => parseFloat(getComputedStyle(el).fontSize) >= 16),
    ),
  );

  const phoneTo = phone.locator('input[aria-label="To"]');
  const phoneSuggestions = phone.locator('[role="listbox"] [role="option"]');
  await phoneTo.tap();
  await phone.waitForTimeout(400);

  check(
    "tapping the field opens the suggestions on a phone",
    (await phoneSuggestions.count()) > 0,
    `${await phoneSuggestions.count()} rows`,
  );
  const rowBox = await phoneSuggestions.first().boundingBox();
  check(
    "a suggestion is big enough to tap",
    (rowBox?.height ?? 0) >= 32 && (rowBox?.width ?? 0) > 0,
    JSON.stringify(rowBox),
  );
  check(
    "and fits the 390px screen",
    (rowBox?.x ?? 0) >= 0 && (rowBox?.x ?? 0) + (rowBox?.width ?? 0) <= 390,
    JSON.stringify(rowBox),
  );

  await phoneSuggestions.first().tap();
  await phone.waitForTimeout(400);
  const phoneChips = phone.locator('[role="dialog"] button[aria-label^="Remove"]');
  check("tapping one adds a recipient", (await phoneChips.count()) === 1);
  check("and Send becomes available", !(await phoneSend.isDisabled()));
  const recipientChipBox = await phoneChips.first().boundingBox();
  check(
    "whose chip can be tapped back off",
    (recipientChipBox?.width ?? 0) >= 24 && (recipientChipBox?.height ?? 0) >= 24,
    JSON.stringify(recipientChipBox),
  );
  await touchComposer.close();

  const back = page.locator('button[aria-label="Back to the list"]');
  check("there is a way back to the list", (await back.count()) > 0);
  await back.first().click();
  await page.waitForTimeout(300);
  check(
    "and it works, bringing the dock back",
    (await page.locator("article h1").count()) === 0 && (await dock.count()) === 1,
  );

  /*
    No selection on a phone.

    The list and the reader are never on screen together there, so a "current" row means
    nothing: it would mark the message you just left. A fresh touch page, so nothing above
    has moved a cursor: it must not open a message on its own, it must not draw or
    announce a selected row while reading or after Back, there is no "Nothing selected"
    placeholder anywhere in the document, and Back lands where the list was left.
  */
  const noSelect = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const tapPage = await noSelect.newPage();
  tapPage.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  tapPage.on("pageerror", (error) => errors.push(String(error)));
  await tapPage.goto(URL, { waitUntil: "networkidle" });
  await tapPage.waitForSelector("[data-message-id]", { timeout: 10_000 });
  await tapPage.waitForTimeout(500);
  const listState = () =>
    tapPage.evaluate(() => ({
      reader: document.querySelectorAll("article h1").length,
      current: document.querySelectorAll("[data-row-count] [aria-current]").length,
      selectedRows: document.querySelectorAll("[data-row-count] .bg-surface-selected").length,
      placeholder: document.body.textContent?.includes("Nothing selected") ?? false,
      scrollTop: Math.round(document.querySelector("[data-row-count]")?.scrollTop ?? -1),
      position: document.querySelector("[data-position]")?.textContent?.trim() ?? null,
      ring: document.activeElement?.matches?.("[data-row-count] :focus-visible") ?? false,
    }));
  const onLoad = await listState();
  check("the phone does not open a message on its own", onLoad.reader === 0, JSON.stringify(onLoad));
  check(
    "nor mark any row current, or render an empty reader",
    onLoad.current === 0 && onLoad.selectedRows === 0 && !onLoad.placeholder,
    JSON.stringify(onLoad),
  );
  await tapPage.locator("[data-row-count]").evaluate((element) => (element.scrollTop = 600));
  await tapPage.waitForTimeout(300);
  const leftAt = (await listState()).scrollTop;
  // A tap on whatever row is under the thumb, not a locator: Playwright scrolls a
  // located element into view first, which would move the list this is about to measure.
  await tapPage.touchscreen.tap(195, 520);
  await tapPage.waitForSelector("article h1", { timeout: 5_000 });
  const whileReading = await listState();
  check(
    "a tap opens the reader, and the hidden list holds no selection",
    whileReading.reader === 1 && whileReading.current === 0 && whileReading.selectedRows === 0,
    JSON.stringify(whileReading),
  );
  await tapPage.locator('button[aria-label="Back to the list"]').first().tap();
  await tapPage.waitForTimeout(400);
  const afterBack = await listState();
  check(
    "Back returns to the list with no row highlighted or marked current",
    afterBack.reader === 0 && afterBack.current === 0 && afterBack.selectedRows === 0 && !afterBack.ring,
    JSON.stringify(afterBack),
  );
  check(
    "and no position claimed in the list",
    afterBack.position !== null && !afterBack.position.includes("of"),
    afterBack.position ?? "none",
  );
  check("and no \"Nothing selected\" placeholder", !afterBack.placeholder);
  check(
    "at the scroll position the list was left at",
    leftAt > 100 && Math.abs(afterBack.scrollTop - leftAt) <= 2,
    `${leftAt} → ${afterBack.scrollTop}`,
  );
  check(
    "rows are still plain buttons that open the message",
    (await tapPage.locator("[data-row-count] button[data-message-id]").count()) > 3 &&
      (await tapPage.locator("[data-row-count] [aria-selected]").count()) === 0,
  );
  await noSelect.close();

  // The rest is not about the phone, and the desktop masthead is where its helpers look.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

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
  // The drawer, because that is where a mailbox is named now — the deep link still
  // has to land in the right folder and the drawer is how a user would check.
  await openDrawer();
  check(
    "and the reader follows it into the mailbox it lives in",
    (await mailbox("Spam").getAttribute("aria-current")) === "page",
  );
  await closeDrawer();

  await page.goto(`${URL}?view=archive`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  check(
    "a link naming a mailbox switches to it",
    await (async () => {
      await openDrawer();
      const current = (await mailbox("Archive").getAttribute("aria-current")) === "page";
      await closeDrawer();
      return current;
    })(),
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
    (await page.locator('[role="alert"]').count()) === 0 && (await rowTotal()) > 0,
    `${await rowTotal()} rows`,
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
