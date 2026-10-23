/**
 * Smoke checks for saving mail offline and for mail deleted on the server
 * (`src/core/offline/`), against the real production build and the shared fake Gmail.
 *
 * - The mailbox and every message body land in the account's IndexedDB database
 *   (`winnow-offline@<id>`), not `localStorage`; Settings → Notifications & sync shows
 *   "Saved N of N".
 * - A message never opened online opens with the network gone, its HTML body read
 *   from the offline store; the app also launches offline from it.
 * - A message deleted for good at Gmail (history `messagesDeleted`) leaves the list and
 *   the offline store; one deleted without a history record goes at the daily
 *   reconciliation.
 *
 * Part `offline-save` of `smoke.mjs` (`WINNOW_SMOKE_PARTS=offline-save` runs it alone).
 */
import { signedInContext } from "./fake-gmail.mjs";

const NEWSLETTER = {
  from: "Field Notes <notes@field.example>",
  subject: "Field notes, offline edition",
  html: "<html><body><h1>Offline edition</h1><p >Read without a connection: kestrel.</p></body></html>",
  text: "Field notes offline edition",
};

/** What the page's offline database holds: mailbox ids and saved body ids. */
async function offlineDb(page) {
  return page.evaluate(async () => {
    const dbs = (await indexedDB.databases()).map((d) => d.name).filter((name) => name?.startsWith("winnow-offline@"));
    if (dbs.length !== 1) return { dbs };
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbs[0]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (store, how) =>
      new Promise((resolve) => {
        const request = how(db.transaction(store).objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
    const mailbox = await read("mailbox", (s) => s.get("messages"));
    const bodies = await read("index", (s) => s.getAllKeys());
    db.close();
    const legacy = Object.keys(localStorage).filter((key) => key.startsWith("winnow.gmail.cache.messages"));
    return { dbs, mailbox: mailbox ? JSON.parse(mailbox).map((e) => e.gmailId).sort() : null, bodies: (bodies ?? []).map(String).sort(), legacy };
  });
}

/** The Android app: a stand-in for Tauri's IPC, signed in through its keychain, recording every command. */
function fakeAndroidApp() {
  let nextId = 1;
  window.__smokeCalls = [];
  const secrets = new Map([
    ["google.oauth-client", JSON.stringify({ clientId: "1234567890-abc123def.apps.googleusercontent.com" })],
    ["gmail.tokens", JSON.stringify({ accessToken: "fake-android-access", refreshToken: "1//r", expiresAt: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/gmail.modify" })],
  ]);
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(callback) {
      const id = nextId++;
      window[`_${id}`] = callback;
      return id;
    },
    unregisterCallback(id) {
      delete window[`_${id}`];
    },
    convertFileSrc: (file) => file,
    async invoke(cmd, args) {
      window.__smokeCalls.push({ cmd, args });
      switch (cmd) {
        case "app_info":
          return { name: "Winnow", version: "1.5.5", os: "android", arch: "aarch64", kind: "desktop", nativeOAuth: true, nativeSecrets: true, backgroundSync: false, saveFiles: true };
        case "secrets_get":
          return secrets.get(args.name) ?? null;
        case "secrets_set":
          secrets.set(args.name, args.value);
          return null;
        case "secrets_delete":
          secrets.delete(args.name);
          return null;
        case "google_signin_info":
          return { packageName: "app.winnow.android", sha1: null, playServices: true };
        case "notify_kept_replies":
          return [];
        case "plugin:event|listen":
          return nextId++;
        default:
          return null;
      }
    },
  };
}

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";

export async function smokeOfflineSave({ browser, URL, check, section, errors }) {
  await webChecks({ browser, URL, check, section, errors });
  await androidChecks({ browser, URL, check, section, errors });
}

async function androidChecks({ browser, URL, check, section, errors }) {
  section("save mail offline on the Android app");
  const { ctx, state } = await signedInContext(
    browser,
    { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, userAgent: ANDROID_UA },
    { count: 6, seed: false },
  );
  await ctx.addInitScript(fakeAndroidApp);
  const p = await ctx.newPage();
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.goto(URL, { waitUntil: "networkidle" });
  await p.locator("[data-message-id]", { hasText: "Fake mail 1" }).first().waitFor({ timeout: 15_000 });
  let db = null;
  for (let i = 0; i < 60; i += 1) {
    db = await offlineDb(p);
    if (db.bodies?.length === 6) break;
    await p.waitForTimeout(250);
  }
  check("the Android app saves every body to its offline database too", db?.bodies?.length === 6, JSON.stringify(db));

  state.expunge("f2");
  await p.evaluate(() => (window.__smokeCalls.length = 0));
  // Pull-to-refresh's sync, without the gesture: the store's own refresh via a focus.
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  const withdrawn = await p
    .waitForFunction(() => window.__smokeCalls.find((call) => call.cmd === "notify_withdraw")?.args ?? null, null, { timeout: 10_000 })
    .then((handle) => handle.jsonValue(), () => null);
  const registry = await p.evaluate(() => JSON.parse(localStorage.getItem("winnow.accounts.v1") ?? "{}"));
  check(
    "a message deleted on the server takes its Android notification down (notify_withdraw, its account)",
    Array.isArray(withdrawn?.gmailIds) && withdrawn.gmailIds.includes("f2") && withdrawn.account === registry.active,
    JSON.stringify(withdrawn),
  );
  await ctx.close();
}

async function webChecks({ browser, URL, check, section, errors }) {
  section("save mail offline, and mail deleted on the server");
  const { ctx, state } = await signedInContext(browser, { viewport: { width: 1440, height: 900 } }, { count: 8, html: { f6: NEWSLETTER } });
  const p = await ctx.newPage();
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.goto(URL, { waitUntil: "networkidle" });
  await p.locator("[data-message-id]", { hasText: "Fake mail 1" }).first().waitFor({ timeout: 15_000 });

  // A small mailbox is saved without asking: wait for every body.
  let db = null;
  for (let i = 0; i < 60; i += 1) {
    db = await offlineDb(p);
    if (db.bodies?.length === 8) break;
    await p.waitForTimeout(250);
  }
  check(
    "the mailbox and all 8 bodies are in the account's IndexedDB database, none of it in localStorage",
    db?.dbs?.length === 1 && db.mailbox?.length === 8 && db.bodies?.length === 8 && db.legacy?.length === 0,
    JSON.stringify(db),
  );
  check("the newest message was downloaded first", state.fullReads[0] === "f0", state.fullReads.join(","));

  await p.keyboard.press(",");
  const dialog = p.locator('[role="dialog"][aria-label="Settings"]');
  await dialog.waitFor({ timeout: 5_000 });
  await dialog.locator('[role="tab"][data-category="sync"]').click();
  const row = dialog.locator("[data-offline-mail]");
  await row.waitFor({ timeout: 5_000 }).catch(() => undefined);
  const settings = {
    saved: await row.getAttribute("data-offline-saved").catch(() => null),
    total: await row.getAttribute("data-offline-total").catch(() => null),
    hint: (await dialog.locator("#winnow-offline-mail-hint").textContent().catch(() => "")) ?? "",
    remove: await dialog.locator("[data-offline-remove]").count(),
  };
  check(
    "Settings → Notifications & sync: Save mail offline is on, “Saved 8 of 8 · … · up to date”, with Remove downloads",
    settings.saved === "8" && settings.total === "8" && /^Saved 8 of 8 · \d+ KB · up to date$/.test(settings.hint) && settings.remove === 1,
    JSON.stringify(settings),
  );
  await p.keyboard.press("Escape");

  // Offline: a message never opened online still opens, HTML and all.
  state.down = true;
  await ctx.setOffline(true);
  await p.locator("[data-message-id]", { hasText: NEWSLETTER.subject }).first().click();
  const proof = await p
    .waitForFunction(
      () => [...document.querySelectorAll("[data-reader], article, iframe")].some((el) =>
        (el.textContent ?? "").includes("kestrel") || (el instanceof HTMLIFrameElement && (el.contentDocument?.body?.textContent ?? "").includes("kestrel"))),
      null,
      { timeout: 5_000 },
    )
    .then(() => true, () => false);
  check("with the network gone, an unopened newsletter opens with its formatted body from the offline store", proof);
  await p.keyboard.press("Escape");

  // A cold launch with Google unreachable opens the saved mailbox. (The page itself is
  // served locally, so only Google is cut off for the reload.)
  await ctx.setOffline(false);
  await p.reload({ waitUntil: "domcontentloaded" });
  const launched = await p
    .locator("[data-message-id]", { hasText: "Fake mail 3" })
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true, () => false);
  check("a launch with Google unreachable shows the saved mailbox", launched);
  state.down = false;

  // Deleted forever at Gmail, reported by history: gone from the list and from disk.
  state.expunge("f3");
  await p.locator("[data-sync-button]").first().click();
  const gone = await p
    .waitForFunction(() => ![...document.querySelectorAll("[data-message-id]")].some((el) => el.textContent?.includes("Fake mail 3")), null, { timeout: 10_000 })
    .then(() => true, () => false);
  await p.waitForTimeout(400);
  db = await offlineDb(p);
  check(
    "a message deleted on the server leaves the list, the saved mailbox and the downloaded bodies",
    gone && !db.mailbox?.includes("f3") && !db.bodies?.includes("f3") && db.bodies?.includes("f2"),
    JSON.stringify(db),
  );

  // Deleted with no history record: the daily reconciliation catches it.
  state.expunge("f4", { quiet: true });
  await p.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("winnow.reconcile.v1")) localStorage.setItem(key, "0");
  });
  await p.locator("[data-sync-button]").first().click();
  const reconciled = await p
    .waitForFunction(() => ![...document.querySelectorAll("[data-message-id]")].some((el) => el.textContent?.includes("Fake mail 4")), null, { timeout: 10_000 })
    .then(() => true, () => false);
  await p.waitForTimeout(400);
  db = await offlineDb(p);
  check(
    "one deleted with no history record goes at the daily reconciliation, body included",
    reconciled && !db.mailbox?.includes("f4") && !db.bodies?.includes("f4"),
    JSON.stringify(db),
  );

  // Remove downloads: the bodies go, the list stays, saving turns off.
  await p.keyboard.press(",");
  await dialog.waitFor({ timeout: 5_000 });
  await dialog.locator('[role="tab"][data-category="sync"]').click();
  await dialog.locator("[data-offline-remove]").click();
  await p.waitForTimeout(500);
  db = await offlineDb(p);
  const toggle = await dialog.locator("[data-offline-mail] [role='switch']").getAttribute("aria-checked").catch(() => null);
  check(
    "Remove downloads deletes the saved bodies, keeps the list, and turns Save mail offline off",
    db.bodies?.length === 0 && (db.mailbox?.length ?? 0) === 6 && toggle === "false",
    JSON.stringify({ db, toggle }),
  );
  await ctx.close();
}
