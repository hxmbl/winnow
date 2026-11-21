/** Interaction states for the audit: a filter switched on, the sidebar, the phone's panel. */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = "http://localhost:5173";
const phase = process.argv[2] ?? "before";
const outDir = `audit/${phase}-states`;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();

async function withPage({ viewport, theme }, run) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    hasTouch: viewport.width < 500,
    isMobile: viewport.width < 500,
  });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate((m) => {
    localStorage.setItem("winnow.preferences.v1", JSON.stringify({ appearance: m }));
    document.documentElement.dataset.theme = m;
  }, theme);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(900);
  await run(page);
  await context.close();
}

// Desktop: a filter switched on, and the sidebar open.
await withPage({ viewport: { width: 1440, height: 900 }, theme: "light" }, async (page) => {
  await page.locator(".wn-pill", { hasText: "Important" }).first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/desktop-light-filter-on.png` });
  await page.locator(".wn-pill", { hasText: "Important" }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /panel|sidebar|navigation/i }).first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/desktop-light-sidebar.png` });
});
await withPage({ viewport: { width: 1440, height: 900 }, theme: "dark" }, async (page) => {
  await page.locator(".wn-pill", { hasText: "Action needed" }).first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/desktop-dark-filter-on.png` });
});

// Phone: dock panel open, and the reader's action pill expanded.
await withPage({ viewport: { width: 390, height: 844 }, theme: "light" }, async (page) => {
  await page.getByRole("button", { name: /more mailboxes/i }).tap();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/phone-light-panel.png` });
});
await withPage({ viewport: { width: 390, height: 844 }, theme: "light" }, async (page) => {
  await page.locator("[data-row-id] button[data-message-id]").nth(1).tap();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: /more/i }).tap();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/phone-light-reader-pill.png` });
});

await browser.close();
console.log("states done");
