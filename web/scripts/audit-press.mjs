/** Pressed states: a row held down, Compose held down, and the split divider. */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = "http://localhost:5173";
const phase = process.argv[2] ?? "after";
const outDir = `audit/${phase}-press`;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();

async function withPage({ viewport, theme }, run) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
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

// A read row pressed and held.
await withPage({ viewport: { width: 1440, height: 900 }, theme: "light" }, async (page) => {
  const row = page.locator("[data-row-id]").nth(1); // Okta — a read row
  const box = await row.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/desktop-light-row-pressed.png`, clip: { x: 0, y: box.y - 90, width: 1240, height: 220 } });
  await page.mouse.up();
});

// Compose pressed and held.
await withPage({ viewport: { width: 1440, height: 900 }, theme: "light" }, async (page) => {
  const compose = page.getByRole("button", { name: "Compose" });
  const box = await compose.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/desktop-light-compose-pressed.png`, clip: { x: box.x - 60, y: box.y - 40, width: 360, height: 140 } });
  await page.mouse.up();
});

// The divider at rest, between list and reader.
await withPage({ viewport: { width: 1440, height: 900 }, theme: "light" }, async (page) => {
  await page.locator("[data-row-id] button[data-message-id]").nth(1).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${outDir}/desktop-light-divider.png`, clip: { x: 1170, y: 0, width: 120, height: 900 } });
});

await browser.close();
console.log("press done");
