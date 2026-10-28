/**
 * Smoke test for native Android sign-in's setup step and its fallback.
 *
 * Runs the production build twice:
 *
 *   1. As the web build: the setup walkthrough keeps its five steps and never shows
 *      the Android one.
 *   2. As the Android app, with a stand-in for Tauri's IPC (`__TAURI_INTERNALS__`)
 *      that reports `os: "android"`, a package name and a signing certificate, and
 *      records every command. The walkthrough gains the Android step, which shows
 *      both values and the "already in use" way out; its fields are validated; and
 *      Save and connect stores the Web client, asks for native sign-in with it, and —
 *      when the stand-in answers DEVELOPER_ERROR — goes on to the loopback flow.
 *   1b. The update button beside the version shortcut (1.5.5): absent on the web build;
 *      in the Android app Check for updates → Checking… → No updates available → back,
 *      and with a newer release Update, which runs the app's APK updater.
 *   1c. Every tenth load (a reload counts) checks in the background: the newer release
 *      puts the button in Update, nothing installs, and the count starts again.
 *   1d. Dev Options → Send test notification: posts the sample through `notify_messages`
 *      with all three buttons and a reply head, and a press on it (as Rust reports one)
 *      only says it did nothing. Check now answers inline (No updates available, Update
 *      available, Couldn't check) and installs nothing.
 *   4. Settings switches (STRM-426), phone in OLED: at every switch's centre, and 23px
 *      out each way (its 48×48 press box), the switch is what `elementFromPoint` finds;
 *      a tap on a row's name presses its switch and a tap on (?) does not; Space and
 *      Enter toggle; the off knob is not black on black. The Android app offers
 *      "Keep syncing while closed" (STRM-427) with no interval: it is on by default and
 *      the background service is told to run for the stored account
 *      (`background_service_configure`); the battery Allow row asks Android and goes
 *      once restrictions are off; Hide it opens the sync notification's settings; and a
 *      tap on the name turns it off (the service's rows go) and on again. The desktop app's switch turns off and back on.
 *
 * Separate from `smoke.mjs` so it can run alone (`node scripts/smoke-android.mjs`);
 * `npm run smoke` runs both. Same environment: WINNOW_PORT, WINNOW_CHROMIUM.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WINNOW_PORT ?? 4174);
const URL = `http://localhost:${PORT}/`;

const PACKAGE = "app.winnow.android";
const SHA1 = "A9:99:3E:36:47:06:81:6A:BA:3E:25:71:78:50:C2:6C:9C:D0:D8:9D";
const DESKTOP_ID = "111111-desktop.apps.googleusercontent.com";
const WEB_ID = "222222-web.apps.googleusercontent.com";
// Split so no scanner takes the fixture for a leaked secret.
const WEB_SECRET = "GOCSPX" + "-smoke-android-secret";

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

/**
 * The stand-in for Tauri's IPC, installed before the app's own scripts. Answers what
 * the Android app would for a phone with no client stored yet, records every command
 * in `window.__smokeCalls`, and answers native sign-in with DEVELOPER_ERROR — Google
 * refusing an unregistered package and certificate — so the fallback runs.
 */
function fakeAndroid({ packageName, sha1 }) {
  const calls = [];
  const secrets = new Map();
  let nextId = 1;
  window.__smokeCalls = calls;
  const service = { enabled: false, running: false, batteryUnrestricted: false, notificationsAllowed: true };
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
      calls.push({ cmd, args: args ?? null });
      switch (cmd) {
        case "app_info":
          return {
            name: "Winnow",
            version: "0.0.0",
            os: "android",
            arch: "aarch64",
            kind: "desktop",
            nativeOAuth: true,
            nativeSecrets: true,
            backgroundSync: true,
            saveFiles: true,
          };
        case "secrets_get":
          return secrets.get(args.name) ?? null;
        case "secrets_set":
          secrets.set(args.name, args.value);
          return null;
        case "secrets_delete":
          secrets.delete(args.name);
          return null;
        case "google_signin_info":
          return { packageName, sha1, playServices: true };
        case "google_signin_authorize":
          return { kind: "unavailable", reason: "developer_error", detail: "status 10" };
        case "update_runtime":
          return { channel: "android", version: "1.5.4", arch: "aarch64" };
        case "update_install_apk":
          return { kind: "opened" };
        case "request_notification_permission":
          return true;
        case "oauth_begin":
          // Stop the loopback flow where it starts: reaching it is the point.
          throw new Error("smoke: no loopback listener");
        // The background service (MailSyncService.kt), as the Kotlin plugin answers:
        // on exactly when the config says so; battery restricted until allowed.
        case "background_service_configure":
          service.enabled = args?.config?.enabled === true;
          service.running = service.enabled;
          return { ...service };
        case "background_service_status":
          return { ...service };
        case "background_service_battery":
          service.batteryUnrestricted = true;
          return { ...service };
        case "background_service_notification_settings":
          return null;
        case "plugin:event|listen":
          return nextId++;
        default:
          return null;
      }
    },
  };
}

async function ensureBuilt() {
  if (existsSync(path.join(ROOT, "dist", "index.html"))) return;
  await build({ root: ROOT, logLevel: "warn" });
}

await ensureBuilt();
const server = await preview({ root: ROOT, logLevel: "warn", preview: { port: PORT, strictPort: true, open: false } });
console.log(`· vite preview on ${URL}`);
const browser = await chromium.launch(
  process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM } : {},
);

const setupOf = (page) => page.locator('[role="dialog"][aria-label="Google account"]');
const stepIds = (setup) => setup.locator("[data-setup-step-button]").evaluateAll((els) => els.map((el) => el.getAttribute("data-setup-step-button")));

async function openSetup(page) {
  await page.goto(URL);
  await page.locator('button:has-text("Connect Gmail")').first().click();
  const setup = setupOf(page);
  await setup.waitFor({ timeout: 10_000 });
  return setup;
}

try {
  // ── 1. The web build ────────────────────────────────────────────────────────
  console.log("\n── web build ──");
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    const setup = await openSetup(page);
    const ids = await stepIds(setup);
    check("the web walkthrough keeps its five steps", ids.join(",") === "project,apis,consent,client,paste", ids.join(","));
    check("and has no Android step", (await page.locator("[data-android-step]").count()) === 0);
    // The version shortcut has no update button here: the web build has no updater.
    await page.locator("button:has-text('Close'), [aria-label='Close']").first().click().catch(() => undefined);
    await page.keyboard.press("Escape");
    await page.locator("[data-masthead-bar] button[data-version-toggle]").click();
    await page.waitForTimeout(300);
    check(
      "web build: the version shows, with no update button beside it",
      (await page.locator("[data-version-text]").textContent())?.startsWith("Winnow") && (await page.locator("[data-update-shortcut]").count()) === 0,
    );
    check(
      "web build: loads are not counted for the every-tenth-load check",
      (await page.evaluate(() => localStorage.getItem("winnow.updates.loads.v1"))) === null,
    );
    await context.close();
  }

  // ── 1b. The update button beside the version, in the Android app ────────────
  console.log("\n── android app: the update button ──");
  {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(fakeAndroid, { packageName: PACKAGE, sha1: SHA1 });
    const cors = { "access-control-allow-origin": "*" };
    let latest = "v1.5.4";
    await context.route("https://api.github.com/repos/hxmbl/winnow/releases/latest", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const version = latest.slice(1);
      await route.fulfill({
        headers: cors,
        json: {
          tag_name: latest,
          name: latest,
          draft: false,
          prerelease: false,
          html_url: `https://github.com/hxmbl/winnow/releases/tag/${latest}`,
          assets: [
            {
              name: `Winnow_${version}_android-universal.apk`,
              browser_download_url: `https://github.com/hxmbl/winnow/releases/download/${latest}/Winnow_${version}_android-universal.apk`,
              size: 1,
            },
          ],
        },
      });
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-row-count] [data-row-id]", { timeout: 15_000 });
    const button = page.locator("[data-phone-topbar] [data-update-shortcut]");
    check("hidden until the version shortcut is open", (await button.count()) === 0);
    await page.locator("[data-phone-topbar] button[data-version-toggle]").tap();
    await button.waitFor({ timeout: 5_000 });
    const label = async () => ((await button.textContent()) ?? "").trim();
    check("beside the version: Check for updates", (await label()) === "Check for updates", await label());
    const bar = await page.locator("[data-phone-topbar]").boundingBox();
    const box = await button.boundingBox();
    check("inside the top bar, on screen", Boolean(bar && box) && box.x + box.width <= 412 && box.y >= bar.y && box.y + box.height <= bar.y + bar.height, JSON.stringify({ bar, box }));
    await button.tap();
    await page.waitForTimeout(150);
    check("while it checks: Checking…", (await label()) === "Checking…", await label());
    await page.waitForFunction(() => document.querySelector("[data-update-shortcut]")?.textContent?.trim() === "No updates available", null, { timeout: 5_000 }).catch(() => undefined);
    check("nothing newer: No updates available", (await label()) === "No updates available", await label());
    await page.waitForFunction(() => document.querySelector("[data-update-shortcut]")?.textContent?.trim() === "Check for updates", null, { timeout: 6_000 }).catch(() => undefined);
    check("then back to Check for updates after a few seconds", (await label()) === "Check for updates", await label());

    latest = "v99.0.0";
    await button.tap();
    await page.waitForFunction(() => document.querySelector("[data-update-shortcut]")?.textContent?.trim() === "Update", null, { timeout: 5_000 }).catch(() => undefined);
    check("a newer release: Update", (await label()) === "Update", await label());
    await button.tap();
    await page.waitForFunction(() => window.__smokeCalls.some((call) => call.cmd === "update_install_apk"), null, { timeout: 5_000 }).catch(() => undefined);
    const install = (await page.evaluate(() => window.__smokeCalls)).find((call) => call.cmd === "update_install_apk");
    check(
      "Update runs the app's APK updater with the release's universal APK",
      install?.args?.name === "Winnow_99.0.0_android-universal.apk" && /releases\/download\/v99\.0\.0\//.test(install?.args?.url ?? ""),
      JSON.stringify(install),
    );
    check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    await context.close();
  }

  // ── 1c. Every tenth load checks for updates by itself ───────────────────────
  console.log("\n── android app: the every-tenth-load check ──");
  {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(fakeAndroid, { packageName: PACKAGE, sha1: SHA1 });
    // Opt in (automation never checks by itself), and start eight loads in.
    await context.addInitScript(() => {
      window.__WINNOW_LOAD_CHECK__ = true;
      if (localStorage.getItem("winnow.updates.loads.v1") === null) localStorage.setItem("winnow.updates.loads.v1", "8");
    });
    const cors = { "access-control-allow-origin": "*" };
    let asked = 0;
    await context.route("https://api.github.com/repos/hxmbl/winnow/releases/latest", async (route) => {
      asked += 1;
      await route.fulfill({
        headers: cors,
        json: {
          tag_name: "v99.0.0",
          name: "v99.0.0",
          draft: false,
          prerelease: false,
          html_url: "https://github.com/hxmbl/winnow/releases/tag/v99.0.0",
          assets: [
            {
              name: "Winnow_99.0.0_android-universal.apk",
              browser_download_url: "https://github.com/hxmbl/winnow/releases/download/v99.0.0/Winnow_99.0.0_android-universal.apk",
              size: 1,
            },
          ],
        },
      });
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const loads = () => page.evaluate(() => localStorage.getItem("winnow.updates.loads.v1"));
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-row-count] [data-row-id]", { timeout: 15_000 });
    await page.waitForFunction(() => localStorage.getItem("winnow.updates.loads.v1") === "9", null, { timeout: 5_000 }).catch(() => undefined);
    check("the 9th load is counted and does not check", (await loads()) === "9" && asked === 0, `loads=${await loads()} asked=${asked}`);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("[data-row-count] [data-row-id]", { timeout: 15_000 });
    await page.waitForFunction(() => localStorage.getItem("winnow.updates.loads.v1") === "0", null, { timeout: 5_000 }).catch(() => undefined);
    check("the 10th load (a reload) checks once in the background and resets the count", asked === 1 && (await loads()) === "0", `loads=${await loads()} asked=${asked}`);
    await page.locator("[data-phone-topbar] button[data-version-toggle]").tap();
    const button = page.locator("[data-phone-topbar] [data-update-shortcut]");
    await button.waitFor({ timeout: 5_000 });
    check("the newer release puts the version shortcut's button in Update", ((await button.textContent()) ?? "").trim() === "Update", (await button.textContent()) ?? "");
    const calls = await page.evaluate(() => window.__smokeCalls.map((call) => call.cmd));
    check("nothing installs by itself", !calls.includes("update_install_apk"));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("[data-row-count] [data-row-id]", { timeout: 15_000 });
    await page.waitForFunction(() => localStorage.getItem("winnow.updates.loads.v1") === "1", null, { timeout: 5_000 }).catch(() => undefined);
    check("the next load counts from 1 again, without a check", (await loads()) === "1" && asked === 1, `loads=${await loads()} asked=${asked}`);
    check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    await context.close();
  }

  // ── 1d. Dev Options in the Android app ──────────────────────────────────────
  console.log("\n── android app: dev options ──");
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addInitScript(fakeAndroid, { packageName: PACKAGE, sha1: SHA1 });
    let release = { status: 200, tag: "v1.5.4" };
    await context.route("https://api.github.com/repos/hxmbl/winnow/releases/latest", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (release.status !== 200) return route.fulfill({ status: release.status, headers: { "access-control-allow-origin": "*" }, json: {} });
      const version = release.tag.slice(1);
      await route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        json: {
          tag_name: release.tag,
          name: release.tag,
          draft: false,
          prerelease: false,
          html_url: `https://github.com/hxmbl/winnow/releases/tag/${release.tag}`,
          assets: [
            {
              name: `Winnow_${version}_android-universal.apk`,
              browser_download_url: `https://github.com/hxmbl/winnow/releases/download/${release.tag}/Winnow_${version}_android-universal.apk`,
              size: 1,
            },
          ],
        },
      });
    });
    await context.addInitScript(() => {
      if (localStorage.getItem("winnow.devOptions.v1") === null) localStorage.setItem("winnow.devOptions.v1", JSON.stringify({ version: 1, unlocked: true }));
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-row-count] [data-row-id]", { timeout: 15_000 });
    await page.keyboard.press(",");
    const dialog = page.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.locator('[role="tab"][data-category="dev"]').click();
    const send = dialog.locator("[data-dev-test-notification]");
    await send.waitFor({ timeout: 5_000 });
    check("Dev Options offers Send test notification in the app", (await send.count()) === 1);
    await send.click();
    await page.waitForSelector('[data-dev-test-notification="sent"]', { timeout: 5_000 }).catch(() => undefined);
    const posted = await page.evaluate(() => window.__smokeCalls.filter((call) => call.cmd === "notify_messages").map((call) => call.args.batch));
    const message = posted[0]?.messages?.[0];
    check(
      "it posts one sample through notify_messages, with Delete, Mark read and Reply",
      posted.length === 1 &&
        posted[0].messages.length === 1 &&
        message.gmailId === "winnowtestnotification" &&
        message.title === "Winnow" &&
        typeof message.replyHead === "string" &&
        posted[0].actions.reply && posted[0].actions.trash && posted[0].actions.read &&
        posted[0].hidePreview === false,
      JSON.stringify(posted).slice(0, 300),
    );
    check(
      "and says it was sent",
      (await send.getAttribute("data-dev-test-notification")) === "sent" &&
        ((await dialog.locator("#winnow-test-notification-hint").textContent()) ?? "").startsWith("Sent."),
    );
    // A press, as Rust reports one it answered without touching Gmail.
    const pressed = await page.evaluate((messageId) => {
      const listen = window.__smokeCalls.find((call) => call.cmd === "plugin:event|listen" && call.args?.event === "winnow://notification-action");
      if (!listen) return false;
      window[`_${listen.args.handler}`]({
        event: "winnow://notification-action",
        id: 1,
        payload: { action: "trash", messageId, gmailId: "winnowtestnotification", origin: "android", outcome: "done" },
      });
      return true;
    }, message?.messageId ?? 1);
    await page.waitForTimeout(300);
    const said = await page.evaluate(() => document.body.innerText.includes("Test notification: Delete did nothing. It isn't a real message."));
    check("a press on it touches nothing and says so", pressed && said, JSON.stringify({ pressed, said }));

    // Check now, inline.
    const checkNow = dialog.locator("[data-dev-check-now]");
    const checkHint = async () => ((await dialog.locator("#winnow-dev-check-now-hint").textContent()) ?? "").trim();
    const checkFor = async (next) => {
      release = next;
      await checkNow.click();
      await page.waitForFunction(
        () => ["offer", "current", "failed"].includes(document.querySelector("[data-dev-check-now]")?.getAttribute("data-dev-check-now") ?? ""),
        null,
        { timeout: 5_000 },
      ).catch(() => undefined);
      await page.waitForTimeout(100);
      return { state: await checkNow.getAttribute("data-dev-check-now"), hint: await checkHint() };
    };
    check("Dev Options offers Check now, quiet until pressed", (await checkNow.getAttribute("data-dev-check-now")) === "idle");
    const current = await checkFor({ status: 200, tag: "v1.5.4" });
    check("Check now: No updates available", current.state === "current" && current.hint === "No updates available", JSON.stringify(current));
    const newer = await checkFor({ status: 200, tag: "v99.0.0" });
    check("Check now: Update available, inline", newer.state === "offer" && newer.hint === "Update available: 99.0.0 (you have 1.5.4)", JSON.stringify(newer));
    const down = await checkFor({ status: 503, tag: "v99.0.0" });
    check("Check now: Couldn't check", down.state === "failed" && down.hint.startsWith("Couldn't check"), JSON.stringify(down));
    const installed = await page.evaluate(() => window.__smokeCalls.some((call) => call.cmd === "update_install_apk"));
    check("and nothing installs", !installed);
    check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    await context.close();
  }

  // ── 2. The Android app ──────────────────────────────────────────────────────
  console.log("\n── android app ──");
  {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
      hasTouch: true,
      isMobile: true,
    });
    await context.addInitScript(fakeAndroid, { packageName: PACKAGE, sha1: SHA1 });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    const setup = await openSetup(page);
    // The signing info arrives asynchronously at boot; give it a beat to land.
    await page.waitForFunction(() => document.querySelectorAll("[data-setup-step-button]").length === 6, null, { timeout: 5_000 }).catch(() => {});
    const ids = await stepIds(setup);
    check(
      "the Android walkthrough adds its step just before the paste step",
      ids.join(",") === "project,apis,consent,client,android,paste",
      ids.join(","),
    );

    await setup.locator('[data-setup-step-button="android"]').click();
    const step = setup.locator("[data-android-step]");
    check("the Android step opens", (await step.count()) === 1);
    check("it shows the package name read from the app", (await step.locator('[data-copy-value="package"]').textContent()) === PACKAGE);
    check("and the running APK's SHA-1", (await step.locator('[data-copy-value="sha1"]').textContent()) === SHA1);
    check(
      "it explains the already-in-use refusal and the self-build way out",
      ((await step.locator("[data-android-in-use]").textContent()) ?? "").includes("one Cloud project") &&
        (await step.locator('[data-console-link="self-build"]').count()) === 1,
    );
    check("Play services is present, so no warning", (await step.locator("[data-android-no-play]").count()) === 0);

    // Validation: a malformed id shows its error once the field is left.
    const nativeId = step.locator('input[name="nativeClientId"]');
    const nativeSecret = step.locator('input[name="nativeClientSecret"]');
    await nativeId.fill("not-a-client-id");
    await nativeSecret.click();
    check("a malformed Web client ID is flagged on blur", (await nativeId.getAttribute("aria-invalid")) === "true");

    await nativeId.fill(WEB_ID);
    await nativeSecret.fill(WEB_SECRET);
    await nativeId.click();
    check("a well-formed Web client clears the error", (await nativeId.getAttribute("aria-invalid")) === null);

    // The step sits in the resumable guide's progress like the other five.
    check(
      "the progress line counts six steps",
      ((await setup.locator("[data-setup-progress]").textContent()) ?? "").includes("Step 5 of 6") &&
        ((await setup.locator("[data-setup-done]").textContent()) ?? "").includes("of 6 done"),
      `${await setup.locator("[data-setup-progress]").textContent()} ${await setup.locator("[data-setup-done]").textContent()}`,
    );
    await setup.locator("[data-setup-next]").click();
    const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem("winnow.google.setupProgress") ?? "null"));
    check(
      "Next ticks the Android step, moves to Paste and remembers both (never the secret)",
      (await setup.locator("[data-setup-step]").getAttribute("data-setup-step")) === "paste" &&
        (await setup.locator('[data-setup-step-button="android"]').getAttribute("data-done")) !== null &&
        remembered?.step === 5 && remembered.done.includes("android") && !JSON.stringify(remembered).includes(WEB_SECRET),
      JSON.stringify(remembered),
    );

    // The paste step: the Desktop app client, then Save and connect.
    await setup.locator('[data-setup-step-button="paste"]').click();
    await setup.locator('input[name="clientId"]').fill(DESKTOP_ID);
    await setup.locator('button[type="submit"]').click();
    await page.waitForFunction(
      () => window.__smokeCalls.some((call) => call.cmd === "oauth_begin"),
      null,
      { timeout: 10_000 },
    ).catch(() => {});

    const calls = await page.evaluate(() => window.__smokeCalls);
    const saved = calls.find((call) => call.cmd === "secrets_set" && call.args?.name === "google.oauth-client");
    const stored = saved ? JSON.parse(saved.args.value) : null;
    check(
      "Save stores the Web client beside the Desktop app client",
      stored?.clientId === DESKTOP_ID && stored?.nativeAndroid?.clientId === WEB_ID && stored?.nativeAndroid?.clientSecret === WEB_SECRET,
    );
    const nativeAt = calls.findIndex((call) => call.cmd === "google_signin_authorize");
    const loopbackAt = calls.findIndex((call) => call.cmd === "oauth_begin");
    const nativeArgs = calls[nativeAt]?.args;
    check(
      "sign-in asks for native sign-in first, with the Web client and the Gmail scope",
      nativeAt >= 0 &&
        nativeArgs?.serverClientId === WEB_ID &&
        JSON.stringify(nativeArgs?.scopes) === JSON.stringify(["https://www.googleapis.com/auth/gmail.modify"]),
      JSON.stringify(nativeArgs),
    );
    check("DEVELOPER_ERROR falls back to the loopback flow", loopbackAt > nativeAt && nativeAt >= 0, `native ${nativeAt}, loopback ${loopbackAt}`);
    const begun = calls[loopbackAt]?.args?.authorizeUrl ?? "";
    check("which uses the Desktop app client", begun.includes(`client_id=${encodeURIComponent(DESKTOP_ID)}`));
    check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    await context.close();
  }

  // ── 3. An Android build that cannot read its certificate ────────────────────
  console.log("\n── android app, no certificate ──");
  {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
    await context.addInitScript(fakeAndroid, { packageName: PACKAGE, sha1: null });
    const page = await context.newPage();
    const setup = await openSetup(page);
    await page.waitForFunction(() => document.querySelectorAll("[data-setup-step-button]").length === 6, null, { timeout: 5_000 }).catch(() => {});
    await setup.locator('[data-setup-step-button="android"]').click();
    check("an unreadable certificate says so instead of showing a fingerprint",
      (await setup.locator("[data-android-no-sha1]").count()) === 1 && (await setup.locator('[data-copy-value="sha1"]').count()) === 0);
    await context.close();
  }

  // ── 4. Settings switches: press box, row tap, keyboard, OLED off state ─────
  console.log("\n── settings switches (phone, OLED) ──");
  const oled = () => {
    if (window.top !== window) return;
    const raw = localStorage.getItem("winnow.preferences.v1");
    localStorage.setItem("winnow.preferences.v1", JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), appearance: "oled", notificationsEnabled: true }));
    // One stored account, so the background service has something to sync (its tokens
    // would be in the keychain; the service reads them itself, never the web layer).
    if (!localStorage.getItem("winnow.accounts.v1")) {
      localStorage.setItem("winnow.accounts.v1", JSON.stringify({ version: 1, active: "smoke1234", accounts: [{ id: "smoke1234", email: "smoke@example.com", color: "space", notify: true, addedAt: 1 }] }));
    }
  };
  const openSyncSettings = async (page) => {
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-row-count] [data-row-id]", { timeout: 15_000 });
    await page.locator("[data-phone-dock] button[data-dock-expand]").tap();
    await page.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForTimeout(400);
    await page.locator('[data-sidebar] [data-nav-account] button[aria-label="Settings"]').tap();
    const dialog = page.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(450);
    await dialog.locator('[data-category="sync"]').first().tap();
    await page.waitForTimeout(600);
    return dialog;
  };
  /** For each switch: is it the hit target at its centre and at ±23px each way? */
  const hitReport = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"][aria-label="Settings"] [role="switch"]')].map((sw) => {
        const r = sw.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const at = (x, y) => {
          const hit = document.elementFromPoint(x, y);
          return hit === sw || sw.contains(hit);
        };
        const misses = [[0, 0], [-23, 0], [23, 0], [0, -23], [0, 23]].filter(([dx, dy]) => !at(cx + dx, cy + dy));
        return { label: sw.getAttribute("aria-label"), size: `${Math.round(r.width)}x${Math.round(r.height)}`, centre: at(cx, cy), misses };
      }),
    );
  {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      userAgent: "Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
      hasTouch: true,
      isMobile: true,
      colorScheme: "dark",
    });
    await context.addInitScript(fakeAndroid, { packageName: PACKAGE, sha1: SHA1 });
    await context.addInitScript(oled);
    await context.route(/^https:\/\/(?!(gmail|oauth2|people|www)\.googleapis\.com)/, (route) => route.fulfill({ status: 204, body: "" }));
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    const dialog = await openSyncSettings(page);
    const report = await hitReport(page);
    check("Notifications & sync has switches to press", report.length >= 2, report.map((r) => r.label).join(", "));
    for (const row of report) {
      check(`"${row.label}" is the hit target at its centre`, row.centre);
      check(`"${row.label}" presses through a 48x48 box`, row.misses.length === 0, `drawn ${row.size}, misses at ${JSON.stringify(row.misses)}`);
    }
    // Android has background sync now (STRM-427): the switch is there, shows the
    // preference, and every change is handed to the background service.
    const keep = dialog.locator('[role="switch"][aria-label="Keep syncing while closed"]');
    check(
      "the Android app offers the background-sync switch, with no interval and no note",
      (await keep.count()) === 1 &&
        (await dialog.locator('[data-background-sync="service"]').count()) === 1 &&
        (await dialog.locator("#sync-interval").count()) === 0 &&
        (await dialog.locator("[data-background-sync-note]").count()) === 0,
    );
    const configures = () =>
      page.evaluate(() => window.__smokeCalls.filter((call) => call.cmd === "background_service_configure").map((call) => call.args?.config ?? null));
    const told = await configures();
    check(
      "it is on by default, and the background service is handed a config with the stored account",
      (await keep.getAttribute("aria-checked")) === "true" && told.length >= 1 && told.at(-1)?.accounts?.some((a) => a.id === "smoke1234"),
      JSON.stringify(told.at(-1)),
    );
    // An account is stored (its session is on the device), so the service is told to run
    // even while the demo is on screen: it syncs that account, not the demo. The signed-in
    // case is smoke-accounts.mjs part 5b.
    check("with an account stored, the service is told to run", told.at(-1)?.enabled === true, JSON.stringify(told.at(-1)));
    const allow = dialog.locator("[data-background-battery]");
    check(
      "with battery restrictions on, an Allow row and a Hide it row show",
      (await allow.count()) === 1 && (await dialog.locator("[data-background-hide-notification]").count()) === 1,
    );
    if ((await allow.count()) === 1) {
      await allow.tap();
      await page.waitForTimeout(400);
      check(
        "Allow asks Android, and the row goes once restrictions are off",
        (await page.evaluate(() => window.__smokeCalls.some((call) => call.cmd === "background_service_battery"))) &&
          (await allow.count()) === 0,
      );
    }
    await dialog.locator("[data-background-hide-notification]").tap();
    await page.waitForTimeout(200);
    check(
      "Hide it opens the sync notification's system settings",
      await page.evaluate(() => window.__smokeCalls.some((call) => call.cmd === "background_service_notification_settings")),
    );
    await dialog.locator('[data-setting="backgroundSync"]').getByText("Keep syncing while closed", { exact: true }).tap();
    await page.waitForTimeout(500);
    check(
      "a tap on its name turns it off, and the service's rows go with it",
      (await keep.getAttribute("aria-checked")) === "false" && (await dialog.locator("[data-background-hide-notification]").count()) === 0,
    );
    await keep.tap();
    await page.waitForTimeout(500);
    check("and a tap on the switch turns it back on", (await keep.getAttribute("aria-checked")) === "true");

    const badge = dialog.locator('[role="switch"][aria-label="Unread count on the app icon"]');
    const badgeRow = dialog.locator('[data-setting="unreadBadge"]');
    const before = await badge.getAttribute("aria-checked");
    await badgeRow.getByText("Unread count on the app icon", { exact: true }).tap();
    await page.waitForTimeout(250);
    const afterName = await badge.getAttribute("aria-checked");
    check("a tap on a row's name presses its switch", afterName !== before, `${before} -> ${afterName}`);
    await badgeRow.locator("[data-setting-info]").tap();
    await page.waitForTimeout(250);
    check(
      "a tap on (?) opens its help and leaves the switch alone",
      (await badge.getAttribute("aria-checked")) === afterName && (await page.locator('[data-setting-popover="unreadBadge"]').count()) === 1,
    );
    const info = await badgeRow.locator("[data-setting-info]").boundingBox();
    const infoBox = await badgeRow.locator("[data-setting-info]").evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      const r = el.getBoundingClientRect();
      return { w: r.width - 2 * parseFloat(after.left), h: r.height - 2 * parseFloat(after.top) };
    });
    check("the (?) button presses through at least 44x44", infoBox.w >= 44 && infoBox.h >= 44, `${info?.width}x${info?.height} drawn, ${infoBox.w}x${infoBox.h} box`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    await badge.focus();
    const k0 = await badge.getAttribute("aria-checked");
    await page.keyboard.press("Space");
    await page.waitForTimeout(150);
    const k1 = await badge.getAttribute("aria-checked");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const k2 = await badge.getAttribute("aria-checked");
    check("Space and Enter toggle a focused switch", k1 !== k0 && k2 === k0, `${k0} -> ${k1} -> ${k2}`);

    const off = await dialog.locator('[role="switch"][aria-checked="false"]').first().evaluate((sw) => ({
      track: getComputedStyle(sw).backgroundColor,
      knob: getComputedStyle(sw.querySelector("span")).backgroundColor,
    }));
    check("on OLED an off switch is not black on black", off.knob !== "rgb(0, 0, 0)" && off.track !== "rgb(0, 0, 0)" && off.track !== "rgb(42, 42, 42)", JSON.stringify(off));
    check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    await context.close();
  }

  // The desktop app, where the switch exists: it must turn off and come back on.
  console.log("\n── settings switches (desktop app: keep syncing while closed) ──");
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addInitScript(fakeAndroid, { packageName: PACKAGE, sha1: SHA1 });
    await context.addInitScript(() => {
      const internals = window.__TAURI_INTERNALS__;
      const invoke = internals.invoke.bind(internals);
      internals.invoke = async (cmd, args) =>
        cmd === "app_info" ? { ...(await invoke(cmd, args)), os: "linux", arch: "x86_64", backgroundSync: true } : invoke(cmd, args);
    });
    await context.route(/^https:\/\/(?!(gmail|oauth2|people|www)\.googleapis\.com)/, (route) => route.fulfill({ status: 204, body: "" }));
    const page = await context.newPage();
    await page.goto(URL, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-row-count] [data-row-id]", { timeout: 15_000 });
    await page.keyboard.press(",");
    const dialog = page.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    const tab = dialog.locator('[role="tab"][data-category="sync"]');
    if ((await tab.count()) > 0) await tab.click();
    else await dialog.locator('[data-category="sync"]').first().click();
    await page.waitForTimeout(400);
    const sync = dialog.locator('[role="switch"][aria-label="Keep syncing while closed"]');
    const interval = () => dialog.locator('[data-setting="syncInterval"]').count();
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("winnow.preferences.v1") ?? "{}").backgroundSync);
    const s0 = await sync.getAttribute("aria-checked");
    await sync.click();
    await page.waitForTimeout(250);
    const s1 = await sync.getAttribute("aria-checked");
    const p1 = await stored();
    const i1 = await interval();
    await dialog.locator('[data-setting="backgroundSync"]').getByText("Keep syncing while closed", { exact: true }).click();
    await page.waitForTimeout(250);
    const s2 = await sync.getAttribute("aria-checked");
    const p2 = await stored();
    check(
      "the desktop switch shows the preference: on, off, and on again (from its name)",
      s0 === "true" && s1 === "false" && p1 === false && s2 === "true" && p2 === true,
      `${s0} -> ${s1} (${p1}) -> ${s2} (${p2})`,
    );
    check("its interval shows only while it is on", i1 === 0 && (await interval()) === 1);
    await context.close();
  }
} catch (error) {
  failures.push(`the run threw: ${error instanceof Error ? error.stack : error}`);
  console.log(` FAIL  the run threw: ${error}`);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
