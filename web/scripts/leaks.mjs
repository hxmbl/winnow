/**
 * Does the app give back what it takes?
 *
 * Opens and closes 50 messages, opens and closes the composer 30 times and toggles the
 * sidebar 30 times, against the production build in the demo, and reads the renderer's
 * own counters after a forced GC: JS heap, DOM nodes, documents and JS event listeners.
 * Each loop is measured after a short warm-up, so lazy one-off work (a code-split chunk,
 * a first measurement) is not counted as growth.
 *
 * Every wait is a locator's `waitFor`, never `page.waitForSelector`: the latter returns an
 * element handle that Playwright keeps alive, so each open "leaked" a whole reader that
 * only the test was holding.
 *
 * Not part of `npm run smoke`: a heap number is a measurement, not a pass/fail, and it
 * moves with the browser version. The ceilings below are deliberately loose; they catch
 * "every open leaks a reader", not a few hundred bytes of JIT state.
 *
 *   node scripts/leaks.mjs            # builds if there is no dist/
 *   WINNOW_CHROMIUM=/usr/bin/chromium WINNOW_PORT=4391 node scripts/leaks.mjs
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WINNOW_PORT ?? 4174);
const URL = `http://localhost:${PORT}/`;

if (!existsSync(path.join(ROOT, "dist", "index.html"))) await build({ root: ROOT, logLevel: "warn" });
const server = await preview({ root: ROOT, logLevel: "warn", preview: { port: PORT, strictPort: true, open: false } });
const browser = await chromium.launch(
  process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM } : {},
);

const results = [];
let failed = false;

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.locator("[data-message-id]").first().waitFor();

  async function sample() {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(150);
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const dom = await cdp.send("Memory.getDOMCounters");
    return {
      heapKB: Math.round(m.JSHeapUsedSize / 1024),
      nodes: dom.nodes,
      documents: dom.documents,
      listeners: dom.jsEventListeners,
    };
  }

  /** Run `once` `warm` times, sample, run it `n` times, sample, and record the growth. */
  async function measure(label, n, once, warm = 3) {
    for (let i = 0; i < warm; i += 1) await once(i);
    const before = await sample();
    for (let i = 0; i < n; i += 1) await once(i);
    const after = await sample();
    const delta = Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]]));
    results.push({ label, n, before, after, delta });
    console.log(`${label} ×${n}`);
    console.log(`  before ${JSON.stringify(before)}`);
    console.log(`  after  ${JSON.stringify(after)}`);
    console.log(`  delta  ${JSON.stringify(delta)}`);
  }

  const blur = () =>
    page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));

  // ── Messages: open and close a different message each time ─────────────────
  await measure("open + close a message", 50, async (i) => {
    const rows = page.locator("[data-message-id]");
    const count = await rows.count();
    await rows.nth(i % Math.min(count, 12)).click();
    await page.locator("article h1").first().waitFor({ timeout: 5_000 });
    await page.waitForTimeout(60);
    await page.keyboard.press("Escape");
    await page.getByText("Nothing selected").first().waitFor({ timeout: 5_000 });
  });

  // ── Composer: `c`, type a little, Escape (an untouched-enough draft discards) ─
  const sheet = () => page.locator('[role="dialog"][aria-label="New message"]');
  await measure("open + close the composer", 30, async () => {
    await blur();
    await page.keyboard.press("c");
    await sheet().waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForTimeout(60);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await sheet().waitFor({ state: "detached", timeout: 5_000 });
  });

  // ── Sidebar: open with its toggle, close with Escape ───────────────────────
  await measure("toggle the sidebar", 30, async () => {
    await page.locator("[data-sidebar-toggle]:visible").first().click();
    await page.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForTimeout(80);
    await page.keyboard.press("Escape");
    await page.locator("[data-sidebar][data-open]").waitFor({ state: "detached", timeout: 5_000 });
    await page.waitForTimeout(250);
  });

  // ── Settings: the heaviest overlay, open and close ─────────────────────────
  await measure("open + close Settings", 20, async () => {
    await blur();
    await page.keyboard.press(",");
    await page.waitForTimeout(150);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  });

  if (errors.length > 0) {
    failed = true;
    console.log(`page errors: ${errors.slice(0, 3).join(" | ")}`);
  }

  // Loose ceilings: per-iteration growth that means a whole component tree is retained.
  for (const r of results) {
    const perNodes = r.delta.nodes / r.n;
    const perListeners = r.delta.listeners / r.n;
    const perKB = r.delta.heapKB / r.n;
    const leaking = perNodes > 20 || perListeners > 1 || perKB > 64 || r.delta.documents > 0;
    if (leaking) failed = true;
    console.log(
      `${leaking ? "LEAK" : "flat"}  ${r.label}: ${perNodes.toFixed(1)} nodes, ${perListeners.toFixed(2)} listeners, ${perKB.toFixed(1)} KB per iteration`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
