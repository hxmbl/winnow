/**
 * Captures the existing UI for the visual audit: desktop (1440×900) and phone
 * (390×844), light and dark, inbox and reader. Before/after pairs go in
 * audit/before and audit/after.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = "http://localhost:5173";
const phase = process.argv[2] ?? "before";

const outDir = `audit/${phase}`;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();

async function setTheme(page, mode) {
  await page.evaluate((m) => {
    const store = JSON.parse(localStorage.getItem("winnow.settings.v1") ?? "{}");
    store.appearance = m;
    localStorage.setItem("winnow.settings.v1", JSON.stringify(store));
    document.documentElement.dataset.theme = m;
  }, mode);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(700);
}

async function capture(name, { viewport, theme, openReader = false, dpr = 2 }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: dpr,
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
  if (openReader) {
    // Open the second row (a plain message) via a click on its row body.
    const rows = page.locator("[data-row-id] button[data-message-id]");
    if (viewport.width < 500) {
      await rows.nth(1).tap();
    } else {
      await rows.nth(1).click();
    }
    await page.waitForTimeout(900);
  }
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: false });
  await context.close();
}

// Desktop
await capture("desktop-light-inbox", { viewport: { width: 1440, height: 900 }, theme: "light" });
await capture("desktop-dark-inbox", { viewport: { width: 1440, height: 900 }, theme: "dark" });
await capture("desktop-light-reader", { viewport: { width: 1440, height: 900 }, theme: "light", openReader: true });
await capture("desktop-dark-reader", { viewport: { width: 1440, height: 900 }, theme: "dark", openReader: true });

// Phone
await capture("phone-light-inbox", { viewport: { width: 390, height: 844 }, theme: "light" });
await capture("phone-dark-inbox", { viewport: { width: 390, height: 844 }, theme: "dark" });
await capture("phone-light-reader", { viewport: { width: 390, height: 844 }, theme: "light", openReader: true });
await capture("phone-dark-reader", { viewport: { width: 390, height: 844 }, theme: "dark", openReader: true });

await browser.close();
console.log(`done: ${phase}`);
