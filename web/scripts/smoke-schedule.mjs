/**
 * Smoke checks for 1.4.0's snooze and send later, against the demo mailbox:
 *
 *   1. Snooze from the row menu (Undo through the status pill), `b` on an open message,
 *      the reader's Snooze button with "Pick date & time…", and the selection bar.
 *   2. The Snoozed mailbox lists them with their wake times; Unsnooze puts one back.
 *   3. Waking: the clock moved past the time (Playwright's fake clock), a focus, and the
 *      conversation is back at the top of the Inbox, unread, with the pill saying so; and
 *      a wake that was due while the app was closed happens on the next open.
 *   4. Send later from the desktop composer's split button: the menu says the app must be
 *      open; the Scheduled mailbox lists it; opening it offers Edit (cancels, back in the
 *      composer), Send now and Cancel schedule; a custom time; a scheduled send going out
 *      at its time (fake clock) and late on the next open (said in the pill).
 *   5. On a phone: the reader pill's Snooze, and the compose top bar's Send later.
 *   6. Settings → Compose says the same limitation.
 *   7. Two windows of the app (one browser context, so one localStorage): each snoozes a
 *      different conversation, and neither save drops the other's (STRM-290).
 *
 * Own module, so it runs alone too: `WINNOW_SMOKE_ONLY=schedule npm run smoke`, or
 * `node scripts/smoke-schedule.mjs` against a built `dist/` (port 4351 by default).
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROWS = "[data-row-count] [data-row-id]";
const HOUR = 3_600_000;

/**
 * A leap that always clears the "Tomorrow" preset (9:00 tomorrow, `core/mail/when.ts`).
 *
 * From just after midnight, 9:00 tomorrow is up to 33 hours away, so the old 26-hour
 * leap only cleared it when the suite started at 07:00 or later and the waking checks
 * failed on every run in the small hours. 34 hours clears it from any start time.
 */
const PAST_TOMORROW_MORNING = 34 * HOUR;

async function desktopPage(browser, URL, errors, { clock = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  p.on("pageerror", (error) => errors.push(String(error)));
  // `WINNOW_SMOKE_CLOCK_AT=2026-10-22T00:30:00` starts the fake clock at that local time
  // instead of now, to check the waking blocks at any hour without waiting for it.
  const at = process.env.WINNOW_SMOKE_CLOCK_AT;
  if (clock) await p.clock.install(at ? { time: new Date(at) } : undefined);
  await p.goto(URL, { waitUntil: "networkidle" });
  await p.waitForSelector(ROWS, { timeout: 15_000 });
  await p.waitForTimeout(400);
  return { ctx, p };
}

async function phonePage(browser, URL, errors) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.goto(URL, { waitUntil: "networkidle" });
  await p.waitForSelector(ROWS, { timeout: 15_000 });
  await p.waitForTimeout(400);
  return { ctx, p };
}

/** The visible rows' ids and accessible names, top first. */
const rows = (p) =>
  p.$$eval(ROWS, (els) =>
    els.map((el) => ({
      id: el.getAttribute("data-row-id"),
      label: el.querySelector("button[data-message-id]")?.getAttribute("aria-label") ?? "",
      text: el.textContent ?? "",
    })),
  );

/** A row that is one message, not a conversation, so it keeps its id when it comes back. */
async function loneRow(p, skip = []) {
  const list = await rows(p);
  return list.find((row) => !/\d+ messages,/.test(row.label) && !skip.includes(row.id)) ?? null;
}

async function goMailbox(p, id) {
  await p.locator("[data-sidebar-toggle]:visible").first().click();
  await p.waitForTimeout(250);
  const target = id === "inbox" ? '[data-sidebar] [data-nav="inbox"]' : `[data-sidebar] [data-nav-folder="${id}"]`;
  await p.locator(target).first().click();
  await p.waitForTimeout(400);
}

const has = async (p, id) => (await p.locator(`${ROWS}[data-row-id="${id}"]`).count()) > 0;
const pillText = (p) => p.locator("[data-status-pill] [data-pill-text]").first().textContent({ timeout: 3_000 }).catch(() => "");

export async function smokeSchedule({ browser, URL, check, section, errors }) {
  // ── 1. Snooze from every entry point ──────────────────────────────────────
  section("snooze: row menu with Undo, b, the reader's button and its picker, the selection bar");
  {
    const { ctx, p } = await desktopPage(browser, URL, errors);

    // Row menu → Snooze ▸ → Tomorrow, then Undo in the pill.
    const first = await loneRow(p);
    await p.locator(`${ROWS}[data-row-id="${first.id}"] button[data-message-id]`).click({ button: "right" });
    await p.locator('[data-menu="row"] [data-menu-item="snooze"]').click();
    const submenu = p.locator('[data-menu-item="snooze-tomorrow"]');
    await submenu.waitFor({ timeout: 3_000 });
    const custom = await p.locator('[data-menu-item="snooze-custom"]').count();
    check("the row menu's Snooze offers the presets and Pick date & time…", custom === 1);
    await submenu.click();
    await p.waitForTimeout(500);
    check("snoozing from the row menu takes the row out of the Inbox", !(await has(p, first.id)));
    check("the status pill says until when, with Undo", /^Snoozed until /.test(await pillText(p)) && (await p.locator("[data-pill-undo]").count()) === 1);
    await p.locator("[data-pill-undo]").first().click();
    await p.waitForTimeout(500);
    check("Undo puts it back", await has(p, first.id));

    // `b` on an open message → the snooze menu → first choice.
    const second = await loneRow(p);
    await p.locator(`${ROWS}[data-row-id="${second.id}"] button[data-message-id]`).click();
    await p.waitForTimeout(400);
    await p.keyboard.press("b");
    const snoozeMenu = p.locator('[data-menu="snooze"]');
    check("b opens the snooze choices for the open message", await snoozeMenu.isVisible().catch(() => false));
    await p.keyboard.press("Enter");
    await p.waitForTimeout(500);
    check("choosing one snoozes it", !(await has(p, second.id)));

    // The reader's Snooze button → Pick date & time… → the picker.
    const third = await loneRow(p);
    await p.locator(`${ROWS}[data-row-id="${third.id}"] button[data-message-id]`).click();
    await p.waitForTimeout(400);
    await p.locator('[data-reader-action="snooze"]').click();
    await p.locator('[data-menu="snooze"] [data-menu-item="snooze-custom"]').click();
    const picker = p.locator("[data-when-picker]");
    await picker.waitFor({ timeout: 3_000 });
    // A time in the past is refused in place.
    await picker.locator("[data-when-date]").fill("2020-01-01");
    await picker.locator("[data-when-confirm]").click();
    check("the picker refuses a time in the past", /future/.test((await picker.locator("[data-when-summary]").textContent()) ?? ""));
    const later = await p.evaluate(() => {
      const d = new Date(Date.now() + 2 * 86_400_000);
      const pad = (n) => String(n).padStart(2, "0");
      return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: "10:30" };
    });
    await picker.locator("[data-when-date]").fill(later.date);
    await picker.locator("[data-when-time]").fill(later.time);
    await picker.locator("[data-when-confirm]").click();
    await p.waitForTimeout(500);
    check("a picked date and time snoozes it", !(await has(p, third.id)) && (await picker.count()) === 0);

    // The selection bar: select two rows by their avatars, then Snooze.
    const pair = (await rows(p)).slice(0, 2);
    await p.locator(`${ROWS}[data-row-id="${pair[0].id}"] [data-row-control="avatar"]`).click();
    await p.locator('[data-menu="sender"] [data-menu-item="sender-select"]').click();
    await p.locator(`${ROWS}[data-row-id="${pair[1].id}"] [data-row-control="avatar"]`).click();
    await p.locator("[data-selection-snooze]").first().click();
    await p.locator('[data-menu="snooze"] [data-menu-item="snooze-nextWeek"]').click();
    await p.waitForTimeout(600);
    check("the selection bar snoozes the selection", !(await has(p, pair[0].id)) && !(await has(p, pair[1].id)));
    check("as one Undo", /^Snoozed until /.test(await pillText(p)));

    // ── 2. The Snoozed mailbox ──────────────────────────────────────────────
    section("the Snoozed mailbox: wake times, and Unsnooze");
    await goMailbox(p, "snoozed");
    const snoozed = await rows(p);
    check("Snoozed lists every snoozed conversation", snoozed.length === 4, String(snoozed.length));
    check(
      "each with when it comes back",
      snoozed.every((row) => /Snoozed/.test(row.text) && /(Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d)/.test(row.text)),
      snoozed.map((row) => row.text.slice(-40)).join(" | "),
    );
    await p.locator(`${ROWS}[data-row-id="${third.id}"] button[data-message-id]`).click({ button: "right" });
    await p.locator('[data-menu="row"] [data-menu-item="archive"]').click();
    await p.waitForTimeout(500);
    check("Unsnooze takes it out of Snoozed", !(await has(p, third.id)));
    await goMailbox(p, "inbox");
    check("and puts it at the top of the Inbox", (await rows(p))[0]?.id === third.id, JSON.stringify((await rows(p)).slice(0, 2)));
    await ctx.close();
  }

  // ── 3. Waking ─────────────────────────────────────────────────────────────
  section("waking: at the time while open, and on the next open after the time");
  {
    const { ctx, p } = await desktopPage(browser, URL, errors, { clock: true });
    const target = await loneRow(p);
    await p.locator(`${ROWS}[data-row-id="${target.id}"] button[data-message-id]`).click({ button: "right" });
    await p.locator('[data-menu="row"] [data-menu-item="snooze"]').click();
    await p.locator('[data-menu-item="snooze-tomorrow"]').click();
    await p.waitForTimeout(400);
    check("snoozed until tomorrow", !(await has(p, target.id)));
    await p.clock.fastForward(PAST_TOMORROW_MORNING);
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    await p.waitForTimeout(800);
    const top = (await rows(p))[0];
    check("after the time, it is back at the top of the Inbox", top?.id === target.id, JSON.stringify(top));
    check("unread and new", /unread/.test(top?.label ?? "") && /new/.test(top?.label ?? ""), top?.label);
    check("and the pill says it came back", /back in your Inbox/.test(await pillText(p)));
    await ctx.close();
  }
  {
    const { ctx, p } = await desktopPage(browser, URL, errors);
    const target = await loneRow(p);
    await p.locator(`${ROWS}[data-row-id="${target.id}"] button[data-message-id]`).click({ button: "right" });
    await p.locator('[data-menu="row"] [data-menu-item="snooze"]').click();
    await p.locator('[data-menu-item="snooze-nextWeek"]').click();
    await p.waitForTimeout(400);
    // The app closes, and the time passes while it is closed.
    await p.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("winnow.snooze.v1"));
      for (const record of state.snoozed) record.wakeAt = Date.now() - 3 * 3_600_000;
      localStorage.setItem("winnow.snooze.v1", JSON.stringify(state));
    });
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForSelector(ROWS);
    await p.waitForTimeout(800);
    check("a wake due while closed happens on the next open", (await rows(p))[0]?.id === target.id);
    check("and the pill says it was due while Winnow was closed", /while Winnow was closed/.test(await pillText(p)));
    await ctx.close();
  }

  // ── 4. Send later ─────────────────────────────────────────────────────────
  section("send later: the split button, the Scheduled mailbox, Edit, Send now, Cancel, at the time, late");
  {
    const { ctx, p } = await desktopPage(browser, URL, errors, { clock: true });
    const sheet = p.locator('[role="dialog"][aria-label="New message"]');
    const compose = async (subject) => {
      await p.keyboard.press("c");
      await sheet.waitFor({ timeout: 5_000 });
      await sheet.locator('input[aria-label="To"]').fill("ana@example.com,");
      await sheet.locator('input[aria-label="Subject"]').fill(subject);
      await sheet.locator('textarea[aria-label="Message"]').fill(`Body of ${subject}.`);
    };
    const later = async (item) => {
      await sheet.locator("[data-send-later]").click();
      await p.locator(`[data-menu="send-later"] [data-menu-item="${item}"]`).click();
      await p.waitForTimeout(500);
    };

    await compose("Later one");
    await sheet.locator("[data-send-later]").click();
    const note = (await p.locator('[data-menu="send-later"] [data-send-later-note]').textContent()) ?? "";
    check("the Send later menu says Winnow has to be open, and what happens if not", /needs to be open/.test(note) && /next time you open/.test(note), note);
    await p.locator('[data-menu="send-later"] [data-menu-item="later-tomorrow"]').click();
    await p.waitForTimeout(500);
    check("Send later closes the composer", (await sheet.count()) === 0);
    check("and the pill says when", /^Scheduled for /.test(await pillText(p)));

    await goMailbox(p, "scheduled");
    let listed = await rows(p);
    check("the Scheduled mailbox lists it with its time", listed.length === 1 && /Scheduled/.test(listed[0].text) && /Tomorrow/.test(listed[0].text), JSON.stringify(listed));
    await p.locator(`${ROWS} button[data-message-id]`).first().click();
    const opened = p.locator("[data-scheduled-sheet]");
    await opened.waitFor({ timeout: 3_000 });
    check("opening it offers Edit, Send now and Cancel schedule", (await opened.locator("[data-scheduled-edit], [data-scheduled-send], [data-scheduled-cancel]").count()) === 3);
    await opened.locator("[data-scheduled-edit]").click();
    await p.waitForTimeout(500);
    const editing = p.locator('[role="dialog"][aria-label="New message"]');
    check("Edit reopens it in the composer", (await editing.locator('input[aria-label="Subject"]').inputValue().catch(() => "")) === "Later one");
    check("and cancels the schedule", (await p.locator(ROWS).count()) === 0);
    // Send later again, at a custom time, from the reopened draft.
    await editing.locator("[data-send-later]").click();
    await p.locator('[data-menu="send-later"] [data-menu-item="later-custom"]').click();
    const picker = p.locator("[data-when-picker]");
    await picker.waitFor({ timeout: 3_000 });
    check("the custom time picker says the same limitation", /needs to be open/.test((await picker.textContent()) ?? ""));
    await picker.locator("[data-when-time]").fill("23:59");
    const inTwoDays = await p.evaluate(() => {
      const d = new Date(Date.now() + 2 * 86_400_000);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    });
    await picker.locator("[data-when-date]").fill(inTwoDays);
    await picker.locator("[data-when-confirm]").click();
    await p.waitForTimeout(500);
    listed = await rows(p);
    check("a custom time schedules it again", listed.length === 1);

    // Send now.
    await p.locator(`${ROWS} button[data-message-id]`).first().click();
    await opened.waitFor({ timeout: 3_000 });
    await opened.locator("[data-scheduled-send]").click();
    await p.waitForTimeout(800);
    check("Send now sends it (the demo files it in Sent)", (await p.locator(ROWS).count()) === 0 && /as scheduled|Sent/.test(await pillText(p)));
    await goMailbox(p, "sent");
    check("it is in Sent", (await rows(p)).some((row) => /Later one/.test(row.label)));

    // Cancel schedule from the row menu: the message stays, in Drafts.
    await goMailbox(p, "inbox");
    await compose("Never mind");
    await later("later-nextWeek");
    await goMailbox(p, "scheduled");
    await p.locator(`${ROWS} button[data-message-id]`).first().click({ button: "right" });
    await p.locator('[data-menu="row"] [data-menu-item="scheduled-cancel"]').click();
    await p.waitForTimeout(400);
    check("Cancel schedule empties Scheduled", (await p.locator(ROWS).count()) === 0);
    await goMailbox(p, "drafts");
    check("and the message is in Drafts", (await rows(p)).some((row) => /Never mind/.test(row.label)));

    // At its time, while open.
    await goMailbox(p, "inbox");
    await compose("On the dot");
    await later("later-tomorrow");
    await p.clock.fastForward(PAST_TOMORROW_MORNING);
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    await p.waitForTimeout(1000);
    await goMailbox(p, "scheduled");
    check("at its time it goes by itself", (await p.locator(ROWS).count()) === 0);
    await goMailbox(p, "sent");
    check("into Sent", (await rows(p)).some((row) => /On the dot/.test(row.label)));
    await ctx.close();
  }
  {
    const { ctx, p } = await desktopPage(browser, URL, errors);
    const sheet = p.locator('[role="dialog"][aria-label="New message"]');
    await p.keyboard.press("c");
    await sheet.waitFor({ timeout: 5_000 });
    await sheet.locator('input[aria-label="To"]').fill("ana@example.com,");
    await sheet.locator('input[aria-label="Subject"]').fill("While away");
    await sheet.locator('textarea[aria-label="Message"]').fill("Hello.");
    await sheet.locator("[data-send-later]").click();
    await p.locator('[data-menu="send-later"] [data-menu-item="later-tomorrow"]').click();
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("winnow.scheduledSend.v1"));
      for (const send of state.sends) send.sendAt = Date.now() - 5 * 3_600_000;
      localStorage.setItem("winnow.scheduledSend.v1", JSON.stringify(state));
    });
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForSelector(ROWS);
    await p.waitForTimeout(1200);
    check("a send due while closed goes on the next open, and the pill says it went late", /late/.test(await pillText(p)), await pillText(p));
    await goMailbox(p, "sent");
    check("it is in Sent", (await rows(p)).some((row) => /While away/.test(row.label)));
    await ctx.close();
  }

  // ── 5. On a phone ────────────────────────────────────────────────────────
  section("phone: the reader pill's Snooze, and Send later from the compose top bar");
  {
    const { ctx, p } = await phonePage(browser, URL, errors);
    const target = await loneRow(p);
    await p.locator(`${ROWS}[data-row-id="${target.id}"] button[data-message-id]`).tap();
    await p.waitForTimeout(600);
    const pillSnooze = p.locator("[data-reader-pill-snooze]");
    check("the reader pill has Snooze", await pillSnooze.isVisible().catch(() => false));
    await pillSnooze.tap();
    await p.locator('[data-menu="snooze"] [data-menu-item="snooze-tomorrow"]').tap();
    await p.waitForTimeout(700);
    if ((await p.locator("[data-reader-pill]").count()) > 0) await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    check("snoozing from the pill takes it out of the Inbox", !(await has(p, target.id)));

    await p.locator("[data-compose-fab]").tap();
    const sheet = p.locator('[role="dialog"][aria-label="New message"]');
    await sheet.waitFor({ timeout: 5_000 });
    await sheet.locator('input[aria-label="To"]').fill("ana@example.com,");
    await sheet.locator('input[aria-label="Subject"]').fill("From the phone");
    await sheet.locator('textarea[aria-label="Message"]').fill("Hi.");
    await sheet.locator("[data-composer-send-later]").tap();
    const menu = p.locator('[data-menu="send-later"]');
    check("the compose top bar's Send later opens the menu, with the note", /needs to be open/.test((await menu.textContent().catch(() => "")) ?? ""));
    await menu.locator('[data-menu-item="later-tomorrow"]').tap();
    await p.waitForTimeout(600);
    check("and schedules it", (await sheet.count()) === 0 && /^Scheduled for /.test(await pillText(p)));
    await ctx.close();
  }

  // ── 6. Settings ──────────────────────────────────────────────────────────
  section("Settings → Compose explains the limitation");
  {
    const { ctx, p } = await desktopPage(browser, URL, errors);
    await p.keyboard.press(",");
    const dialog = p.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.locator('[role="tab"][data-category="compose"]').click();
    await p.waitForTimeout(200);
    const row = dialog.locator("[data-setting='sendLater']");
    check("the Compose page has Send later and snooze", (await row.count()) === 1 && /scheduled/.test((await row.textContent()) ?? ""));
    await row.hover();
    await p.waitForTimeout(300);
    const text = (await dialog.textContent()) ?? "";
    check("whose help says Winnow has to be open, and that a late one is said", /has to be open/.test(text) && /went late/.test(text));
    await ctx.close();
  }

  // ── 7. Two windows ───────────────────────────────────────────────────────
  section("two windows: neither overwrites the other's snoozes (STRM-290)");
  {
    const { ctx, p: a } = await desktopPage(browser, URL, errors);
    const b = await ctx.newPage();
    b.on("pageerror", (error) => errors.push(String(error)));
    await b.goto(URL, { waitUntil: "networkidle" });
    await b.waitForSelector(ROWS, { timeout: 15_000 });
    await b.waitForTimeout(400);
    const snoozeRow = async (p, id) => {
      await p.locator(`${ROWS}[data-row-id="${id}"] button[data-message-id]`).click({ button: "right" });
      await p.locator('[data-menu="row"] [data-menu-item="snooze"]').click();
      await p.locator('[data-menu-item="snooze-nextWeek"]').click();
      await p.waitForTimeout(500);
    };
    const inA = await loneRow(a);
    await snoozeRow(a, inA.id);
    const inB = await loneRow(b, [inA.id]);
    await snoozeRow(b, inB.id);
    const keys = await a.evaluate(() => {
      const raw = localStorage.getItem("winnow.snooze.v1");
      return raw ? JSON.parse(raw).snoozed.flatMap((record) => record.gmailIds) : [];
    });
    check("storage keeps both windows' snoozes", keys.length === 2, JSON.stringify(keys));
    await goMailbox(a, "snoozed");
    const listed = (await rows(a)).map((row) => row.id);
    check(
      "the first window lists the other window's snooze too",
      listed.includes(inA.id) && listed.includes(inB.id),
      JSON.stringify({ listed, inA: inA.id, inB: inB.id }),
    );
    await ctx.close();
  }
}

// ── Standalone ────────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { chromium } = await import("playwright");
  const { preview } = await import("vite");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (!existsSync(path.join(root, "dist", "index.html"))) {
    console.error("No dist/: run `npm run build` first.");
    process.exit(1);
  }
  const port = Number(process.env.WINNOW_PORT ?? 4351);
  const server = await preview({ root, logLevel: "warn", preview: { port, strictPort: true, open: false } });
  const browser = await chromium.launch(
    process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM, args: ["--no-sandbox"] } : {},
  );
  let passed = 0;
  const failures = [];
  const errors = [];
  const check = (label, ok, detail = "") => {
    const line = `${label}${detail ? ` — ${detail}` : ""}`;
    if (ok) passed += 1;
    else failures.push(line);
    console.log(`${ok ? "  ok  " : " FAIL "} ${line}`);
    return ok;
  };
  const section = (title) => console.log(`\n── ${title}`);
  try {
    await smokeSchedule({ browser, URL: `http://localhost:${port}/`, check, section, errors });
    check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (error) {
    failures.push(`aborted: ${error?.stack ?? error}`);
    console.error(error);
  } finally {
    await browser.close();
    server.httpServer.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const line of failures) console.log(`  · ${line}`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}
