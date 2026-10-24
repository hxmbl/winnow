/**
 * Blur sensitive info (Settings → Privacy; `ui/censorDom.ts`).
 *
 * The promise is about what a screenshot, a copy or a screen reader can get: with the
 * switch on, no real address is in the page's text or in the attributes that tooltips,
 * screen readers and link previews read, wherever it comes from — the list, the reader's
 * header, a Sent message's To and Cc, the composer's chips, a message body. And the
 * other half: what goes to Gmail is untouched, so a reply sent while censored still goes
 * to the real address.
 *
 * Part `censor` of `smoke.mjs` (shard contexts-b).
 */
import { signedInContext } from "./fake-gmail.mjs";

const ADDRESS = "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}";

/** Every real-looking address left in the page's visible text or read-out attributes. */
function leaks(page) {
  return page.evaluate((source) => {
    const re = new RegExp(source, "g");
    const found = new Set();
    for (const m of document.body.innerText.match(re) ?? []) found.add(`text:${m}`);
    for (const el of document.querySelectorAll("*")) {
      for (const name of ["title", "aria-label", "alt", "placeholder", "href"]) {
        const value = el.getAttribute(name);
        if (value) for (const m of value.match(re) ?? []) found.add(`${name}:${m}`);
      }
    }
    return [...found];
  }, ADDRESS);
}

/** Open the sidebar and pick a mailbox. */
async function openMailbox(p, selector) {
  await p.keyboard.press("[");
  const item = p.locator(selector).first();
  await item.waitFor({ timeout: 5_000 });
  await item.click();
  await p.waitForTimeout(400);
}

/** Pick a step in Blur sensitive info's menu. */
async function chooseLevel(p, dialog, label) {
  await dialog.locator('[data-select="censor-level"]').click();
  await p.locator('[role="listbox"][data-select-list="censor-level"] [role="option"]').filter({ hasText: new RegExp(`^\\s*${label.replace(/[+]/g, "\\+")}\\s*$`) }).first().click();
  await p.waitForTimeout(200);
}

export async function smokeCensor({ browser, URL, check, section, errors }) {
  section("blur sensitive info");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]");

    // Off by default: the demo's own addresses are on screen as they are.
    await p.locator("[data-row-count] [data-row-id]").nth(1).click();
    await p.waitForTimeout(400);
    const plain = ((await p.locator("[data-reader-address]").first().textContent()) ?? "").trim();
    check("off by default: the reader shows the sender's real address", /@/.test(plain), JSON.stringify(plain));

    // Settings → Privacy → Blur sensitive info.
    await p.keyboard.press("Escape");
    await p.keyboard.press(",");
    const dialog = p.locator('[role="dialog"][aria-label="Settings"]');
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.locator('[data-category="privacy"]').first().click();
    const trigger = dialog.locator('[data-select="censor-level"]');
    check("Settings → Privacy has Blur sensitive info, off", /Off/.test((await trigger.textContent()) ?? ""), (await trigger.textContent()) ?? "");
    await chooseLevel(p, dialog, "Email addresses");
    const stored = await p.evaluate(() => JSON.parse(localStorage.getItem("winnow.preferences.v1") ?? "{}").censorLevel);
    check("choosing a step is saved on the device", stored === "emails", String(stored));
    check("Settings itself shows no real address", (await leaks(p)).length === 0, JSON.stringify(await leaks(p)));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);

    check("the list shows no real address", (await leaks(p)).length === 0, JSON.stringify(await leaks(p)));
    await p.locator("[data-row-count] [data-row-id]").nth(1).click();
    await p.waitForTimeout(400);
    const censored = ((await p.locator("[data-reader-address]").first().textContent()) ?? "").trim();
    check(
      "the reader's address is 12 random letters, blurred",
      !/@/.test(censored) &&
        /^[a-z]{12}$/.test(censored.replace(/[<>\s]/g, "")) &&
        (await p.locator("[data-reader-address][data-wn-censored], [data-reader-address] [data-wn-censored]").count()) > 0,
      JSON.stringify({ plain, censored }),
    );
    check("the reader shows no real address", (await leaks(p)).length === 0, JSON.stringify(await leaks(p)));

    // The same address keeps its letters: close and reopen.
    await p.keyboard.press("Escape");
    await p.locator("[data-row-count] [data-row-id]").nth(1).click();
    await p.waitForTimeout(300);
    const again = ((await p.locator("[data-reader-address]").first().textContent()) ?? "").trim();
    check("an address keeps its letters for the session", again === censored, JSON.stringify({ censored, again }));

    // A message with To and Cc: the demo's Sent mail.
    await p.keyboard.press("Escape");
    await openMailbox(p, '[data-nav-folder="sent"]');
    const sent = p.locator("[data-row-count] [data-row-id]");
    if ((await sent.count()) > 0) {
      await sent.first().click();
      await p.waitForTimeout(400);
      check("a Sent message's recipients show no real address", (await leaks(p)).length === 0, JSON.stringify(await leaks(p)));
    } else {
      check("the demo has Sent mail to look at", false, "Sent opened no rows");
    }

    // The composer: suggestions and chips, typed into a censored page.
    await p.keyboard.press("Escape");
    await p.keyboard.press("c");
    await p.waitForSelector("[data-composer]", { timeout: 5_000 });
    await p.keyboard.type("dana");
    await p.waitForTimeout(400);
    check("compose suggestions show no real address", (await leaks(p)).length === 0, JSON.stringify(await leaks(p)));
    await p.keyboard.press("Enter");
    await p.waitForTimeout(300);
    check("a recipient chip shows no real address", (await leaks(p)).length === 0, JSON.stringify(await leaks(p)));
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    const discard = p.getByRole("button", { name: /Discard|Delete/ }).first();
    if (await discard.isVisible().catch(() => false)) await discard.click();

    // Off again: the real addresses come back, without a reload.
    await p.keyboard.press(",");
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.locator('[data-category="privacy"]').first().click();
    await chooseLevel(p, dialog, "Off");
    await p.keyboard.press("Escape");
    await openMailbox(p, '[data-nav="inbox"]');
    await p.locator("[data-row-count] [data-row-id]").nth(1).click();
    await p.waitForTimeout(400);
    const back = ((await p.locator("[data-reader-address]").first().textContent()) ?? "").trim();
    check(
      "turning it off brings the real address back, unblurred",
      back === plain && (await p.locator("[data-wn-censored]").count()) === 0,
      JSON.stringify({ plain, back }),
    );
    await ctx.close();
  }

  section("blur sensitive info: message bodies, passwords, and what is sent");
  {
    const SECRET = "helper.desk@support.example";
    const PASSWORD = "Hunter-2-Secret";
    const { ctx } = await signedInContext(
      browser,
      { viewport: { width: 1440, height: 900 } },
      {
        count: 3,
        html: {
          f0: {
            from: `Support <${SECRET}>`,
            subject: "Your ticket",
            text: `Write to ${SECRET} any time.`,
            html: `<p>Write to <b>${SECRET}</b> any time, or <a href="mailto:${SECRET}">mail us</a>.</p><p>Password: <b>${PASSWORD}</b></p>`,
          },
        },
      },
    );
    await ctx.addInitScript(() => {
      if (window.top !== window) return;
      const key = "winnow.preferences.v1";
      const prefs = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...prefs, censorLevel: "passwords", undoSendSeconds: 0 }));
    });
    // Registered after the fake's own route, so it answers the send first.
    const sends = [];
    await ctx.route("https://gmail.googleapis.com/**/messages/send", (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      sends.push(Buffer.from(body.raw ?? "", "base64url").toString("utf8"));
      return route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify({ id: "sent1", threadId: "t-f0", labelIds: ["SENT"] }) });
    });
    const p = await ctx.newPage();
    p.on("pageerror", (error) => errors.push(String(error)));
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForSelector("[data-row-count] [data-row-id]", { timeout: 15_000 });
    check("signed in and censored: the list and account show no real address", (await leaks(p)).length === 0, JSON.stringify(await leaks(p)));
    await p.locator("[data-row-count] [data-row-id]").filter({ hasText: "Your ticket" }).first().click();
    await p.waitForSelector("[data-wn-email]", { timeout: 10_000 }).catch(() => undefined);
    await p.waitForTimeout(500);
    check("a message body shows no real address, in text or link", (await leaks(p)).length === 0, JSON.stringify(await leaks(p)));
    check(
      "each address in a body is its own blurred span",
      (await p.locator("[data-wn-email] [data-wn-censored]").count()) >= 1,
      String(await p.locator("[data-wn-email] [data-wn-censored]").count()),
    );
    const html = await p.content();
    // `data-*` attributes are the app's own keys (a rail chip's `sender:<address>`): never
    // drawn, read out or copied, and the smoke selectors depend on them.
    check(
      "the real address is nowhere in the markup outside data-* keys",
      !html.replace(/ data-[a-z-]+="[^"]*"/g, "").includes(SECRET),
    );
    check(
      "a password after its label, in its own element, is not in the markup",
      !html.includes(PASSWORD) && html.includes("Password:"),
    );

    // Reply while censored: the mail still goes to the real address.
    await p.keyboard.press("r");
    await p.waitForSelector("[data-composer]", { timeout: 5_000 });
    await p.keyboard.type("Thanks");
    await p.keyboard.press("Meta+Enter");
    await p.waitForTimeout(1_500);
    const raw = sends[0] ?? "";
    check(
      "a reply sent while censored goes to the real address",
      /^To:.*helper\.desk@support\.example/im.test(raw),
      JSON.stringify(raw.split(/\r?\n/).find((line) => /^To:/i.test(line)) ?? `${sends.length} sends`),
    );
    await ctx.close();
  }
}
