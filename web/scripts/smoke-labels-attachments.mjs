/**
 * Smoke checks for labels and attachments, against the demo mailbox.
 *
 * Its own module so it can run alone (`node scripts/smoke-labels-attachments.mjs`, which
 * serves `dist/` itself on `WINNOW_PORT`, default 4321) as well as inside `smoke.mjs`,
 * which calls `labelsAndAttachments` with its own browser, URL and reporters.
 *
 *   - Labels: chips on rows and in the reader, the reader toolbar's Label button, the
 *     selection bar's Label for several rows, and browsing a label from the desktop
 *     sidebar and from the phone's dock menu.
 *   - Attachments: the reader's list (type, name, size), a picture's thumbnail and its
 *     lightbox, Save as a download, Open for a PDF in a new tab; in compose, Attach,
 *     the chips with remove, the 25 MB refusal, a desktop drop, and the device copy
 *     keeping the files.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MB = 1024 * 1024;

export async function labelsAndAttachments({ browser, url, check, section }) {
  // ── Labels ─────────────────────────────────────────────────────────────────
  section("labels");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-message-id]", { timeout: 10_000 });

    const travelRow = p.locator("[data-message-id]", { hasText: "Check-in is open" }).first();
    check(
      "a labelled row shows its label as a chip",
      (await travelRow.locator('[data-label-chip="Travel"]').count()) === 1,
    );
    check(
      "an unlabelled row shows none",
      (await p.locator("[data-message-id]").filter({ hasNot: p.locator("[data-label-chips]") }).count()) > 0,
    );

    await travelRow.click();
    await p.waitForSelector("article h1", { timeout: 5_000 });
    check("the reader shows the message's labels", (await p.locator('[data-reader] [data-label-chip="Travel"], main [data-label-chip="Travel"]').count()) >= 1);
    const toolbarLabel = p.locator("[data-reader-toolbar-label]:visible");
    check("the reader toolbar has a Label as… button", (await toolbarLabel.count()) === 1);
    await toolbarLabel.click();
    const picker = p.locator('[role="dialog"][aria-label="Label as"]');
    await picker.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    check(
      "which opens the picker for the open message",
      (await picker.count()) === 1 &&
        (await picker.locator("[data-label-option]", { hasText: "Travel" }).getAttribute("aria-checked")) === "true",
    );
    await p.keyboard.press("Escape");
    await p.waitForTimeout(150);

    // Several rows at once, from the selection bar.
    const plain = p.locator("[data-message-id]").filter({ hasNot: p.locator("[data-label-chips]") });
    const first = plain.nth(0);
    const second = plain.nth(1);
    const firstId = await first.getAttribute("data-message-id");
    const secondId = await second.getAttribute("data-message-id");
    await first.click({ modifiers: ["Control"] });
    await p.locator(`[data-message-id="${secondId}"]`).click({ modifiers: ["Control"] });
    await p.waitForTimeout(150);
    const selectionLabel = p.locator("[data-selection-bar='desktop'] [data-selection-label]");
    check("the selection bar offers Label", (await selectionLabel.count()) === 1);
    await selectionLabel.click();
    await picker.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    await picker.locator("[data-label-option]", { hasText: "Family" }).click();
    await picker.locator("[data-label-apply]").click();
    await p.waitForTimeout(250);
    check(
      "and Apply labels every selected row",
      (await p.locator(`[data-message-id="${firstId}"] [data-label-chip="Family"]`).count()) === 1 &&
        (await p.locator(`[data-message-id="${secondId}"] [data-label-chip="Family"]`).count()) === 1,
    );
    await p.keyboard.press("Escape");

    // Browsing a label from the sidebar.
    await p.locator("[data-sidebar-toggle]:visible").first().click();
    const sidebar = p.locator("[data-sidebar][data-open]");
    await sidebar.waitFor({ timeout: 5_000 });
    const navLabels = await sidebar.locator("[data-nav-label]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-nav-label")));
    check(
      "the sidebar has a Labels section with every label",
      JSON.stringify(navLabels) === JSON.stringify(["Family", "Receipts", "Travel", "Work/Northwind"]),
      JSON.stringify(navLabels),
    );
    await sidebar.locator('[data-nav-label="Travel"]').click();
    await p.waitForTimeout(300);
    const listed = await p.locator("[data-message-id]").evaluateAll((nodes) => nodes.length);
    const travelChips = await p.locator("[data-message-id] [data-label-chip='Travel']").count();
    check(
      "choosing one lists that label's mail, without repeating its chip on every row",
      listed >= 1 && (await p.locator("[data-message-id]", { hasText: "Check-in is open" }).count()) === 1 && travelChips === 0,
      `${listed} rows, ${travelChips} Travel chips`,
    );
    const heading = await p.evaluate(() => [...document.querySelectorAll("[title]")].some((n) => n.getAttribute("title") === "Travel" && n.textContent?.trim() === "Travel"));
    check("the list's header names the label", heading);
    await p.locator("[data-sidebar-toggle]:visible").first().click();
    await sidebar.waitFor({ timeout: 5_000 });
    check(
      "and the sidebar marks it as the current page, not Inbox",
      (await sidebar.locator('[data-nav-label="Travel"][aria-current="page"]').count()) === 1 &&
        (await sidebar.locator('[data-nav="inbox"][aria-current="page"]').count()) === 0,
    );
    await sidebar.locator('[data-nav="inbox"]').click();
    await p.waitForTimeout(250);
    check("Inbox leaves the label", (await p.locator("[data-message-id]").count()) > listed);
    check("no page errors in labels", errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  section("labels on a phone");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-message-id]", { timeout: 10_000 });
    await p.locator("[data-dock-expand]").click();
    const panel = p.locator("[data-sidebar][data-open]");
    await panel.waitFor({ timeout: 5_000 });
    const receipts = panel.locator('[data-nav-label="Receipts"]');
    check("the dock menu lists the labels", (await receipts.count()) === 1);
    const height = await receipts.evaluate((node) => node.getBoundingClientRect().height);
    check("at touch size", height >= 44, String(height));
    await receipts.tap();
    await p.waitForTimeout(350);
    check(
      "and a tap browses one",
      (await p.locator("[data-message-id]").count()) >= 1 &&
        (await p.locator("h1").first().textContent())?.includes("Receipts") === true,
      String(await p.locator("h1").first().textContent()),
    );
    check("no page errors in phone labels", errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ── Attachments in the reader ──────────────────────────────────────────────
  section("attachments");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-message-id]", { timeout: 10_000 });
    await p.locator("#winnow-search").fill("annual return");
    await p.waitForTimeout(300);
    await p.locator("[data-message-id]", { hasText: "Confirmation of your annual return" }).first().click();
    await p.waitForSelector("[data-attachments]", { timeout: 5_000 }).catch(() => undefined);

    const rows = await p.locator("[data-attachment]").evaluateAll((nodes) =>
      nodes.map((node) => ({
        name: node.getAttribute("data-attachment"),
        kind: node.getAttribute("data-attachment-kind"),
        text: node.textContent,
        icon: Boolean(node.querySelector("svg")),
      })),
    );
    check(
      "the reader lists each file with its type icon, name and size",
      rows.length === 2 &&
        rows[0].name === "annual-return-2025.pdf" && rows[0].kind === "pdf" && /696 B/.test(rows[0].text) &&
        rows[1].name === "filing-receipt.png" && rows[1].kind === "image" && /221 B/.test(rows[1].text) &&
        rows.every((row) => row.icon),
      JSON.stringify(rows),
    );

    const thumb = p.locator('[data-attachment-thumb="filing-receipt.png"] img');
    await thumb.waitFor({ timeout: 5_000 }).catch(() => undefined);
    const decoded = await thumb.evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
    check("a picture gets a thumbnail", decoded === true);
    await p.locator('[data-attachment-thumb="filing-receipt.png"]').click();
    const lightbox = p.locator("[data-lightbox]");
    await lightbox.waitFor({ timeout: 5_000 }).catch(() => undefined);
    check(
      "which opens the lightbox, focus inside",
      (await p.locator("[data-lightbox-image]").count()) === 1 &&
        (await p.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))),
    );
    // `e` would archive the message behind it; the lightbox keeps it.
    await p.keyboard.press("e");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    check(
      "Escape closes it, and the app's shortcuts did not act behind it",
      (await lightbox.count()) === 0 && (await p.locator("article h1").textContent())?.includes("annual return") === true,
    );

    const downloadPromise = p.waitForEvent("download", { timeout: 5_000 }).catch(() => null);
    await p.locator('[data-attachment="annual-return-2025.pdf"] [data-attachment-save]').click();
    const download = await downloadPromise;
    check(
      "Save downloads the file under its own name",
      download?.suggestedFilename() === "annual-return-2025.pdf",
      String(download?.suggestedFilename()),
    );

    const popupPromise = ctx.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
    const pdfDownload = p.waitForEvent("download", { timeout: 5_000 }).catch(() => null);
    await p.locator('[data-attachment="annual-return-2025.pdf"] [data-attachment-open]').click();
    const popup = await popupPromise;
    check(
      "Open shows a PDF in a new tab (the browser's viewer)",
      popup !== null && /^blob:/.test(popup.url() || (await popup.evaluate(() => location.href).catch(() => ""))),
      popup ? popup.url() : "no tab",
    );
    void pdfDownload;
    check("no page errors in attachments", errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  // ── Attachments in compose ─────────────────────────────────────────────────
  section("compose attachments");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-message-id]", { timeout: 10_000 });
    await p.locator("[data-compose]:visible").click();
    const sheet = p.locator('[role="dialog"][aria-label="New message"]');
    await sheet.waitFor({ state: "visible", timeout: 5_000 });
    check("the composer has an Attach button", (await sheet.locator("[data-attach]").count()) === 1);

    await sheet.locator("[data-attach-input]").setInputFiles([
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello from winnow") },
      { name: "photo.png", mimeType: "image/png", buffer: Buffer.alloc(2048, 1) },
    ]);
    await sheet.locator('[data-attachment-chip="photo.png"]').waitFor({ timeout: 5_000 }).catch(() => undefined);
    const chips = await sheet.locator("[data-attachment-chip]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-attachment-chip")));
    check("picked files arrive as chips", JSON.stringify(chips) === JSON.stringify(["notes.txt", "photo.png"]), JSON.stringify(chips));
    check(
      "with a running total against 25 MB",
      /of 25 MB/.test((await sheet.locator("[data-attachment-total]").textContent()) ?? ""),
    );

    await sheet.locator("[data-attach-input]").setInputFiles([
      { name: "huge.mov", mimeType: "video/quicktime", buffer: Buffer.alloc(26 * MB, 0) },
    ]);
    await p.waitForTimeout(300);
    const refusal = (await sheet.locator("[data-attach-error]").textContent().catch(() => "")) ?? "";
    check(
      "a file over Gmail's 25 MB is refused, in place, saying why",
      /huge\.mov .* too big to attach: Gmail allows 25 MB/.test(refusal) &&
        (await sheet.locator('[data-attachment-chip="huge.mov"]').count()) === 0,
      refusal,
    );

    await sheet.locator('[data-attachment-chip="notes.txt"] [data-attachment-remove]').click();
    check("a chip's × removes it", (await sheet.locator('[data-attachment-chip="notes.txt"]').count()) === 0);

    // A desktop drop, with a real DataTransfer.
    await sheet.locator("[data-composer]").evaluate((target) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["dropped"], "dropped.txt", { type: "text/plain" }));
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
    });
    await sheet.locator('[data-attachment-chip="dropped.txt"]').waitFor({ timeout: 5_000 }).catch(() => undefined);
    check("a file dropped on the composer is attached", (await sheet.locator('[data-attachment-chip="dropped.txt"]').count()) === 1);
    check("and the drop hint is gone", (await sheet.locator("[data-drop-hint]").count()) === 0);

    await p.waitForTimeout(400);
    const kept = await p.evaluate(() => localStorage.getItem("winnow.drafts.v1:demo") ?? "");
    let files = [];
    try {
      files = JSON.parse(kept).flatMap((entry) => entry.draft.attachments ?? []);
    } catch {
      files = [];
    }
    check(
      "the autosaved draft keeps its files",
      files.map((file) => file.filename).join("|") === "photo.png|dropped.txt" && files.every((file) => typeof file.data === "string"),
      JSON.stringify(files.map((file) => file.filename)),
    );

    check("no page errors in compose attachments", errors.length === 0, errors.slice(0, 3).join(" | "));
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
  const port = Number(process.env.WINNOW_PORT ?? 4321);
  const server = await preview({ root, logLevel: "warn", preview: { port, strictPort: true, open: false } });
  const browser = await chromium.launch(
    process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM, args: ["--no-sandbox"] } : {},
  );
  let passed = 0;
  const failures = [];
  const check = (label, ok, detail = "") => {
    const line = `${label}${detail ? ` — ${detail}` : ""}`;
    if (ok) passed += 1;
    else failures.push(line);
    console.log(`${ok ? "  ok  " : " FAIL "} ${line}`);
    return ok;
  };
  const section = (title) => console.log(`\n── ${title}`);
  try {
    await labelsAndAttachments({ browser, url: `http://localhost:${port}/`, check, section });
  } catch (error) {
    failures.push(`aborted: ${error?.stack ?? error}`);
    console.error(error);
  } finally {
    await browser.close();
    server.httpServer.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}
