/**
 * Smoke checks for undo send on a phone and the offline action queue
 * (`src/core/offline/queue.ts`), against the real production build.
 *
 * Kept in its own module so it can run alone — `WINNOW_SMOKE_ONLY=offline npm run
 * smoke` — and so the main suite only gains one call. The offline half drives a fake
 * Gmail (the pattern the pull-to-refresh checks use) and Playwright's network emulation:
 * `setOffline(true)` turns `navigator.onLine` false and fires `offline`, and every request
 * fails the way a dead network does.
 */

const FAKE_TOKEN = ["fake", "offline", "access"].join("-");

export async function smokeOffline({ browser, URL, check, section, errors }) {
  section("undo send window setting");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-message-id]", { timeout: 15_000 });
    await p.keyboard.press(",");
    const dialog = p.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.locator('[role="tab"][data-category="compose"]').click();
    await p.waitForTimeout(150);
    const trigger = dialog.locator('[data-select="undo-send"]');
    await trigger.click();
    const choices = await p.locator('[data-select-list="undo-send"] [role="option"]').allTextContents();
    await p.keyboard.press("Escape");
    check(
      "Settings → Compose has the Undo send window: Off, 5, 10, 20 seconds, with 10 chosen",
      choices.join("|") === "Off|5 seconds|10 seconds|20 seconds" &&
        (await trigger.getAttribute("data-value")) === "10" &&
        ((await dialog.locator('[data-setting="undoSend"]').first().textContent()) ?? "").includes("Undo send window"),
      choices.join("|"),
    );
    await ctx.close();
  }

  section("undo send on a phone");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-message-id]", { timeout: 15_000 });
    await p.locator("[data-compose-fab]").first().tap();
    const sheet = () => p.locator('[role="dialog"][aria-label="New message"]');
    await sheet().waitFor({ state: "visible", timeout: 5_000 });
    const subject = `Phone undo ${Date.now().toString(36)}`;
    await sheet().locator('input[aria-label="To"]').fill("ana@example.com,");
    await sheet().locator('input[aria-label="Subject"]').fill(subject);
    await sheet().locator('textarea[aria-label="Message"]').fill("Sent from the phone.");
    await sheet().locator("button", { hasText: /^Send/ }).first().tap();
    const strip = p.locator("[data-send-pending]");
    await strip.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    const placed = await p.evaluate(() => {
      const undo = document.querySelector("[data-send-undo]");
      if (!undo) return null;
      const box = undo.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        inView: box.top >= 0 && box.bottom <= window.innerHeight && box.width > 0,
        reachable: hit === undo || undo.contains(hit),
        text: document.querySelector("[data-send-pending]")?.textContent ?? "",
      };
    });
    check(
      "on a phone, Send holds the message under a Sending… pill whose Undo is on screen and tappable",
      placed?.inView === true && placed.reachable === true && /Sending in (9|10)s/.test(placed.text),
      JSON.stringify(placed),
    );
    await strip.locator("[data-send-undo]").tap();
    await sheet().waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
    check(
      "and Undo brings the composer back with the subject and the words",
      (await sheet().count()) === 1 &&
        (await sheet().locator('input[aria-label="Subject"]').inputValue()) === subject &&
        (await sheet().locator('textarea[aria-label="Message"]').inputValue()).startsWith("Sent from the phone."),
    );
    check("and the strip goes", (await strip.count()) === 0);
    await ctx.close();
  }

  section("offline action queue");
  {
    const b64 = (text) => Buffer.from(text, "utf8").toString("base64url");
    const ids = Array.from({ length: 8 }, (_, i) => `o${i}`);
    /** Every label change Gmail was asked for, in order: `id +ADD -REMOVE`. */
    const modifies = [];
    /** Messages Gmail says are gone (404), as if deleted on another device. */
    const gone = new Set();
    /** The fake's own truth, so a sync after the replay reads what the replay did. */
    const labels = new Map(ids.map((id) => [id, ["INBOX"]]));
    let historyId = 700;
    /** Changes not yet reported by /history: what an incremental sync re-fetches. */
    const touched = new Set();
    const json = (route, body, status = 200) =>
      route.fulfill({ status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    const fake = (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" } });
      }
      const url = new globalThis.URL(request.url());
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      if (path === "/profile") return json(route, { emailAddress: "me@winnow.example", historyId: String(historyId), messagesTotal: ids.length });
      if (path === "/messages") {
        const q = url.searchParams.get("q") ?? "";
        const inbox = ids.filter((id) => labels.get(id).includes("INBOX"));
        return json(route, q.includes("in:inbox") && !q.includes("-in:inbox") ? { messages: inbox.map((id) => ({ id, threadId: `t-${id}` })), resultSizeEstimate: inbox.length } : { resultSizeEstimate: 0 });
      }
      const modify = /^\/messages\/(o\d+)\/modify$/.exec(path);
      if (modify) {
        if (gone.has(modify[1])) return json(route, { error: { code: 404, message: "Not Found" } }, 404);
        const body = JSON.parse(request.postData() ?? "{}");
        modifies.push(`${modify[1]} +${(body.addLabelIds ?? []).join(",")} -${(body.removeLabelIds ?? []).join(",")}`);
        const next = labels.get(modify[1]).filter((label) => !(body.removeLabelIds ?? []).includes(label));
        for (const label of body.addLabelIds ?? []) if (!next.includes(label)) next.push(label);
        labels.set(modify[1], next);
        touched.add(modify[1]);
        historyId += 1;
        return json(route, { id: modify[1], labelIds: [] });
      }
      const one = /^\/messages\/(o\d+)$/.exec(path);
      if (one) {
        const n = Number(one[1].slice(1));
        const headers = [
          { name: "From", value: `Sender ${n} <s${n}@offline.example>` },
          { name: "To", value: "me@winnow.example" },
          { name: "Subject", value: `Offline check ${n}` },
          { name: "Date", value: new Date(Date.now() - n * 3_600_000).toUTCString() },
        ];
        return json(route, {
          id: one[1], threadId: `t-${one[1]}`, labelIds: labels.get(one[1]), snippet: `Offline check ${n}`,
          internalDate: String(Date.now() - n * 3_600_000), sizeEstimate: 900,
          payload: { mimeType: "text/plain", headers, body: { size: 10, data: b64(`Offline check ${n}`) } },
        });
      }
      if (path === "/history") {
        const changed = [...touched];
        touched.clear();
        return json(route, {
          historyId: String(historyId),
          ...(changed.length ? { history: [{ id: String(historyId), labelsAdded: changed.map((id) => ({ message: { id } })) }] } : {}),
        });
      }
      return json(route, {});
    };

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript((accessToken) => {
      if (window.top !== window) return;
      if (sessionStorage.getItem("seeded-offline")) return;
      sessionStorage.setItem("seeded-offline", "1");
      localStorage.setItem("winnow.google.oauthClient", JSON.stringify({ clientId: "1234567890-abc123def.apps.googleusercontent.com" }));
      localStorage.setItem("winnow.gmail.tokens", JSON.stringify({ accessToken, refreshToken: "1//smoke-refresh", expiresAt: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/gmail.modify" }));
    }, FAKE_TOKEN);
    await ctx.route("https://gmail.googleapis.com/**", fake);
    await ctx.route("https://oauth2.googleapis.com/**", (route) => json(route, { error: "invalid_grant" }, 400));
    await ctx.route("https://people.googleapis.com/**", (route) => json(route, {}));
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.locator("[data-message-id]", { hasText: "Offline check 1" }).first().waitFor({ state: "visible", timeout: 15_000 });
    await p.waitForFunction(() => !document.querySelector("[data-sync-status='busy']"), null, { timeout: 10_000 }).catch(() => undefined);
    await p.waitForTimeout(500);

    const rowFor = (n) => p.locator("[data-message-id]", { hasText: `Offline check ${n}` });
    const indicator = p.locator("[data-offline-queue]");
    // The queue is the active account's (1.4.0): `winnow.offlineQueue.v1@<id>`.
    const queued = () =>
      p.evaluate(() => {
        const id = JSON.parse(localStorage.getItem("winnow.accounts.v1") ?? "null")?.active;
        return JSON.parse((id && localStorage.getItem(`winnow.offlineQueue.v1@${id}`)) ?? "null")?.entries?.length ?? 0;
      });
    check("online with nothing waiting, there is no offline line", (await indicator.count()) === 0);

    await ctx.setOffline(true);
    await p.waitForTimeout(200);
    // The cursor on the first row (o0), then archive it; the next row (o1) takes its
    // place under the cursor and is starred; then the one gone from Gmail (o2).
    gone.add("o2");
    await p.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await p.keyboard.press("j");
    await p.waitForTimeout(120);
    await p.keyboard.press("e");
    await p.waitForTimeout(200);
    await p.keyboard.press("s");
    await p.waitForTimeout(200);
    await p.keyboard.press("j");
    await p.waitForTimeout(120);
    await p.keyboard.press("e");
    await p.waitForTimeout(400);

    const offlineShape = {
      archivedGone: (await rowFor(0).count()) === 0,
      text: (await indicator.textContent().catch(() => null)) ?? null,
      count: await indicator.getAttribute("data-offline-queue").catch(() => null),
      alerts: await p.locator('div[role="alert"]').count(),
      saved: await queued(),
    };
    check(
      "offline, archive and star stay done on screen with no error",
      offlineShape.archivedGone && offlineShape.alerts === 0,
      JSON.stringify(offlineShape),
    );
    check(
      "and a quiet line says how many changes wait",
      /^Offline: 3 changes waiting$/.test((offlineShape.text ?? "").trim()) && offlineShape.count === "3",
      JSON.stringify(offlineShape),
    );
    check("and the queue is kept on the device", offlineShape.saved === 3, String(offlineShape.saved));
    check("and nothing reached Gmail while offline", modifies.length === 0, modifies.join(" | "));

    await ctx.setOffline(false);
    await indicator.waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
    await p.waitForTimeout(300);
    const replayed = [...modifies];
    check(
      "back online, the queue replays in order: the archive, then the star",
      replayed.length >= 2 && /^o0 \+ -.*INBOX/.test(replayed[0]) && /STARRED/.test(replayed[1]) && /\+STARRED/.test(replayed[1]),
      replayed.join(" | "),
    );
    check(
      "the one Gmail no longer has is dropped quietly: no error, nothing left waiting",
      (await p.locator('div[role="alert"]').count()) === 0 && (await indicator.count()) === 0 && (await queued()) === 0,
    );
    // A sync after the replay reads Gmail's own answer, which now agrees.
    await p.keyboard.press("Escape").catch(() => undefined);
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    await p.waitForTimeout(1_500);
    check(
      "and after a sync the archived message stays archived, read from Gmail itself",
      (await rowFor(0).count()) === 0 && labels.get("o0").includes("INBOX") === false,
      JSON.stringify(Object.fromEntries(labels)),
    );
    await ctx.close();
  }
}
