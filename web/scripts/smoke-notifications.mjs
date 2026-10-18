/**
 * Targeted smoke for Settings → Notifications & sync: the notification buttons and the
 * lock-screen privacy switch. Run against an existing build (`npm run build` first):
 *
 *   WINNOW_PORT=4361 WINNOW_CHROMIUM=/usr/bin/chromium node scripts/smoke-notifications.mjs
 *
 * The full suite (`smoke.mjs`) is not run for this; this checks only the new rows: they
 * appear once notifications are on, each button switches on its own, the switches
 * survive a reload, and nothing reaches the console.
 */
import { chromium } from "playwright";
import { preview } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WINNOW_PORT ?? 4361);
const URL = `http://localhost:${PORT}/`;

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
}

const server = await preview({ root: ROOT, logLevel: "warn", preview: { port: PORT, strictPort: true, open: false } });
const browser = await chromium.launch(process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(["notifications"], { origin: URL.replace(/\/$/, "") });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  const openSync = async () => {
    await page.keyboard.press(",");
    const dialog = page.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.locator('[role="tab"][data-category="sync"]').click();
    await page.waitForTimeout(150);
    return dialog;
  };
  const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem("winnow.preferences.v1") ?? "{}"));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-row-id], [role='option']", { timeout: 10_000 }).catch(() => undefined);

  let dialog = await openSync();
  const buttons = dialog.getByRole("group", { name: "Notification buttons" });
  check("the notification rows are hidden while notifications are off", (await buttons.count()) === 0);

  await dialog.getByRole("switch", { name: "Notify about new mail" }).click();
  await page.waitForTimeout(300);
  check(
    "turning notifications on keeps them on when the browser allows it",
    (await dialog.getByRole("switch", { name: "Notify about new mail" }).getAttribute("aria-checked")) === "true",
  );
  check("and shows the three notification buttons", (await buttons.getByRole("button").count()) === 3);
  const names = await buttons.getByRole("button").allTextContents();
  check("in the order a notification shows them", names.join("|") === "Reply|Mark read|Delete", names.join("|"));
  const pressed = async (name) => buttons.getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
  check("all on by default", (await pressed("Reply")) === "true" && (await pressed("Mark read")) === "true" && (await pressed("Delete")) === "true");

  await buttons.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForTimeout(150);
  check("Delete switches off on its own", (await pressed("Delete")) === "false" && (await pressed("Reply")) === "true");

  const privacy = dialog.getByRole("switch", { name: "Hide preview on lock screen" });
  check("the lock-screen privacy switch is there, off by default", (await privacy.getAttribute("aria-checked")) === "false");
  await privacy.click();
  await page.waitForTimeout(150);
  check("and turns on", (await privacy.getAttribute("aria-checked")) === "true");

  const saved = await prefs();
  check(
    "both are saved",
    saved.notificationActions?.trash === false && saved.notificationActions?.reply === true && saved.notificationHidePreview === true,
    JSON.stringify({ a: saved.notificationActions, h: saved.notificationHidePreview }),
  );

  await page.reload({ waitUntil: "networkidle" });
  dialog = await openSync();
  const again = dialog.getByRole("group", { name: "Notification buttons" });
  check(
    "and survive a reload",
    (await again.getByRole("button", { name: "Delete", exact: true }).getAttribute("aria-pressed")) === "false" &&
      (await dialog.getByRole("switch", { name: "Hide preview on lock screen" }).getAttribute("aria-checked")) === "true",
  );

  check("the console stayed empty", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
