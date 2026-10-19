/**
 * Smoke checks for attachments (and for labels staying gone), against the demo mailbox.
 *
 * Its own module so it can run alone (`node scripts/smoke-attachments.mjs`, which
 * serves `dist/` itself on `WINNOW_PORT`, default 4321) as well as inside `smoke.mjs`,
 * which calls `attachmentsSmoke` with its own browser, URL and reporters.
 *
 *   - No labels: no chips, no Labels section in the sidebar or the phone's dock menu,
 *     no Label as… in the reader, the row menu or the selection bar.
 *   - Attachments: the reader's list (type, name, size), a picture's thumbnail and its
 *     lightbox, Save as a download, Open for a PDF in a new tab; in compose, Attach,
 *     the chips with remove, the 25 MB refusal, a desktop drop, and the device copy
 *     keeping the files.
 *   - Drive links (demo, no network): a file over 25 MB offers "Send as a Drive link",
 *     then the plain-words consent dialog, then a Drive chip and the "File name (size) — link" line; Send warns about an
 *     address Drive can't share with before anything goes; Settings → Privacy shows the
 *     row. Nothing reaches Google.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MB = 1024 * 1024;

export async function attachmentsSmoke({ browser, url, check, section }) {
  // ── No labels ──────────────────────────────────────────────────────────────
  // Labels were removed from the UI (they are for people who stay on Gmail). Nothing may
  // name or offer one: no chips, no sidebar section, no Label as… anywhere.
  section("no labels");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-message-id]", { timeout: 10_000 });
    const labelish = async () =>
      p.locator("[data-label-chip], [data-label-chips], [data-nav-label], [data-reader-toolbar-label], [data-reader-label-as], [data-selection-label]").count();
    check("no label chips on rows", (await labelish()) === 0);
    const travelRow = p.locator("[data-message-id]", { hasText: "Check-in is open" }).first();
    await travelRow.click();
    await p.waitForSelector("[data-reader-subject]");
    await p.locator("[data-reader] [aria-label='More']:visible").first().click();
    const more = p.locator('[role="menu"][aria-label="More actions"]');
    await more.waitFor({ timeout: 5_000 });
    check("the reader has no Label as…", (await labelish()) === 0 && !/label/i.test((await more.textContent()) ?? ""), (await more.textContent()) ?? "");
    await p.keyboard.press("Escape");
    await travelRow.click({ button: "right" });
    const rowMenu = p.locator("[data-menu='row']");
    await rowMenu.waitFor({ timeout: 5_000 });
    check("the row menu has no Label as…", (await rowMenu.locator("[data-menu-item='label-as']").count()) === 0 && !/Label as/.test((await rowMenu.textContent()) ?? ""));
    await p.keyboard.press("Escape");
    await p.locator("[data-sidebar-toggle]:visible").first().click();
    const sidebar = p.locator("[data-sidebar][data-open]");
    await sidebar.waitFor({ timeout: 5_000 });
    check("the sidebar has no Labels section", (await labelish()) === 0 && !/Labels|Travel|Receipts/.test((await sidebar.textContent()) ?? ""), (await sidebar.textContent()) ?? "");
    check("no page errors without labels", errors.length === 0, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  section("no labels on a phone");
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
    check("the dock menu lists no labels", (await panel.locator("[data-nav-label]").count()) === 0 && !/Receipts|Travel/.test((await panel.textContent()) ?? ""));
    check("no page errors in phone menu", errors.length === 0, errors.slice(0, 3).join(" | "));
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

    // A browser with a PDF viewer shows the blob in the new tab; one without (the headless
    // shell CI runs) turns the tab's navigation into a download, closes the tab, and
    // Playwright reports the download on the page that opened it. Either is Open working:
    // the file went to a new tab on its blob URL. Downloads are listened for before the
    // click, and the tab's URL is read once it has navigated, not when it appears.
    const tabDownloads = [];
    const onDownload = (d) => tabDownloads.push(d);
    const onTab = (tab) => tab.on("download", onDownload);
    ctx.on("page", onTab);
    p.on("download", onDownload);
    const popupPromise = ctx.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
    await p.locator('[data-attachment="annual-return-2025.pdf"] [data-attachment-open]').click();
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForURL(/^blob:/, { timeout: 5_000 }).catch(() => undefined);
      for (let i = 0; i < 20 && !(!popup.isClosed() && /^blob:/.test(popup.url())) && tabDownloads.length === 0; i++) {
        await p.waitForTimeout(100);
      }
    }
    ctx.off("page", onTab);
    p.off("download", onDownload);
    const tabUrl = popup && !popup.isClosed() ? popup.url() : "";
    const tabDownload = tabDownloads.find((d) => /^blob:/.test(d.url())) ?? null;
    check(
      "Open puts a PDF in a new tab on its blob URL (the browser's viewer, or its download where there is none)",
      popup !== null && (/^blob:/.test(tabUrl) || tabDownload !== null),
      popup ? JSON.stringify({ tab: tabUrl, download: tabDownload?.url() ?? null }) : "no tab",
    );
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

  // ── Drive links ────────────────────────────────────────────────────────────
  section("drive links");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errors = [];
    const google = [];
    p.on("pageerror", (error) => errors.push(String(error)));
    p.on("request", (request) => {
      if (/googleapis\.com|accounts\.google\.com/.test(request.url())) google.push(request.url());
    });
    await p.goto(url, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-message-id]", { timeout: 10_000 });
    await p.locator("[data-compose]:visible").click();
    const sheet = p.locator('[role="dialog"][aria-label="New message"]');
    await sheet.waitFor({ state: "visible", timeout: 5_000 });
    const to = sheet.locator('input[aria-label="To"]');
    for (const address of ["ada@example.com", "who@example.invalid"]) {
      await to.fill(address);
      await to.press("Enter");
    }
    await sheet.locator('input[aria-label="Subject"]').fill("The film").catch(() => undefined);
    await sheet.locator('textarea[aria-label="Message"]').fill("Here it is.");
    check("no Drive offer before a file is too big", (await sheet.locator("[data-drive-offer]").count()) === 0);
    await sheet.locator("[data-attach-input]").setInputFiles([
      { name: "film.mov", mimeType: "video/quicktime", buffer: Buffer.alloc(26 * MB, 0) },
    ]);
    const offer = sheet.locator("[data-drive-offer]");
    await offer.waitFor({ timeout: 5_000 }).catch(() => undefined);
    check("a file over 25 MB offers Send as a Drive link", (await offer.count()) === 1 && /Send as a Drive link/.test((await offer.textContent()) ?? ""));
    await offer.click().catch(() => undefined);
    // The plain-words dialog comes before anything is asked (the demo then "allows"
    // without Google and makes up the upload).
    const consent = p.locator("[data-drive-consent]");
    await consent.waitFor({ timeout: 5_000 }).catch(() => undefined);
    const consentText = (await consent.textContent().catch(() => "")) ?? "";
    check(
      "a plain-words dialog says what Drive access allows and what it doesn't, before asking",
      /Winnow will be able to/.test(consentText) && /Winnow won't be able to/.test(consentText) && /anything else in your Drive/.test(consentText),
      consentText.slice(0, 160),
    );
    await p.locator("[data-drive-consent-continue]").click().catch(() => undefined);
    await sheet.locator('[data-drive-chip="film.mov"]').waitFor({ timeout: 5_000 }).catch(() => undefined);
    check("the upload adds a Drive chip", (await sheet.locator('[data-drive-chip="film.mov"]').count()) === 1);
    const body = await sheet.locator('textarea[aria-label="Message"]').inputValue();
    check(
      'and the line "File name (size) — link" after what was written',
      /^Here it is\.\n\nfilm\.mov \(26 MB\) — https:\/\/drive\.google\.com\/file\/d\/demo-drive-\d+\/view\n?$/.test(body),
      JSON.stringify(body),
    );
    check("the refusal is gone once it went as a link", (await sheet.locator("[data-attach-error]").count()) === 0);

    await sheet.locator("button", { hasText: /^Send/ }).first().click();
    const warning = p.locator('[role="dialog"][aria-label="One recipient can\'t open the Drive link"]');
    await warning.waitFor({ timeout: 5_000 }).catch(() => undefined);
    check(
      "Send warns first about an address Drive can't share with",
      (await warning.count()) === 1 && /who@example\.invalid/.test((await warning.textContent()) ?? ""),
      (await warning.textContent().catch(() => "")) ?? "",
    );
    await warning.locator("button", { hasText: "Keep editing" }).click().catch(() => undefined);
    await p.waitForTimeout(200);
    check("Keep editing goes back to the message, unsent", (await sheet.count()) === 1 && (await warning.count()) === 0);

    await sheet.locator('[data-drive-chip="film.mov"] [data-drive-remove]').click().catch(() => undefined);
    check(
      "removing the Drive chip takes its line out",
      (await sheet.locator("[data-drive-chip]").count()) === 0 &&
        !/drive\.google\.com/.test(await sheet.locator('textarea[aria-label="Message"]').inputValue()),
    );
    check("the demo never reached Google", google.length === 0, google.slice(0, 3).join(" | "));
    check("no page errors in drive links", errors.length === 0, errors.slice(0, 3).join(" | "));
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
    await attachmentsSmoke({ browser, url: `http://localhost:${port}/`, check, section });
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
