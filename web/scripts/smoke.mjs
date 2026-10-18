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
import { createHash } from "node:crypto";
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

/**
 * Open one Settings category: its tab in the desktop list, or on a phone its row in the
 * category list (stepping back out of an open category first). Settings opens on Reading.
 */
async function openSettingsCategory(p, id) {
  const dialog = p.locator('[role="dialog"][aria-label="Settings"]');
  await dialog.waitFor({ timeout: 5_000 });
  const tab = dialog.locator(`[role="tab"][data-category="${id}"]`);
  if ((await tab.count()) > 0) {
    await tab.click();
  } else {
    if ((await dialog.locator('[data-settings-page="category"]').count()) > 0) {
      await dialog.locator("[data-settings-back]").click();
    }
    await dialog.locator(`[data-category="${id}"]`).click();
  }
  await p.waitForTimeout(120);
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

/**
 * CSP tripwire. The production build carries the web Content-Security-Policy as a
 * `<meta>` tag (`src/platform/csp.ts`), so every page this run opens is running under
 * it. Chromium reports a violation as a console message; every page in every context
 * is watched, including the ones whose own error lists ignore the console, and the run
 * fails at the end if any appeared.
 */
const cspViolations = [];
const cspWatched = new WeakSet();
const watchCsp = (p) => {
  if (cspWatched.has(p)) return p;
  cspWatched.add(p);
  p.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text());
  });
  return p;
};
const bareNewContext = browser.newContext.bind(browser);
browser.newContext = async (options) => {
  const ctx = await bareNewContext(options);
  ctx.on("page", watchCsp);
  return ctx;
};
const watchedNewPage = browser.newPage.bind(browser);
browser.newPage = async (options) => watchCsp(await watchedNewPage(options));

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
  const confirmDialogIn = (p) => p.locator('[role="dialog"][aria-label="Discard this draft?"]');
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
  const isOn = async (locator) => (await locator.getAttribute("aria-pressed")) === "true";
  /**
   * The navigation: the sidebar, an overlay on every screen size, opened by the toggle
   * at the head of the list (desktop) or a second tap on the dock's Inbox tab (phone,
   * where it is a bottom sheet). It is always
   * mounted so it can animate out; `data-open` says whether it is open, and closed it is
   * `visibility: hidden` once its slide has finished. It holds no smart filters; those
   * are the rail above.
   */
  const overflowMenu = () => page.locator('[data-sidebar][role="dialog"][aria-label="Menu"]');
  const sidebarToggle = () => page.locator("[data-sidebar-toggle]:visible").first();
  const sidebarOpen = async () => (await page.locator("[data-sidebar][data-open]").count()) > 0;
  const waitSidebarClosed = () =>
    page.locator("[data-sidebar]").waitFor({ state: "hidden", timeout: 5_000 });
  const openDrawer = async () => {
    if (await sidebarOpen()) return;
    await page
      .waitForFunction(() => !document.querySelector('[role="presentation"]'), null, { timeout: 5_000 })
      .catch(() => undefined);
    const toggle = sidebarToggle();
    await toggle.click();
    // On a phone the toggle is the Inbox tab, whose first tap only switches to the inbox
    // when another mailbox (or Settings) is showing.
    if (await toggle.evaluate((element) => element.closest("[data-phone-dock]") !== null)) {
      await page.waitForTimeout(150);
      if (!(await sidebarOpen())) await toggle.click();
    }
    await page.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    // The slide-in, so boxes measured next are where they settle.
    await page.waitForTimeout(300);
  };
  const closeDrawer = async () => {
    if (!(await sidebarOpen())) return;
    await page.keyboard.press("Escape");
    await waitSidebarClosed();
  };
  const mailbox = (name) =>
    page
      .locator('[data-mail-nav]:visible button[data-nav-folder], [data-mail-nav]:visible button[data-nav="inbox"]')
      .filter({ hasText: new RegExp(`^${name}`) })
      .first();
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
    await waitSidebarClosed().catch(() => undefined);
    await page.waitForTimeout(250);
  };
  /**
   * The unread count on a mailbox row, or `0` when it has none.
   *
   * Read from the row's `data-unread` (opening the phone's menu when it is there), never
   * from a `span` that might simply not be on screen, which would be indistinguishable
   * from a real zero.
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

  // The web CSP is in force, not just written down: the meta tag is there, and a
  // throwaway page (outside the tripwire) sees an inline script refused.
  if (!EXTERNAL) {
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content").catch(() => null);
    check(
      "the build carries the web CSP as a meta tag",
      Boolean(csp && /script-src 'self'(;|$)/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp)),
      csp ?? "missing",
    );
    // Its own unwatched context: `browser.newPage` makes one through `newContext`,
    // which would put the probe's deliberate violation in the tripwire.
    const probeCtx = await bareNewContext();
    const probe = await probeCtx.newPage();
    await probe.goto(URL, { waitUntil: "domcontentloaded" });
    const refused = await probe.evaluate(
      () =>
        new Promise((resolve) => {
          document.addEventListener("securitypolicyviolation", (event) => resolve(event.violatedDirective), { once: true });
          const script = document.createElement("script");
          script.textContent = "window.__inlineRan = true";
          document.head.append(script);
          setTimeout(() => resolve(window.__inlineRan ? "ran" : "no report"), 1_000);
        }),
    );
    check("and it refuses an inline script", /^script-src/.test(String(refused)), String(refused));
    await probeCtx.close();
  }

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

  // ── The filter rail ───────────────────────────────────────────────────────
  //
  // The smart filters are the rail again, on its own row under search at the top of the
  // list column: text tabs with counts, ranked by the store, a fade and a step chevron
  // at an edge with more past it. It has the column's width to itself, so search can
  // never sit over its last tab.
  const rail = await page.evaluate(() => {
    const scrollers = [...document.querySelectorAll("header [data-rail-scroller]")];
    if (scrollers.length !== 1) return { copies: scrollers.length };
    const scroller = scrollers[0];
    const pills = [...scroller.querySelectorAll("button[aria-pressed]")];
    const box = scroller.getBoundingClientRect();
    const header = scroller.closest("header").getBoundingClientRect();
    const field = document.querySelector("#winnow-search").closest("label").getBoundingClientRect();
    const visible = pills.filter((pill) => {
      const rect = pill.getBoundingClientRect();
      return rect.right > box.left + 1 && rect.left < box.right - 1;
    });
    return {
      copies: scrollers.length,
      total: pills.length,
      visible: visible.length,
      width: Math.round(box.width),
      headerWidth: Math.round(header.width),
      belowSearch: box.top >= field.bottom - 0.5,
      inSidebar: Boolean(document.querySelector("[data-sidebar] [data-rail-scroller]")),
    };
  });
  check("the rail is rendered exactly once, above the list", rail?.copies === 1 && !rail.inSidebar, JSON.stringify(rail));
  check("it has the list column's width to itself", (rail?.width ?? 0) >= (rail?.headerWidth ?? 1) * 0.9, JSON.stringify(rail));
  check("on its own row under search", rail?.belowSearch === true, JSON.stringify(rail));
  check(
    "so a useful run of it is reachable without scrolling",
    (rail?.visible ?? 0) >= Math.min(5, rail?.total ?? 0),
    `${rail?.visible} of ${rail?.total} pills in ${rail?.width}px`,
  );
  const railDigits = await page
    .locator("header [data-rail-scroller] button[aria-pressed]")
    .evaluateAll((nodes) => nodes.slice(0, 9).map((node) => node.getAttribute("aria-keyshortcuts")));
  check(
    "the first nine tabs carry their digit shortcuts, in rail order",
    JSON.stringify(railDigits) === JSON.stringify(["1", "2", "3", "4", "5", "6", "7", "8", "9"]),
    JSON.stringify(railDigits),
  );
  const secondLabel = await pills().nth(1).getAttribute("aria-label");
  await page.keyboard.press("2");
  await page.waitForTimeout(250);
  check(
    "pressing 2 turns the second tab on, and it keeps its place in the rail",
    (await isOn(pills().nth(1))) && (await pills().nth(1).getAttribute("aria-label")) === secondLabel,
    `${secondLabel} → ${await pills().nth(1).getAttribute("aria-label")}`,
  );
  check(
    "and Inbox in the sidebar is no longer current",
    (await page.locator('[data-sidebar] button[data-nav="inbox"]').getAttribute("aria-current")) === null,
  );
  await page.keyboard.press("2");
  await page.waitForTimeout(250);
  check("pressing it again turns it off", !(await isOn(pills().nth(1))));
  await page.keyboard.press("3");
  await page.waitForTimeout(250);
  const threeOn = await isOn(pills().nth(2));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(
    "Escape clears the rail",
    threeOn && (await page.locator("header [data-rail-scroller] button[aria-pressed='true']").count()) === 0,
  );

  // ── The rail's colours ─────────────────────────────────────────────────────
  //
  // Every pill is its own colour, as a soft tint: a non-transparent fill, no two the
  // same along the rail, and the one that is on clearly stronger than it was at rest.
  // The label is held to AA on its own tint, composited over the plane under the rail,
  // which is the arithmetic `theme.test.ts` does, run against what the browser painted.
  const pillPaint = () =>
    page.evaluate(() => {
      const parse = (value) => {
        const parts = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
        return [parts[0], parts[1], parts[2], value.startsWith("rgba") || parts.length > 3 ? parts[3] : 1];
      };
      const over = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((c) => {
          const v = Math.round(c) / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      const base = parse(getComputedStyle(document.documentElement).getPropertyValue("--wn-surface").trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`));
      return [...document.querySelectorAll("header [data-rail-scroller] [data-rail-item][data-rail-key]")]
        .map((item) => {
          const fill = parse(getComputedStyle(item).backgroundColor);
          const label = item.querySelector("button[aria-pressed] span.grid > span:last-child");
          const ink = parse(getComputedStyle(label).color);
          return {
            key: item.dataset.railKey,
            on: item.hasAttribute("data-on"),
            fill: getComputedStyle(item).backgroundColor,
            alpha: fill[3],
            radius: parseFloat(getComputedStyle(item).borderTopLeftRadius),
            height: item.getBoundingClientRect().height,
            contrast: Math.round(ratio(ink, over(fill, base)) * 100) / 100,
          };
        });
    });
  const restPaint = await pillPaint();
  // Sender pills share a colour per domain, on purpose; the buckets are all distinct.
  const buckets = restPaint.filter((pill) => !pill.key.startsWith("sender:"));
  check(
    "every pill has a tint of its own: non-transparent, and no two buckets alike",
    restPaint.length > 5 &&
      restPaint.every((pill) => pill.alpha > 0) &&
      new Set(buckets.map((pill) => pill.fill)).size === buckets.length,
    `${new Set(restPaint.map((pill) => pill.fill)).size} fills over ${restPaint.length} pills, ${buckets.length} buckets`,
  );
  check(
    "the pills are rounded capsules, not text tabs",
    restPaint.every((pill) => pill.radius >= pill.height / 2 - 1),
    restPaint.slice(0, 3).map((pill) => `${pill.radius}/${pill.height}`).join(" "),
  );
  check(
    "each label clears AA on its own tint",
    restPaint.every((pill) => pill.contrast >= 4.5),
    `min ${Math.min(...restPaint.map((pill) => pill.contrast))}`,
  );
  const firstWidth = await pills().nth(0).evaluate((node) => node.closest("[data-rail-item]").getBoundingClientRect().width);
  await page.keyboard.press("1");
  await page.waitForTimeout(250);
  const onPaint = await pillPaint();
  const before = restPaint.find((pill) => pill.key === onPaint.find((p) => p.on)?.key);
  const after = onPaint.find((pill) => pill.on);
  check(
    "an active pill is painted stronger than it was at rest",
    Boolean(before && after) && after.fill !== before.fill && after.alpha > before.alpha && after.contrast >= 4.5,
    `${before?.fill} → ${after?.fill} (${after?.contrast}:1)`,
  );
  check(
    "and switching it on does not resize it",
    Math.abs((await pills().nth(0).evaluate((node) => node.closest("[data-rail-item]").getBoundingClientRect().width)) - firstWidth) < 0.5,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  // ── The sidebar overlay ────────────────────────────────────────────────────
  //
  // Folders and the account, not the smart filters (those are the rail). An overlay on
  // every screen: closed until its toggle opens it, it slides in over the list instead
  // of taking a column from it, and while it is open the rest of the app sits behind a
  // progressive blur that is strongest at its edge. 8px from the left and top, 12px
  // radius, a hairline and no shadow, translucent over its own blur, and only as tall as
  // what it holds. It closes on a click outside, Escape, a destination chosen, and the
  // mouse being away from it for a moment.
  // Where the scrim's blur spreads from, and how strong it is around that point, read from
  // the live page: the origin is resolved by placing a probe at the masks' own custom
  // properties, and each layer's reach is read back off its computed mask. The strength at
  // a point is each layer's blur times what is left of its mask there (as `scrimBlurAt`
  // in `sidebarOverlay.ts`), sampled right of, below and above the origin.
  const scrimFalloff = () =>
    page.evaluate(() => {
      const element = document.querySelector("[data-sidebar-scrim]");
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;width:0;height:0;left:var(--wn-sidebar-edge);top:var(--wn-sidebar-mid, 50%)";
      element.append(probe);
      const at = probe.getBoundingClientRect();
      probe.remove();
      const origin = { x: Math.round(at.left), y: Math.round(at.top) };
      const sideRect = document.querySelector("[data-sidebar]").getBoundingClientRect();
      const side = {
        right: Math.round(sideRect.right),
        mid: Math.round(sideRect.top + sideRect.height / 2),
        top: Math.round(sideRect.top),
        centre: Math.round(sideRect.left + sideRect.width / 2),
      };
      const layers = [...element.querySelectorAll("[data-scrim-layer]")].map((layer) => {
        const style = getComputedStyle(layer);
        const mask = style.maskImage || style.webkitMaskImage;
        const reach = Number(/([\d.]+)%\)$/.exec(mask)?.[1]) / 100;
        return { blur: parseFloat(style.backdropFilter.replace("blur(", "")), reach };
      });
      const corners = [[0, 0], [innerWidth, 0], [0, innerHeight], [innerWidth, innerHeight]];
      const distances = corners.map(([x, y]) => Math.hypot(x - origin.x, y - origin.y));
      const corner = Math.max(...distances);
      const farthest = corners[distances.indexOf(corner)];
      const blurAt = (x, y) => {
        const d = Math.hypot(x - origin.x, y - origin.y);
        return layers.reduce((sum, l) => sum + l.blur * Math.max(0, 1 - d / (l.reach * corner)), 0);
      };
      const room = Math.min(innerWidth - origin.x, innerHeight - origin.y, origin.y) - 1;
      const steps = [0.1, 0.3, 0.6, 0.95].map((share) => Math.round(room * share));
      const right = steps.map((d) => blurAt(origin.x + d, origin.y));
      const down = steps.map((d) => blurAt(origin.x, origin.y + d));
      const up = steps.map((d) => blurAt(origin.x, origin.y - d));
      const falling = (list) => list.every((v, i) => i === 0 || v < list[i - 1]);
      const same = right.every((v, i) => Math.abs(v - down[i]) < 0.01 && Math.abs(v - up[i]) < 0.01);
      const far = blurAt(...farthest);
      const ok =
        layers.length >= 2 && layers.every((l) => l.reach > 0 && l.reach <= 1) &&
        blurAt(origin.x, origin.y) > right[0] && falling(right) && falling(down) && falling(up) && same && far < 0.05;
      const round = (list) => list.map((v) => Math.round(v * 100) / 100);
      return { origin, side, ok, samples: { steps, right: round(right), down: round(down), up: round(up), far, layers } };
    });

  section("sidebar overlay");
  const sidebar = page.locator("[data-sidebar]");
  const toggle = page.locator("header [data-sidebar-toggle]");
  const SIDEBAR_IDLE_MS = 1500;
  check("the sidebar is rendered exactly once", (await sidebar.count()) === 1);
  check("and it lists no smart filters: no category rows, no Edit mode",
    (await sidebar.locator("[data-nav-category], [data-nav-edit], [data-rail-scroller], button[aria-pressed]").count()) === 0);
  const contentBoxes = () =>
    page.evaluate(() => {
      const round = (rect) => [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
      return {
        search: round(document.querySelector("#winnow-search").closest("label").getBoundingClientRect()),
        list: round(document.querySelector("[data-row-count]").getBoundingClientRect()),
        rail: round(document.querySelector("header [data-rail-scroller]").getBoundingClientRect()),
        reader: document.querySelector("[data-reader]") ? round(document.querySelector("[data-reader]").getBoundingClientRect()) : null,
      };
    });
  const closedState = await page.evaluate(() => {
    const side = document.querySelector("[data-sidebar]");
    const scrim = document.querySelector("[data-sidebar-scrim]");
    return {
      visibility: getComputedStyle(side).visibility,
      inert: side.inert,
      right: side.getBoundingClientRect().right,
      scrim: getComputedStyle(scrim).visibility,
      listLeft: document.querySelector("[data-row-count]").getBoundingClientRect().left,
    };
  });
  check(
    "it starts closed: off the left edge, hidden, inert, and no scrim",
    closedState.visibility === "hidden" && closedState.inert && closedState.right <= 0 && closedState.scrim === "hidden",
    JSON.stringify(closedState),
  );
  check("and the list takes the window from its left edge, no column kept for it", closedState.listLeft < 1, JSON.stringify(closedState));
  check(
    "the toggle heads the list, says it is collapsed and names what it controls",
    (await toggle.count()) === 1 && (await toggle.getAttribute("aria-expanded")) === "false" &&
      (await toggle.getAttribute("aria-controls")) === "winnow-sidebar",
  );

  const beforeOpen = await contentBoxes();
  await openDrawer();
  const afterOpen = await contentBoxes();
  check(
    "opening it from the toggle shifts nothing under it: search, rail and list stay put",
    JSON.stringify(beforeOpen) === JSON.stringify(afterOpen),
    `${JSON.stringify(beforeOpen)} → ${JSON.stringify(afterOpen)}`,
  );
  const openState = await page.evaluate(() => {
    const side = document.querySelector("[data-sidebar]");
    const root = document.querySelector("#root > div") ?? document.querySelector("[data-masthead]").closest("[inert]");
    const active = document.activeElement;
    return {
      expanded: document.querySelector("header [data-sidebar-toggle]").getAttribute("aria-expanded"),
      modal: side.getAttribute("aria-modal"),
      role: side.getAttribute("role"),
      focusInside: side.contains(active),
      focused: active?.getAttribute("data-nav") ?? active?.getAttribute("data-nav-folder") ?? active?.tagName,
      appInert: Boolean(document.querySelector("[data-masthead]").closest("[inert]")),
      rootInert: root?.inert ?? null,
    };
  });
  check(
    "open: the toggle says expanded, the sidebar is a modal dialog with focus on the current destination",
    openState.expanded === "true" && openState.role === "dialog" && openState.modal === "true" &&
      openState.focusInside && openState.focused === "inbox",
    JSON.stringify(openState),
  );
  check("and the app behind it is inert", openState.appInert, JSON.stringify(openState));

  // The slide in can still be settling on a busy machine (a left of 7.98 rather than 8),
  // so the shape is read once it has landed.
  await page
    .waitForFunction(() => document.querySelector("[data-sidebar]")?.getBoundingClientRect().left === 8, null, { timeout: 2_000 })
    .catch(() => undefined);
  const sideShape = await page.evaluate(() => {
    const side = document.querySelector("[data-sidebar]");
    const style = getComputedStyle(side);
    const rect = side.getBoundingClientRect();
    const layer = (n) => getComputedStyle(side.querySelector(`.wn-sidebar-blur-${n}`)).backdropFilter;
    const tint = getComputedStyle(side.querySelector(".wn-sidebar-tint")).backgroundImage;
    return {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      radius: style.borderTopLeftRadius, shadow: style.boxShadow, border: style.borderTopWidth,
      blurs: [layer(1), layer(2), layer(3)],
      mask: getComputedStyle(side.querySelector(".wn-sidebar-blur-3")).maskImage,
      tint,
    };
  });
  check(
    "it floats 8px from the left and top edges with a 12px radius, a hairline and no shadow",
    sideShape.left === 8 && sideShape.top === 8 && sideShape.radius === "12px" && sideShape.shadow === "none" && sideShape.border === "1px",
    JSON.stringify(sideShape),
  );
  check(
    "its own blur is 2/6/14px, masked from the left edge outward, under a translucent tint",
    JSON.stringify(sideShape.blurs) === JSON.stringify(["blur(2px)", "blur(6px)", "blur(14px)"]) &&
      /linear-gradient/.test(sideShape.mask) && /rgba?\(.*0\.\d+\)|color\(srgb.* \/ 0\.\d+\)/.test(sideShape.tint),
    JSON.stringify({ blurs: sideShape.blurs, mask: sideShape.mask, tint: sideShape.tint }),
  );

  // The scrim: a progressive blur over the rest of the app, strongest at the sidebar.
  // Its fade-in can trail the slide by a frame or two on a busy machine.
  await page
    .waitForFunction(
      () => [...document.querySelectorAll("[data-sidebar-scrim] > *")].every((node) => getComputedStyle(node).opacity === "1"),
      null,
      { timeout: 2_000 },
    )
    .catch(() => undefined);
  const scrim = await page.evaluate(() => {
    const element = document.querySelector("[data-sidebar-scrim]");
    const rect = element.getBoundingClientRect();
    const layers = [...element.querySelectorAll("[data-scrim-layer]")].map((layer) => {
      const style = getComputedStyle(layer);
      return { blur: parseFloat(style.backdropFilter.replace("blur(", "")), mask: style.maskImage || style.webkitMaskImage, opacity: style.opacity };
    });
    const tint = getComputedStyle(element.querySelector(".wn-scrim-tint"));
    return {
      visibility: getComputedStyle(element).visibility,
      covers: rect.left === 0 && rect.top === 0 && rect.width === innerWidth && rect.height === innerHeight,
      under: Number(getComputedStyle(element).zIndex) < Number(getComputedStyle(document.querySelector("[data-sidebar]")).zIndex),
      layers,
      tint: tint.backgroundImage !== "none" ? tint.backgroundImage : tint.backgroundColor,
      tintOpacity: tint.opacity,
    };
  });
  check(
    "behind it, a scrim over the whole window, under the sidebar",
    scrim.visibility === "visible" && scrim.covers && scrim.under,
    JSON.stringify({ visibility: scrim.visibility, covers: scrim.covers, under: scrim.under }),
  );
  check(
    "a progressive blur: stacked layers, strongest first, each a radial mask",
    scrim.layers.length >= 3 &&
      scrim.layers.every((layer, i) => i === 0 || layer.blur < scrim.layers[i - 1].blur) &&
      scrim.layers.every((layer) => /^radial-gradient\(circle/.test(layer.mask) && layer.opacity === "1"),
    JSON.stringify(scrim.layers),
  );
  const radial = await scrimFalloff();
  check(
    "the blur spreads from the middle of the sidebar's right edge",
    Math.abs(radial.origin.x - radial.side.right) <= 1 && Math.abs(radial.origin.y - radial.side.mid) <= 1,
    JSON.stringify({ origin: radial.origin, side: radial.side }),
  );
  check(
    "and falls off evenly in every direction: weaker further right, further down and further up, the same at the same distance",
    radial.ok,
    JSON.stringify(radial.samples),
  );
  check(
    "over a light translucent tint, spreading from the same point",
    /radial-gradient|rgba|color\(srgb/.test(scrim.tint) && scrim.tintOpacity === "1",
    scrim.tint,
  );
  // Only as tall as its contents: in a tall window it stops well short of the bottom.
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.waitForTimeout(200);
  const tall = await page.evaluate(() => {
    const rect = document.querySelector("[data-sidebar]").getBoundingClientRect();
    return { bottom: Math.round(rect.bottom), window: innerHeight };
  });
  check("in a tall window the sidebar ends at its contents, not the window's bottom",
    tall.bottom < tall.window - 40, JSON.stringify(tall));
  // Short enough that even the folders-only sidebar has to scroll.
  await page.setViewportSize({ width: 1440, height: 260 });
  await page.waitForTimeout(200);
  const short = await page.evaluate(() => {
    const side = document.querySelector("[data-sidebar]");
    const scroll = side.querySelector("[data-sidebar-scroll]");
    const footer = side.querySelector("[data-nav-account]").getBoundingClientRect();
    return {
      bottom: Math.round(side.getBoundingClientRect().bottom),
      window: innerHeight,
      scrolls: scroll.scrollHeight > scroll.clientHeight,
      footerInside: footer.bottom <= side.getBoundingClientRect().bottom + 0.5,
    };
  });
  check("in a short window it stays inside the window and scrolls inside itself, footer in view",
    short.bottom <= short.window - 8 && short.scrolls && short.footerInside, JSON.stringify(short));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);

  const sideText = await sidebar.evaluate((side) => ({
    brand: side.textContent.includes("Winnow"),
    sections: [...side.querySelectorAll("h3")].map((h) => h.textContent.trim()),
    folders: [...side.querySelectorAll("[data-nav-folder]")].map((b) => b.getAttribute("data-nav-folder")),
    account: side.querySelector("[data-nav-account]")?.textContent ?? "",
    gear: Boolean(side.querySelector('[data-nav-account] button[aria-label="Settings"]')),
    inboxCurrent: side.querySelector('button[data-nav="inbox"]')?.getAttribute("aria-current"),
    nav: Boolean(side.querySelector("nav")),
  }));
  check(
    "top to bottom: Winnow, Inbox, Mail (Sent, Archive, Trash…), the demo account and a gear",
    sideText.brand && JSON.stringify(sideText.sections) === JSON.stringify(["Mail"]) &&
      ["sent", "archive", "trash"].every((id) => sideText.folders.includes(id)) &&
      sideText.account.includes("Demo account") && sideText.gear && sideText.nav,
    JSON.stringify(sideText),
  );
  check("Inbox is the current page, in a nav list", sideText.inboxCurrent === "page", JSON.stringify(sideText));
  const sidebarInboxCount = Number(
    ((await sidebar.locator('button[data-nav="inbox"]').textContent()) ?? "").replace(/\D/g, ""),
  );
  check("the Inbox count is the list's own", sidebarInboxCount === (await rowTotal()), `${sidebarInboxCount} vs ${await rowTotal()}`);

  // The ways it closes. Escape first: it closes the sidebar and nothing else, and focus
  // goes back to the toggle.
  await page.keyboard.press("Escape");
  await waitSidebarClosed();
  const afterEscape = await page.evaluate(() => ({
    toggleFocused: document.activeElement?.hasAttribute("data-sidebar-toggle") ?? false,
    expanded: document.querySelector("header [data-sidebar-toggle]").getAttribute("aria-expanded"),
    scrim: getComputedStyle(document.querySelector("[data-sidebar-scrim]")).visibility,
    appInert: Boolean(document.querySelector("[data-masthead]").closest("[inert]")),
  }));
  check(
    "Escape closes it: focus back on the toggle, collapsed, scrim gone, app live again",
    afterEscape.toggleFocused && afterEscape.expanded === "false" && afterEscape.scrim === "hidden" && !afterEscape.appInert,
    JSON.stringify(afterEscape),
  );
  check("and that Escape closed nothing else", (await rowTotal()) === rowCount, `${await rowTotal()} rows`);

  // The toggle again: open, then a click outside it, on the scrim over the list.
  await openDrawer();
  await page.mouse.click(1000, 500);
  await waitSidebarClosed().catch(() => undefined);
  check(
    "a click outside it closes it, and the click does not reach what is under the scrim",
    !(await sidebarOpen()) && (await page.locator("article h1").count()) === 0,
  );

  // Choosing a destination closes it.
  await openDrawer();
  await sidebar.locator('button[data-nav-folder="sent"]').click();
  await waitSidebarClosed().catch(() => undefined);
  check(
    "choosing a folder goes there and closes it",
    !(await sidebarOpen()) && (await listTitle())?.trim() === "Sent",
    await listTitle(),
  );
  await openDrawer();
  await sidebar.locator('button[data-nav="inbox"]').click();
  await waitSidebarClosed().catch(() => undefined);
  check("and Inbox comes back the same way", !(await sidebarOpen()) && (await listTitle())?.trim() === "Inbox", await listTitle());

  // Idle: the mouse in, then away from it. Still open just before the timer, closed after.
  await openDrawer();
  await page.mouse.move(120, 120);
  await page.mouse.move(130, 130);
  await page.mouse.move(900, 450, { steps: 4 });
  await page.waitForTimeout(SIDEBAR_IDLE_MS - 600);
  const stillOpen = await sidebarOpen();
  await page.waitForTimeout(1_100);
  check(
    `the mouse away for ${SIDEBAR_IDLE_MS}ms closes it, and not before`,
    stillOpen && !(await sidebarOpen()),
    `open at ${SIDEBAR_IDLE_MS - 600}ms: ${stillOpen}`,
  );
  await waitSidebarClosed().catch(() => undefined);

  // Coming back inside cancels the timer; and an open account menu keeps it open.
  await openDrawer();
  await page.mouse.move(120, 120);
  await page.mouse.move(900, 450, { steps: 3 });
  await page.waitForTimeout(500);
  await page.mouse.move(120, 140, { steps: 3 });
  await page.waitForTimeout(SIDEBAR_IDLE_MS + 300);
  check("coming back before the timer keeps it open", await sidebarOpen());
  await sidebar.locator("[data-nav-account] button[aria-haspopup='menu']").click();
  await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 5_000 });
  const menuBox = await page.locator('[role="menu"]').first().boundingBox();
  // Out of the sidebar without crossing the menu, and wait well past the timer.
  await page.mouse.move(900, 80, { steps: 3 });
  await page.waitForTimeout(SIDEBAR_IDLE_MS + 400);
  check(
    "an open account menu inside it holds off the idle close",
    (await sidebarOpen()) && (await page.locator('[role="menu"]').count()) > 0,
    JSON.stringify(menuBox),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("Escape in the account menu closes the menu, not the sidebar", await sidebarOpen());
  await closeDrawer();

  // Keyboard: opened from the toggle with Enter, Tab stays inside, and the idle timer
  // leaves a keyboard user alone.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await page.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForTimeout(250);
  let escaped = false;
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => document.querySelector("[data-sidebar]").contains(document.activeElement)))) escaped = true;
  }
  check("Tab cycles inside the open sidebar", !escaped);
  await closeDrawer();
  check(
    "and closing hands focus back to the toggle",
    await page.evaluate(() => document.activeElement?.hasAttribute("data-sidebar-toggle") ?? false),
  );
  await page.mouse.move(900, 450);

  // Reduced motion: no slide and no fade, the sidebar and its scrim simply appear.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDrawer();
  const still = await page.evaluate(() => {
    const longest = (element) =>
      Math.max(...getComputedStyle(element).transitionDuration.split(",").map((value) => parseFloat(value) || 0));
    return {
      panel: longest(document.querySelector("[data-sidebar]")),
      layer: longest(document.querySelector("[data-scrim-layer]")),
      visible: getComputedStyle(document.querySelector("[data-sidebar-scrim]")).visibility,
    };
  });
  check(
    "with reduced motion it shows and hides without a slide or a fade, the blur still there",
    still.panel === 0 && still.layer === 0 && still.visible === "visible",
    JSON.stringify(still),
  );
  await closeDrawer();
  await page.emulateMedia({ reducedMotion: "no-preference" });

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

  // ── Google account setup ───────────────────────────────────────────────────

  section("google account setup");

  // The stubbed token endpoint answers 400 and 401 on purpose below, and Chromium logs
  // every failed load as a console error. Those two are expected; anything else that
  // this section produces still fails the console check at the end.
  const errorsBeforeSetup = errors.length;

  // Winnow ships no Google client, so "Connect Gmail" with nothing stored has to open
  // the setup sheet rather than fail with a configuration error.
  await connect.first().click();
  const setup = page.locator('[role="dialog"][aria-label="Google account"]');
  await setup.waitFor({ timeout: 5_000 });
  check("Connect Gmail opens the Google account setup when no client is stored", (await setup.count()) === 1);
  check(
    "focus starts in the client ID field",
    await page.evaluate(() => document.activeElement?.getAttribute("name") === "clientId"),
  );
  check(
    "the web build asks for a Web application client",
    (await setup.getByText("Web application", { exact: true }).count()) > 0,
  );
  check(
    "and shows the exact redirect URI to register",
    (await setup.locator("code").first().textContent())?.trim() === URL,
    await setup.locator("code").first().textContent(),
  );
  check(
    "the setup guide is one click away",
    (await setup.getByRole("button", { name: "Open the setup guide" }).count()) === 1,
  );

  const idInput = setup.locator('input[name="clientId"]');
  const secretInput = setup.locator('input[name="clientSecret"]');
  check(
    "both fields have labels",
    (await setup.getByLabel("Client ID").count()) === 1 && (await setup.getByLabel(/Client secret/).count()) === 1,
  );

  /** The text of the error a field's aria-describedby points at, or null. */
  const fieldError = (input) =>
    input.evaluate((el) => {
      if (el.getAttribute("aria-invalid") !== "true") return null;
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/);
      return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" | ");
    });

  // Submitting empty flags both fields and puts focus on the first.
  await setup.getByRole("button", { name: "Save and connect" }).click();
  await page.waitForTimeout(150);
  const emptyIdError = await fieldError(idInput);
  check("an empty client ID is flagged inline and tied to its field", /Enter the client ID/.test(emptyIdError ?? ""), emptyIdError ?? "no error");
  check("so is the missing secret a web client needs", /needs its client secret/.test((await fieldError(secretInput)) ?? ""));
  check(
    "focus moves to the first field with a problem",
    await page.evaluate(() => document.activeElement?.getAttribute("name") === "clientId"),
  );

  await idInput.fill("1234567890-abc123def");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(100);
  check(
    "a client ID without the Google suffix says what it should end in",
    /\.apps\.googleusercontent\.com/.test((await fieldError(idInput)) ?? ""),
  );

  const VALID_ID = "1234567890-abc123def.apps.googleusercontent.com";
  await idInput.fill(VALID_ID);
  await secretInput.fill("smoke-test-secret");
  await page.waitForTimeout(100);
  check("a well-formed pair clears the errors", (await fieldError(idInput)) === null && (await fieldError(secretInput)) === null);

  // "Test connection" talks to Google's token endpoint only; here that endpoint is
  // stubbed to answer the way it does for a known client and a made-up code.
  const tokenRequests = [];
  await page.route("https://oauth2.googleapis.com/token", async (route) => {
    tokenRequests.push(route.request().postData() ?? "");
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ error: "invalid_grant", error_description: "Malformed auth code." }),
    });
  });
  await setup.getByRole("button", { name: "Test connection" }).click();
  await setup.getByText("Google recognised this client").waitFor({ timeout: 5_000 }).catch(() => undefined);
  check("Test connection reports a recognised client", (await setup.getByText("Google recognised this client").count()) === 1);
  check(
    "and sent the client to Google's token endpoint only",
    tokenRequests.length === 1 && tokenRequests[0].includes(encodeURIComponent(VALID_ID)),
    `${tokenRequests.length} requests`,
  );
  check("nothing is stored until it is saved", (await page.evaluate(() => localStorage.getItem("winnow.google.oauthClient"))) === null);

  // A rejected client lands on the field Google blamed.
  await page.unroute("https://oauth2.googleapis.com/token");
  await page.route("https://oauth2.googleapis.com/token", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ error: "invalid_client", error_description: "The OAuth client was not found." }),
    }),
  );
  await setup.getByRole("button", { name: "Test connection" }).click();
  await page.waitForTimeout(400);
  check("an unknown client is reported on the client ID field", /doesn't know this client ID/.test((await fieldError(idInput)) ?? ""));
  await page.unroute("https://oauth2.googleapis.com/token");

  // Escape leaves without saving.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Escape closes the setup sheet", (await setup.count()) === 0);
  check("and the demo is still there", (await rowTotal()) > 0);

  // Save and connect: stored locally, then off to Google with the user's client id.
  const authorizeRequests = [];
  await page.route("https://accounts.google.com/**", async (route) => {
    authorizeRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Google</title>" });
  });
  await connect.first().click();
  await setup.waitFor({ timeout: 5_000 });
  await idInput.fill(VALID_ID);
  await secretInput.fill("smoke-test-secret");
  await page.keyboard.press("Enter");
  await page.waitForURL(/accounts\.google\.com/, { timeout: 5_000 }).catch(() => undefined);
  const authorize = authorizeRequests[0] ? new globalThis.URL(authorizeRequests[0]) : null;
  check(
    "Enter saves and starts sign-in with the user's own client id",
    authorize?.searchParams.get("client_id") === VALID_ID,
    authorizeRequests[0] ?? "no authorize request",
  );
  check("with the app's own address as the redirect URI", authorize?.searchParams.get("redirect_uri") === URL);
  check("and never puts the secret in the authorize URL", !(authorizeRequests[0] ?? "").includes("smoke-test-secret"));

  // Back to the app before dropping the stub, so the fake page's own follow-up
  // requests (a favicon) never reach the real network.
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.unroute("https://accounts.google.com/**");
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("winnow.google.oauthClient") ?? "null"));
  check("the client is kept in this browser's storage", saved?.clientId === VALID_ID && saved?.clientSecret === "smoke-test-secret");

  // Settings → Google account shows it, and can remove it.
  await page.keyboard.press(",");
  await openSettingsCategory(page, "google");
  await page.waitForSelector("text=Your Google OAuth client", { timeout: 5_000 });
  check("Settings has a Google account section", (await page.getByText("Your Google OAuth client").count()) === 1);
  check("which shows the client, shortened", (await page.getByText(/123456….*\.apps\.googleusercontent\.com/).count()) > 0);
  await page.locator('[role="dialog"][aria-label="Settings"]').getByRole("button", { name: "Change" }).click();
  await setup.waitFor({ timeout: 5_000 });
  check("Change opens the setup sheet with the saved id", (await idInput.inputValue()) === VALID_ID);
  await setup.getByRole("button", { name: "Remove…" }).click();
  await setup.getByRole("button", { name: "Remove", exact: true }).click();
  await page.waitForTimeout(300);
  check("Remove forgets the client", (await page.evaluate(() => localStorage.getItem("winnow.google.oauthClient"))) === null);
  check("and leaves the demo usable", (await idInput.inputValue()) === "");

  // Import JSON: the client_secret_….json Google Cloud downloads fills both fields.
  const IMPORT_SECRET = "smoke-import-secret-value";
  const clientFile = (section, extra = {}) =>
    JSON.stringify({
      [section]: {
        client_id: VALID_ID,
        project_id: "winnow-smoke-42",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        client_secret: IMPORT_SECRET,
        redirect_uris: [URL],
        javascript_origins: [new globalThis.URL(URL).origin],
        ...extra,
      },
    });
  const importButton = setup.getByRole("button", { name: "Import JSON" });
  check("an Import JSON button is on the setup sheet", (await importButton.count()) === 1);
  await importButton.focus();
  check("and it is keyboard-reachable", await importButton.evaluate((el) => el === document.activeElement));

  const fileInput = setup.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "client_secret_1234567890-abc123def.apps.googleusercontent.com.json",
    mimeType: "application/json",
    buffer: Buffer.from(`\uFEFF${clientFile("web")}\n`),
  });
  await setup.locator("[data-imported-project]").waitFor({ timeout: 5_000 }).catch(() => undefined);
  check(
    "importing a client file fills the client ID and secret",
    (await idInput.inputValue()) === VALID_ID && (await secretInput.inputValue()) === IMPORT_SECRET,
  );
  check("and names the imported project", (await setup.locator("[data-imported-project]").textContent()) === "winnow-smoke-42");
  check(
    "inside a polite live region",
    (await setup.locator('[data-import-status][aria-live="polite"]').count()) === 1,
  );
  const apiLinks = await setup.locator("[data-api-note] a").evaluateAll((links) => links.map((a) => a.getAttribute("href")));
  check(
    "with links to enable the Gmail and People APIs for that project",
    apiLinks.length === 2 &&
      apiLinks[0] === "https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=winnow-smoke-42" &&
      apiLinks[1] === "https://console.cloud.google.com/apis/library/people.googleapis.com?project=winnow-smoke-42",
    JSON.stringify(apiLinks),
  );
  check(
    "focus moves to Save and connect after the import",
    await page.evaluate(() => document.activeElement?.textContent?.trim() === "Save and connect"),
  );
  check("a matching file raises no warnings", (await setup.locator("[data-import-warning]").count()) === 0);
  check("nothing is stored until it is saved, imported or not", (await page.evaluate(() => localStorage.getItem("winnow.google.oauthClient"))) === null);

  // A Desktop app client can't return to a web page: refused, pointing at the right type.
  await fileInput.setInputFiles({ name: "client_secret_desktop.json", mimeType: "application/json", buffer: Buffer.from(clientFile("installed")) });
  await setup.locator("[data-import-error]").waitFor({ timeout: 5_000 }).catch(() => undefined);
  const wrongType = (await setup.locator('[data-import-error][role="alert"]').textContent()) ?? "";
  check("a Desktop app client file is refused in the browser, as an alert", /Desktop app client/.test(wrongType) && /Web application/.test(wrongType), wrongType);
  check("and the error never shows the secret", !wrongType.includes(IMPORT_SECRET));
  check("focus returns to Import JSON after a refused file", await importButton.evaluate((el) => el === document.activeElement));

  // A file that isn't JSON at all.
  await fileInput.setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from("client id: abc") });
  await page.waitForTimeout(200);
  check("a file that isn't JSON is refused", /isn't a Google client JSON file/.test((await setup.locator("[data-import-error]").textContent()) ?? ""));

  // Pasting the file's text into the client ID field imports it too.
  await idInput.fill("");
  await secretInput.fill("");
  await idInput.focus();
  await idInput.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, `  ${clientFile("web", { redirect_uris: [URL.replace(/\/$/, "")] })}  `);
  await setup.locator("[data-imported-project]").waitFor({ timeout: 5_000 }).catch(() => undefined);
  check(
    "pasting the JSON into Client ID imports it instead of filling the field with JSON",
    (await idInput.inputValue()) === VALID_ID && (await secretInput.inputValue()) === IMPORT_SECRET,
    await idInput.inputValue(),
  );
  check("the error from the last file is cleared", (await setup.locator("[data-import-error]").count()) === 0);
  const pasteWarning = (await setup.locator("[data-import-warning]").first().textContent()) ?? "";
  check("a redirect URI that misses the trailing slash is warned about", /trailing slash/.test(pasteWarning), pasteWarning);

  // Dropping the file onto the sheet.
  await idInput.fill("");
  await secretInput.fill("");
  const dropped = await page.evaluateHandle((text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], "client_secret.json", { type: "application/json" }));
    return data;
  }, clientFile("web"));
  const form = setup.locator('[data-testid="google-setup"]');
  await form.dispatchEvent("dragenter", { dataTransfer: dropped });
  await setup.locator('[data-testid="google-setup"][data-dragging="true"]').waitFor({ timeout: 2_000 }).catch(() => undefined);
  check("dragging a file over the sheet highlights it", (await form.getAttribute("data-dragging")) === "true");
  await form.dispatchEvent("drop", { dataTransfer: dropped });
  await setup.locator('[data-testid="google-setup"]:not([data-dragging])').waitFor({ timeout: 2_000 }).catch(() => undefined);
  await page.waitForFunction((id) => document.querySelector('input[name="clientId"]')?.value === id, VALID_ID, { timeout: 2_000 }).catch(() => undefined);
  check(
    "dropping the client file onto the sheet imports it",
    (await idInput.inputValue()) === VALID_ID && (await secretInput.inputValue()) === IMPORT_SECRET && (await form.getAttribute("data-dragging")) === null,
  );
  check(
    "the secret appears nowhere on the sheet as text",
    !((await setup.textContent()) ?? "").includes(IMPORT_SECRET),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("the demo mailbox is untouched", (await rowTotal()) > 0 && (await setup.count()) === 0);

  const setupErrors = errors.splice(errorsBeforeSetup);
  errors.push(...setupErrors.filter((text) => !/status of 40[01] \((Bad Request|Unauthorized)\)/.test(text)));

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
  const subjectFont = await page.locator("article h1").first().evaluate((el) => {
    const style = getComputedStyle(el);
    return { family: style.fontFamily, weight: style.fontWeight, size: style.fontSize, tracking: style.letterSpacing };
  });
  check(
    "the reader's subject is IBM Plex Sans semibold 24px, slightly tight",
    subjectFont.family.startsWith('"IBM Plex Sans"') && subjectFont.weight === "600" && subjectFont.size === "24px" && subjectFont.tracking === "-0.24px",
    JSON.stringify(subjectFont),
  );
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
    // Cleared through the rail's own "All", which is what the rail offers for it.
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

  // ── Settings: How Winnow sorts ─────────────────────────────────────────────
  //
  // No sliders and no "Learn from stars" switch any more: one line, and a Reset sorting
  // button behind an inline confirmation. Seeded with a tuned weight (written to storage
  // and reloaded, which is how a real install would carry one) so the reset has
  // something to undo, and a legacy `adaptive: false` to prove it is not honoured.
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("winnow.learning.v1") ?? "{}");
    localStorage.setItem(
      "winnow.learning.v1",
      JSON.stringify({ ...raw, adaptive: false, weights: { ...(raw.weights ?? {}), security: 30 } }),
    );
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("[data-message-id]", { timeout: 10_000 });
  await page.keyboard.press(",");
  await page.waitForSelector("text=How Winnow sorts", { timeout: 5_000 });
  const sliders = await page.locator('input[type="range"]').count();
  check("settings has no weight sliders", sliders === 0, `${sliders} sliders`);
  check(
    "and no Learn from stars switch",
    (await page.locator('[role="switch"][aria-label="Learn from stars"]').count()) === 0,
  );
  check(
    "it says Winnow learns from stars and hides",
    ((await page.locator("[data-sorting-note]").textContent()) ?? "").includes("learns from your stars and hides"),
  );
  const learnedSecurity = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("winnow.learning.v1") ?? "{}").weights?.security);
  const resetButton = page.getByRole("button", { name: "Reset sorting" });
  await resetButton.click();
  await page.waitForTimeout(100);
  check(
    "Reset sorting asks first, inline, and changes nothing yet",
    (await page.locator('[data-sorting-reset="confirm"] [role="group"][aria-label="Reset sorting?"]').count()) === 1 &&
      (await learnedSecurity()) === 30,
    String(await learnedSecurity()),
  );
  await page.locator('[data-sorting-reset="confirm"]').getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(100);
  check("Cancel backs out", (await resetButton.count()) === 1 && (await learnedSecurity()) === 30);
  await resetButton.click();
  await page.locator('[data-sorting-reset="confirm"]').getByRole("button", { name: "Reset", exact: true }).click();
  await page.waitForTimeout(300);
  const afterReset = await page.evaluate(() => JSON.parse(localStorage.getItem("winnow.learning.v1") ?? "{}"));
  check(
    "confirming restores the default weights and says so",
    afterReset.weights?.security === 16 &&
      ((await page.locator('[data-sorting-reset] [role="status"]').textContent()) ?? "").includes("Sorting reset"),
    JSON.stringify(afterReset.weights),
  );
  check("and the old learning switch is not written back", !("adaptive" in afterReset), Object.keys(afterReset).join(","));

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
    (await page.locator('[data-composer] button:has-text("Send") kbd').count()) > 0,
  );
  await page.keyboard.press("Meta+Enter");
  await page.waitForTimeout(300);
  // Undo send holds it first; Send now skips the wait, and a failed send brings the
  // composer back with its draft and the reason.
  check("⌘⏎ puts the reply in its undo window", (await page.locator("[data-send-pending]").count()) === 1);
  await page.locator("[data-send-now]").click();
  await page.locator('[data-composer] [role="alert"]').first().waitFor({ timeout: 5_000 }).catch(() => undefined);
  check(
    "and a send that fails reopens the reply as it was",
    ((await page.locator('textarea[aria-label="Message"]').first().inputValue().catch(() => "")) ?? "").startsWith("Sounds good"),
  );

  // The demo has nowhere to send to, which is the one thing it can usefully prove here:
  // the failure is reported *once*, in the composer, in words a person can act on. It
  // used to be reported twice — "Cannot send: not signed in." inside the sheet and
  // "Signing in to Gmail is required to send." in the app-wide strip above it — so one
  // failed send produced two banners saying different things about the same event.
  const composerError = page.locator('[data-composer] [role="alert"]');
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
  await page.waitForSelector('[data-composer-dock]', { timeout: 5_000 });
  check(
    "Forward opens docked in the reader, titled Forward",
    (await page.locator('section[data-composer-dock][aria-label="Forward"]').count()) > 0,
  );
  check(
    "it focuses the To field first, not the body",
    (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "To",
  );
  check(
    "Send is disabled with no recipient",
    await page.locator('[data-composer] button:has-text("Send")').first().isDisabled(),
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
      (await page.locator('section[data-composer-dock][aria-label="Forward"]').count()) > 0,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(
    "an empty forward closes without asking",
    (await page.locator('section[data-composer-dock][aria-label="Forward"]').count()) === 0,
  );
  check("and asks nothing", (await confirmDialog().count()) === 0);

  await closeReader();
  await openMessage();
  await page.keyboard.press("f");
  await page.waitForTimeout(400);
  check(
    "`f` opens the forward composer",
    (await page.locator('section[data-composer-dock][aria-label="Forward"]').count()) > 0,
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
  // Focused rather than clicked: docked, the six-row body sits under the To field's open
  // suggestion list, which a click would land on.
  await page.locator('textarea[aria-label="Message"]').focus();
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
  const chips = page.locator('[data-composer] button[aria-label^="Remove"]');
  const sendButton = page.locator('[data-composer] button:has-text("Send")').first();

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
    (await page.locator('[data-composer] [aria-invalid="true"]').count()) > 0,
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

  // ── Composing a new message ─────────────────────────────────────────────────
  //
  // Self-contained: it sets the viewport it needs, puts it back, and leaves the inbox on
  // screen. The demo has no server, so a send is simulated and filed into Sent locally —
  // which is what lets this prove the whole loop rather than the error path.
  section("compose");
  {
    const viewportBefore = page.viewportSize();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);

    const newSheet = () => page.locator('[role="dialog"][aria-label="New message"]');
    const newSend = () => newSheet().locator("button", { hasText: /^Send/ }).first();
    const subjectConfirm = () => page.locator('[role="dialog"][aria-label="Send without a subject?"]');
    /** Escape until the sheet closes or asks: the To field's suggestion list takes one. */
    const escapeComposer = async () => {
      for (let i = 0; i < 3; i += 1) {
        if ((await newSheet().count()) === 0 || (await confirmDialog().count()) > 0) return;
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
      }
    };

    const composeButton = page.locator("[data-compose]:visible");
    require("the masthead has a Compose button", (await composeButton.count()) === 1);
    check(
      "it names its key in the tooltip",
      (await composeButton.getAttribute("title")) === "Compose (c)",
      String(await composeButton.getAttribute("title")),
    );
    await composeButton.click();
    await newSheet().waitFor({ state: "visible", timeout: 5_000 });
    check("Compose opens a sheet titled New message", true);
    check(
      "the draft is blank",
      (await newSheet().locator("[aria-invalid], button[aria-label^='Remove']").count()) === 0 &&
        (await newSheet().locator('input[aria-label="To"]').inputValue()) === "" &&
        (await newSheet().locator('input[aria-label="Subject"]').inputValue()) === "" &&
        (await newSheet().locator('textarea[aria-label="Message"]').inputValue()) === "",
    );
    check(
      "and it starts in To",
      (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "To",
    );
    check(
      "From is the account it goes out from",
      ((await newSheet().locator("[data-composer-from]").textContent()) ?? "").includes("@"),
      String(await newSheet().locator("[data-composer-from]").textContent()),
    );
    check(
      "Cc and Bcc wait until asked for",
      (await newSheet().locator('input[aria-label="Cc"]').count()) === 0 &&
        (await newSheet().locator("[data-show-copies]").count()) === 1,
    );
    await newSheet().locator("[data-show-copies]").click();
    await page.waitForTimeout(200);
    check(
      "Cc/Bcc reveals both fields",
      (await newSheet().locator('input[aria-label="Cc"]').count()) === 1 &&
        (await newSheet().locator('input[aria-label="Bcc"]').count()) === 1,
    );

    await escapeComposer();
    check(
      "an untouched new message closes on Escape without asking",
      (await newSheet().count()) === 0 && (await confirmDialog().count()) === 0,
    );

    // `c` on the list composes.
    await page.locator("[data-message-id]").first().waitFor({ state: "visible", timeout: 5_000 });
    await page.locator("body").click({ position: { x: 5, y: 890 } }).catch(() => undefined);
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press("c");
    await page.waitForTimeout(300);
    require("`c` opens a new message", (await newSheet().count()) === 1);

    // Nobody to send to: Send is disabled, and ⌘⏎ says why in place.
    check("Send is disabled with no recipient", await newSend().isDisabled());
    // `focus()`, not a click: the To field's suggestion list is open over the body.
    await newSheet().locator('textarea[aria-label="Message"]').focus();
    await page.keyboard.type("Are we still on for Thursday?");
    await page.keyboard.press("Meta+Enter");
    await page.waitForTimeout(250);
    check(
      "a send with no recipient is blocked, and says so",
      (await newSheet().count()) === 1 &&
        ((await newSheet().locator('[role="alert"]').allTextContents()).join(" ")).includes("Add at least one recipient"),
      (await newSheet().locator('[role="alert"]').allTextContents()).join(" | "),
    );

    // Something that is not an address: a red chip, an inline reason, Send stays off.
    const newTo = newSheet().locator('input[aria-label="To"]');
    await newTo.focus();
    await page.keyboard.type("not an address,");
    await page.waitForTimeout(200);
    check(
      "an invalid recipient is marked and explained",
      (await newSheet().locator('[aria-invalid="true"]').count()) > 0 &&
        (await page.locator("#winnow-composer-to-error").count()) === 1,
    );
    check("and Send stays disabled", await newSend().isDisabled());
    check(
      "the caret stays in To once it has a chip",
      (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "To",
    );
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(150);
    check(
      "Backspace in an empty field removes the last chip",
      (await newSheet().locator('button[aria-label^="Remove"]').count()) === 0,
    );

    // Esc with something written asks; keep editing.
    await escapeComposer();
    check("Escape with a written draft asks before discarding", (await confirmDialog().count()) === 1);
    await answerDiscard(false);
    check("declining keeps the new message open", (await newSheet().count()) === 1);

    // A typed, uncommitted address counts: Send is enabled, and takes it along.
    await newTo.focus();
    await page.keyboard.type("Ana Kovač <ana@northwind.example>");
    await page.waitForTimeout(150);
    check("an address typed but not yet a chip enables Send", !(await newSend().isDisabled()));

    // No subject: asked, as Gmail does.
    await page.keyboard.press("Meta+Enter");
    await subjectConfirm().waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    check("sending without a subject asks first", (await subjectConfirm().count()) === 1);
    await subjectConfirm().getByRole("button", { name: "Keep editing" }).click();
    await page.waitForTimeout(250);
    check(
      "and cancelling goes back to the draft, with the typed address now a chip",
      (await newSheet().count()) === 1 &&
        (await newSheet().locator('button[aria-label^="Remove"]').count()) === 1,
    );

    const subject = `Thursday — café at 12? ${Date.now().toString(36)}`;
    await newSheet().locator('input[aria-label="Subject"]').fill(subject);
    await newSend().click();
    await newSheet().waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
    check("a valid send in the demo closes the composer", (await newSheet().count()) === 0);

    // Undo send (5s by default): the message waits under a "Sending… Undo" strip, and
    // Undo brings it back to the composer exactly as it was — nothing has left.
    const sendingStrip = page.locator("[data-send-pending]");
    check("and holds the message under a Sending… Undo strip", (await sendingStrip.count()) === 1,
      String(await sendingStrip.textContent().catch(() => "none")));
    check("which counts down", /Sending in \d+s/.test((await sendingStrip.textContent().catch(() => "")) ?? ""));
    await sendingStrip.locator("[data-send-undo]").click();
    await newSheet().waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    check(
      "Undo reopens the composer with what was written",
      (await newSheet().count()) === 1 &&
        (await newSheet().locator('input[aria-label="Subject"]').inputValue()) === subject &&
        (await newSheet().locator('button[aria-label^="Remove"]').count()) === 1,
    );
    check("and the strip goes", (await sendingStrip.count()) === 0);
    await page.waitForTimeout(5_500);
    check("and nothing was sent in the meantime",
      !(((await page.locator("[data-notice-text]").textContent().catch(() => "")) ?? "").includes("Message sent")));

    // Sending again, then Send now on the strip: it goes without waiting the rest out.
    await newSend().click();
    await newSheet().waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
    await sendingStrip.locator("[data-send-now]").click();
    await page.locator("[data-notice-text]", { hasText: "Message sent" }).waitFor({ timeout: 5_000 }).catch(() => undefined);
    check("Send now on the strip sends at once", (await sendingStrip.count()) === 0);
    check(
      "and confirms it went",
      ((await page.locator("[data-notice-text]").textContent().catch(() => "")) ?? "").includes("Message sent"),
      String(await page.locator("[data-notice-text]").textContent().catch(() => "no notice")),
    );
    check("and puts up no error", (await page.locator('div[role="alert"]').count()) === 0);

    await goTo("Sent");
    check(
      "the message is in Sent",
      (await page.locator("[data-message-id]", { hasText: subject }).count()) === 1,
    );
    await goTo("Inbox");

    if (viewportBefore) await page.setViewportSize(viewportBefore);
    await page.waitForTimeout(250);
  }

  // The pencil, on a phone: its own context so the desktop page above is untouched.
  {
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const p = await phoneContext.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-message-id]", { timeout: 10_000 });
    const fab = p.locator("[data-compose-fab]");
    check("the phone shows a compose pencil over the list", (await fab.count()) === 1 && (await fab.isVisible()));
    const fabBox = await fab.boundingBox();
    const dockBox = await p.locator("[data-phone-dock]").boundingBox();
    check(
      "bottom-right, clear of the dock, and a full touch target",
      Boolean(fabBox && dockBox) &&
        fabBox.x + fabBox.width <= 390 - 8 &&
        fabBox.x > 390 / 2 &&
        fabBox.y + fabBox.height <= dockBox.y - 4 &&
        fabBox.width >= 44 &&
        fabBox.height >= 44,
      JSON.stringify({ fabBox, dockBox }),
    );
    await p.locator("[data-message-id]").first().tap();
    await p.waitForSelector("article h1", { timeout: 5_000 });
    check("it is hidden in the reader", (await p.locator("[data-compose-fab]").count()) === 0);
    await p.locator('button[aria-label="Back to the list"]:visible').first().tap();
    await p.waitForTimeout(400);
    check("and back on the list", (await p.locator("[data-compose-fab]").count()) === 1);
    await p.locator("[data-compose-fab]").tap();
    const phoneSheet = p.locator('[role="dialog"][aria-label="New message"]');
    await phoneSheet.waitFor({ state: "visible", timeout: 5_000 });
    await p.waitForTimeout(400);
    const sheetBox = await phoneSheet.boundingBox();
    check(
      "it opens the composer full-screen",
      Boolean(sheetBox) && sheetBox.width >= 389 && sheetBox.height >= 840,
      JSON.stringify(sheetBox),
    );
    const phoneSendBox = await phoneSheet.locator("button", { hasText: /^Send$/ }).boundingBox();
    check(
      "with Send at the bottom, a full touch target",
      Boolean(phoneSendBox) && phoneSendBox.height >= 44 && phoneSendBox.y + phoneSendBox.height >= 844 - 16,
      JSON.stringify(phoneSendBox),
    );
    check("and the pencil is gone under it", (await p.locator("[data-compose-fab]").count()) === 0);
    await phoneContext.close();
  }

  // ── Inline reply and drafts ─────────────────────────────────────────────────
  //
  // A desktop reply docks at the bottom of the reader, under the conversation, which
  // keeps its own scroll; Reply / Reply all switches who it goes to; the draft is saved
  // (in the demo, on this device), survives moving away and a reload, and Discard
  // clears it. A phone keeps the full-screen composer. Its own contexts, so the saved
  // drafts cannot reach any other section's reloads.
  section("inline reply and drafts");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const d = await ctx.newPage();
    d.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    d.on("pageerror", (error) => errors.push(String(error)));
    d.on("dialog", (dialog) => {
      errors.push(`native ${dialog.type()} dialog: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await d.goto(URL, { waitUntil: "networkidle" });
    await d.waitForSelector("[data-message-id]", { timeout: 10_000 });

    const dockEl = d.locator("[data-composer-dock]");
    const body = d.locator('[data-composer-dock] textarea[aria-label="Message"]');
    const toNames = () =>
      d.locator('[data-composer] button[aria-label^="Remove"]').evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    const status = d.locator("[data-draft-status]");
    const storedDrafts = () => d.evaluate(() => localStorage.getItem("winnow.drafts.v1:demo") ?? "");
    const openThread = async () => {
      await d.locator("[data-message-id]", { hasText: "the migration plan" }).first().click();
      await d.waitForSelector("article h1", { timeout: 5_000 });
    };

    await openThread();
    await d.keyboard.press("r");
    await dockEl.waitFor({ state: "visible", timeout: 5_000 });
    await d.waitForTimeout(300);
    check("a desktop reply opens docked, not as a sheet", (await d.locator('[role="dialog"][aria-label="Reply"]').count()) === 0);
    const pane = await d.locator("[data-reader-pane]").boundingBox();
    const dockBox = await dockEl.boundingBox();
    check(
      "inside the reader pane, at its bottom",
      Boolean(pane && dockBox) &&
        dockBox.x >= pane.x - 1 &&
        dockBox.x + dockBox.width <= pane.x + pane.width + 1 &&
        dockBox.y >= pane.y &&
        Math.abs(dockBox.y + dockBox.height - (pane.y + pane.height)) <= 2,
      JSON.stringify({ pane, dockBox }),
    );
    check(
      "and no taller than about half of it",
      Boolean(pane && dockBox) && dockBox.height <= pane.height * 0.52,
      JSON.stringify({ pane: pane?.height, dock: dockBox?.height }),
    );
    check(
      "with the caret in the body",
      (await d.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Message",
    );
    const scrolled = await d.evaluate(() => {
      const scroller = [...document.querySelectorAll("[data-reader] .overflow-y-auto")].find(
        (el) => !el.closest("[data-composer-dock]"),
      );
      if (!scroller) return null;
      scroller.scrollTop = 0;
      scroller.scrollTop = 160;
      return { top: scroller.scrollTop, sh: scroller.scrollHeight, ch: scroller.clientHeight };
    });
    check(
      "the conversation above still scrolls on its own",
      Boolean(scrolled) && scrolled.top > 0 && scrolled.ch > 100,
      JSON.stringify(scrolled),
    );

    const allNames = await toNames();
    check("Reply all is the default and leaves you off", allNames.length === 2 && !allNames.some((n) => n.includes("Alex")), JSON.stringify(allNames));
    await d.locator('[data-reply-all="one"]').click();
    await d.waitForTimeout(150);
    const oneNames = await toNames();
    check("Reply switches To to the last sender", oneNames.length === 1, JSON.stringify(oneNames));
    check("and says which is on", (await d.locator('[data-reply-all="one"]').getAttribute("aria-pressed")) === "true");
    await d.locator('[data-reply-all="all"]').click();
    await d.waitForTimeout(150);
    check("Reply all puts everyone back", (await toNames()).length === 2);

    await body.focus();
    await d.keyboard.type("Thursday works. j k e", { delay: 10 });
    check(
      "reader shortcuts do not fire while typing",
      (await body.inputValue()).startsWith("Thursday works. j k e") && (await dockEl.count()) === 1,
    );
    await d.waitForTimeout(2600);
    check("typing shows Saved (the demo saves on this device)", (await status.textContent()) === "Saved on this device", (await status.textContent()) ?? "");
    check("and the device copy holds the text", (await storedDrafts()).includes("Thursday works."));

    // Moving to another message keeps the half-written reply rather than losing it.
    await d.locator("[data-message-id]", { hasText: "Your verification code" }).first().click();
    await d.waitForTimeout(400);
    check("moving to another message puts the reply away", (await dockEl.count()) === 0 && (await confirmDialogIn(d).count()) === 0);
    check("and says it was kept", (await d.locator("text=Draft saved.").count()) > 0);
    await openThread();
    await d.keyboard.press("r");
    await dockEl.waitFor({ state: "visible", timeout: 5_000 });
    check("replying again picks the draft back up", (await body.inputValue()).startsWith("Thursday works."));

    // A reload (or a crash) offers it back.
    await d.reload({ waitUntil: "networkidle" });
    await d.waitForSelector("[data-message-id]", { timeout: 10_000 });
    const offer = d.locator('[role="dialog"][aria-label="Restore your unsent draft?"]');
    await offer.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    check("after a reload, the unsent draft is offered back", (await offer.count()) === 1);
    await offer.getByRole("button", { name: "Restore" }).click();
    await dockEl.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    check(
      "Restore reopens it docked on its message, with the text",
      (await dockEl.count()) === 1 && (await body.inputValue()).startsWith("Thursday works.") && (await d.locator("article h1").count()) === 1,
    );

    // Closing during the undo window keeps the message as a draft and never sends it:
    // the reload offers it back, text and all.
    await body.focus();
    await d.keyboard.press("Meta+Enter");
    await d.locator("[data-send-pending]").waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
    check("Send puts the reply in its undo window", (await d.locator("[data-send-pending]").count()) === 1 && (await dockEl.count()) === 0);
    await d.reload({ waitUntil: "networkidle" });
    await d.waitForSelector("[data-message-id]", { timeout: 10_000 });
    await offer.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    check("closing in the undo window keeps it as a draft, offered back on launch", (await offer.count()) === 1);
    await offer.getByRole("button", { name: "Restore" }).click();
    await dockEl.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    check("and it comes back unsent, with the text", (await dockEl.count()) === 1 && (await body.inputValue()).startsWith("Thursday works."));

    // Escape asks; Discard clears.
    await body.focus();
    await d.keyboard.press("Escape");
    await d.waitForTimeout(250);
    check("Escape in the docked reply asks before discarding", (await confirmDialogIn(d).count()) === 1);
    await confirmDialogIn(d).getByRole("button", { name: "Keep editing" }).click();
    await d.waitForTimeout(200);
    check("and keeping it keeps it", (await dockEl.count()) === 1);
    await dockEl.getByRole("button", { name: "Discard", exact: true }).click();
    await d.waitForTimeout(300);
    check("Discard closes it", (await dockEl.count()) === 0);
    check("and clears the saved copy", !(await storedDrafts()).includes("Thursday works."));
    await d.reload({ waitUntil: "networkidle" });
    await d.waitForSelector("[data-message-id]", { timeout: 10_000 });
    await d.waitForTimeout(500);
    check("so nothing is offered after a reload", (await offer.count()) === 0);

    // A new message is still a sheet on the desktop.
    await d.keyboard.press("c");
    await d.waitForTimeout(300);
    check("Compose stays a sheet on the desktop", (await d.locator('[role="dialog"][aria-label="New message"]').count()) === 1);
    await d.keyboard.press("Escape");
    await ctx.close();

    // The phone keeps the full-screen composer for a reply.
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const p = await phoneCtx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-message-id]", { timeout: 10_000 });
    await p.locator("[data-message-id]").first().tap();
    await p.waitForSelector("article h1", { timeout: 5_000 });
    await p.locator('[data-reader-dock] button[aria-label^="Reply"]').first().tap();
    const phoneReply = p.locator('[role="dialog"][aria-label="Reply"]');
    await phoneReply.waitFor({ state: "visible", timeout: 5_000 });
    await p.waitForTimeout(400);
    const phoneBox = await phoneReply.boundingBox();
    check(
      "a phone reply is still the full-screen composer, never docked",
      Boolean(phoneBox) && phoneBox.width >= 389 && phoneBox.height >= 840 && (await p.locator("[data-composer-dock]").count()) === 0,
      JSON.stringify(phoneBox),
    );
    await phoneCtx.close();
  }

  // ── The mailboxes ──────────────────────────────────────────────────────────

  section("mailboxes");

  await page.keyboard.press("!");
  // Selected by role, not by text: the palette's accessible name is an
  // `aria-label`, and `text=` matches visible text only.
  await page.waitForSelector('[role="menu"]', { timeout: 5_000 });
  const paletteRows = await page.locator('[role="menu"] [role="menuitem"]').count();
  check("the navigation palette opens", paletteRows === 6, `${paletteRows} rows`);
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

  // ── Drafts: the demo's drafts, reopened in the composer ───────────────────

  await goTo("Drafts");
  const draftRows = await page.locator("[data-message-id]").count();
  check("Drafts lists the demo's drafts", draftRows >= 2, `${draftRows} rows`);
  check(
    "and each row says it is a draft",
    (await page.locator('[data-row-id] span:text-is("Draft")').count()) === draftRows,
  );
  const studio = page.locator("[data-message-id]", { hasText: "Studio visit next week" });
  await studio.click();
  await page.waitForSelector('[role="dialog"] input[aria-label="Subject"]', { timeout: 5_000 });
  check(
    "opening a draft reopens it in the composer",
    (await page.locator('[role="dialog"] input[aria-label="Subject"]').inputValue()) === "Studio visit next week",
  );
  check(
    "with its words intact",
    ((await page.locator('[role="dialog"] textarea[aria-label="Message"]').inputValue()) ?? "").includes("printed proofs"),
  );
  check("and not the reader", (await page.locator("article h1").count()) === 0);
  await page.locator('[role="dialog"] textarea[aria-label="Message"]').fill("Hi Helena,\n\nTuesday it is.");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Escape puts a reopened draft away without asking", (await page.locator('[role="dialog"]').count()) === 0);
  check(
    "and the row shows the edit",
    (await page.locator("[data-message-id]", { hasText: "Tuesday it is." }).count()) === 1,
  );
  const migration = page.locator("[data-message-id]", { hasText: "Re: the migration plan" });
  await migration.click();
  await page.waitForSelector('[role="dialog"] textarea[aria-label="Message"]', { timeout: 5_000 });
  check(
    "a reply draft reopens as a reply",
    (await page.locator('[role="dialog"][aria-label="Reply"]').count()) === 1,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await goTo("Inbox");

  // ── There is no Mark all read ──────────────────────────────────────────────

  // Winnow marks a message read when it is opened; a button (or `⇧U`, or a palette
  // row) that clears a whole mailbox's unread state lets mail look read that never
  // was, so the verb was removed everywhere. The inbox's unread count must survive
  // the old keystroke, and no undo offer may appear for something that did not happen.
  await goTo("Inbox");
  check(
    "the masthead has no Mark all read button",
    (await page.locator('[aria-label^="Mark all read"]').count()) === 0,
  );
  const inboxUnreadBefore = await unreadBadge("Inbox");
  require("the demo inbox has unread mail to test against", Number(inboxUnreadBefore) > 0, `inbox ${inboxUnreadBefore}`);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.keyboard.press("Shift+U");
  await page.waitForTimeout(300);
  check(
    "⇧U no longer marks the mailbox read",
    (await unreadBadge("Inbox")) === inboxUnreadBefore,
    `inbox ${inboxUnreadBefore} → ${await unreadBadge("Inbox")}`,
  );
  check("and offers no undo", (await page.locator('button:has-text("Undo")').count()) === 0);

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
    'button[aria-label="Archive"]:not([data-nav-folder]), button[aria-label="Restore"]:not([data-nav-folder]), button[aria-label="Move to inbox"]:not([data-nav-folder])',
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

  // ── Filters cannot be hidden ──────────────────────────────────────────────

  section("no hiding filters");

  /*
    A pill switches its filter on and off, and "All" clears them; nothing removes a
    bucket from the rail or its mail from the inbox. Checked after a hover, because the
    hide control this replaces only appeared on hover, so a count before it would say
    nothing.
  */
  await goTo("Inbox");
  await page.waitForTimeout(300);
  const newsletters = page.locator('header button[aria-label^="Newsletters,"]:visible').first();
  require("the demo has a Newsletters bucket", (await newsletters.count()) > 0);
  await newsletters.hover();
  await page.waitForTimeout(250);
  const hideControls = () =>
    page.locator(
      'header [data-rail-scroller] button[aria-label^="Hide "], header [data-rail-scroller] button[aria-label^="Show "]',
    );
  check("no pill offers a hide or restore control", (await hideControls().count()) === 0, `${await hideControls().count()}`);
  const railButtons = await page.evaluate(() =>
    [...document.querySelectorAll("header [data-rail-scroller] [data-rail-item][data-rail-key]")].map(
      (item) => item.querySelectorAll("button").length,
    ),
  );
  check(
    "every pill is a single toggle and nothing else",
    railButtons.length > 5 && railButtons.every((count) => count === 1),
    JSON.stringify(railButtons),
  );
  check(
    "and no pill is drawn as hidden",
    (await page.locator("header [data-rail-item][data-muted], header button[aria-label*=', hidden']").count()) === 0,
  );

  await page.keyboard.press(",");
  await page.waitForTimeout(400);
  const settingsHeadings = await page.locator('[role="dialog"] h2, [role="dialog"] h3').allTextContents();
  check(
    "settings has no hidden-buckets section",
    !settingsHeadings.some((heading) => heading.startsWith("Hidden buckets")),
    settingsHeadings.join(" | "),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  /*
    Migration: an earlier build stored the hidden buckets under `winnow.mutedFilters.v1`.
    Written by hand here, as that build would have left it, then reloaded: the bucket must
    be back on the rail as a live toggle, its mail back in the inbox, and the key gone.
  */
  const inboxRowsBefore = await rowTotal();
  await page.evaluate(() =>
    localStorage.setItem("winnow.mutedFilters.v1", JSON.stringify(["newsletters", "receipts"])),
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("[data-message-id]", { timeout: 10_000 });
  await page.waitForTimeout(500);
  check(
    "a bucket an earlier build hid is back on the rail",
    (await page.locator('header button[aria-label^="Newsletters,"]:visible:not([disabled])').count()) > 0,
  );
  check("and its mail is back in the inbox", (await rowTotal()) === inboxRowsBefore, `${inboxRowsBefore} → ${await rowTotal()}`);
  check(
    "and the stored hidden list is deleted on load",
    !("winnow.mutedFilters.v1" in (await storage())),
  );
  const revived = page.locator('header button[aria-label^="Newsletters,"]:visible').first();
  await revived.click();
  await page.waitForTimeout(300);
  check("and it switches on as a filter", (await revived.getAttribute("aria-pressed")) === "true");
  await revived.click();
  await page.waitForTimeout(300);
  check("and off again", (await revived.getAttribute("aria-pressed")) === "false");

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
  await openSettingsCategory(page, "privacy");
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
  await openSettingsCategory(page, "appearance");
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

  // Dark is Notion-like neutral grey: a #191919 canvas and untinted hover and selection.
  await modeRadios.filter({ hasText: "Dark" }).click();
  await page.waitForTimeout(150);
  const darkTokens = await page.evaluate(() => {
    const style = document.documentElement.style;
    const read = (name) => style.getPropertyValue(`--wn-${name}`).trim().toUpperCase();
    return {
      canvas: getComputedStyle(document.body).backgroundColor,
      hover: read("surfaceHover"),
      selected: read("surfaceSelected"),
      hairline: read("hairline"),
    };
  });
  const neutral = (hex) => /^#([0-9A-F]{2})\1\1$/.test(hex);
  check(
    "choosing Dark paints the neutral #191919 canvas with grey hover and selection",
    darkTokens.canvas === "rgb(25, 25, 25)" && neutral(darkTokens.hover) && neutral(darkTokens.selected) &&
      darkTokens.hairline.startsWith("RGBA(255, 255, 255"),
    JSON.stringify(darkTokens),
  );

  await modeRadios.filter({ hasText: "OLED" }).click();
  await page.waitForTimeout(150);
  let state = await themeState();
  const oledStates = await page.evaluate(() =>
    ["surfaceHover", "surfaceActive", "surfaceSelected", "edge"].map((name) =>
      document.documentElement.style.getPropertyValue(`--wn-${name}`).trim().toUpperCase(),
    ),
  );
  check(
    "OLED's hover, pressed, selected and edge are neutral grey, not violet",
    oledStates.slice(0, 3).every(neutral) && oledStates[3].startsWith("RGBA(255, 255, 255"),
    JSON.stringify(oledStates),
  );
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
  await openSettingsCategory(page, "appearance");
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
    meets its end. What is claimed here, across the common widths with and without a
    message open: the rail stays clear of the floating sidebar and of the search field
    (it has its own row under search), nothing of it reaches under the field, and wherever
    it overflows the end is a wide fade with a step button over it, so the tab meeting the
    edge dissolves rather than being cut.
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
        const side = document.querySelector("[data-sidebar]")?.getBoundingClientRect() ?? null;
        const meets = (a, b) => a.right > b.left + 0.5 && a.left < b.right - 0.5 && a.bottom > b.top + 0.5 && a.top < b.bottom - 0.5;
        return {
          clearOfField: !meets(rail, field) ? 1 : 0,
          clearOfSidebar: side === null || rail.left >= side.right,
          underField: tabs.filter((t) => meets(t, field)).length,
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
    "the rail stays clear of the search field and the sidebar at every desktop width, reader open or not",
    railOk((shape) => shape.clearOfField === 1 && shape.clearOfSidebar),
    railDetail((shape) => `${shape.clearOfField}/${shape.clearOfSidebar}`),
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

  // The sidebar is an overlay: closed, it is off the left edge, and the list, its search
  // field and the reader never sit under it, at every common desktop width, reading or not.
  const SIDEBAR_WIDTHS = [1024, 1280, 1440, 1920];
  const overlaps = [];
  for (const width of SIDEBAR_WIDTHS) {
    for (const reading of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      if (reading) await openMessage();
      else if ((await page.locator("article h1").count()) > 0) await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      const shape = await page.evaluate(() => {
        const side = document.querySelector("[data-sidebar]").getBoundingClientRect();
        const boxes = ["#winnow-search", "[data-row-count]", "[data-reader]"]
          .map((selector) => document.querySelector(selector))
          .filter((element) => element && element.getClientRects().length > 0)
          .map((element) => (element.closest("label") ?? element).getBoundingClientRect());
        return { right: side.right, lefts: boxes.map((box) => Math.round(box.left)) };
      });
      if (shape.lefts.some((left) => left < shape.right)) overlaps.push({ width, reading, ...shape });
    }
  }
  check("nothing sits under the closed sidebar at any desktop width, reading or not", overlaps.length === 0, JSON.stringify(overlaps));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  if ((await page.locator("article h1").count()) === 0) await openMessage();

  // The desktop keeps its selection exactly as it was: the open row is marked.
  const openRow = page.locator('[data-row-count] button[data-message-id][aria-current="true"]');
  check("on the desktop the open message's row is still marked current", (await openRow.count()) === 1);
  check(
    "and still drawn selected",
    (await page.locator("[data-row-count] [data-row-id].bg-surface-selected").count()) === 1,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ── The phone layout ───────────────────────────────────────────────────────

  section("mobile");

  /*
    The phone layout.

    Below 640px the masthead is replaced, not squeezed: a top bar (the mark, the list's
    name and search), the list, and one dock at the bottom edge holding the swipeable
    smart filter chips above four tabs; folders and the account are in
    the menu, a bottom sheet that a second tap on Inbox raises. The reader brings its own action bar to the
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
  check(
    "the mark sits top-left, at touch size",
    Boolean(logoBox) && logoBox.x < 40 && Math.min(logoBox.width, logoBox.height) >= MIN_TARGET,
    JSON.stringify(logoBox),
  );
  // The top bar is where you are and search, nothing else: no prev/next chevrons, no
  // tick and no menu button (the menu is a second tap on Inbox).
  const topBarButtons = await topBar.locator("button").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label") ?? node.textContent),
  );
  check(
    "no chevrons, tick or menu button in the phone top bar",
    topBarButtons.length === 0 &&
      (await topBar.locator(
        '[aria-label="Previous message"], [aria-label="Next message"], [aria-label="Mark all read"], [aria-label="Open menu"], [data-sidebar-toggle]',
      ).count()) === 0,
    JSON.stringify(topBarButtons),
  );

  const searchBox = await page.locator("[data-phone-search]").boundingBox();
  check(
    "search has its own full-width row under the title, at touch height",
    Boolean(searchBox && logoBox) && searchBox.y >= logoBox.y + logoBox.height &&
      Math.abs(searchBox.x - logoBox.x) <= 1 && searchBox.x + searchBox.width >= 390 - logoBox.x - 1 &&
      searchBox.height >= MIN_TARGET,
    JSON.stringify(searchBox),
  );
  check("the list's name is in the top bar", (await listTitle())?.trim() === "Inbox", await listTitle());
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
    "the smart filter chips sit in the dock, above the tabs, at thumb size",
    (await dockChips.count()) > 3 && Boolean(chipBox) && chipBox.y < tabBoxes[0].y && chipBox.height >= MIN_TARGET,
    JSON.stringify(chipBox),
  );
  const chipRow = await dock.locator("[data-rail-scroller]").evaluate((element) => ({
    swipeable: getComputedStyle(element).overflowX === "auto" && element.scrollWidth > element.clientWidth,
  }));
  check("and the chip row swipes sideways", chipRow.swipeable, JSON.stringify(chipRow));
  check(
    "and the sidebar starts closed on a phone",
    !(await sidebarOpen()) && (await page.locator("[data-sidebar]").isHidden()),
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

  /*
    The menu, from the dock: the Inbox tab is the toggle once it is the current tab. From
    another mailbox the first tap only switches to the inbox; the second raises the menu
    as a bottom sheet resting on the tabs, and the third closes it.
  */
  const inboxTab = tabs.filter({ hasText: "Inbox" });
  await tabs.filter({ hasText: "Sent" }).click();
  await page.waitForTimeout(250);
  const inboxTabState = () =>
    inboxTab.evaluate((tab) => ({
      label: tab.getAttribute("aria-label"),
      popup: tab.getAttribute("aria-haspopup"),
      expanded: tab.getAttribute("aria-expanded"),
      controls: tab.getAttribute("aria-controls"),
      current: tab.getAttribute("aria-current"),
    }));
  const awayState = await inboxTabState();
  check(
    "away from the inbox, the Inbox tab is plainly a tab",
    awayState.popup === null && awayState.expanded === null && !/Activate again/.test(awayState.label ?? ""),
    JSON.stringify(awayState),
  );
  await inboxTab.click();
  await page.waitForTimeout(300);
  const firstTap = await inboxTabState();
  check(
    "the first Inbox tap switches to the inbox and does not open the menu",
    !(await sidebarOpen()) && (await listTitle())?.trim() === "Inbox" && firstTap.current === "page",
    JSON.stringify({ title: await listTitle(), open: await sidebarOpen() }),
  );
  check(
    "then it tells a screen reader a second activation opens the menu",
    firstTap.popup === "dialog" && firstTap.expanded === "false" && firstTap.controls === "winnow-sidebar" &&
      /^Inbox(, \d+ unread)?\. Activate again for mailboxes and account$/.test(firstTap.label ?? ""),
    JSON.stringify(firstTap),
  );
  await inboxTab.click();
  await page.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  check("the second Inbox tap opens the menu", await sidebarOpen());
  const menu = overflowMenu();
  const menuShape = await menu.evaluate((panel) => ({
    filter: Boolean(panel.querySelector("#winnow-nav-filter")),
    inbox: Boolean(panel.querySelector('button[data-nav="inbox"]')),
    categories: panel.querySelectorAll("[data-nav-category], button[aria-pressed]").length,
    folders: [...panel.querySelectorAll("[data-nav-folder]")].map((b) => b.getAttribute("data-nav-folder")),
    account: panel.querySelector("[data-nav-account]")?.textContent ?? "",
    settings: Boolean(panel.querySelector('[data-nav-account] button[aria-label="Settings"]')),
    markAllRead: panel.querySelectorAll('[data-nav-action="mark-all-read"], [aria-label^="Mark all read"]').length,
  }));
  check(
    "the menu is one sheet: Inbox, Mail, the account and Settings, no categories and no Mark all read",
    !menuShape.filter && menuShape.inbox && menuShape.categories === 0 &&
      ["sent", "archive", "trash", "spam"].every((id) => menuShape.folders.includes(id)) &&
      menuShape.account.includes("Demo account") && menuShape.settings &&
      menuShape.markAllRead === 0,
    JSON.stringify(menuShape),
  );
  const menuTargets = await menu.locator('button[data-nav-folder], button[data-nav="inbox"], button[data-nav-action]').evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().height)),
  );
  check("its rows are touch-sized", menuTargets.every((h) => h >= MIN_TARGET), JSON.stringify(menuTargets));
  const phoneSide = await page.evaluate(() => {
    const side = document.querySelector("[data-sidebar]").getBoundingClientRect();
    const tabsRow = document.querySelector('[data-phone-dock] nav[aria-label="Primary"]').getBoundingClientRect();
    const scrim = document.querySelector("[data-sidebar-scrim]");
    const chips = document.querySelector("[data-phone-dock] [data-rail-scroller]");
    return {
      left: Math.round(side.left),
      right: Math.round(side.right),
      top: Math.round(side.top),
      bottom: Math.round(side.bottom),
      tabsTop: Math.round(tabsRow.top),
      window: innerWidth,
      height: innerHeight,
      radius: getComputedStyle(document.querySelector("[data-sidebar]")).borderTopLeftRadius,
      scrim: getComputedStyle(scrim).visibility,
      layers: scrim.querySelectorAll("[data-scrim-layer]").length,
      dockInert: Boolean(document.querySelector("[data-phone-dock]")?.closest("[inert]")),
      chipsAside: Boolean(chips?.closest("[inert]")) && getComputedStyle(chips).visibility === "hidden",
      listInert: Boolean(document.querySelector("[data-row-count]")?.closest("[inert]")),
      focusInside: document.querySelector("[data-sidebar]").contains(document.activeElement),
    };
  });
  check(
    "on a phone it is a bottom sheet: full width, resting on the tabs near the bottom edge, rounded on top",
    phoneSide.left === 0 && phoneSide.right === phoneSide.window &&
      Math.abs(phoneSide.bottom - phoneSide.tabsTop) <= 1 && phoneSide.bottom >= phoneSide.height - 120 &&
      phoneSide.top >= phoneSide.height * 0.2 - 1 && phoneSide.radius !== "0px",
    JSON.stringify(phoneSide),
  );
  check(
    "the app behind it is blurred and inert, the tabs stay live and the chip row is set aside",
    phoneSide.scrim === "visible" && phoneSide.layers >= 2 && phoneSide.layers < 4 && phoneSide.listInert &&
      !phoneSide.dockInert && phoneSide.chipsAside && phoneSide.focusInside,
    JSON.stringify(phoneSide),
  );
  const openTab = await inboxTabState();
  check(
    "and the Inbox tab says it is expanded, and that activating it again closes the menu",
    openTab.expanded === "true" && /Activate again to close/.test(openTab.label ?? ""),
    JSON.stringify(openTab),
  );
  const phoneRadial = await scrimFalloff();
  check(
    "its blur spreads from the middle of its top edge, falling off evenly in every direction",
    Math.abs(phoneRadial.origin.x - phoneRadial.side.centre) <= 1 &&
      Math.abs(phoneRadial.origin.y - phoneRadial.side.top) <= 1 && phoneRadial.ok,
    JSON.stringify({ origin: phoneRadial.origin, side: phoneRadial.side, samples: phoneRadial.samples }),
  );
  await inboxTab.click();
  await waitSidebarClosed().catch(() => undefined);
  check(
    "the third Inbox tap closes it, and focus is back on the Inbox tab",
    !(await sidebarOpen()) &&
      (await inboxTab.evaluate((tab) => document.activeElement === tab)) &&
      (await inboxTabState()).expanded === "false",
  );
  // A tap on the app above it closes it too.
  await openDrawer();
  await page.mouse.click(phoneSide.window / 2, 120);
  await waitSidebarClosed().catch(() => undefined);
  check("a tap outside it closes it on a phone", !(await sidebarOpen()) && (await page.locator("article h1").count()) === 0);
  await closeDrawer();
  // Escape closes it, and focus goes back to the tab.
  await openDrawer();
  await page.keyboard.press("Escape");
  await waitSidebarClosed().catch(() => undefined);
  check(
    "Escape closes it and gives focus back to the Inbox tab",
    !(await sidebarOpen()) && (await inboxTab.evaluate((tab) => document.activeElement === tab)),
  );

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
  // Google account setup, on a phone: the whole screen, with touch-sized fields.
  await openSettingsCategory(page, "google");
  await page.locator('[role="dialog"][aria-label="Settings"]').getByRole("button", { name: "Set up" }).click();
  const phoneSetup = page.locator('[role="dialog"][aria-label="Google account"]');
  await phoneSetup.waitFor({ timeout: 5_000 }).catch(() => undefined);
  // Measured after the sheet's entrance animation, which scales it a hair.
  await page.waitForTimeout(400);
  const phoneSetupBox = await phoneSetup.boundingBox();
  check(
    "Settings → Google account opens the setup full-width on a phone",
    Boolean(phoneSetupBox) && Math.round(phoneSetupBox.width) === 390,
    JSON.stringify(phoneSetupBox),
  );
  const fieldBoxes = await Promise.all(
    ["clientId", "clientSecret"].map((name) => phoneSetup.locator(`input[name="${name}"]`).boundingBox()),
  );
  check(
    "and its fields are full touch targets",
    fieldBoxes.every((b) => b && b.height >= MIN_TARGET),
    JSON.stringify(fieldBoxes.map((b) => b && Math.round(b.height))),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await tabs.filter({ hasText: "Inbox" }).click();
  await page.waitForTimeout(300);
  check("and the Inbox tab comes back", (await listTitle())?.trim() === "Inbox", await listTitle());

  // Trash and Spam have no tab; the menu still reaches them.
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
      // A closed overlay (the sidebar, off the left edge) is hidden and inert, not a
      // control anyone can reach for.
      return r.width > 0 && r.height > 0 && !scrollable(b) && getComputedStyle(b).visibility !== "hidden" && !b.closest("[inert]");
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
    on a phone. Hence a second context
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

  const touchHides = touchPage.locator(
    '[data-phone-dock] button[aria-label^="Hide "], [data-phone-dock] button[aria-label^="Show "]',
  );
  check(
    "the chip row has no hide control on a device with no hover either",
    (await touchHides.count()) === 0,
    `${await touchHides.count()} controls`,
  );
  const touchPill = touchPage.locator("[data-phone-dock] [data-rail-key] button[aria-pressed]").first();
  const touchPillBox = await touchPill.boundingBox();
  check(
    "a chip is tall enough for a thumb",
    Boolean(touchPillBox) && touchPillBox.height >= MIN_TARGET,
    JSON.stringify(touchPillBox),
  );
  await touchPill.tap();
  await touchPage.waitForTimeout(300);
  check("and a tap switches its filter on", (await touchPill.getAttribute("aria-pressed")) === "true");
  await touchPill.tap();
  await touchPage.waitForTimeout(300);
  const starTarget = await touchPage
    .locator('main button[aria-label="Star"], main button[aria-label="Unstar"]')
    .first()
    .boundingBox();
  check(
    "a row's star is a full touch target on a touch device",
    Boolean(starTarget) && starTarget.width >= MIN_TARGET && starTarget.height >= MIN_TARGET,
    JSON.stringify(starTarget),
  );
  // No Mark all read on a phone either: the menu (two taps on Inbox) has no such row, and
  // opening and closing it leaves the list's unread rows exactly as they were.
  const touchInbox = touchPage.locator('[data-phone-dock] nav[aria-label="Primary"] button').first();
  const unreadRows = () =>
    touchPage.locator("[data-row-count] button[data-message-id]").evaluateAll((rows) =>
      rows.filter((row) => /, unread,/.test(row.getAttribute("aria-label") ?? "")).length,
    );
  const unreadBefore = await unreadRows();
  await touchInbox.tap();
  await touchPage.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  const touchMarkAll = await touchPage.locator('[data-sidebar] [data-nav-action="mark-all-read"], [data-sidebar] [aria-label^="Mark all read"]').count();
  await touchPage.keyboard.press("Escape");
  await touchPage.locator("[data-sidebar]").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
  check(
    "on a phone, the menu has no Mark all read and the list keeps its unread mail",
    unreadBefore > 0 && touchMarkAll === 0 && (await unreadRows()) === unreadBefore,
    `${touchMarkAll} rows; ${unreadBefore} → ${await unreadRows()} unread rows`,
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
      selectedRows: document.querySelectorAll("[data-row-count] [data-row-id].bg-surface-selected").length,
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

  // ── Avatars, sender menu, multi-select, context menu, mark-unread, scroll ─

  section("avatars and selection");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const d = await ctx.newPage();
    const dErrors = [];
    d.on("pageerror", (error) => dErrors.push(String(error)));
    d.on("console", (message) => message.type() === "error" && dErrors.push(message.text()));
    await d.goto(URL, { waitUntil: "networkidle" });
    await d.waitForSelector("[data-row-count] [data-row-id]");
    const rows = d.locator("[data-row-count] [data-row-id]");
    const rowButton = (i) => rows.nth(i).locator("button[data-message-id]");
    const current = () => d.locator('[data-row-count] button[data-message-id][aria-current="true"]').count();
    const checkedCount = () => d.locator("[data-row-count] [data-row-id][data-checked]").count();

    check(
      "every row has an avatar button",
      (await d.locator("[data-row-count] [data-row-control='avatar']").count()) === (await rows.count()),
    );
    check("the demo shows quiet monograms for senders without a picture", (await d.locator("[data-row-count] [data-avatar='monogram']").count()) > 0);

    // Weight is unread and only unread.
    const weights = await d.evaluate(() => {
      const out = { read: new Set(), unread: new Set() };
      for (const row of document.querySelectorAll("[data-row-count] [data-row-id]")) {
        const button = row.querySelector("button[data-message-id]");
        const unread = /, unread,/.test(button.getAttribute("aria-label"));
        for (const sel of ["[data-row-sender]", "[data-row-subject]"]) {
          out[unread ? "unread" : "read"].add(getComputedStyle(row.querySelector(sel)).fontWeight);
        }
      }
      return { read: [...out.read], unread: [...out.unread] };
    });
    check("read rows are regular weight throughout", weights.read.length === 1 && weights.read[0] === "400", JSON.stringify(weights));
    check("unread rows are bold", weights.unread.every((w) => Number(w) >= 600), JSON.stringify(weights));

    // The sender menu, from the list.
    const avatar = rows.nth(2).locator("[data-row-control='avatar']");
    // Right-click on an avatar is the same as a left click: the sender menu, never the
    // row's menu or the browser's.
    await avatar.click({ button: "right" });
    await d.waitForTimeout(150);
    check(
      "right-clicking an avatar opens the sender menu, not the row menu",
      (await d.locator("[data-menu='sender']").count()) === 1 && (await d.locator("[data-menu='row']").count()) === 0,
    );
    check("and does not open the message either", (await current()) === 0);
    await d.keyboard.press("Escape");
    await d.waitForTimeout(150);
    await avatar.click();
    await d.waitForTimeout(150);
    check("clicking an avatar opens the sender menu", (await d.locator("[data-menu='sender']").count()) === 1);
    check("and does not open the message", (await current()) === 0);
    const senderItems = await d.locator("[data-menu='sender'] [role='menuitem']").allTextContents();
    check(
      "the sender menu offers all mail, copy, contacts, mute and block",
      ["All mail from this sender", "Copy address", "Mute sender", "Block sender"].every((t) => senderItems.includes(t)),
      senderItems.join(" | "),
    );
    check("focus moves into the menu", await d.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem"));
    await d.keyboard.press("ArrowDown");
    check(
      "arrow keys move through it",
      (await d.evaluate(() => document.activeElement?.getAttribute("data-menu-item"))) === "sender-all",
    );
    await d.keyboard.press("j"); // swallowed by the menu, not routed to the list
    check("shortcuts do not leak out of an open menu", (await current()) === 0);
    await d.keyboard.press("Escape");
    await d.waitForTimeout(100);
    check("Escape closes it", (await d.locator("[data-menu='sender']").count()) === 0);
    check(
      "and focus returns to the avatar",
      await d.evaluate(() => document.activeElement?.getAttribute("data-row-control") === "avatar"),
    );
    await d.keyboard.press("Enter");
    await d.waitForTimeout(100);
    check("the avatar opens its menu from the keyboard", (await d.locator("[data-menu='sender']").count()) === 1);
    await d.keyboard.press("Escape");

    // Unsubscribe only where List-Unsubscribe exists.
    const unsubscribeFor = async (query) => {
      await d.locator("input[type='search']").first().fill(query);
      await d.waitForTimeout(300);
      await d.locator("[data-row-count] [data-row-control='avatar']").first().click();
      await d.waitForTimeout(100);
      const has = (await d.locator("[data-menu='sender'] [data-menu-item='sender-unsubscribe']").count()) === 1;
      await d.keyboard.press("Escape");
      await d.locator("input[type='search']").first().fill("");
      await d.waitForTimeout(200);
      return has;
    };
    check("a newsletter with List-Unsubscribe offers Unsubscribe", await unsubscribeFor("engineering"));
    check("a person's mail does not", !(await unsubscribeFor("migration")));

    // All mail from this sender.
    const senderName = (await rows.nth(0).locator("[data-row-sender]").textContent()).trim();
    await rows.nth(0).locator("[data-row-control='avatar']").click();
    await d.locator("[data-menu-item='sender-all']").click();
    await d.waitForTimeout(250);
    const names = await d.locator("[data-row-count] [data-row-sender]").allTextContents();
    check("All mail from this sender narrows the list to them", names.length > 0 && names.every((n) => n.trim() === senderName), names.join(" | "));
    await d.keyboard.press("Escape"); // clear the filter
    await d.waitForTimeout(200);

    // Drag select.
    const a = await rows.nth(1).boundingBox();
    const b = await rows.nth(4).boundingBox();
    await d.mouse.move(a.x + 300, a.y + a.height / 2);
    await d.mouse.down();
    await d.mouse.move(a.x + 300, a.y + a.height / 2 + 12, { steps: 3 });
    await d.mouse.move(b.x + 300, b.y + b.height / 2, { steps: 8 });
    await d.mouse.up();
    await d.waitForTimeout(150);
    check("a drag selects every row it passes over", (await checkedCount()) === 4, `${await checkedCount()}`);
    check("without opening any of them", (await current()) === 0);
    check("the batch bar shows the count", (await d.locator("[data-selection-bar='desktop'] [data-selection-count='4']").count()) === 1);
    check(
      "no text is selected by the drag",
      (await d.evaluate(() => window.getSelection()?.toString() ?? "")) === "",
    );

    // The context menu acts on the whole selection.
    const c = await rows.nth(2).boundingBox();
    await d.mouse.click(c.x + 400, c.y + c.height / 2, { button: "right" });
    await d.waitForTimeout(150);
    const multiItems = await d.locator("[data-menu='row'] > [role='menuitem']").evaluateAll((els) => els.map((e) => e.dataset.menuItem));
    check("right-clicking a selected row opens a menu for the selection", (await d.locator("[data-menu='row']").count()) === 1);
    check("which hides single-message items", !multiItems.includes("reply") && !multiItems.includes("find-from"), multiItems.join(","));
    check(
      "and counts what it acts on",
      ((await d.locator("[data-menu-item='archive']").textContent()) ?? "").includes("4"),
    );
    await d.keyboard.press("Escape");
    await d.keyboard.press("Escape");
    await d.waitForTimeout(100);
    check("Escape clears the selection", (await checkedCount()) === 0 && (await d.locator("[data-selection-bar]").count()) === 0);

    // Drag from the sender avatar. The avatar is a control (a click opens the sender
    // menu), and the drag code used to ignore every press on a control, so pressing an
    // avatar and dragging did nothing at all.
    {
      const scroller = d.locator("[data-row-count]");
      const avatarCenter = async (i) => {
        const box = await rows.nth(i).locator("[data-row-control='avatar']").boundingBox();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      await d.evaluate(() => {
        window.__nativeDrags = 0;
        document.addEventListener("dragstart", () => (window.__nativeDrags += 1), true);
      });
      const from = await avatarCenter(1);
      const to = await avatarCenter(4);
      const back = await avatarCenter(2);
      await d.mouse.move(from.x, from.y);
      await d.mouse.down();
      await d.mouse.move(from.x, from.y + 12, { steps: 3 });
      await d.mouse.move(to.x, to.y, { steps: 8 });
      await d.waitForTimeout(100);
      check("dragging down from an avatar selects the rows it passes", (await checkedCount()) === 4, `${await checkedCount()}`);
      await d.mouse.move(back.x, back.y, { steps: 6 });
      await d.waitForTimeout(100);
      check("and moving back up shrinks the range", (await checkedCount()) === 2, `${await checkedCount()}`);
      await d.mouse.move(to.x, to.y, { steps: 6 });
      await d.mouse.up();
      await d.waitForTimeout(150);
      check("releasing keeps the range", (await checkedCount()) === 4, `${await checkedCount()}`);
      check("the selection bar shows the count, ready for an action", (await d.locator("[data-selection-bar='desktop'] [data-selection-count='4']").count()) === 1);
      check("an avatar drag opens neither the sender menu nor a message", (await d.locator("[data-menu='sender']").count()) === 0 && (await current()) === 0);
      check("no native image drag starts from the avatar", (await d.evaluate(() => window.__nativeDrags)) === 0);
      check("and no text is selected", (await d.evaluate(() => window.getSelection()?.toString() ?? "")) === "");
      check(
        "with something selected the avatars become checkboxes",
        (await d.locator("[data-row-count] [data-row-control='avatar'][aria-pressed]").count()) === (await rows.count()),
      );
      await d.keyboard.press("Escape");
      await d.waitForTimeout(100);

      // Escape mid-drag puts back what was there before the press.
      await d.mouse.move(from.x, from.y);
      await d.mouse.down();
      await d.mouse.move(to.x, to.y, { steps: 8 });
      await d.waitForTimeout(80);
      const during = await checkedCount();
      await d.keyboard.press("Escape");
      await d.waitForTimeout(80);
      check("Escape mid-drag cancels it", during === 4 && (await checkedCount()) === 0, `${during} → ${await checkedCount()}`);
      await d.mouse.move(to.x, to.y + 40, { steps: 3 });
      await d.mouse.up();
      await d.waitForTimeout(120);
      check("and the rest of that press does nothing", (await checkedCount()) === 0 && (await d.locator("[data-menu]").count()) === 0 && (await current()) === 0);

      // A plain click on an avatar is still the sender menu, after all of that.
      await rows.nth(3).locator("[data-row-control='avatar']").click();
      await d.waitForTimeout(120);
      check("a plain click on an avatar still opens the sender menu", (await d.locator("[data-menu='sender']").count()) === 1);
      await d.keyboard.press("Escape");
      await d.waitForTimeout(80);

      // Past the bottom of the list: it scrolls and keeps selecting.
      const box = await scroller.boundingBox();
      const top0 = await scroller.evaluate((el) => el.scrollTop);
      await d.mouse.move(from.x, from.y);
      await d.mouse.down();
      await d.mouse.move(from.x, from.y + 20, { steps: 3 });
      await d.mouse.move(from.x, box.y + box.height + 60, { steps: 10 });
      await d.waitForTimeout(700);
      const scrolledBy = (await scroller.evaluate((el) => el.scrollTop)) - top0;
      const farCount = await checkedCount();
      check("dragging past the list's edge scrolls it", scrolledBy > 100, `${scrolledBy}px`);
      // The wheel mid-drag moves rows under a still pointer; the range follows.
      await d.mouse.move(from.x, box.y + box.height / 2, { steps: 4 });
      await d.waitForTimeout(80);
      const beforeWheel = Number(await d.locator("[data-selection-bar='desktop'] [data-selection-count]").getAttribute("data-selection-count"));
      await d.mouse.wheel(0, 400);
      await d.waitForTimeout(250);
      const afterWheel = Number(await d.locator("[data-selection-bar='desktop'] [data-selection-count]").getAttribute("data-selection-count"));
      check("and the selection grows with it", farCount > 4, `${farCount}`);
      check("scrolling with the wheel mid-drag extends the range", afterWheel > beforeWheel, `${beforeWheel} → ${afterWheel}`);
      // Let go outside the window: the drag still ends, and nothing is left stuck.
      await d.mouse.move(from.x, -40, { steps: 4 });
      await d.mouse.up();
      await d.waitForTimeout(150);
      const kept = Number(await d.locator("[data-selection-bar='desktop'] [data-selection-count]").getAttribute("data-selection-count"));
      await d.mouse.move(from.x, box.y + box.height / 2, { steps: 4 });
      await d.waitForTimeout(100);
      const afterRelease = Number(await d.locator("[data-selection-bar='desktop'] [data-selection-count]").getAttribute("data-selection-count"));
      check("releasing outside the window ends the drag", kept > 0 && afterRelease === kept, `${kept} → ${afterRelease}`);
      await d.keyboard.press("Escape");
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await d.waitForTimeout(200);

      // The sender menu's way in: Select, then add to it.
      await rows.nth(1).locator("[data-row-control='avatar']").click();
      await d.waitForTimeout(120);
      const menuIds = await d.locator("[data-menu='sender'] [role='menuitem']").evaluateAll((els) => els.map((e) => e.dataset.menuItem));
      check("the sender menu leads with Select", menuIds[0] === "sender-select", menuIds.join(","));
      check("with a lucide icon like its other items", (await d.locator("[data-menu-item='sender-select'] svg").count()) === 1);
      check("the demo, whose contacts are seeded, does not offer to connect contact photos", !menuIds.includes("sender-photos"));
      await d.keyboard.press("Enter"); // focus starts on the first item
      await d.waitForTimeout(120);
      check("Select puts that row in a selection", (await checkedCount()) === 1 && (await d.locator("[data-selection-bar='desktop'] [data-selection-count='1']").count()) === 1);
      check("and closes the menu", (await d.locator("[data-menu='sender']").count()) === 0);
      await rows.nth(3).locator("[data-row-control='avatar']").click();
      await d.waitForTimeout(100);
      check("then a click on another avatar adds it", (await checkedCount()) === 2);
      const a2 = await avatarCenter(4);
      const a3 = await avatarCenter(6);
      await d.mouse.move(a2.x, a2.y);
      await d.mouse.down();
      await d.mouse.move(a3.x, a3.y, { steps: 8 });
      await d.mouse.up();
      await d.waitForTimeout(120);
      check("and an avatar drag adds a range on top", (await checkedCount()) === 5, `${await checkedCount()}`);
      await d.keyboard.press("Escape");
      await d.waitForTimeout(100);

      // Select all from this sender, for a sender with several rows.
      const multi = await d.evaluate(() => {
        const names = [...document.querySelectorAll("[data-row-count] [data-row-id] [data-row-sender]")].map((n) => n.textContent.trim());
        const counts = new Map();
        for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
        const name = [...counts].find(([, c]) => c > 1)?.[0];
        return name ? { index: names.indexOf(name), count: counts.get(name) } : null;
      });
      if (multi) {
        await rows.nth(multi.index).locator("[data-row-control='avatar']").click();
        await d.waitForTimeout(120);
        const all = d.locator("[data-menu-item='sender-select-all']");
        check("Select all from this sender appears for a sender with several rows", (await all.count()) === 1, await all.textContent().catch(() => ""));
        await all.click();
        await d.waitForTimeout(120);
        check("and selects at least every one of their mounted rows", (await checkedCount()) >= multi.count, `${await checkedCount()} of ${multi.count}`);
        await d.keyboard.press("Escape");
        await d.waitForTimeout(100);
      } else {
        check("the demo has a sender with several rows for Select all", false);
      }
    }

    // A plain click still opens.
    await rowButton(1).click();
    await d.waitForTimeout(150);
    check("a simple click still opens the message", (await current()) === 1);

    // Ctrl-click toggles, shift-click ranges.
    await rowButton(5).click({ modifiers: ["Control"] });
    await rowButton(8).click({ modifiers: ["Shift"] });
    await d.waitForTimeout(100);
    check("ctrl-click toggles and shift-click selects the range", (await checkedCount()) === 4, `${await checkedCount()}`);

    // Batch mark read, then archive.
    const total = Number(await d.locator("[data-row-count]").getAttribute("data-row-count"));
    await d.locator("[data-selection-bar='desktop'] button", { hasText: /Mark (read|unread)/ }).click();
    await d.waitForTimeout(100);
    await d.locator("[data-selection-bar='desktop'] button", { hasText: "Archive" }).click();
    await d.waitForTimeout(250);
    // Each selected row's message is archived, as `e` would; a thread row whose other
    // messages are still in the inbox stays, now showing the next one, so the count can
    // drop by fewer than four.
    const remaining = Number(await d.locator("[data-row-count]").getAttribute("data-row-count"));
    check(
      "the batch bar archives the selection and clears it",
      remaining < total && remaining >= total - 4 && (await checkedCount()) === 0,
      `${total} → ${remaining}`,
    );

    // The single-row context menu, by mouse and by keyboard, inside the viewport.
    const last = await rows.nth(Math.min(12, (await rows.count()) - 1)).boundingBox();
    await d.mouse.click(860, Math.min(895, last.y + last.height / 2), { button: "right" });
    await d.waitForTimeout(150);
    const box = await d.locator("[data-menu='row']").boundingBox();
    check("the row menu opens on right-click", box !== null);
    check(
      "and stays inside the viewport",
      box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900,
      JSON.stringify(box),
    );
    const singleItems = await d.locator("[data-menu='row'] > [role='menuitem']").evaluateAll((els) => els.map((e) => e.dataset.menuItem));
    check("a single row's menu has reply, find and open-in-Gmail", ["reply", "reply-all", "forward", "find-from", "open-gmail"].every((i) => singleItems.includes(i)), singleItems.join(","));
    await d.locator("[data-menu-item='move']").hover();
    await d.waitForTimeout(100);
    check("Move to opens its submenu", (await d.locator("[data-menu='row-sub']").count()) === 1);
    await d.keyboard.press("Escape");
    await d.keyboard.press("Escape");
    await rowButton(3).focus();
    await d.keyboard.press("Shift+F10");
    await d.waitForTimeout(150);
    check("Shift+F10 on a focused row opens its menu", (await d.locator("[data-menu='row']").count()) === 1);
    await d.keyboard.press("ArrowDown");
    check("arrow keys navigate it", (await d.evaluate(() => document.activeElement?.getAttribute("data-menu-item"))) === "reply-all");
    await d.keyboard.press("Escape");
    await d.waitForTimeout(100);
    check(
      "Escape closes it and returns focus to the row",
      (await d.locator("[data-menu='row']").count()) === 0 &&
        (await d.evaluate(() => document.activeElement?.hasAttribute("data-message-id"))),
    );

    // Label as…, from the row menu: the user's Gmail labels with a checkbox each.
    // The demo seeds four, so the picker has something to show without an account.
    // By message id rather than row index: the list is windowed, so the nth mounted row
    // can be a different message by the time the picker is reopened below.
    const labelledId = await rowButton(5).getAttribute("data-message-id");
    const labelledRow = d.locator(`[data-row-count] button[data-message-id="${labelledId}"]`);
    await labelledRow.focus();
    await d.keyboard.press("Shift+F10");
    await d.waitForTimeout(150);
    check("the row menu offers Label as…", (await d.locator("[data-menu='row'] [data-menu-item='label-as']").count()) === 1);
    await d.locator("[data-menu='row'] [data-menu-item='label-as']").click();
    const picker = d.locator('[role="dialog"][aria-label="Label as"]');
    await picker.waitFor({ timeout: 5_000 }).catch(() => undefined);
    check("Label as… opens the label picker", (await picker.count()) === 1);
    const pickerNames = await picker.locator("[data-label-option]").allTextContents();
    check(
      "it lists the demo's seeded labels",
      ["Travel", "Receipts", "Work/Northwind", "Family"].every((name) => pickerNames.includes(name)),
      pickerNames.join(", "),
    );
    check(
      "focus starts in its find-or-make field",
      await d.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Find or make a label"),
    );
    const apply = picker.locator("[data-label-apply]");
    check("Apply waits for a change", await apply.isDisabled());
    const family = picker.locator('[data-label-option="Label_4"]');
    const familyBefore = await family.getAttribute("aria-checked");
    await family.click();
    const familyAfter = await family.getAttribute("aria-checked");
    check(
      "clicking a label toggles its checkbox",
      familyBefore !== familyAfter && ["true", "false"].includes(familyAfter ?? ""),
      `${familyBefore} → ${familyAfter}`,
    );
    check("and enables Apply", !(await apply.isDisabled()));
    const field = picker.getByRole("textbox", { name: "Find or make a label" });
    await field.fill("Smoke/Made here");
    const make = picker.locator("[data-label-create]");
    check("a new name offers to make it", (await make.count()) === 1 && /Make “Smoke\/Made here”/.test((await make.textContent()) ?? ""));
    await make.click();
    const made = picker.locator("[data-label-option]", { hasText: "Smoke/Made here" });
    await made.waitFor({ timeout: 3_000 }).catch(() => undefined);
    check(
      "making it adds it to the list, checked",
      (await made.count()) === 1 && (await made.getAttribute("aria-checked")) === "true",
    );
    check("and clears the field", (await field.inputValue()) === "");
    await field.fill("Travel");
    check("an existing name filters to it rather than offering a duplicate", (await picker.locator("[data-label-create]").count()) === 0 && (await picker.locator("[data-label-option]").count()) === 1);
    await field.fill("");
    await apply.click();
    await picker.waitFor({ state: "detached", timeout: 3_000 }).catch(() => undefined);
    check("Apply closes the picker", (await picker.count()) === 0);
    check("and says so", (await d.getByText("Labels updated.").count()) > 0);
    // Reopened on the same message, the picker shows what was applied.
    await labelledRow.scrollIntoViewIfNeeded().catch(() => undefined);
    await labelledRow.focus();
    await d.keyboard.press("Shift+F10");
    await d.waitForTimeout(150);
    await d.locator("[data-menu='row'] [data-menu-item='label-as']").click();
    await picker.waitFor({ timeout: 5_000 }).catch(() => undefined);
    const stuck = {
      family: await picker.locator('[data-label-option="Label_4"]').getAttribute("aria-checked").catch(() => null),
      made: await picker.locator("[data-label-option]", { hasText: "Smoke/Made here" }).getAttribute("aria-checked").catch(() => null),
    };
    check(
      "and the labels stick on the message",
      stuck.family === familyAfter && stuck.made === "true",
      JSON.stringify({ ...stuck, expected: familyAfter, id: labelledId }),
    );
    await d.keyboard.press("Escape");
    await picker.waitFor({ state: "detached", timeout: 3_000 }).catch(() => undefined);
    check("Escape closes the picker", (await picker.count()) === 0);

    // Marking the open message unread moves on.
    const readIndex = await d.evaluate(() => {
      const buttons = [...document.querySelectorAll("[data-row-count] button[data-message-id]")];
      return buttons.findIndex((b, i) => i < buttons.length - 1 && !/, unread,/.test(b.getAttribute("aria-label")));
    });
    const readId = await rowButton(readIndex).getAttribute("data-message-id");
    const nextId = await rowButton(readIndex + 1).getAttribute("data-message-id");
    await rowButton(readIndex).click();
    await d.waitForTimeout(100);
    await d.keyboard.press("u");
    await d.waitForTimeout(200);
    const openNow = await d.locator('[data-row-count] button[aria-current="true"]').getAttribute("data-message-id");
    const nowUnread = /, unread,/.test(await d.locator(`[data-row-count] button[data-message-id="${readId}"]`).getAttribute("aria-label"));
    check("marking the open message unread advances to the next one", openNow === nextId, `${openNow} vs ${nextId}`);
    check("and it stays unread", nowUnread);

    // Scrolling away from the open message is not undone.
    await rowButton(1).click();
    await d.waitForTimeout(100);
    const scroller = d.locator("[data-row-count]");
    await d.mouse.move(400, 500);
    await d.mouse.wheel(0, 2400);
    await d.waitForTimeout(400);
    const scrolled = await scroller.evaluate((el) => el.scrollTop);
    await d.mouse.move(420, 520);
    await d.mouse.move(400, 300);
    await d.evaluate(() => window.dispatchEvent(new Event("focus")));
    await d.waitForTimeout(1500);
    const after = await scroller.evaluate((el) => el.scrollTop);
    check("scrolling away from the open message stays put", scrolled > 1000 && Math.abs(after - scrolled) < 4, `${scrolled} → ${after}`);
    await d.keyboard.press("j");
    await d.waitForTimeout(300);
    const revealed = await scroller.evaluate((el) => el.scrollTop);
    check("but j brings the next row back into view", revealed < scrolled - 500, `${scrolled} → ${revealed}`);

    check("no console errors on the desktop pass", dErrors.length === 0, dErrors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    const pErrors = [];
    p.on("pageerror", (error) => pErrors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");
    const rows = p.locator("[data-row-count] [data-row-id]");
    const cdp = await ctx.newCDPSession(p);
    const longPress = async (i) => {
      const r = await rows.nth(i).boundingBox();
      const point = { x: r.x + 200, y: r.y + r.height / 2 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await p.waitForTimeout(650);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await p.waitForTimeout(150);
    };
    const tap = async (i) => {
      const r = await rows.nth(i).boundingBox();
      await p.touchscreen.tap(r.x + 200, r.y + r.height / 2);
      await p.waitForTimeout(150);
    };
    const count = () => p.locator("[data-row-count] [data-row-id][data-checked]").count();

    check("phone rows have avatars", (await p.locator("[data-row-count] [data-row-control='avatar']").count()) > 0);
    // The avatar on a phone: a tap is the sender menu, a swipe is a scroll, and a
    // long-press selects and then slides on to select a range.
    {
      const avatarAt = async (i) => {
        const box = await rows.nth(i).locator("[data-row-control='avatar']").boundingBox();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const scroller = p.locator("[data-row-count]");
      const slide = async (from, toY, { hold }) => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
        await p.waitForTimeout(hold);
        for (let i = 1; i <= 12; i += 1) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x, y: from.y + ((toY - from.y) * i) / 12 }] });
          await p.waitForTimeout(16);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await p.waitForTimeout(250);
      };

      const tapAt = await avatarAt(2);
      await p.touchscreen.tap(tapAt.x, tapAt.y);
      await p.waitForTimeout(150);
      check("a tap on a phone avatar opens the sender menu", (await p.locator("[data-menu='sender']").count()) === 1);
      check("which offers Select there too", (await p.locator("[data-menu='sender'] [data-menu-item='sender-select']").count()) === 1);
      await p.keyboard.press("Escape");
      await p.waitForTimeout(150);

      const top0 = await scroller.evaluate((el) => el.scrollTop);
      const start = await avatarAt(5);
      await slide(start, start.y - 220, { hold: 0 });
      const swiped = (await scroller.evaluate((el) => el.scrollTop)) - top0;
      check("a quick swipe starting on an avatar scrolls the list", swiped > 50, `${swiped}px`);
      check("and selects nothing", (await count()) === 0);
      await scroller.evaluate((el) => (el.scrollTop = 0));
      await p.waitForTimeout(200);

      const from = await avatarAt(1);
      const to = await avatarAt(4);
      const top1 = await scroller.evaluate((el) => el.scrollTop);
      await slide(from, to.y, { hold: 650 });
      check("a long-press on an avatar, then a slide, selects the range", (await count()) === 4, `${await count()}`);
      check("without scrolling the list under the finger", Math.abs((await scroller.evaluate((el) => el.scrollTop)) - top1) < 2);
      check("the phone selection bar shows the count", (await p.locator("[data-selection-bar='phone'] [data-selection-count='4']").count()) === 1);
      check("nothing opened", (await p.locator("[data-reader]").count()) === 0 && (await p.locator("[data-menu]").count()) === 0);
      await p.locator("[data-selection-bar='phone'] button[aria-label='Clear selection']").tap();
      await p.waitForTimeout(150);
    }

    await longPress(1);
    check("a long-press enters select mode with that row", (await count()) === 1 && (await p.locator("[data-row-count][data-select-mode]").count()) === 1);
    check("without opening the message", (await p.locator("[data-reader]").count()) === 0);
    check("and without selecting text", (await p.evaluate(() => window.getSelection()?.toString() ?? "")) === "");
    check("the top bar becomes the selection bar", (await p.locator("[data-selection-bar='phone'] [data-selection-count='1']").count()) === 1 && (await p.locator("[data-phone-topbar]").count()) === 0);
    await tap(3);
    check("a tap in select mode adds a row", (await count()) === 2);
    await tap(3);
    check("and a second tap removes it", (await count()) === 1);
    await p.locator("[data-selection-bar='phone'] button[aria-label='Clear selection']").tap();
    await p.waitForTimeout(150);
    check("Cancel leaves select mode", (await count()) === 0 && (await p.locator("[data-phone-topbar]").count()) === 1);
    await tap(2);
    check("outside select mode a tap opens the reader", (await p.locator("[data-reader]").count()) === 1);
    check("with no single-row selection state", (await p.locator("[data-row-count] [data-row-id].bg-surface-selected").count()) === 0);

    // Mark unread from the phone reader returns to the list.
    const readIndex = await p.evaluate(() =>
      [...document.querySelectorAll("[data-row-count] button[data-message-id]")].findIndex(
        (b) => !/, unread,/.test(b.getAttribute("aria-label")),
      ),
    );
    await p.locator("[data-reader-dock] button[aria-label='Back to the list']").tap();
    await p.waitForTimeout(150);
    const readId = await rows.nth(readIndex).getAttribute("data-row-id");
    await tap(readIndex);
    await p.locator("[data-reader-dock] button[aria-label='More']").tap();
    await p.waitForTimeout(100);
    await p.getByRole("menuitem", { name: "Mark unread" }).tap();
    await p.waitForTimeout(200);
    check("marking unread on a phone returns to the list", (await p.locator("[data-reader]").count()) === 0);
    check(
      "and the message stays unread",
      /, unread,/.test(await p.locator(`[data-row-count] button[data-message-id="${readId}"]`).getAttribute("aria-label")),
    );

    // Scrolling away is not undone on the phone either.
    const scroller = p.locator("[data-row-count]");
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await p.waitForTimeout(300);
    const phoneScrolled = await scroller.evaluate((el) => el.scrollTop);
    await p.waitForTimeout(1500);
    const phoneAfter = await scroller.evaluate((el) => el.scrollTop);
    check(
      "the phone list stays where it was scrolled",
      phoneScrolled > 600 && Math.abs(phoneAfter - phoneScrolled) < 4,
      `${phoneScrolled} → ${phoneAfter}`,
    );
    check("no console errors on the phone pass", pErrors.length === 0, pErrors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ── One-time codes ─────────────────────────────────────────────────────────

  /*
   * The row's Copy chip is time-boxed (five minutes from arrival) and the reader's bar
   * is not, so this runs on a faked clock: the demo's Okta code is two minutes old at
   * boot, and fast-forwarding past the window must take the chip away while the reader
   * keeps offering the code.
   */
  section("one-time codes");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin }).catch(() => undefined);
    const cPage = await ctx.newPage();
    const cErrors = [];
    cPage.on("pageerror", (error) => cErrors.push(String(error)));
    cPage.on("console", (message) => {
      if (message.type() === "error") cErrors.push(message.text());
    });
    await cPage.clock.install({ time: Date.now() });
    await cPage.goto(URL, { waitUntil: "networkidle" });
    await cPage.waitForSelector("[data-message-id]", { timeout: 10_000 });

    const chip = cPage.locator('main button[data-code-chip="418902"]');
    check("a fresh code shows a Copy chip on its row", (await chip.count()) === 1, `${await chip.count()} chips`);
    check(
      "and the chip names the code, grouped for reading",
      ((await chip.first().textContent()) ?? "").includes("Copy 418 902"),
      (await chip.first().textContent()) ?? "",
    );
    check("with an accessible name that is the code itself", (await chip.first().getAttribute("aria-label")) === "Copy code 418902");
    const rowsBefore = await cPage.locator("article h1").count();
    await chip.first().click();
    // The clipboard write is a promise; the confirmation follows it. The clock is
    // frozen, so the "Copied" state cannot time out while this waits.
    const copiedShown = await chip
      .filter({ hasText: "Copied" })
      .first()
      .waitFor({ timeout: 3_000 })
      .then(() => true, () => false);
    check("clicking the chip says it copied", copiedShown, (await chip.first().textContent()) ?? "");
    check("without opening the message", (await cPage.locator("article h1").count()) === rowsBefore);
    const clipboard = await cPage.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    check("and the code is what lands on the clipboard", clipboard === null || clipboard === "418902", String(clipboard));

    // Open it: the reader's bar sits at the top with the code and its own Copy.
    await cPage.locator('[data-message-id]:has-text("Your verification code")').first().click();
    await cPage.waitForSelector("article h1", { timeout: 5_000 });
    const bar = cPage.locator('[data-code-bar="418902"]');
    check("the reader shows a code bar for a message with a code", (await bar.count()) === 1);
    check("which shows the code, grouped", ((await bar.textContent()) ?? "").includes("418 902"));
    check("and carries its own Copy button", (await bar.locator('button[aria-label$="code 418902"]').count()) === 1);
    const barBox = await bar.boundingBox();
    const headingBox = await cPage.locator("article h1").boundingBox();
    check(
      "above the subject",
      Boolean(barBox && headingBox) && barBox.y + barBox.height <= headingBox.y + 1,
      JSON.stringify({ barBox, headingBox }),
    );

    // Past five minutes from arrival (two at boot, so four more is past it), with the
    // store's one-minute tick in between.
    await cPage.clock.runFor(4 * 60_000 + 61_000);
    await cPage.waitForTimeout(100);
    check(
      "after five minutes the row's chip is gone",
      (await cPage.locator('main button[data-code-chip]').count()) === 0,
      `${await cPage.locator('main button[data-code-chip]').count()} chips`,
    );
    check("but the reader still offers the code", (await bar.count()) === 1);
    check("no console errors on the codes pass", cErrors.length === 0, cErrors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ── Sender pictures ───────────────────────────────────────────────────────
  //
  // Contact photos (Dana and Ana carry bundled demo photos), brand logos behind their
  // setting (bundled demo logos for Northline and Product Hunt), the monogram for
  // everyone else, and the monogram again when a picture fails to load.

  section("sender pictures");
  {
    const origin = new globalThis.URL(URL).origin;
    const avatarFor = (pg, senderName) =>
      pg
        .locator("[data-row-count] [data-row-id]")
        .filter({ has: pg.locator("[data-row-sender]", { hasText: senderName }) })
        .first()
        .locator("[data-row-control='avatar'] [data-avatar]");
    const search = async (pg, query) => {
      await pg.locator("input[type='search']").first().fill(query);
      await pg.waitForTimeout(300);
    };
    const imageLoaded = (locator) =>
      locator.locator("img").evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);

    // Default settings: contact photos yes, brand logos no.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const sp = await ctx.newPage();
    const spErrors = [];
    const offOrigin = [];
    sp.on("pageerror", (error) => spErrors.push(String(error)));
    sp.on("console", (message) => message.type() === "error" && spErrors.push(message.text()));
    sp.on("request", (request) => {
      if (!request.url().startsWith(origin) && !request.url().startsWith("data:")) offOrigin.push(request.url());
    });
    await sp.goto(URL, { waitUntil: "networkidle" });
    await sp.waitForSelector("[data-row-count] [data-row-id]");

    await search(sp, "dana@northwind");
    const dana = avatarFor(sp, "Dana Whitfield");
    await dana.locator("img").waitFor({ timeout: 3_000 }).catch(() => undefined);
    check("a demo contact with a photo shows an image avatar", (await dana.getAttribute("data-avatar")) === "photo");
    check("and the image actually loaded", await imageLoaded(dana));
    check("an image avatar is an <img>, never inline SVG", (await dana.locator("svg").count()) === 0);

    // The reader header and the sender menu use the same picture.
    await sp.locator("[data-row-count] button[data-message-id]").first().click();
    await sp.waitForSelector("article h1", { timeout: 5_000 });
    check(
      "the reader header shows the sender's photo",
      (await sp.locator("[data-reader-avatar] [data-avatar='photo'] img").count()) === 1,
    );
    await sp.locator("[data-reader-avatar]").click();
    await sp.waitForTimeout(150);
    check(
      "the sender menu opens with the sender's picture and address",
      (await sp.locator("[data-menu='sender'] [data-menu-header] [data-avatar='photo'] img").count()) === 1 &&
        ((await sp.locator("[data-menu='sender'] [data-menu-header]").textContent()) ?? "").includes("dana@northwind.example"),
      (await sp.locator("[data-menu='sender'] [data-menu-header]").textContent()) ?? "",
    );
    await sp.keyboard.press("Escape");
    await sp.keyboard.press("Escape");

    await search(sp, "Marcus");
    check("a sender without a picture shows the monogram", (await avatarFor(sp, "Marcus").getAttribute("data-avatar")) === "monogram");
    await search(sp, "deals@shop");
    check(
      "brand logos are off by default: a brand sender gets the monogram",
      (await avatarFor(sp, "Northline").getAttribute("data-avatar")) === "monogram",
    );
    check("Settings offers Show brand logos, off", await sp.evaluate(() => {
      const raw = localStorage.getItem("winnow.preferences.v1");
      return !raw || JSON.parse(raw).brandLogos !== true;
    }));
    check("no console errors on the pictures pass", spErrors.length === 0, spErrors.slice(0, 3).join(" | "));
    await ctx.close();

    // Brand logos on: the demo answers from bundled logos, with no lookup off the origin.
    const onCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await onCtx.addInitScript(() => {
      if (!sessionStorage.getItem("seeded-logos")) {
        localStorage.setItem("winnow.preferences.v1", JSON.stringify({ brandLogos: true }));
        sessionStorage.setItem("seeded-logos", "1");
      }
    });
    const on = await onCtx.newPage();
    on.on("request", (request) => {
      if (!request.url().startsWith(origin) && !request.url().startsWith("data:")) offOrigin.push(request.url());
    });
    await on.goto(URL, { waitUntil: "networkidle" });
    await on.waitForSelector("[data-row-count] [data-row-id]");
    await search(on, "deals@shop");
    const northline = avatarFor(on, "Northline");
    await northline.locator("img").waitFor({ timeout: 3_000 }).catch(() => undefined);
    check("with Show brand logos on, a brand sender shows its logo", (await northline.getAttribute("data-avatar")) === "photo");
    check("and the logo loaded", await imageLoaded(northline));
    await search(on, "Marcus");
    check("a person with no picture still gets the monogram", (await avatarFor(on, "Marcus").getAttribute("data-avatar")) === "monogram");
    await on.locator("input[type='search']").first().fill("");
    await on.keyboard.press("Escape");
    // The toggle itself: off again from Settings.
    await on.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await on.keyboard.press(",");
    await on.waitForTimeout(300);
    await openSettingsCategory(on, "privacy");
    const toggle = on.locator('[aria-label="Show brand logos"]');
    check("Settings has a Show brand logos switch", (await toggle.count()) === 1);
    if ((await toggle.count()) === 1) {
      check("which is on", (await toggle.getAttribute("aria-checked")) === "true");
      await toggle.click();
      await on.waitForTimeout(150);
      check("and turns off", (await toggle.getAttribute("aria-checked")) === "false");
    }
    check("the demo makes no request off its own origin for pictures", offOrigin.length === 0, offOrigin.slice(0, 3).join(" | "));
    await onCtx.close();

    // A broken picture falls back to the monogram. Console errors are expected here (the
    // 404 is the point), so this context does not collect them.
    const brokenCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await brokenCtx.route("**/demo-avatars/dana.svg", (route) => route.fulfill({ status: 404, body: "" }));
    const br = await brokenCtx.newPage();
    await br.goto(URL, { waitUntil: "networkidle" });
    await br.waitForSelector("[data-row-count] [data-row-id]");
    await search(br, "dana@northwind");
    await br.waitForTimeout(400);
    const broken = avatarFor(br, "Dana Whitfield");
    check(
      "a picture that fails to load falls back to the monogram",
      (await broken.getAttribute("data-avatar")) === "monogram" && ((await broken.textContent()) ?? "").trim() === "D",
      `${await broken.getAttribute("data-avatar")} ${(await broken.textContent()) ?? ""}`,
    );
    await brokenCtx.close();

    // Gravatar photos: off by default, its own switch, and when on, the d=404 URL for
    // the SHA-256 of the address — intercepted here, never the real network. Marcus has
    // a Gravatar; everyone else is a 404, so Northline falls through to its logo.
    const sha = (address) => createHash("sha256").update(address.trim().toLowerCase()).digest("hex");
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const marcusUrl = `https://gravatar.com/avatar/${sha("marcus@northwind.example")}?d=404&s=64`;
    const gravatarHits = [];
    const gOffOrigin = [];
    const routeGravatar = (ctxToRoute) =>
      ctxToRoute.route("https://gravatar.com/**", (route) => {
        const request = route.request();
        gravatarHits.push({ url: request.url(), headers: request.headers() });
        const hit = request.url().startsWith(`https://gravatar.com/avatar/${sha("marcus@northwind.example")}?`);
        return route.fulfill({
          status: hit ? 200 : 404,
          headers: { "access-control-allow-origin": "*", "content-type": hit ? "image/png" : "text/plain" },
          body: hit ? PNG : "Not Found",
        });
      });

    const gDefaultCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await routeGravatar(gDefaultCtx);
    const gd = await gDefaultCtx.newPage();
    await gd.goto(URL, { waitUntil: "networkidle" });
    await gd.waitForSelector("[data-row-count] [data-row-id]");
    await search(gd, "Marcus");
    await gd.waitForTimeout(300);
    check("Gravatar is off by default: no request to Gravatar", gravatarHits.length === 0, gravatarHits.map((h) => h.url).join(" | "));
    check("and Marcus keeps his monogram", (await avatarFor(gd, "Marcus").getAttribute("data-avatar")) === "monogram");
    await gd.locator("input[type='search']").first().fill("");
    await gd.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await gd.keyboard.press(",");
    await gd.waitForTimeout(300);
    await openSettingsCategory(gd, "privacy");
    const gDefaultToggle = gd.locator('[aria-label="Gravatar photos"]');
    check("Settings has a Gravatar photos switch", (await gDefaultToggle.count()) === 1);
    check("which is off by default", (await gDefaultToggle.getAttribute("aria-checked")) === "false");
    await gd.locator('[data-setting="gravatars"]').hover();
    await gd.waitForTimeout(100);
    check(
      "beside Show brand logos, explained as sending a hashed address to Gravatar",
      await gd.evaluate(() => {
        const text = document.querySelector('[data-settings-body]')?.innerText ?? "";
        const logos = text.indexOf("Show brand logos");
        const grav = text.indexOf("Gravatar photos");
        const about = document.querySelector("[data-settings-explain]")?.textContent ?? "";
        return logos >= 0 && grav > logos && /hashed copy of each sender's address/.test(about);
      }),
    );
    await gDefaultCtx.close();

    const gCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await gCtx.addInitScript(() => {
      if (!sessionStorage.getItem("seeded-gravatars")) {
        localStorage.setItem("winnow.preferences.v1", JSON.stringify({ gravatars: true, brandLogos: true }));
        sessionStorage.setItem("seeded-gravatars", "1");
      }
    });
    await routeGravatar(gCtx);
    const g = await gCtx.newPage();
    g.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("https://gravatar.com/")) gOffOrigin.push(url);
    });
    await g.goto(URL, { waitUntil: "networkidle" });
    await g.waitForSelector("[data-row-count] [data-row-id]");
    await search(g, "Marcus");
    const marcus = avatarFor(g, "Marcus");
    await marcus.locator("img").waitFor({ timeout: 5_000 }).catch(() => undefined);
    await g.waitForTimeout(300);
    check("with Gravatar on, the expected d=404 URL is requested", gravatarHits.some((h) => h.url === marcusUrl), gravatarHits.slice(0, 3).map((h) => h.url).join(" | "));
    check("and a sender with a Gravatar shows it", (await marcus.getAttribute("data-avatar")) === "photo" && (await imageLoaded(marcus)));
    check("at twice the list's 32px", (await marcus.locator("img").getAttribute("src")) === marcusUrl);
    check(
      "without cookies or a referrer",
      gravatarHits.length > 0 && gravatarHits.every((h) => !h.headers.cookie && !h.headers.referer),
    );
    const skipped = ["no-reply@claims.example", "dana@northwind.example"].map((a) => sha(a));
    check(
      "no lookup for no-reply senders or senders with a contact photo",
      !gravatarHits.some((h) => skipped.some((hash) => h.url.includes(hash))),
    );
    check("every Gravatar request has the expected shape", gravatarHits.every((h) => /^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?d=404&s=(64|72)$/.test(h.url)), gravatarHits.map((h) => h.url).find((u) => !/d=404/.test(u)) ?? "");
    await search(g, "deals@shop");
    const northlineG = avatarFor(g, "Northline");
    await northlineG.locator("img").waitFor({ timeout: 5_000 }).catch(() => undefined);
    await g.waitForTimeout(300);
    check(
      "with no Gravatar (a 404), the brand logo is next",
      (await northlineG.getAttribute("data-avatar")) === "photo" &&
        ((await northlineG.locator("img").getAttribute("src")) ?? "").includes("/demo-avatars/"),
      (await northlineG.locator("img").getAttribute("src").catch(() => "")) ?? "",
    );
    await g.locator("input[type='search']").first().fill("");
    await g.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await g.keyboard.press(",");
    await g.waitForTimeout(300);
    await openSettingsCategory(g, "privacy");
    const gToggle = g.locator('[aria-label="Gravatar photos"]');
    check("the Gravatar switch shows on", (await gToggle.getAttribute("aria-checked")) === "true");
    await gToggle.click();
    await g.waitForTimeout(150);
    check("and turns off", (await gToggle.getAttribute("aria-checked")) === "false");
    check(
      "which forgets the cached answers",
      await g.evaluate(() => localStorage.getItem("winnow.gravatars.v1") === null),
    );
    check("nothing else off the origin is asked for", gOffOrigin.length === 0, gOffOrigin.slice(0, 3).join(" | "));
    await gCtx.close();
  }

  // ── Sidebar, rail and avatar edge cases ───────────────────────────────────
  //
  // Each in its own context, so a failure here cannot leave the main page in a state the
  // console section then blames on something else.
  section("sidebar edge cases");
  {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 900 } });
    const m = await ctx.newPage();
    const mErrors = [];
    m.on("pageerror", (error) => mErrors.push(String(error)));
    m.on("console", (message) => message.type() === "error" && mErrors.push(message.text()));
    await m.goto(URL, { waitUntil: "networkidle" });
    await m.waitForSelector("[data-row-count] button[data-message-id]");
    const mOpen = async () => (await m.locator("[data-sidebar][data-open]").count()) > 0;
    const waitClosed = () => m.locator("[data-sidebar]").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
    const focusedToggle = () =>
      m.evaluate(() => {
        const active = document.activeElement;
        return active?.hasAttribute("data-sidebar-toggle") && active.getClientRects().length > 0
          ? active.hasAttribute("data-reader-sidebar-toggle") ? "reader" : "masthead"
          : (active?.tagName ?? "none");
      });

    // A medium window with a message open: the list (and the masthead's toggle) gives
    // way to the reader, which has to carry a toggle of its own.
    await m.locator("[data-row-count] button[data-message-id]").first().click();
    await m.waitForSelector("article h1", { timeout: 5_000 });
    const readerToggle = m.locator("[data-reader-sidebar-toggle]");
    check(
      "at 800px with a message open, the reader carries a visible sidebar toggle",
      (await readerToggle.isVisible()) && !(await m.locator("header [data-sidebar-toggle]").isVisible()),
    );
    check(
      "which is labelled and wired like the masthead's",
      (await readerToggle.getAttribute("aria-controls")) === "winnow-sidebar" &&
        (await readerToggle.getAttribute("aria-expanded")) === "false" &&
        (await readerToggle.getAttribute("aria-label")) === "Open sidebar",
    );
    await readerToggle.click();
    await m.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    check("it opens the sidebar over the reader", await mOpen());
    await m.keyboard.press("Escape");
    await waitClosed();
    check(
      "Escape closes it, the message stays open, and focus is back on the reader's toggle",
      !(await mOpen()) && (await m.locator("article h1").count()) === 1 && (await focusedToggle()) === "reader",
      await focusedToggle(),
    );

    // Opened at medium width, then the window widens past `lg` while it is open: the
    // reader's toggle is hidden, so focus has to land on the masthead's, not the body.
    await readerToggle.click();
    await m.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    await m.setViewportSize({ width: 1440, height: 900 });
    await m.waitForTimeout(200);
    check("widening the window keeps the sidebar open", await mOpen());
    await m.keyboard.press("Escape");
    await waitClosed();
    check(
      "and closing it then gives focus to the toggle that is on screen",
      (await focusedToggle()) === "masthead",
      await focusedToggle(),
    );

    // Desktop to phone while open: one sidebar, the scrim's origin follows the new
    // width, and the phone's own toggle gets focus back.
    await m.locator("article h1").count();
    await m.keyboard.press("Escape"); // close the reader, so the phone bar is shown
    await m.waitForTimeout(150);
    await m.locator("header [data-sidebar-toggle]").click();
    await m.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    const edgeAt = () =>
      m.evaluate(() => {
        const scrim = document.querySelector("[data-sidebar-scrim]");
        const probe = document.createElement("div");
        probe.style.cssText = "position:fixed;width:0;height:0;left:var(--wn-sidebar-edge);top:var(--wn-sidebar-mid, 50%)";
        scrim.appendChild(probe);
        const at = probe.getBoundingClientRect();
        probe.remove();
        const side = document.querySelector("[data-sidebar]").getBoundingClientRect();
        return {
          x: at.left,
          y: at.top,
          right: side.right,
          mid: side.top + side.height / 2,
          top: side.top,
          centre: side.left + side.width / 2,
          bottom: side.bottom,
        };
      });
    await m.setViewportSize({ width: 390, height: 844 });
    await m.waitForTimeout(400);
    const phoneEdge = await edgeAt();
    check(
      "shrinking to a phone while open: still exactly one sidebar, still open",
      (await m.locator("[data-sidebar]").count()) === 1 && (await mOpen()),
    );
    check(
      "and it becomes the bottom sheet, its blur's origin moving to the middle of its top edge",
      Math.abs(phoneEdge.x - phoneEdge.centre) <= 2 && Math.abs(phoneEdge.y - phoneEdge.top) <= 2 &&
        phoneEdge.bottom > 844 - 120,
      JSON.stringify(phoneEdge),
    );
    // A window too short for the panel: it scrolls inside itself, and the origin follows.
    await m.setViewportSize({ width: 390, height: 300 });
    await m.waitForTimeout(400);
    const shortEdge = await edgeAt();
    check(
      "a window resize re-measures the origin, and the sheet stays inside the window",
      Math.abs(shortEdge.y - shortEdge.top) <= 2 && shortEdge.top >= 0,
      JSON.stringify(shortEdge),
    );
    await m.keyboard.press("Escape");
    await waitClosed();
    check(
      "closing on the phone gives focus to the phone's toggle",
      await m.evaluate(() => {
        const active = document.activeElement;
        return Boolean(active?.hasAttribute("data-sidebar-toggle") && active.getClientRects().length > 0);
      }),
    );
    check(
      "and the app behind it is no longer inert",
      await m.evaluate(() => ![...document.querySelectorAll("[inert]")].some((node) => !node.hasAttribute("data-sidebar"))),
    );
    check(
      "the sidebar's scroller contains its own overscroll (no rubber-banding the app)",
      (await m.locator("[data-sidebar-scroll]").evaluate((node) => getComputedStyle(node).overscrollBehaviorY)) === "contain",
    );
    await m.setViewportSize({ width: 1440, height: 900 });
    await m.waitForTimeout(200);

    // A double-click on the toggle: the second click lands on the scrim, and used to
    // close the sidebar it had just opened.
    await m.locator("header [data-sidebar-toggle]").dblclick();
    await m.waitForTimeout(300);
    check("a double-click on the toggle leaves the sidebar open", await mOpen());
    await m.mouse.click(1200, 600);
    await waitClosed();
    check("and a single click outside still closes it", !(await mOpen()));

    // A drag that starts inside and leaves (selecting, or dragging the scrollbar) is not
    // walking away: the idle close waits for the button to come up.
    await m.locator("header [data-sidebar-toggle]").click();
    await m.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    await m.waitForTimeout(350); // the slide-in, so the box below is where it rests
    const brand = await m.locator("[data-sidebar]").getByText("Winnow", { exact: true }).boundingBox();
    await m.mouse.move(brand.x + 4, brand.y + brand.height / 2);
    await m.mouse.down();
    await m.mouse.move(900, 450, { steps: 5 });
    await m.waitForTimeout(SIDEBAR_IDLE_MS + 400);
    check("held mouse button after a press inside: the idle close waits", await mOpen());
    await m.mouse.up();
    await m.evaluate(() => document.getSelection()?.removeAllRanges());
    await m.mouse.move(905, 455);
    await m.waitForTimeout(SIDEBAR_IDLE_MS + 500);
    check("released outside: it closes on the idle timer as usual", !(await mOpen()));
    if (await mOpen()) await m.keyboard.press("Escape");
    await waitClosed();

    // Reduced transparency (no Playwright option yet, so through CDP): no glass, just
    // the opaque surface and the plain tint.
    const cdp = await ctx.newCDPSession(m);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    await m.locator("header [data-sidebar-toggle]").click();
    await m.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    const clear = await m.evaluate(() => ({
      supported: matchMedia("(prefers-reduced-transparency: reduce)").matches,
      layers: [...document.querySelectorAll("[data-scrim-layer], .wn-sidebar-blur")].every(
        (node) => getComputedStyle(node).display === "none",
      ),
      tint: getComputedStyle(document.querySelector(".wn-scrim-tint")).backgroundImage,
      panel: getComputedStyle(document.querySelector(".wn-sidebar-tint")).backgroundImage,
    }));
    check(
      "with reduced transparency the blur layers are gone and both tints are flat",
      !clear.supported || (clear.layers && clear.tint === "none" && clear.panel === "none"),
      JSON.stringify(clear),
    );
    await m.keyboard.press("Escape");
    await waitClosed();
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });

    // Forced colours: a Canvas panel with a border, no glass, no scrim paint.
    await m.emulateMedia({ forcedColors: "active" });
    await m.locator("header [data-sidebar-toggle]").click();
    await m.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    const forced = await m.evaluate(() => ({
      layers: [...document.querySelectorAll("[data-scrim-layer], .wn-sidebar-blur, .wn-scrim-tint")].every(
        (node) => getComputedStyle(node).display === "none",
      ),
      border: getComputedStyle(document.querySelector("[data-sidebar]")).borderTopStyle,
    }));
    check("in forced colours the glass and scrim are dropped and the panel keeps a border", forced.layers && forced.border === "solid", JSON.stringify(forced));
    await m.keyboard.press("Escape");
    await waitClosed();
    await m.emulateMedia({ forcedColors: "none" });

    check("no console errors on the sidebar edge-case pass", mErrors.length === 0, mErrors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  section("rail and avatar edge cases");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // Dana's photo answers slowly: the monogram has to hold the place until it lands.
    let releasePhoto;
    const photoGate = new Promise((resolve) => (releasePhoto = resolve));
    await ctx.route("**/demo-avatars/dana.svg", async (route) => {
      await photoGate;
      await route.continue();
    });
    const r = await ctx.newPage();
    await r.goto(URL, { waitUntil: "domcontentloaded" });
    await r.waitForSelector("[data-row-count] [data-row-id]");
    await r.locator("input[type='search']").first().fill("dana@northwind");
    await r.waitForTimeout(400);
    const dana = r
      .locator("[data-row-count] [data-row-id]")
      .filter({ has: r.locator("[data-row-sender]", { hasText: "Dana Whitfield" }) })
      .first()
      .locator("[data-row-control='avatar'] [data-avatar]");
    const pending = await dana.evaluate((node) => ({
      kind: node.getAttribute("data-avatar"),
      loaded: node.hasAttribute("data-avatar-loaded"),
      letter: [...node.querySelectorAll("span")].find((span) => span.textContent.trim() === "D")?.checkVisibility() ?? false,
    }));
    check(
      "while a picture is still loading, the avatar shows the monogram, not an empty disc",
      pending.kind === "photo" && !pending.loaded && pending.letter,
      JSON.stringify(pending),
    );
    releasePhoto();
    await r.waitForSelector("[data-avatar-loaded]", { timeout: 5_000 }).catch(() => undefined);
    const landed = await dana.evaluate((node) => ({
      loaded: node.hasAttribute("data-avatar-loaded"),
      letterHidden: [...node.querySelectorAll("span")].every((span) => getComputedStyle(span).visibility === "hidden"),
    }));
    check("once it lands, the letter is hidden under it", landed.loaded && landed.letterHidden, JSON.stringify(landed));
    await r.locator("input[type='search']").first().fill("");
    await r.waitForTimeout(300);

    // The rail: every pill carries its whole label as a title, and labels are capped.
    const railPills = r.locator("header [data-rail-scroller] button[aria-pressed]");
    const titles = await railPills.evaluateAll((buttons) =>
      buttons.map((button) => ({
        title: button.getAttribute("title") ?? "",
        label: button.querySelector("[data-pill-label]")?.textContent ?? "",
        max: getComputedStyle(button.querySelector("[data-pill-label]")).maxWidth,
      })),
    );
    check(
      "every rail pill has a title naming it, and a capped label",
      titles.length > 0 && titles.every((item) => item.title.length > 0 && item.max !== "none"),
      JSON.stringify(titles.slice(0, 2)),
    );
    // A label far too long for any pill: truncated, not stretching the rail.
    const longest = await r.evaluate(() => {
      const label = document.querySelector("header [data-rail-scroller] [data-pill-label] span:last-child");
      const before = label.textContent;
      label.textContent = `From ${"averyveryverylongsendername".repeat(4)}@example.com`;
      const width = label.closest("button").getBoundingClientRect().width;
      label.textContent = before;
      return width;
    });
    check("a very long pill label is capped rather than stretching the pill", longest < 300, `${Math.round(longest)}px`);

    // The end fade follows the rail's content: switching a filter on adds "All" at the
    // start, which grows the rail without changing the scroller's own size.
    await r.setViewportSize({ width: 1100, height: 900 });
    await r.waitForTimeout(300);
    await railPills.nth(0).click();
    await r.waitForTimeout(300);
    const edgeMatches = await r.evaluate(() => {
      const scroller = document.querySelector("header [data-rail-scroller]");
      const more = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
      return { more, edge: Boolean(document.querySelector("header [data-rail-edge='end']")) };
    });
    check(
      "after a filter goes on, the end fade and step button match whether there is more rail",
      edgeMatches.more === edgeMatches.edge,
      JSON.stringify(edgeMatches),
    );
    await railPills.nth(0).click();
    await ctx.close();
  }

  // ── Text selection ─────────────────────────────────────────────────────────
  //
  // The chrome is `user-select: none`, and readable text opts back in. A report that
  // "you can't select anything that isn't in an email" is what this guards: the reader
  // header, an error, and Settings must be selectable; the list rows and the buttons
  // must not, or a drag across the list paints a selection over it.

  section("text selection");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
    const t = await ctx.newPage();
    t.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    t.on("pageerror", (error) => errors.push(String(error)));
    await t.goto(URL, { waitUntil: "networkidle" });
    await t.waitForSelector("[data-message-id]", { timeout: 10_000 });

    /** Select an element's contents the way a script (or a triple-click) would, and read it back. */
    const selectIn = (locator) =>
      locator.evaluate((el) => {
        const selection = document.getSelection();
        selection.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.addRange(range);
        return selection.toString();
      });
    const selected = () => t.evaluate(() => document.getSelection()?.toString() ?? "");
    const clear = () => t.evaluate(() => document.getSelection()?.removeAllRanges());
    const userSelect = (locator) => locator.evaluate((el) => getComputedStyle(el).userSelect);

    await t.locator("[data-message-id]").first().click();
    await t.waitForSelector("[data-reader] article h1", { timeout: 5_000 });
    const reader = t.locator("[data-reader]");
    const subjectText = ((await reader.locator("[data-reader-subject]").textContent()) ?? "").trim();
    for (const [name, selector] of [
      ["subject", "[data-reader-subject]"],
      ["sender name", "[data-reader-sender]"],
      ["sender address", "[data-reader-address]"],
      ["date", "[data-reader-date]"],
    ]) {
      const element = reader.locator(selector).first();
      const text = ((await element.textContent()) ?? "").trim();
      const got = (await selectIn(element)).trim();
      check(`the reader's ${name} is selectable`, text.length > 0 && got === text, `${JSON.stringify(got)} vs ${JSON.stringify(text)}`);
    }

    // A real triple-click, so the CSS is what is tested and not only the Selection API.
    await reader.locator("[data-reader-subject]").click({ clickCount: 3 });
    check("triple-clicking the subject selects it", (await selected()).includes(subjectText), await selected());

    // A drag from the subject up across the toolbar stops at the controls.
    await clear();
    const subjectBox = await reader.locator("[data-reader-subject]").boundingBox();
    const toolbarButton = reader.locator("button[aria-label]").filter({ hasNotText: /./ }).first();
    const avatarBox = await reader.locator("[data-reader-avatar]").boundingBox();
    await t.mouse.move(subjectBox.x + subjectBox.width - 2, subjectBox.y + subjectBox.height / 2);
    await t.mouse.down();
    await t.mouse.move(avatarBox.x + 2, avatarBox.y + 2, { steps: 8 });
    await t.mouse.up();
    const bled = await selected();
    check(
      "a drag from the subject into the header selects text, not button labels",
      bled.length > 0 && !/Archive|Trash|Reply|Forward|Sender options/.test(bled),
      JSON.stringify(bled.slice(0, 120)),
    );

    // Controls stay chrome, even inside the selectable reader.
    check("the reader's buttons are not selectable", (await userSelect(toolbarButton)) === "none", await userSelect(toolbarButton));
    await clear();
    await reader.locator("[data-reader-avatar]").dblclick();
    await t.keyboard.press("Escape");
    await t.waitForTimeout(150);
    check("double-clicking the avatar button selects nothing", (await selected()) === "", JSON.stringify(await selected()));

    // The list rows: unselectable, so drag-select owns the drag.
    const row = t.locator("button[data-message-id]").first();
    check("a list row is not selectable", (await userSelect(row)) === "none" && (await selectIn(row)).trim() === "", await userSelect(row));
    const pill = t.locator("header button[aria-pressed]:visible").first();
    check("a filter pill is not selectable", (await userSelect(pill)) === "none" && (await selectIn(pill)).trim() === "");
    await clear();

    // The browser's own context menu over selected text: nothing in the app cancels it.
    const menuAllowed = await reader.locator("[data-reader-subject]").evaluate((el) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 });
      return el.dispatchEvent(event);
    });
    check("right-clicking reader text leaves the native menu (Copy) alone", menuAllowed);

    // ⌘A / Ctrl+A selects the reader, not the whole app.
    await reader.locator("[data-reader-subject]").click();
    await t.keyboard.press("ControlOrMeta+a");
    const all = await t.evaluate(() => {
      const selection = document.getSelection();
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      return {
        text: selection.toString(),
        inReader: Boolean(range && document.querySelector("[data-reader]").contains(range.commonAncestorContainer)),
      };
    });
    check(
      "Ctrl/⌘+A in the reader selects the reader's text and nothing outside it",
      all.inReader && all.text.includes(subjectText),
      JSON.stringify({ inReader: all.inReader, length: all.text.length }),
    );

    // Ctrl/⌘+C copies; it is not a shortcut, so the reader stays as it was.
    const rowsBefore = await t.locator("[data-row-count]").getAttribute("data-row-count");
    await t.keyboard.press("ControlOrMeta+c");
    await t.waitForTimeout(150);
    const clip = await t.evaluate(() => navigator.clipboard.readText().catch(() => null));
    check(
      "Ctrl/⌘+C copies the selection and triggers no app action",
      (await t.locator("[data-reader] article h1").count()) === 1 &&
        (await t.locator("[data-row-count]").getAttribute("data-row-count")) === rowsBefore &&
        (clip === null || clip.includes(subjectText)),
      clip === null ? "clipboard unreadable here" : JSON.stringify(clip.slice(0, 80)),
    );
    await clear();

    // Settings: its text is selectable, its controls are not, and ⌘A stays inside it.
    await t.keyboard.press("Escape");
    await t.waitForTimeout(150);
    await t.keyboard.press(",");
    await t.waitForSelector("[data-settings-body]", { timeout: 5_000 });
    const settings = t.locator("[data-settings-body]");
    const note = settings.locator("[data-sorting-note]");
    const noteText = ((await note.textContent()) ?? "").trim();
    check("a Settings text is selectable", noteText.length > 0 && (await selectIn(note)).trim() === noteText);
    await openSettingsCategory(t, "google");
    const clientHint = settings.locator('[data-setting="oauthClient"] [data-settings-row] p').first();
    const clientText = ((await clientHint.textContent()) ?? "").trim();
    check("the Google client value in Settings is selectable", clientText.length > 0 && (await selectIn(clientHint)).trim() === clientText, clientText);
    const settingsButton = settings.locator("button").first();
    check("Settings buttons are not selectable", (await userSelect(settingsButton)) === "none");
    await clear();
    await t.keyboard.press("ControlOrMeta+a");
    const settingsAll = await t.evaluate(() => {
      const selection = document.getSelection();
      const range = selection.rangeCount ? selection.getRangeAt(0) : null;
      return Boolean(range && document.querySelector("[data-settings-body]").contains(range.commonAncestorContainer)) && selection.toString().length > 0;
    });
    check("Ctrl/⌘+A in Settings selects the Settings text only", settingsAll);
    await clear();
    await t.keyboard.press("Escape");
    await t.waitForTimeout(150);

    // An error banner: the whole text selectable, with a Copy button that copies all of it.
    await t.goto(`${URL}?error=access_denied&state=smoke-selection`, { waitUntil: "networkidle" });
    const banner = t.locator("[data-error-banner]");
    await banner.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    if (check("a declined sign-in shows the error banner", (await banner.count()) === 1)) {
      const copyText = banner.locator("[data-error-copy]");
      const full = ((await copyText.textContent()) ?? "").trim();
      check("the banner's error is selectable in full", full.length > 0 && (await selectIn(copyText)).trim() === full, full);
      check("the banner's Dismiss button is not selectable", (await userSelect(banner.getByRole("button", { name: "Dismiss" }))) === "none");
      await clear();
      await banner.locator("[data-error-copy-button]").click();
      await t.waitForTimeout(200);
      const copied = await t.evaluate(() => navigator.clipboard.readText().catch(() => null));
      check(
        "the banner's Copy button copies the whole error",
        (await banner.locator('[data-error-copy-button][aria-label="Copied the error"]').count()) === 1 &&
          (copied === null || copied === full),
        copied === null ? "clipboard unreadable here" : JSON.stringify(copied),
      );
    }
    await ctx.close();
  }

  // ── Reader split ───────────────────────────────────────────────────────────
  //
  // The divider between the list and the reader: a separator that drags, steps with
  // the keyboard, resets on double-click and persists as a fraction. Only on the wide
  // layout; the phone has one pane and nothing to divide.

  section("reader split");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const t = await ctx.newPage();
    t.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    t.on("pageerror", (error) => errors.push(String(error)));
    await t.goto(URL, { waitUntil: "networkidle" });
    await t.waitForSelector("[data-message-id]");
    await t.locator("[data-message-id]").nth(1).click();
    await t.waitForTimeout(300);

    const handle = t.locator('[data-reader-split][role="separator"]');
    const widths = () =>
      t.evaluate(() => {
        const main = document.querySelector("main");
        const reader = document.querySelector("[data-reader-pane]");
        const handleBox = document.querySelector("[data-reader-split]")?.getBoundingClientRect();
        return {
          main: main?.getBoundingClientRect().width ?? 0,
          reader: reader?.getBoundingClientRect().width ?? 0,
          readerLeft: reader?.getBoundingClientRect().left ?? 0,
          handleMid: handleBox ? handleBox.left + handleBox.width / 2 : 0,
          stored: localStorage.getItem("winnow.readerSplit.v1"),
          resizing: document.documentElement.hasAttribute("data-resizing"),
        };
      });

    require("the reader split handle is on the desktop layout", (await handle.count()) === 1);
    const attrs = await handle.evaluate((el) => ({
      orientation: el.getAttribute("aria-orientation"),
      now: Number(el.getAttribute("aria-valuenow")),
      min: Number(el.getAttribute("aria-valuemin")),
      max: Number(el.getAttribute("aria-valuemax")),
      tabIndex: el.tabIndex,
      cursor: getComputedStyle(el).cursor,
      width: el.getBoundingClientRect().width,
    }));
    check(
      "it is a focusable vertical separator with a percentage value",
      attrs.orientation === "vertical" && attrs.tabIndex === 0 && attrs.min < attrs.now && attrs.now < attrs.max && attrs.max <= 100,
      JSON.stringify(attrs),
    );
    check("with a col-resize cursor and a thin hit area", attrs.cursor === "col-resize" && attrs.width >= 6 && attrs.width <= 8, JSON.stringify(attrs));

    const start = await widths();
    check(
      "the default split gives the reader 38% and sits on the boundary",
      Math.abs(start.reader / start.main - 0.38) < 0.01 && Math.abs(start.handleMid - start.readerLeft) <= 1.5 && start.stored === null,
      JSON.stringify(start),
    );

    // Drag the divider 200px left: a wider reader. No row opens, nothing selects.
    const openBefore = await t.locator("[data-reader-pane] h1").first().textContent();
    await t.mouse.move(start.handleMid, 450);
    await t.mouse.down();
    await t.mouse.move(start.handleMid - 100, 450, { steps: 5 });
    const during = await widths();
    await t.mouse.move(start.handleMid - 200, 450, { steps: 5 });
    await t.waitForTimeout(50);
    await t.mouse.up();
    await t.waitForTimeout(100);
    const dragged = await widths();
    check("dragging the divider widens the reader", Math.abs(dragged.reader - start.reader - 200) <= 3, `${start.reader} → ${dragged.reader}`);
    check("the list narrows by the same amount", Math.abs(dragged.readerLeft - (start.readerLeft - 200)) <= 3, JSON.stringify(dragged));
    check("text selection is vetoed while dragging, and restored after", during.resizing && !dragged.resizing, JSON.stringify({ during: during.resizing, after: dragged.resizing }));
    check(
      "the drag neither selects text nor opens a row",
      (await t.evaluate(() => document.getSelection()?.toString() ?? "")) === "" &&
        (await t.locator("[data-reader-pane] h1").first().textContent()) === openBefore &&
        (await t.locator("[data-select-bar], [data-selection-bar]").count()) === 0,
    );
    const saved = JSON.parse(dragged.stored ?? "null");
    check(
      "the split is saved as a fraction on drag end",
      typeof saved?.reader === "number" && Math.abs(saved.reader - dragged.reader / dragged.main) < 0.01,
      String(dragged.stored),
    );

    // It is a proportion: the window grows, the reader keeps its share.
    await t.setViewportSize({ width: 1800, height: 900 });
    await t.waitForTimeout(200);
    const grown = await widths();
    check("the split scales with the window", Math.abs(grown.reader / grown.main - saved.reader) < 0.01, JSON.stringify(grown));
    await t.setViewportSize({ width: 1440, height: 900 });
    await t.waitForTimeout(200);

    // Persists across a reload.
    await t.reload({ waitUntil: "networkidle" });
    await t.waitForSelector("[data-message-id]");
    await t.waitForTimeout(200);
    const reloaded = await widths();
    check("the split survives a reload", Math.abs(reloaded.reader - dragged.reader) <= 2, `${dragged.reader} → ${reloaded.reader}`);

    // The minimums hold against a drag past either end.
    await t.mouse.move(reloaded.handleMid, 450);
    await t.mouse.down();
    await t.mouse.move(5, 450, { steps: 6 });
    await t.mouse.up();
    await t.waitForTimeout(100);
    const farLeft = await widths();
    check("the list keeps at least 280px", Math.round(farLeft.main - farLeft.reader) >= 279, JSON.stringify(farLeft));
    await t.mouse.move(farLeft.handleMid, 450);
    await t.mouse.down();
    await t.mouse.move(1435, 450, { steps: 6 });
    await t.mouse.up();
    await t.waitForTimeout(100);
    const farRight = await widths();
    check("the reader keeps at least 360px", Math.round(farRight.reader) >= 359, JSON.stringify(farRight));

    // Double-click resets.
    await t.mouse.dblclick(farRight.handleMid, 450);
    await t.waitForTimeout(100);
    const reset = await widths();
    check(
      "double-clicking the divider resets the default split",
      Math.abs(reset.reader / reset.main - 0.38) < 0.01 && reset.stored === null,
      JSON.stringify(reset),
    );

    // The keyboard.
    await handle.focus();
    const value = () => handle.evaluate((el) => Number(el.getAttribute("aria-valuenow")));
    const v0 = await value();
    await t.keyboard.press("ArrowRight");
    const v1 = await value();
    await t.keyboard.press("Shift+ArrowLeft");
    const v2 = await value();
    await t.keyboard.press("Home");
    const vHome = await value();
    await t.keyboard.press("End");
    const vEnd = await value();
    const range = await handle.evaluate((el) => [Number(el.getAttribute("aria-valuemin")), Number(el.getAttribute("aria-valuemax"))]);
    check("ArrowRight steps the divider by 2%", v1 - v0 === 2, `${v0} → ${v1}`);
    check("Shift+ArrowLeft steps it back by 10%", v1 - v2 === 10, `${v1} → ${v2}`);
    check("Home and End go to the minimum and maximum", vHome === range[0] && vEnd === range[1], JSON.stringify({ vHome, vEnd, range }));
    check(
      "the keys stay on the handle, not the app's shortcuts",
      await t.evaluate(() => document.activeElement?.hasAttribute("data-reader-split") ?? false),
    );
    const keyed = await widths();
    check("and the keyboard's split is saved too", keyed.stored !== null, String(keyed.stored));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const t = await ctx.newPage();
    t.on("pageerror", (error) => errors.push(String(error)));
    await t.goto(URL, { waitUntil: "networkidle" });
    await t.waitForSelector("[data-message-id]");
    const listCount = await t.locator("[data-reader-split]").count();
    await t.locator("[data-message-id]").first().tap();
    await t.waitForTimeout(300);
    check("there is no split handle on the phone layout", listCount === 0 && (await t.locator("[data-reader-split]").count()) === 0);
    await ctx.close();
  }
  {
    // A tablet keeps the single-pane reader: the handle is there but hidden with it.
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1000 } });
    const t = await ctx.newPage();
    t.on("pageerror", (error) => errors.push(String(error)));
    await t.goto(URL, { waitUntil: "networkidle" });
    await t.waitForSelector("[data-message-id]");
    await t.locator("[data-message-id]").first().click();
    await t.waitForTimeout(300);
    check("and none to grab below the wide layout", !(await t.locator("[data-reader-split]").isVisible()));
    await ctx.close();
  }

  // ── Read on open ───────────────────────────────────────────────────────────

  section("read on open");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const r = await ctx.newPage();
    r.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    r.on("pageerror", (error) => errors.push(String(error)));
    await r.goto(URL, { waitUntil: "networkidle" });
    await r.waitForSelector("[data-row-count] [data-row-id]");

    const rowButtons = r.locator("[data-row-count] button[data-message-id]");
    // The Inbox row's `data-unread`, read off the DOM whether or not the sidebar is
    // showing: absent means zero, as everywhere else.
    const inboxUnread = () =>
      r.evaluate(() => Number(document.querySelector('button[data-nav="inbox"]')?.getAttribute("data-unread") ?? "0"));
    /** A row's read state as the list paints it: the label, the dot, and the weight. */
    const rowState = (id) =>
      r.evaluate((id) => {
        const button = document.querySelector(`[data-row-count] button[data-message-id="${id}"]`);
        const row = button?.closest("[data-row-id]");
        if (!button || !row) return null;
        return {
          labelUnread: /, unread,/.test(button.getAttribute("aria-label") ?? ""),
          dot: row.querySelector(":scope > span[aria-hidden]")?.className.includes("bg-accent") ?? false,
          weight: Number(getComputedStyle(row.querySelector("[data-row-sender]")).fontWeight),
        };
      }, id);
    const isUnreadPainted = (st) => st !== null && st.labelUnread && st.dot && st.weight >= 600;
    const isReadPainted = (st) => st !== null && !st.labelUnread && !st.dot && st.weight === 400;
    /** Ids of unread rows, in list order. */
    const unreadIds = () =>
      r.evaluate(() =>
        [...document.querySelectorAll("[data-row-count] button[data-message-id]")]
          .filter((b) => /, unread,/.test(b.getAttribute("aria-label") ?? ""))
          .map((b) => b.getAttribute("data-message-id")),
      );
    const openRow = async (id) => {
      await r.locator(`[data-row-count] button[data-message-id="${id}"]`).click();
      await r.waitForTimeout(200);
    };

    // A click.
    const startUnread = await unreadIds();
    require("the demo inbox has unread rows to open", startUnread.length >= 4, `${startUnread.length}`);
    const countBefore = await inboxUnread();
    const first = startUnread[0];
    check("an unread row shows its dot and weight before it is opened", isUnreadPainted(await rowState(first)), JSON.stringify(await rowState(first)));
    await openRow(first);
    check("opening an unread row clears its dot and weight", isReadPainted(await rowState(first)), JSON.stringify(await rowState(first)));
    check("and the inbox count drops", (await inboxUnread()) === countBefore - 1, `${countBefore} → ${await inboxUnread()}`);
    check("with no undo offer for it", (await r.getByText(/^Undo$/).count()) === 0);

    // j onto the next row is an open too.
    await openRow(startUnread[1]);
    await r.keyboard.press("Escape");
    await r.waitForTimeout(150);
    const afterSecond = await unreadIds();
    const nextUnread = afterSecond[0];
    const nextIndex = await rowButtons.evaluateAll((els, id) => els.findIndex((e) => e.getAttribute("data-message-id") === id), nextUnread);
    await rowButtons.nth(nextIndex - 1).click();
    await r.waitForTimeout(150);
    await r.keyboard.press("j");
    await r.waitForTimeout(200);
    check("j onto an unread row reads it", isReadPainted(await rowState(nextUnread)), JSON.stringify(await rowState(nextUnread)));

    // Mark unread moves on and does not bounce back to read; a later open reads it again.
    await openRow(first);
    await r.keyboard.press("u");
    await r.waitForTimeout(250);
    const openAfterU = await r.locator('[data-row-count] button[aria-current="true"]').getAttribute("data-message-id").catch(() => null);
    check("marking the open message unread moves on", openAfterU !== first, `${openAfterU}`);
    await r.waitForTimeout(300);
    check("and it stays unread", isUnreadPainted(await rowState(first)), JSON.stringify(await rowState(first)));
    await openRow(first);
    check("re-opening it later reads it again", isReadPainted(await rowState(first)), JSON.stringify(await rowState(first)));

    // Checking a row in select mode is not an open.
    const toCheck = (await unreadIds())[0];
    await r.locator(`[data-row-count] [data-row-id="${toCheck}"] [data-row-control='avatar']`).click();
    await r.waitForTimeout(120);
    await r.locator("[data-menu-item='sender-select']").click();
    await r.waitForTimeout(150);
    check("Select checks the row", (await r.locator(`[data-row-count] [data-row-id="${toCheck}"][data-checked]`).count()) === 1);
    check("and leaves it unread", isUnreadPainted(await rowState(toCheck)), JSON.stringify(await rowState(toCheck)));
    await r.keyboard.press("Escape");
    await r.waitForTimeout(150);

    // The switch: on by default, and off keeps an opened message unread.
    await r.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await r.keyboard.press(",");
    await r.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 5_000 });
    const toggle = r.locator('[role="switch"][aria-label="Mark as read when opened"]');
    check("Settings has a Mark as read when opened switch", (await toggle.count()) === 1);
    check("which is on by default", (await toggle.getAttribute("aria-checked")) === "true");
    await toggle.click();
    await r.waitForTimeout(150);
    check("and turns off", (await toggle.getAttribute("aria-checked")) === "false");
    await r.keyboard.press("Escape");
    await r.waitForTimeout(250);
    const offTarget = (await unreadIds())[0];
    const countOff = await inboxUnread();
    await openRow(offTarget);
    await r.waitForTimeout(200);
    check("with it off, opening an unread row leaves it unread", isUnreadPainted(await rowState(offTarget)), JSON.stringify(await rowState(offTarget)));
    check("and the inbox count holds", (await inboxUnread()) === countOff, `${countOff} → ${await inboxUnread()}`);
    check(
      "the switch is saved with the other preferences",
      await r.evaluate(() => JSON.parse(localStorage.getItem("winnow.preferences.v1") ?? "{}").markReadOnOpen === false),
    );

    // Undo send sits beside it: Off, 5, 10, 20 or 30 seconds, 5 by default.
    await r.keyboard.press(",");
    await r.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 5_000 });
    const undoChoices = r.locator("[data-undo-send-choices] button");
    check(
      "Settings offers Undo send as Off, 5s, 10s, 20s and 30s",
      (await undoChoices.allTextContents()).join("|") === "Off|5s|10s|20s|30s",
      (await undoChoices.allTextContents()).join("|"),
    );
    check("with 5s chosen by default", (await r.locator("[data-undo-send-choices] button[aria-pressed='true']").textContent()) === "5s");
    await r.locator("[data-undo-send-choices] button", { hasText: "Off" }).click();
    await r.waitForTimeout(150);
    check(
      "and Off is saved with the other preferences",
      await r.evaluate(() => JSON.parse(localStorage.getItem("winnow.preferences.v1") ?? "{}").undoSendSeconds === 0),
    );
    await r.keyboard.press("Escape");
    await r.waitForTimeout(250);
    await ctx.close();
  }

  // ── Settings layout ────────────────────────────────────────────────────────
  //
  // Three columns on a desktop (categories, controls, an explanation of the last setting
  // pointed at), a (?) popover per setting below 1200px, and on a phone a category list
  // that opens one category page at a time above the dock.

  section("settings layout");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const s = await ctx.newPage();
    s.on("pageerror", (error) => errors.push(String(error)));
    await s.goto(URL, { waitUntil: "networkidle" });
    await s.waitForSelector("[data-row-count] [data-row-id]");
    await s.keyboard.press(",");
    const dialog = s.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    await s.waitForTimeout(300);
    check("Settings is three columns at 1440px", (await s.locator('[data-settings-layout="three"]').count()) === 1);
    const columns = await s.evaluate(() =>
      ["nav", "content", "explain"].map((name) => {
        const element = document.querySelector(`[data-settings-column="${name}"]`);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { x: Math.round(rect.x), width: Math.round(rect.width), height: Math.round(rect.height), border: style.borderRightWidth };
      }),
    );
    check(
      "about 27%, 45% and 28% of the window, left to right, full height",
      columns.every(Boolean) &&
        Math.abs(columns[0].width - 389) <= 12 && Math.abs(columns[1].width - 648) <= 12 && Math.abs(columns[2].width - 403) <= 12 &&
        columns[0].x === 0 && columns[1].x > columns[0].x && columns[2].x > columns[1].x &&
        columns.every((column) => column.height === 900),
      JSON.stringify(columns),
    );
    check("separated by hairlines, not bars", columns[0]?.border === "1px" && columns[1]?.border === "1px", JSON.stringify(columns.map((c) => c?.border)));
    const tabs = dialog.locator('[role="tablist"][aria-orientation="vertical"] [role="tab"]');
    const tabLabels = await tabs.allTextContents();
    check(
      "the categories, Reading first and selected",
      JSON.stringify(tabLabels) === JSON.stringify(["Reading", "Appearance", "Privacy", "Notifications & sync", "Google account", "Hidden & muted senders", "Keyboard shortcuts", "About"]) &&
        (await tabs.first().getAttribute("aria-selected")) === "true",
      JSON.stringify(tabLabels),
    );
    const backBox = await dialog.locator("[data-settings-back]").boundingBox();
    check("Back is at the top left", Boolean(backBox) && backBox.x < 40 && backBox.y < 40, JSON.stringify(backBox));
    const title = () => dialog.locator("[data-settings-title]").textContent();
    const explain = s.locator("[data-settings-explain]");
    check("the explanation column is a polite live region", (await explain.getAttribute("aria-live")) === "polite");
    check("before anything is pointed at it introduces the category", (await explain.getAttribute("data-settings-explain")) === "intro");

    // Arrow keys move through the categories, and the middle column follows.
    await tabs.first().focus();
    await s.keyboard.press("ArrowDown");
    await s.waitForTimeout(80);
    check(
      "ArrowDown selects and focuses the next category",
      (await title()) === "Appearance" &&
        (await s.evaluate(() => document.activeElement?.getAttribute("data-category"))) === "appearance",
    );
    await s.keyboard.press("End");
    await s.waitForTimeout(80);
    check("End jumps to the last", (await title()) === "About");
    await s.keyboard.press("ArrowDown");
    await s.waitForTimeout(80);
    check("and ArrowDown wraps round to the first", (await title()) === "Reading");
    await s.keyboard.press("ArrowDown");
    await s.keyboard.press("ArrowDown");
    await s.waitForTimeout(80);
    check("Privacy shows its own settings", (await title()) === "Privacy" && (await dialog.locator('[data-setting="brandLogos"]').count()) === 1);
    check("with no (?) buttons, since the column explains them", (await dialog.locator("[data-setting-info]").count()) === 0);
    check("and no explanation copy under the rows", !((await dialog.locator("[data-settings-body]").innerText()).includes("Cloudflare")));

    // Hover: the column describes the row, and keeps it after the pointer leaves.
    await dialog.locator('[data-setting="brandLogos"]').hover();
    await s.waitForTimeout(80);
    check(
      "hovering a setting explains it in the right column",
      (await explain.getAttribute("data-explains")) === "brandLogos" && /Cloudflare's DNS-over-HTTPS/.test((await explain.textContent()) ?? ""),
    );
    await s.mouse.move(700, 850);
    await s.waitForTimeout(80);
    check("and the explanation stays after the pointer leaves", (await explain.getAttribute("data-explains")) === "brandLogos");
    await dialog.locator('[data-setting="gravatars"]').hover();
    await s.waitForTimeout(80);
    check(
      "the next hover replaces it",
      (await explain.getAttribute("data-explains")) === "gravatars" && /hashed copy of each sender's address/.test((await explain.textContent()) ?? ""),
    );
    await s.mouse.move(700, 850);

    // Keyboard focus does the same, with no pointer involved.
    await dialog.locator('[role="switch"][aria-label="Show brand logos"]').focus();
    await s.waitForTimeout(80);
    check("keyboard focus entering a setting explains it", (await explain.getAttribute("data-explains")) === "brandLogos");
    await s.keyboard.press("Tab");
    await s.waitForTimeout(80);
    check("and Tab to the next setting moves the explanation", (await explain.getAttribute("data-explains")) === "gravatars");

    // Choosing another category starts on its intro.
    await openSettingsCategory(s, "reading");
    check("a new category starts on its intro", (await explain.getAttribute("data-settings-explain")) === "intro" && ((await explain.textContent()) ?? "").includes("Reading"));
    // Every setting row in every category explains itself.
    let unexplained = [];
    for (const id of ["reading", "appearance", "privacy", "sync", "google", "senders", "shortcuts", "about"]) {
      await openSettingsCategory(s, id);
      for (const block of await dialog.locator("[data-setting]").all()) {
        const setting = await block.getAttribute("data-setting");
        await block.hover();
        const body = (await explain.locator("p").nth(1).textContent()) ?? "";
        if ((await explain.getAttribute("data-explains")) !== setting || body.trim().length < 40) unexplained.push(`${id}/${setting}`);
      }
    }
    check("every setting row has explanation copy", unexplained.length === 0, unexplained.join(", "));

    // Back and Escape both return to the mail.
    await dialog.locator("[data-settings-back]").click();
    await s.waitForTimeout(200);
    check("Back returns to the mail", (await s.locator('[role="dialog"]').count()) === 0 && (await s.locator("[data-row-count] [data-row-id]").count()) > 0);
    await s.keyboard.press(",");
    await dialog.waitFor({ timeout: 5_000 });
    await s.keyboard.press("Escape");
    await s.waitForTimeout(200);
    check("and so does Escape", (await s.locator('[role="dialog"]').count()) === 0);
    await ctx.close();
  }
  {
    // Below 1200px: two columns, and a (?) per setting instead of the third column.
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const s = await ctx.newPage();
    s.on("pageerror", (error) => errors.push(String(error)));
    await s.goto(URL, { waitUntil: "networkidle" });
    await s.waitForSelector("[data-row-count] [data-row-id]");
    await s.keyboard.press(",");
    const dialog = s.locator('[role="dialog"][aria-label="Settings"]');
    await openSettingsCategory(s, "privacy");
    check("at 1024px Settings is two columns, with no explanation column", (await s.locator('[data-settings-layout="two"]').count()) === 1 && (await s.locator("[data-settings-explain]").count()) === 0);
    const infos = dialog.locator("[data-setting-info]");
    const labels = await infos.evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")));
    check(
      "every setting has a (?) named for it",
      JSON.stringify(labels) === JSON.stringify(["About Remote images", "About Show brand logos", "About Gravatar photos"]),
      JSON.stringify(labels),
    );
    check("and the explanations are not printed under the rows", !((await dialog.innerText()).includes("Cloudflare")));
    const info = dialog.locator('[data-setting-info="brandLogos"]');
    const tip = s.locator('[role="tooltip"][data-setting-popover="brandLogos"]');
    check("closed, it says so", (await info.getAttribute("aria-expanded")) === "false" && (await tip.count()) === 0);
    await info.hover();
    await s.waitForTimeout(150);
    const tipId = await tip.getAttribute("id").catch(() => null);
    check(
      "hovering the (?) shows the same copy as the column",
      (await tip.isVisible()) && /Cloudflare's DNS-over-HTTPS/.test((await tip.textContent()) ?? "") &&
        (await info.getAttribute("aria-expanded")) === "true" && (await info.getAttribute("aria-describedby")) === tipId,
    );
    const tipBox = await tip.boundingBox();
    check(
      "inside the viewport",
      Boolean(tipBox) && tipBox.x >= 0 && tipBox.y >= 0 && tipBox.x + tipBox.width <= 1024 && tipBox.y + tipBox.height <= 768,
      JSON.stringify(tipBox),
    );
    await s.mouse.move(900, 700);
    await s.waitForTimeout(100);
    check("and hides when the pointer leaves it", (await tip.count()) === 0);
    await info.click();
    await s.mouse.move(900, 700);
    await s.waitForTimeout(100);
    check("a click pins it open", await tip.isVisible());
    await s.keyboard.press("Escape");
    await s.waitForTimeout(100);
    check("Escape closes the popover and leaves Settings open", (await tip.count()) === 0 && (await dialog.count()) === 1);
    await dialog.locator('[data-setting-info="gravatars"]').focus();
    await s.waitForTimeout(100);
    check("keyboard focus on the (?) shows it", await s.locator('[data-setting-popover="gravatars"]').isVisible());
    await s.keyboard.press("Shift+Tab");
    await s.waitForTimeout(100);
    check("and moving focus away hides it", (await s.locator('[data-setting-popover="gravatars"]').count()) === 0);
    await dialog.locator("[data-settings-back]").click();
    await s.waitForTimeout(200);
    check("Back returns to the mail here too", (await s.locator('[role="dialog"]').count()) === 0);
    await ctx.close();
  }
  {
    // Phone: a category list, then one category's page with a back arrow, above the dock.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const s = await ctx.newPage();
    s.on("pageerror", (error) => errors.push(String(error)));
    await s.goto(URL, { waitUntil: "networkidle" });
    await s.waitForSelector("[data-row-count] [data-row-id]");
    const tabsNav = s.locator('[data-phone-dock] nav[aria-label="Primary"] button');
    await tabsNav.filter({ hasText: "Settings" }).tap();
    const dialog = s.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    await s.waitForTimeout(300);
    check("a phone opens Settings on its category list", (await s.locator('[data-settings-layout="phone"][data-settings-page="list"]').count()) === 1);
    check("with every category", (await dialog.locator("button[data-category]").count()) === 8);
    const settingsTab = tabsNav.filter({ hasText: "Settings" });
    const dockBox = await s.locator("[data-phone-dock] nav").boundingBox();
    const dialogBox = await dialog.boundingBox();
    check(
      "above the dock, whose Settings tab stays visible and current",
      (await settingsTab.getAttribute("aria-current")) === "page" && Boolean(dockBox && dialogBox) &&
        dialogBox.y + dialogBox.height <= dockBox.y + 1 && (await settingsTab.isVisible()),
      JSON.stringify({ dockBox, dialogBox }),
    );
    await dialog.locator('button[data-category="privacy"]').tap();
    await s.waitForTimeout(200);
    check(
      "tapping a category opens its page, titled, with a back arrow",
      (await s.locator('[data-settings-page="category"]').count()) === 1 &&
        (await dialog.locator("[data-settings-title]").textContent()) === "Privacy" &&
        (await dialog.locator('[data-settings-back][aria-label="Back to Settings"]').count()) === 1,
    );
    check("its settings carry (?) buttons, not helper text", (await dialog.locator("[data-setting-info]").count()) === 3 && !((await dialog.innerText()).includes("Cloudflare")));
    await dialog.locator('[data-setting-info="gravatars"]').tap();
    await s.waitForTimeout(150);
    const tip = s.locator('[data-setting-popover="gravatars"]');
    const tipBox = await tip.boundingBox();
    check(
      "a tap opens the explanation, inside the screen",
      Boolean(tipBox) && tipBox.x >= 0 && tipBox.x + tipBox.width <= 390 && tipBox.y >= 0 && tipBox.y + tipBox.height <= 844 &&
        /hashed copy of each sender's address/.test((await tip.textContent()) ?? ""),
      JSON.stringify(tipBox),
    );
    await dialog.locator("[data-settings-title]").tap();
    await s.waitForTimeout(150);
    check("a tap elsewhere closes it", (await tip.count()) === 0);
    await dialog.locator('[data-setting-info="gravatars"]').tap();
    await s.waitForTimeout(100);
    await dialog.locator('[data-setting-info="gravatars"]').tap();
    await s.waitForTimeout(100);
    check("and a second tap on the (?) closes it too", (await tip.count()) === 0);
    await dialog.locator("[data-settings-back]").tap();
    await s.waitForTimeout(200);
    check(
      "back returns to the list, focus on the category it came from",
      (await s.locator('[data-settings-page="list"]').count()) === 1 &&
        (await s.evaluate(() => document.activeElement?.getAttribute("data-category"))) === "privacy",
    );
    await tabsNav.filter({ hasText: "Inbox" }).tap();
    await s.waitForTimeout(250);
    check("the Inbox tab returns to the mail", (await s.locator('[role="dialog"]').count()) === 0);
    await ctx.close();
  }

  // ── Privacy ─────────────────────────────────────────────────────────────────
  //
  // From the network's side: what leaves the browser. A signed-in session against a
  // fake Gmail (every googleapis call is answered here, nothing reaches Google), one
  // message carrying every remote-content vector a tracking email uses, and a request
  // log. With images withheld nothing may go anywhere but this origin and the fake API,
  // in either the inline or the "as sent" form; once the reader allows images only the
  // images load, with no Referer; and signing out leaves nothing of the account in
  // storage, the drafts kept on the device included.

  section("privacy");
  {
    // Built at run time so the secret scan does not read the fixture as a real token.
    const FAKE_SMOKE_TOKEN = ["fake", "smoke", "access"].join("-");
    const origin = new globalThis.URL(URL).origin;
    const T = "https://t.example/o";
    const TORTURE = [
      `<h1>Privacy torture</h1><p>Every way a sender learns you opened this.</p>`,
      `<img src="${T}/img.gif" width="10" height="10" alt="pixel">`,
      `<img srcset="${T}/a.gif 1x, ${T}/b.gif 2x" alt="srcset">`,
      `<table background="${T}/bg.gif"><tr><td background="${T}/td.gif">cell</td></tr></table>`,
      `<div style="background:url(${T}/css.gif)">css url</div>`,
      `<div style="background:u\\72l(${T}/esc.gif)">escaped url</div>`,
      `<div style="background:image-set('${T}/set.gif' 1x)">image-set</div>`,
      `<style>@import url(${T}/import.css); @font-face{font-family:x;src:url(${T}/font.woff)} .a{background:url(${T}/sheet.gif)}</style>`,
      `<link rel="stylesheet" href="${T}/link.css"><link rel="prefetch" href="${T}/prefetch">`,
      `<meta http-equiv="refresh" content="0;url=${T}/refresh">`,
      `<iframe src="${T}/frame"></iframe>`,
      `<form action="${T}/form"><input type="image" src="${T}/input.gif"></form>`,
      `<svg><image href="${T}/svg.gif"/><use href="${T}/sprite.svg#a"/></svg>`,
      `<video poster="${T}/poster.gif"><source src="${T}/v.mp4"></video>`,
      `<object data="${T}/obj"></object><embed src="${T}/embed">`,
      `<a href="https://shop.example/" ping="${T}/ping">a link</a>`,
    ].join("\n");
    const b64url = (text) => Buffer.from(text, "utf8").toString("base64url");
    const headers = [
      { name: "From", value: "Tracker <news@tracker.example>" },
      { name: "To", value: "me@winnow.example" },
      { name: "Subject", value: "Privacy torture" },
      { name: "Date", value: new Date().toUTCString() },
      { name: "Message-ID", value: "<m1@tracker.example>" },
    ];
    const message = (format) => ({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Every way a sender learns you opened this.",
      internalDate: String(Date.now() - 60_000),
      sizeEstimate: 4000,
      payload:
        format === "full"
          ? {
              mimeType: "multipart/alternative",
              headers,
              parts: [
                { partId: "0", mimeType: "text/plain", headers: [], body: { size: 40, data: b64url("Every way a sender learns you opened this.") } },
                { partId: "1", mimeType: "text/html", headers: [], body: { size: TORTURE.length, data: b64url(TORTURE) } },
              ],
            }
          : { mimeType: "multipart/alternative", headers },
    });
    const json = (route, body, status = 200) =>
      route.fulfill({ status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    const fakeGmail = (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-allow-methods": "GET, POST, PUT, DELETE",
          },
        });
      }
      const url = new globalThis.URL(request.url());
      const p = url.pathname.replace("/gmail/v1/users/me", "");
      if (p === "/profile") return json(route, { emailAddress: "me@winnow.example", historyId: "500", messagesTotal: 1 });
      if (p === "/messages") {
        const q = url.searchParams.get("q") ?? "";
        return json(route, q.includes("in:inbox") && !q.includes("-in:inbox") ? { messages: [{ id: "m1", threadId: "t1" }], resultSizeEstimate: 1 } : { resultSizeEstimate: 0 });
      }
      if (p === "/messages/m1") return json(route, message(url.searchParams.get("format") === "full" ? "full" : "metadata"));
      if (p === "/history") return json(route, { historyId: "500" });
      if (p === "/drafts" && request.method() === "POST") return json(route, { id: "d1", message: { id: "dm1", threadId: "t1" } });
      if (p.startsWith("/drafts/") && request.method() === "PUT") return json(route, { id: "d1", message: { id: "dm1", threadId: "t1" } });
      if (p.startsWith("/drafts/") && request.method() === "DELETE") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
      return json(route, {});
    };

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((accessToken) => {
      // Init scripts run in every frame, and the message's own frames are sandboxed with
      // no storage at all: only the app's top-level document is seeded.
      if (window.top !== window) return;
      if (sessionStorage.getItem("seeded-privacy")) return;
      sessionStorage.setItem("seeded-privacy", "1");
      localStorage.setItem("winnow.google.oauthClient", JSON.stringify({ clientId: "1234567890-abc123def.apps.googleusercontent.com" }));
      localStorage.setItem(
        "winnow.gmail.tokens",
        JSON.stringify({
          accessToken,
          refreshToken: "1//smoke-refresh",
          expiresAt: Date.now() + 3_600_000,
          scope: "https://www.googleapis.com/auth/gmail.modify",
        }),
      );
    }, FAKE_SMOKE_TOKEN);
    await ctx.route("https://gmail.googleapis.com/**", fakeGmail);
    await ctx.route("https://oauth2.googleapis.com/**", (route) => json(route, { error: "invalid_grant" }, 400));
    // Sign-out revokes the grant at Google. Registered after the catch-all, so it wins.
    const revokes = [];
    await ctx.route("https://oauth2.googleapis.com/revoke", (route) => {
      const request = route.request();
      revokes.push({ url: request.url(), method: request.method(), body: request.postData() ?? "" });
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: "{}" });
    });
    const trackerHits = [];
    await ctx.route("https://t.example/**", (route) => {
      trackerHits.push({ url: route.request().url(), headers: route.request().headers() });
      return route.fulfill({
        status: 200,
        headers: { "content-type": "image/gif" },
        body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
      });
    });

    const pv = await ctx.newPage();
    const pvErrors = [];
    pv.on("pageerror", (error) => pvErrors.push(String(error)));
    const external = [];
    pv.on("request", (request) => {
      const url = request.url();
      if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return;
      if (url.startsWith("https://gmail.googleapis.com/")) return;
      external.push(url);
    });
    await pv.goto(URL, { waitUntil: "networkidle" });
    const row = pv.locator("[data-message-id]", { hasText: "Privacy torture" }).first();
    await row.waitFor({ state: "visible", timeout: 15_000 });
    check("a signed-in session against the fake Gmail lists the message", true);

    await row.click();
    await pv.locator("article h1").first().waitFor({ timeout: 5_000 });
    await pv.locator("[data-wn-email]").first().waitFor({ timeout: 5_000 });
    await pv.waitForTimeout(800);
    check("opening it with images withheld sends nothing anywhere", external.length === 0, external.slice(0, 4).join(" | "));
    check(
      "and the reader says what it withheld",
      /remote (thing is|things are) withheld/.test(await pv.locator("[data-reader]").first().innerText()),
    );

    const more = pv.locator('[data-reader] button[aria-label="More"]:visible').first();
    const forms = pv.locator('[role="menu"] [role="menuitemradio"]');
    await more.click();
    await forms.nth(2).click();
    await pv.locator('iframe[title="Message as sent"]').waitFor({ timeout: 5_000 });
    await pv.waitForTimeout(800);
    check("the original, with the sender's stylesheet, still sends nothing", external.length === 0, external.slice(0, 4).join(" | "));
    await more.click();
    await forms.nth(0).click();
    await pv.waitForTimeout(300);

    const show = pv.getByRole("button", { name: /^Show (it|them) for this message$/ });
    await show.click();
    await pv.waitForTimeout(1_000);
    const loaded = trackerHits.map((hit) => new globalThis.URL(hit.url).pathname);
    check("allowing images loads the message's images", loaded.some((p) => p.endsWith("/img.gif")), loaded.join(" "));
    check(
      "and only images: no stylesheet, font, frame, form, svg, video or ping",
      !loaded.some((p) => /css|font|import|sheet|link|prefetch|refresh|frame|form|input|svg|sprite|poster|v\.mp4|obj|embed|ping|esc|set\.gif/.test(p)),
      loaded.join(" "),
    );
    check(
      "with no Referer and no cookie",
      trackerHits.length > 0 && trackerHits.every((hit) => !hit.headers.referer && !hit.headers.cookie),
      JSON.stringify(trackerHits.map((hit) => hit.headers.referer ?? null)),
    );
    check("and nothing else left the browser", external.every((url) => url.startsWith("https://t.example/")), external.filter((u) => !u.startsWith("https://t.example/")).join(" | "));

    // A reply, so a draft is kept on this device, then sign out with it still open.
    await pv.keyboard.press("r");
    const dockBody = pv.locator('[data-composer-dock] textarea[aria-label="Message"]');
    await dockBody.waitFor({ state: "visible", timeout: 5_000 });
    await dockBody.focus();
    await pv.keyboard.type("A private reply.");
    await pv.waitForTimeout(2_600);
    const kept = await pv.evaluate(() => localStorage.getItem("winnow.drafts.v1:me@winnow.example") ?? "");
    check("a written reply is kept on the device while signed in", kept.includes("A private reply."));

    await pv.locator("[data-sidebar-toggle]:visible").first().click();
    await pv.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    await pv.locator('[data-nav-account] button[aria-label^="Account"]').click();
    await pv.getByRole("menuitem", { name: "Sign out" }).click();
    await pv.waitForTimeout(800);
    check(
      "signing out revokes the grant at Google once, with the refresh token in the body and not the URL",
      revokes.length === 1 &&
        revokes[0].method === "POST" &&
        !revokes[0].url.includes("token=") &&
        new globalThis.URLSearchParams(revokes[0].body).get("token") === "1//smoke-refresh",
      JSON.stringify(revokes.map((r) => ({ url: r.url, method: r.method, hasToken: r.body.includes("token=") }))),
    );
    const left = await pv.evaluate(() => Object.keys(localStorage).filter((key) => /^winnow\.(gmail|drafts|google\.contacts|logos|gravatars)/.test(key)));
    check("signing out leaves no mail, cursor, token or draft in storage", left.length === 0, left.join(", "));
    const written = await pv.evaluate(() => Object.values(localStorage).join("\n"));
    check("and no trace of the message or the reply", !/Privacy torture|A private reply/.test(written) && !written.includes(FAKE_SMOKE_TOKEN));
    // The autosave was stopped, not just hidden: nothing is written back a moment later.
    await pv.waitForTimeout(2_600);
    check(
      "and nothing is written back afterwards",
      (await pv.evaluate(() => Object.keys(localStorage).filter((key) => /^winnow\.(gmail|drafts)/.test(key)))).length === 0,
    );
    check("no page errors on the privacy pass", pvErrors.length === 0, pvErrors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ── The position readout follows the open message ─────────────────────────

  // "4 of 39" was the cursor's index, a separate number from the open message, and every
  // change to the rows (an archive above, new mail at the top, a re-sort on read) shifted
  // one without the other. Against a fake Gmail, so mail can genuinely arrive.
  section("position readout");
  {
    const FAKE_POSITION_TOKEN = ["fake", "position", "access"].join("-");
    const b64url = (text) => Buffer.from(text, "utf8").toString("base64url");
    const base = Date.now() - 30 * 60_000;
    // p1 newest .. p8 oldest; p0 is the mail that arrives later, newer than all of them.
    const labels = new Map();
    const subjects = new Map();
    const dates = new Map();
    for (let i = 0; i <= 8; i += 1) {
      labels.set(`p${i}`, i <= 4 ? ["INBOX", "UNREAD"] : ["INBOX"]);
      subjects.set(`p${i}`, `Position check ${i}`);
      dates.set(`p${i}`, i === 0 ? Date.now() - 5_000 : base - i * 3_600_000);
    }
    let arrived = false;
    let delivered = false;
    const touched = new Set();
    const listed = () => [...labels.keys()].filter((id) => id !== "p0" || arrived);
    const message = (id, format) => {
      const headers = [
        { name: "From", value: `Sender ${id} <${id}@position.example>` },
        { name: "To", value: "me@winnow.example" },
        { name: "Subject", value: subjects.get(id) },
        { name: "Date", value: new Date(dates.get(id)).toUTCString() },
        { name: "Message-ID", value: `<${id}@position.example>` },
      ];
      const text = `Body of ${subjects.get(id)}.`;
      return {
        id,
        threadId: `t-${id}`,
        labelIds: labels.get(id),
        snippet: text,
        internalDate: String(dates.get(id)),
        sizeEstimate: 400,
        payload:
          format === "full"
            ? { mimeType: "text/plain", headers, body: { size: text.length, data: b64url(text) } }
            : { mimeType: "text/plain", headers },
      };
    };
    const json = (route, body, status = 200) =>
      route.fulfill({ status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    const fakeGmail = (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-allow-methods": "GET, POST, PUT, DELETE",
          },
        });
      }
      const url = new globalThis.URL(request.url());
      const p = url.pathname.replace("/gmail/v1/users/me", "");
      if (p === "/profile") return json(route, { emailAddress: "me@winnow.example", historyId: "500", messagesTotal: listed().length });
      if (p === "/messages") {
        const q = url.searchParams.get("q") ?? "";
        const inbox = q.includes("in:inbox") && !q.includes("-in:inbox");
        const ids = listed().filter((id) => (inbox ? labels.get(id).includes("INBOX") : !labels.get(id).includes("INBOX")));
        return json(route, ids.length ? { messages: ids.map((id) => ({ id, threadId: `t-${id}` })), resultSizeEstimate: ids.length } : { resultSizeEstimate: 0 });
      }
      const modify = /^\/messages\/(p\d)\/modify$/.exec(p);
      if (modify && request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}");
        const id = modify[1];
        const next = new Set(labels.get(id));
        for (const label of body.addLabelIds ?? []) next.add(label);
        for (const label of body.removeLabelIds ?? []) next.delete(label);
        labels.set(id, [...next]);
        touched.add(id);
        return json(route, { id, labelIds: labels.get(id) });
      }
      const one = /^\/messages\/(p\d)$/.exec(p);
      if (one && (one[1] !== "p0" || arrived)) return json(route, message(one[1], url.searchParams.get("format") === "full" ? "full" : "metadata"));
      if (p === "/history") {
        if (!arrived || delivered) return json(route, { historyId: delivered ? "501" : "500" });
        delivered = true;
        return json(route, {
          history: [
            { id: "501", messagesAdded: [{ message: { id: "p0", threadId: "t-p0" } }] },
            ...[...touched].map((id) => ({ id: "501", labelsRemoved: [{ message: { id, threadId: `t-${id}` }, labelIds: ["INBOX"] }] })),
          ],
          historyId: "501",
        });
      }
      return json(route, {});
    };

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((accessToken) => {
      if (window.top !== window) return;
      if (sessionStorage.getItem("seeded-position")) return;
      sessionStorage.setItem("seeded-position", "1");
      localStorage.setItem("winnow.google.oauthClient", JSON.stringify({ clientId: "1234567890-abc123def.apps.googleusercontent.com" }));
      localStorage.setItem(
        "winnow.gmail.tokens",
        JSON.stringify({
          accessToken,
          refreshToken: "1//smoke-refresh",
          expiresAt: Date.now() + 3_600_000,
          scope: "https://www.googleapis.com/auth/gmail.modify",
        }),
      );
    }, FAKE_POSITION_TOKEN);
    await ctx.route("https://gmail.googleapis.com/**", fakeGmail);
    await ctx.route("https://oauth2.googleapis.com/**", (route) => json(route, { error: "invalid_grant" }, 400));

    const pp = await ctx.newPage();
    const ppErrors = [];
    pp.on("pageerror", (error) => ppErrors.push(String(error)));
    await pp.goto(URL, { waitUntil: "networkidle" });
    const listRows = pp.locator("[data-row-count] button[data-message-id]");
    await pp.locator("[data-message-id]", { hasText: "Position check 8" }).first().waitFor({ state: "visible", timeout: 15_000 });

    /** The readout, the open message and the list, read in one pass. */
    const readState = () =>
      pp.evaluate(() => {
        const readout = document.querySelector("header [data-position]")?.textContent?.trim() ?? "";
        const match = /^(\d+)\s*of\s*(\d+)$/.exec(readout);
        const rows = [...document.querySelectorAll("[data-row-count] button[data-message-id]")];
        const subjectOf = (row) => /Position check \d/.exec(row?.textContent ?? "")?.[0] ?? null;
        const open = /Position check \d/.exec(document.querySelector("article h1")?.textContent ?? "")?.[0] ?? null;
        const position = match ? Number(match[1]) : null;
        const total = match ? Number(match[2]) : Number(readout);
        return {
          readout,
          position,
          total,
          open,
          atPosition: position ? subjectOf(rows[position - 1]) : null,
          openRow: rows.findIndex((row) => subjectOf(row) === open) + 1,
          current: rows.findIndex((row) => row.getAttribute("aria-current") === "true") + 1,
          rows: rows.map(subjectOf),
          prevDisabled: document.querySelector('header [aria-label="Previous message"]')?.disabled ?? null,
          nextDisabled: document.querySelector('header [aria-label="Next message"]')?.disabled ?? null,
        };
      });
    const agrees = (s) =>
      s.open !== null &&
      s.position === s.openRow &&
      s.atPosition === s.open &&
      s.current === s.position &&
      s.prevDisabled === (s.position === 1) &&
      s.nextDisabled === (s.position === s.total);

    await listRows.nth(4).click();
    await pp.locator("article h1").first().waitFor({ timeout: 5_000 });
    await pp.waitForTimeout(400);
    const opened = await readState();
    check("the readout names the row that was opened", agrees(opened) && opened.position === 5, JSON.stringify(opened));

    // Archive a row above the open one, from its menu, without opening it.
    const aboveIndex = opened.rows.findIndex((subject, index) => index < opened.position - 1 && subject !== opened.open);
    await listRows.nth(aboveIndex).click({ button: "right" });
    await pp.locator("[data-menu='row'] [data-menu-item='archive']").click();
    await pp.waitForTimeout(500);
    const archived = await readState();
    check(
      "after a row above it is archived, the readout still names the open message",
      agrees(archived) && archived.open === opened.open && archived.position === opened.position - 1 && archived.total === opened.total - 1,
      JSON.stringify(archived),
    );

    // `j` steps from the open message, not from a cursor left where it used to be.
    const below = archived.rows[archived.position];
    await pp.keyboard.press("j");
    await pp.waitForTimeout(400);
    const stepped = await readState();
    check("j then opens the row straight below it", agrees(stepped) && stepped.open === below, JSON.stringify(stepped));

    // New mail arrives on the next foreground poll, at the top of the list.
    arrived = true;
    await pp.evaluate(() => window.dispatchEvent(new Event("focus")));
    await pp.locator("[data-message-id]", { hasText: "Position check 0" }).first().waitFor({ state: "visible", timeout: 20_000 });
    await pp.waitForTimeout(500);
    const fresh = await readState();
    const freshRow = fresh.rows.indexOf("Position check 0") + 1;
    check(
      "after new mail arrives above it, the readout still names the open message",
      agrees(fresh) && fresh.open === stepped.open && fresh.total === stepped.total + 1 && freshRow < fresh.position && fresh.position === stepped.position + 1,
      JSON.stringify({ ...fresh, freshRow }),
    );

    // The chevrons' ends are the open message's ends.
    await pp.locator('header [aria-label="Previous message"]').click();
    await pp.waitForTimeout(300);
    const prev = await readState();
    check("the previous chevron steps up from the open message", agrees(prev) && prev.position === fresh.position - 1, JSON.stringify(prev));
    for (let i = 0; i < 12 && !(await readState()).prevDisabled; i += 1) {
      await pp.locator('header [aria-label="Previous message"]').click();
      await pp.waitForTimeout(150);
    }
    const top = await readState();
    check("and is disabled on the first row, with next still live", agrees(top) && top.position === 1 && top.nextDisabled === false, JSON.stringify(top));
    check("no page errors on the position pass", ppErrors.length === 0, ppErrors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ── Label as ───────────────────────────────────────────────────────────────
  //
  // The row menu and the reader's More menu open a picker of the user's Gmail labels:
  // checked where a label is on the message, and able to make a new one. The demo's
  // labels are seeded, and the boarding-pass mail carries "Travel".

  section("label as");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const l = await ctx.newPage();
    const lErrors = [];
    l.on("pageerror", (error) => lErrors.push(String(error)));
    await l.goto(URL, { waitUntil: "networkidle" });
    await l.waitForSelector("[data-message-id]", { timeout: 10_000 });
    const picker = l.locator('[role="dialog"][aria-label="Label as"]');
    const option = (name) => picker.locator("[data-label-option]", { hasText: name });
    const travelRow = l.locator("[data-message-id]", { hasText: "Check-in is open" }).first();
    const openFromRow = async () => {
      await travelRow.click({ button: "right" });
      await l.locator("[data-menu-item='label-as']").click();
      await picker.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    };

    await travelRow.click({ button: "right" });
    check("the row menu offers Label as…", (await l.locator("[data-menu-item='label-as']").count()) === 1);
    await l.locator("[data-menu-item='label-as']").click();
    await picker.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    check("which opens a picker of the user's labels", (await picker.count()) === 1);
    check(
      "listing every label, by name",
      (await picker.locator("[data-label-option]").allTextContents()).join("|") === "Family|Receipts|Travel|Work/Northwind",
      (await picker.locator("[data-label-option]").allTextContents()).join("|"),
    );
    check("with the message's own label checked", (await option("Travel").getAttribute("aria-checked")) === "true");
    check("and Apply off until something changes", await picker.locator("[data-label-apply]").isDisabled());
    await option("Family").click();
    check("a click checks a label", (await option("Family").getAttribute("aria-checked")) === "true");

    // A new label: typed, made, and checked.
    await picker.locator('input[aria-label="Find or make a label"]').fill("Inbox");
    check("Gmail's own names are refused in place", ((await picker.locator("[data-label-problem]").textContent()) ?? "").includes("Gmail's own"));
    await picker.locator('input[aria-label="Find or make a label"]').fill("Lisbon trip");
    await picker.locator("[data-label-create]").click();
    await option("Lisbon trip").waitFor({ timeout: 3_000 }).catch(() => undefined);
    check("a new label can be made, and arrives checked", (await option("Lisbon trip").getAttribute("aria-checked")) === "true");
    await picker.locator("[data-label-apply]").click();
    await l.waitForTimeout(200);
    check("Apply closes the picker", (await picker.count()) === 0);
    check("and says it did", ((await l.locator("[data-notice-text]").textContent().catch(() => "")) ?? "").includes("Labels updated"));

    await openFromRow();
    check(
      "reopening shows the change kept",
      (await option("Family").getAttribute("aria-checked")) === "true" &&
        (await option("Lisbon trip").getAttribute("aria-checked")) === "true" &&
        (await option("Travel").getAttribute("aria-checked")) === "true",
    );
    await option("Travel").click();
    await l.keyboard.press("Escape");
    await l.waitForTimeout(150);
    check("Escape closes it without applying", (await picker.count()) === 0);
    await openFromRow();
    check("so nothing changed", (await option("Travel").getAttribute("aria-checked")) === "true");
    await l.keyboard.press("Escape");
    await l.waitForTimeout(150);

    // The reader's More menu has it too.
    await travelRow.click();
    await l.waitForSelector("article h1", { timeout: 5_000 });
    await l.locator('button[aria-label="More"]').first().click();
    await l.locator("[data-reader-label-as]").first().click();
    await picker.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    check(
      "the reader's More menu opens Label as… for the open message",
      (await picker.count()) === 1 && (await option("Travel").getAttribute("aria-checked")) === "true",
    );
    await l.keyboard.press("Escape");
    check("no page errors in Label as", lErrors.length === 0, lErrors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ── Console ────────────────────────────────────────────────────────────────

  section("console");

  check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  check(
    "no Content-Security-Policy violations on any page of the run",
    cspViolations.length === 0,
    `${cspViolations.length}: ${cspViolations.slice(0, 3).join(" | ")}`,
  );

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
