/**
 * Targeted smoke for multi-account (1.4.0), against the production build and a fake
 * Google that knows two accounts (by bearer token):
 *
 *   1. Migration: a 1.3.5 browser (one unscoped session) opens straight into its inbox,
 *      with its data moved into the account's namespace and no sign-in.
 *   2. Add: the switcher's Add account goes to Google's account chooser
 *      (prompt=select_account) and back, and the second account opens; adding the first
 *      again switches to it instead of adding a copy.
 *   3. Switch: one tap in the switcher shows the other account's mail.
 *   4. Reply from the right address: the composer's From starts on the account that
 *      received the message, and the sent message's From is that address.
 *   5. A notification's deep link (the Android app, with a stand-in for Tauri's IPC):
 *      a tap on another account's notification for a message that is not cached yet
 *      switches account, fetches it and opens it in the phone's full-screen reader; Back
 *      returns to that account's inbox; a summary's link opens the inbox; and a cold
 *      start from a tap (`deep_link_launch`) opens the message too.
 *   6. The Accounts page (1.5), on the desktop and a phone: the switcher's Manage
 *      accounts opens it; an account's page sets its colour and notify switch; Escape
 *      steps back; Settings' Accounts row opens it and it links back to Settings →
 *      Google account; Switch opens the other inbox; signing out of one leaves the other.
 *
 *   WINNOW_PORT=4362 WINNOW_CHROMIUM=/usr/bin/chromium node scripts/smoke-accounts.mjs
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WINNOW_PORT ?? 4362);
const URL = `http://localhost:${PORT}/`;
const CLIENT = { clientId: "1234567890-abc123def.apps.googleusercontent.com", clientSecret: "GOCSPX" + "-smoke-accounts" };
const ADA = "ada@one.example";
const BOB = "bob@two.example";

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

/** `core/model/ids.ts`'s `hashId`: a message's numeric id, as a deep link names it. */
function hashId(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return Number(hash >> 11n);
}

/**
 * Two Gmail accounts. Each access token belongs to one; codes from the fake chooser
 * mint a token for whichever address `state.nextSignIn` names.
 */
async function fakeGoogle(ctx) {
  const b64 = (text) => Buffer.from(text, "utf8").toString("base64url");
  const mail = (prefix, owner, n, extra = {}) => ({
    id: `${prefix}${n}`,
    owner,
    subject: `${owner === ADA ? "Ada" : "Bob"} mail ${n}`,
    from: `Sender ${n} <s${n}@fake.example>`,
    labels: ["INBOX", "UNREAD"],
    at: Date.now() - n * 3_600_000,
    ...extra,
  });
  const state = {
    accounts: { [ADA]: [1, 2, 3].map((n) => mail("a", ADA, n)), [BOB]: [1, 2].map((n) => mail("b", BOB, n)) },
    tokens: new Map([["tok-ada", ADA], ["tok-bob", BOB]]),
    nextSignIn: BOB,
    authorizeUrls: [],
    sent: [],
    minted: 0,
  };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  const preflight = (route) =>
    route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" } });
  const owned = (owner) => state.accounts[owner] ?? [];
  const message = (m) => ({
    id: m.id,
    threadId: `t-${m.id}`,
    labelIds: m.labels,
    snippet: m.subject,
    internalDate: String(m.at),
    sizeEstimate: 900,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: m.from },
        { name: "To", value: m.owner },
        { name: "Subject", value: m.subject },
        { name: "Message-ID", value: `<${m.id}@fake.example>` },
        { name: "Date", value: new Date(m.at).toUTCString() },
      ],
      body: { size: 10, data: b64(`Body of ${m.subject}`) },
    },
  });
  await ctx.route("https://gmail.googleapis.com/**", (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return preflight(route);
    const owner = state.tokens.get((request.headers().authorization ?? "").replace(/^Bearer /, ""));
    if (!owner) return json(route, { error: { code: 401, message: "Invalid Credentials" } }, 401);
    const url = new globalThis.URL(request.url());
    const p = url.pathname.replace(/^\/(upload\/)?gmail\/v1\/users\/me/, "");
    if (p === "/profile") return json(route, { emailAddress: owner, historyId: "500", messagesTotal: owned(owner).length });
    if (p === "/history") return json(route, { historyId: "500" });
    if (p === "/messages") {
      const q = url.searchParams.get("q") ?? "";
      let list = [];
      if (q.includes("in:inbox") && !q.includes("-in:inbox")) {
        list = owned(owner).filter((m) => m.labels.includes("INBOX") && (!q.includes("is:unread") || m.labels.includes("UNREAD")));
      }
      return json(route, list.length ? { messages: list.map((m) => ({ id: m.id, threadId: `t-${m.id}` })), resultSizeEstimate: list.length } : { resultSizeEstimate: 0 });
    }
    if (p === "/messages/send" || p === "/drafts/send") {
      const body = JSON.parse(request.postData() ?? "{}");
      const raw = body.raw ?? body.message?.raw ?? "";
      state.sent.push({ owner, raw: Buffer.from(raw, "base64url").toString("utf8") });
      return json(route, { id: `sent${state.sent.length}`, threadId: "t-sent", labelIds: ["SENT"] });
    }
    if (p === "/drafts" && request.method() === "POST") return json(route, { id: "d1", message: { id: "dm1" } });
    if (/^\/drafts\/[^/]+$/.test(p)) return json(route, request.method() === "DELETE" ? {} : { id: "d1", message: { id: "dm2" } });
    if (p === "/drafts") return json(route, {});
    const one = /^\/messages\/([A-Za-z0-9]+)(\/modify)?$/.exec(p);
    if (one) {
      const m = owned(owner).find((candidate) => candidate.id === one[1]);
      if (!m) return json(route, { error: { code: 404, message: "Not Found" } }, 404);
      if (one[2]) {
        const body = JSON.parse(request.postData() ?? "{}");
        m.labels = m.labels.filter((l) => !(body.removeLabelIds ?? []).includes(l)).concat(body.addLabelIds ?? []);
      }
      return json(route, message(m));
    }
    return json(route, {});
  });
  await ctx.route("https://oauth2.googleapis.com/**", (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return preflight(route);
    if (request.url().includes("/revoke")) return json(route, {});
    const body = new URLSearchParams(request.postData() ?? "");
    if (body.get("grant_type") === "authorization_code") {
      state.minted += 1;
      const token = `tok-minted-${state.minted}`;
      state.tokens.set(token, state.nextSignIn);
      return json(route, { access_token: token, refresh_token: `1//r-${state.minted}`, expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.modify", token_type: "Bearer" });
    }
    return json(route, { error: "invalid_grant" }, 400);
  });
  // Google's account chooser and consent, answered at once: back to the app with a code.
  await ctx.route("https://accounts.google.com/**", (route) => {
    const url = new globalThis.URL(route.request().url());
    state.authorizeUrls.push(url.toString());
    const back = `${url.searchParams.get("redirect_uri")}?code=c${state.authorizeUrls.length}&state=${url.searchParams.get("state")}`;
    return route.fulfill({ status: 302, headers: { location: back } });
  });
  await ctx.route("https://people.googleapis.com/**", (route) => json(route, {}));
  await ctx.route("https://www.googleapis.com/**", (route) => json(route, {}));
  await ctx.route("https://cloudflare-dns.com/**", (route) => json(route, {}));
  return state;
}

/** The stand-in for Tauri's IPC on Android: the keychain, deep links and event listeners. */
function fakeAndroid({ secrets, launch }) {
  const store = new Map(Object.entries(secrets));
  const listeners = new Map();
  let nextId = 1;
  window.__smokeEmit = (event, payload) => {
    for (const [id, name] of listeners) if (name === event) window[`_${id}`]?.({ event, id: Number(id), payload });
  };
  window.__smokeSecrets = store;
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
      switch (cmd) {
        case "app_info":
          return { name: "Winnow", version: "1.4.0", os: "android", arch: "aarch64", kind: "desktop", nativeOAuth: true, nativeSecrets: true, backgroundSync: false, saveFiles: true };
        case "secrets_get":
          return store.get(args.name) ?? null;
        case "secrets_set":
          store.set(args.name, args.value);
          return null;
        case "secrets_delete":
          store.delete(args.name);
          return null;
        case "deep_link_launch":
          return launch ? [launch] : [];
        case "google_signin_info":
          return null;
        case "notify_kept_replies":
          return [];
        case "plugin:event|listen":
          listeners.set(String(args.handler), args.event);
          return args.handler;
        case "plugin:event|unlisten":
          return null;
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

const tokensJson = (accessToken) =>
  JSON.stringify({ accessToken, refreshToken: "1//smoke-refresh", expiresAt: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/gmail.modify" });

const subjects = (page) => page.locator("[data-row-id]").allInnerTexts().then((texts) => texts.join(" | "));


/** The registry as stored: who is here, with each account's colour and notify switch. */
const registry = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("winnow.accounts.v1") ?? "{}"));

/** A web build with Ada and Bob already signed in (Ada open), for the phone's Accounts page. */
function seedTwoAccounts({ client, ada, bob }) {
  if (sessionStorage.getItem("seeded-accounts")) return;
  sessionStorage.setItem("seeded-accounts", "1");
  localStorage.setItem("winnow.google.oauthClient", JSON.stringify(client));
  localStorage.setItem("winnow.gmail.tokens@acctada01", ada);
  localStorage.setItem("winnow.gmail.tokens@acctbob02", bob);
  localStorage.setItem("winnow.preferences.v1", JSON.stringify({ undoSendSeconds: 0 }));
  localStorage.setItem(
    "winnow.accounts.v1",
    JSON.stringify({
      version: 1,
      active: "acctada01",
      accounts: [
        { id: "acctada01", email: "ada@one.example", color: "space", notify: true, addedAt: 1 },
        { id: "acctbob02", email: "bob@two.example", color: "aurora", notify: true, addedAt: 2 },
      ],
    }),
  );
}

/**
 * The Accounts page, the same on both layouts: the switcher's Manage accounts opens it
 * (not Settings), it lists both accounts, an account's page sets its colour (click and
 * arrow keys) and notify switch, Escape steps back to the list, Settings' Accounts row
 * opens it, its Google account link opens Settings there, Switch opens the other inbox,
 * and signing out of the account that is not open leaves the other signed in.
 */
async function accountsPageChecks(page, { label, openSwitcher, registry: read }) {
  const t = (text) => `accounts page (${label}): ${text}`;
  const pageState = () => page.locator("[data-accounts-page]").getAttribute("data-accounts-page").catch(() => null);
  const openPage = async () => {
    await openSwitcher();
    await page.locator("[data-account-manage]").click();
    await page.locator("[data-accounts-page]").waitFor({ timeout: 5_000 });
  };
  await openPage();
  const before = await read(page);
  const activeId = before.active;
  const other = before.accounts.find((account) => account.id !== activeId);
  check(t("Manage accounts opens the Accounts page, not Settings"), (await pageState()) === "list" && (await page.locator("[data-settings-layout]").count()) === 0);
  check(
    t("it lists every account, the open one marked"),
    (await page.locator("[data-accounts-row]").count()) === before.accounts.length &&
      (await page.locator(`[data-accounts-row="${activeId}"]`).getAttribute("aria-current")) === "true",
  );
  const layout = await page.locator("[data-accounts-layout]").getAttribute("data-accounts-layout");
  // Layout boxes rather than the painted one, which the entrance motion scales for 160ms.
  const box = await page
    .locator('[role="dialog"][aria-label="Accounts"]')
    .evaluate((el) => ({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }));
  const viewport = page.viewportSize();
  check(
    t(label === "phone" ? "a full-screen sheet with 44px+ rows" : "a centred panel"),
    label === "phone"
      ? layout === "phone" && box && box.width >= viewport.width - 1 && (await page.locator("[data-accounts-row]").first().evaluate((el) => el.offsetHeight)) >= 44
      : layout === "desktop" && box && box.width <= 520 && Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2,
    JSON.stringify(box),
  );
  check(t("Add account and its Testing-mode note are on it"), (await page.locator("[data-accounts-add]").innerText()).includes("Add account") && (await page.locator("[data-accounts-add-help]").innerText()).includes("test users"));
  check(t("so are the demo inbox and Sign out of all"), (await page.locator("[data-accounts-demo]").count()) === 1 && (await page.locator("[data-accounts-sign-out-all]").count()) === 1);

  // One account's page: colour and notify.
  await page.locator(`[data-accounts-row="${other.id}"]`).click();
  await page.locator(`[data-accounts-detail="${other.id}"]`).waitFor({ timeout: 3_000 });
  check(t("an account opens its own page, titled with its address"), (await page.locator("[data-accounts-title]").innerText()) === other.email);
  await page.locator(`[data-accounts-detail="${other.id}"] [data-accounts-colour="ember"]`).click();
  await page.waitForTimeout(150);
  let stored = (await read(page)).accounts.find((account) => account.id === other.id);
  check(t("a colour is chosen and stored"), stored?.color === "ember" && (await page.locator('[data-accounts-colour="ember"]').getAttribute("aria-checked")) === "true", stored?.color);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  stored = (await read(page)).accounts.find((account) => account.id === other.id);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-accounts-colour"));
  check(t("the arrow keys move the colour and the focus together"), stored?.color === "aurora" && focused === "aurora", `${stored?.color} / ${focused}`);
  await page.locator(`[data-accounts-notify="${other.id}"] [role="switch"]`).click();
  await page.waitForTimeout(150);
  stored = (await read(page)).accounts.find((account) => account.id === other.id);
  check(t("its notify switch is stored"), stored?.notify === false && (await page.locator(`[data-accounts-notify="${other.id}"] [role="switch"]`).getAttribute("aria-checked")) === "false");

  // Escape steps back to the list, onto that account's row; a second closes the page.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const back = await page.evaluate(() => document.activeElement?.getAttribute("data-accounts-row"));
  check(t("Escape steps back to the list, focus on that account's row"), (await pageState()) === "list" && back === other.id, String(back));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(t("and Escape on the list closes the page"), (await page.locator("[data-accounts-page]").count()) === 0);

  // Settings keeps one Accounts row, which opens the page; the page links back to Settings → Google account.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press(",");
  await page.locator("[data-settings-layout]").waitFor({ timeout: 5_000 });
  if (label === "phone") await page.locator('[data-category="google"]').click();
  else await page.locator('[data-settings-nav] [data-category="google"]').click();
  check(
    t("Settings no longer holds the per-account controls"),
    (await page.locator("[data-settings-layout] [data-accounts-colour], [data-settings-layout] [data-sign-out-account]").count()) === 0 &&
      (await page.locator("[data-settings-manage-accounts]").count()) === 1,
  );
  await page.locator("[data-settings-manage-accounts]").click();
  await page.locator("[data-accounts-page]").waitFor({ timeout: 5_000 });
  check(t("Settings' Accounts row opens the page"), (await page.locator("[data-settings-layout]").count()) === 0);
  await page.locator("[data-accounts-google-settings]").click();
  await page.locator("[data-settings-title]").waitFor({ timeout: 5_000 });
  check(t("Google account settings opens Settings on Google account"), (await page.locator("[data-settings-title]").innerText()) === "Google account");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  if ((await page.locator("[data-settings-layout]").count()) > 0) {
    // The phone's category page steps back to its list first.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
  if ((await page.locator("[data-settings-layout]").count()) > 0) {
    await page.locator("[data-settings-back]").first().click();
    await page.waitForTimeout(250);
  }

  // Switch from the account's page: the page makes way for that inbox.
  await openPage();
  await page.locator(`[data-accounts-row="${other.id}"]`).click();
  await page.locator(`[data-accounts-switch="${other.id}"]`).click();
  const otherMail = other.email === BOB ? "Bob mail 1" : "Ada mail 1";
  await page.waitForFunction((text) => document.body.innerText.includes(text), otherMail, { timeout: 10_000 }).catch(() => undefined);
  check(t("Switch to this account opens its inbox and closes the page"), (await page.locator("[data-accounts-page]").count()) === 0 && (await subjects(page)).includes(otherMail));

  // Sign out of the account that is no longer open: only it goes.
  await openPage();
  await page.locator(`[data-accounts-row="${activeId}"]`).click();
  await page.locator(`[data-accounts-sign-out="${activeId}"]`).click();
  if (label === "phone") {
    // Asked first on a phone, as everywhere else.
    await page.locator('[data-action-sheet-item="confirm"]').click();
  }
  await page.waitForFunction((id) => !(JSON.parse(localStorage.getItem("winnow.accounts.v1") ?? "{}").accounts ?? []).some((a) => a.id === id), activeId, { timeout: 10_000 }).catch(() => undefined);
  const after = await read(page);
  check(t("sign out of this account removes only it"), after.accounts?.length === 1 && after.accounts[0].id === other.id, JSON.stringify(after.accounts?.map((a) => a.email)));
  check(t("and the page goes back to the list, which no longer shows it"), (await pageState()) === "list" && (await page.locator(`[data-accounts-row="${activeId}"]`).count()) === 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
}

await ensureBuilt();
const server = await preview({ root: ROOT, logLevel: "warn", preview: { port: PORT, strictPort: true, open: false } });
const browser = await chromium.launch(process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM } : {});
const errors = [];
try {
  // ── 1–4. The web build ─────────────────────────────────────────────────────
  console.log("\n── migration, add, switch, reply (web) ──");
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const google = await fakeGoogle(ctx);
    await ctx.addInitScript(({ client, tokens }) => {
      if (sessionStorage.getItem("seeded-accounts")) return;
      sessionStorage.setItem("seeded-accounts", "1");
      // 1.3.5's storage: one unscoped session and its learning.
      localStorage.setItem("winnow.google.oauthClient", JSON.stringify(client));
      localStorage.setItem("winnow.gmail.tokens", tokens);
      // No cursor: 1.3.5 only ever wrote one over the mail cache it described, and a
      // cursor with no cache is a state the app (rightly) syncs as "no changes".
      localStorage.setItem("winnow.activeFilters.v1", JSON.stringify([]));
      localStorage.setItem("winnow.filterLearning.v1", JSON.stringify({ version: 1, owner: "ada@one.example", corrections: [] }));
      localStorage.setItem("winnow.preferences.v1", JSON.stringify({ undoSendSeconds: 0 }));
    }, { client: CLIENT, tokens: tokensJson("tok-ada") });
    const page = await ctx.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("dialog", (dialog) => {
      errors.push(`native dialog: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await page.goto(URL);
    await page.waitForFunction(() => (document.body?.innerText ?? "").includes("Ada mail 1"), null, { timeout: 15_000 }).catch(() => undefined);

    const stored = await page.evaluate(() => {
      const registry = JSON.parse(localStorage.getItem("winnow.accounts.v1") ?? "null");
      const id = registry?.active ?? "";
      return {
        registry,
        legacyTokens: localStorage.getItem("winnow.gmail.tokens"),
        scopedTokens: Boolean(localStorage.getItem(`winnow.gmail.tokens@${id}`)),
        legacyLearning: localStorage.getItem("winnow.filterLearning.v1"),
        scopedLearning: localStorage.getItem(`winnow.filterLearning.v1@${id}`),
      };
    });
    check("migration: a 1.3.5 session opens its inbox with no sign-in", (await subjects(page)).includes("Ada mail 1") && google.authorizeUrls.length === 0);
    check(
      "migration: the account is registered and its data moved into its namespace",
      stored.registry?.accounts?.length === 1 && stored.registry.accounts[0].email === ADA && stored.scopedTokens && stored.legacyTokens === null && stored.legacyLearning === null && (stored.scopedLearning ?? "").includes(ADA),
      JSON.stringify(stored).slice(0, 300),
    );

    // Add account.
    // The trigger is in the desktop sidebar, which opening the switcher closes. Ask the
    // toggle whether it is open rather than the trigger whether it is visible: while the
    // sidebar slides away the trigger is still on screen, and is hidden a moment later.
    const openSwitcher = async () => {
      const toggle = page.locator("[data-sidebar-toggle]").first();
      if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await page.locator("[data-account-switcher-trigger]").first().click();
      await page.locator("[data-account-switcher]").waitFor({ timeout: 5_000 });
    };
    await openSwitcher();
    check("the switcher lists the account with its address, ringed in its colour", (await page.locator(`[data-account-row][data-account-email="${ADA}"] [data-account-glow]`).count()) === 1);
    check("the open account is marked current; there is no dot badge any more", (await page.locator(`[data-account-row][aria-current="true"] [data-account-glow-active]`).count()) === 1 && (await page.locator("[data-account-dot]").count()) === 0);
    check("the trigger avatar is ringed for the open account", (await page.locator("[data-account-switcher-trigger] [data-account-glow-active]").count()) === 1);
    check("and says, under Add account, that Testing mode needs every address as a test user", (await page.locator("[data-account-switcher]").innerText()).includes("test users"));
    google.nextSignIn = BOB;
    await Promise.all([page.waitForURL(/\?|\/$/, { timeout: 15_000 }).catch(() => undefined), page.locator("[data-account-add]").click()]);
    await page.waitForFunction(() => (document.body?.innerText ?? "").includes("Bob mail 1"), null, { timeout: 15_000 }).catch(() => undefined);
    const chooser = google.authorizeUrls[0] ? new globalThis.URL(google.authorizeUrls[0]).searchParams.get("prompt") : null;
    check("add: Google's account chooser is asked for", chooser === "select_account consent", String(chooser));
    check("add: the second account opens with its own mail", (await subjects(page)).includes("Bob mail 1") && !(await subjects(page)).includes("Ada mail 1"));
    const accounts = await page.evaluate(() => JSON.parse(localStorage.getItem("winnow.accounts.v1") ?? "{}").accounts?.map((a) => a.email) ?? []);
    check("add: both accounts are registered", accounts.join(",") === `${ADA},${BOB}`, accounts.join(","));

    // Adding Ada again: switched to, not added twice.
    await openSwitcher();
    google.nextSignIn = ADA;
    await page.locator("[data-account-add]").click();
    await page.waitForFunction(() => (document.body?.innerText ?? "").includes("Ada mail 1"), null, { timeout: 15_000 }).catch(() => undefined);
    const afterDuplicate = await page.evaluate(() => JSON.parse(localStorage.getItem("winnow.accounts.v1") ?? "{}").accounts?.length ?? 0);
    check("add: an account already added is switched to, not added again", afterDuplicate === 2 && (await subjects(page)).includes("Ada mail 1"));

    // Switch with one tap.
    await openSwitcher();
    await page.locator(`[data-account-row][data-account-email="${BOB}"]`).click();
    await page.waitForFunction(() => (document.body?.innerText ?? "").includes("Bob mail 1"), null, { timeout: 10_000 }).catch(() => undefined);
    check("switch: one tap shows the other account's mail", (await subjects(page)).includes("Bob mail 1"));
    await openSwitcher();
    await page.locator(`[data-account-row][data-account-email="${ADA}"]`).click();
    await page.waitForFunction(() => (document.body?.innerText ?? "").includes("Ada mail 2"), null, { timeout: 10_000 }).catch(() => undefined);

    // Reply from the right address.
    await page.locator("[data-row-id]", { hasText: "Ada mail 2" }).first().click();
    await page.locator("[data-reader-subject]").waitFor({ timeout: 5_000 });
    await page.keyboard.press("r");
    const picker = page.locator("[data-composer-from-picker]");
    await picker.waitFor({ timeout: 5_000 }).catch(() => undefined);
    const fromLabel = (await picker.count()) ? await picker.evaluate((el) => el.options[el.selectedIndex]?.text ?? "") : "";
    check("reply: the From picker starts on the account that received the message", fromLabel === ADA, fromLabel);
    await page.locator('textarea[aria-label="Message"]').fill("Sounds good.");
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => true, null, { timeout: 500 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const sent = google.sent.at(-1);
    check(
      "reply: it goes out from that address, through that account",
      Boolean(sent) && sent.owner === ADA && /^From: .*ada@one\.example/m.test(sent.raw) && /^In-Reply-To: <a2@fake\.example>/m.test(sent.raw),
      sent ? sent.raw.split("\r\n").slice(0, 6).join(" / ") : "nothing sent",
    );

    // ── 6. The Accounts page (desktop) ──────────────────────────────────────
    console.log("\n── the Accounts page (desktop) ──");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await accountsPageChecks(page, { label: "desktop", openSwitcher, registry });
    await ctx.close();
  }

  // ── 6. The Accounts page (phone) ───────────────────────────────────────────
  console.log("\n── the Accounts page (phone) ──");
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      hasTouch: true,
      isMobile: true,
    });
    await fakeGoogle(ctx);
    await ctx.addInitScript(seedTwoAccounts, { client: CLIENT, ada: tokensJson("tok-ada"), bob: tokensJson("tok-bob") });
    const page = await ctx.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("dialog", (dialog) => {
      errors.push(`native dialog: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await page.goto(URL);
    await page.waitForFunction(() => (document.body?.innerText ?? "").includes("Ada mail 1"), null, { timeout: 15_000 }).catch(() => undefined);
    const openSwitcher = async () => {
      await page.locator("[data-account-switcher-trigger]").first().click();
      await page.locator("[data-account-switcher]").waitFor({ timeout: 5_000 });
    };
    await accountsPageChecks(page, { label: "phone", openSwitcher, registry });
    await ctx.close();
  }

  // ── 5. Notification deep links on the Android app ───────────────────────────
  console.log("\n── notification deep links (Android app) ──");
  {
    const androidContext = async (launch) => {
      const ctx = await browser.newContext({
        viewport: { width: 412, height: 915 },
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
        hasTouch: true,
        isMobile: true,
      });
      const google = await fakeGoogle(ctx);
      // The message the notification is about: in Bob's Gmail, never synced here yet.
      google.accounts[BOB].push({ id: "bnew9", owner: BOB, subject: "Fresh from the notification", from: "Carol <carol@fake.example>", labels: ["INBOX", "UNREAD"], at: Date.now() - 60_000 });
      await ctx.addInitScript(fakeAndroid, {
        secrets: {
          "google.oauth-client": JSON.stringify({ clientId: CLIENT.clientId }),
          "gmail.tokens@acctada01": tokensJson("tok-ada"),
          "gmail.tokens@acctbob02": tokensJson("tok-bob"),
        },
        launch,
      });
      await ctx.addInitScript(() => {
        if (localStorage.getItem("winnow.accounts.v1")) return;
        localStorage.setItem(
          "winnow.accounts.v1",
          JSON.stringify({
            version: 1,
            active: "acctada01",
            accounts: [
              { id: "acctada01", email: "ada@one.example", color: "space", notify: true, addedAt: 1 },
              { id: "acctbob02", email: "bob@two.example", color: "aurora", notify: true, addedAt: 2 },
            ],
          }),
        );
      });
      const page = await ctx.newPage();
      page.on("pageerror", (error) => errors.push(String(error)));
      return { ctx, page };
    };
    const link = `winnow://message/${hashId("bnew9")}?account=acctbob02&gmail=bnew9`;

    {
      const { ctx, page } = await androidContext(null);
      await page.goto(URL);
      await page.waitForFunction(() => (document.body?.innerText ?? "").includes("Ada mail 1"), null, { timeout: 15_000 }).catch(() => undefined);
      check("the Android app opens the active account", (await subjects(page)).includes("Ada mail 1"));
      await page.evaluate((url) => window.__smokeEmit("winnow://open-url", url), link);
      await page.locator("[data-reader-subject]").waitFor({ timeout: 10_000 }).catch(() => undefined);
      const subject = await page.locator("[data-reader-subject]").innerText().catch(() => "");
      check("deep link: another account's uncached message is fetched and opened in the reader", subject === "Fresh from the notification", subject);
      // The phone's full-screen reader covers the header (no switcher trigger on screen),
      // so the account is read from the registry; Back below shows that account's inbox.
      const active = await page.evaluate(() => JSON.parse(localStorage.getItem("winnow.accounts.v1") ?? "{}").active ?? "");
      check("deep link: in the right account", active === "acctbob02", active);
      const full = await page.locator("[data-reader]").first().boundingBox().catch(() => null);
      check("deep link: on a phone the reader is full screen", Boolean(full) && full.width >= 400, JSON.stringify(full));
      await page.locator("[data-reader-back]").first().click();
      await page.waitForTimeout(400);
      const list = await subjects(page);
      check("Back returns to that account's inbox", list.includes("Bob mail 1") && list.includes("Fresh from the notification") && !list.includes("Ada mail 1"), list.slice(0, 120));

      await page.evaluate(() => window.__smokeEmit("winnow://open-url", "winnow://open?account=acctada01&view=inbox"));
      await page.waitForFunction(() => (document.body?.innerText ?? "").includes("Ada mail 1"), null, { timeout: 10_000 }).catch(() => undefined);
      check("a summary's link opens that account's inbox", (await subjects(page)).includes("Ada mail 1") && (await page.locator("[data-reader-subject]").count()) === 0);
      await ctx.close();
    }
    {
      const { ctx, page } = await androidContext(link);
      await page.goto(URL);
      await page.locator("[data-reader-subject]").waitFor({ timeout: 15_000 }).catch(() => undefined);
      const subject = await page.locator("[data-reader-subject]").innerText().catch(() => "");
      check("cold start from a notification's tap opens that message", subject === "Fresh from the notification", subject);
      await ctx.close();
    }
  }
  check("no page errors or native dialogs", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
  failures.push(`aborted: ${error?.message ?? error}`);
  console.error(error);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const line of failures) console.log(`  · ${line}`);
process.exit(failures.length > 0 ? 1 : 0);
