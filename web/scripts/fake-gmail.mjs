/**
 * A small fake Gmail for the smoke tests that need a signed-in account: a seeded web
 * session (`winnow.gmail.tokens` + a stored OAuth client) and routes for the Gmail,
 * OAuth and People hosts. The same pattern `smoke-offline.mjs` uses, shared.
 *
 * `count` inbox messages `f0…`; `moves` records every modify as `id +ADD -REMOVE`.
 * `gmailCalls` counts every Gmail request attempted (even while `down`).
 * `failProfile` makes /profile answer 500 that many times first (a connect that fails).
 * `html` gives some messages an HTML body: `{ f0: { from, subject, html, text? } }`, sent
 * as multipart/alternative the way a newsletter arrives.
 */
export const FAKE_TOKEN = ["fake", "smoke", "access"].join("-");

export async function signedInContext(browser, options = {}, { count = 12, failProfile = 0, seed = true, html = {} } = {}) {
  const b64 = (text) => Buffer.from(text, "utf8").toString("base64url");
  const ids = Array.from({ length: count }, (_, i) => `f${i}`);
  const labels = new Map(ids.map((id) => [id, ["INBOX", "UNREAD"]]));
  const moves = [];
  let historyId = 900;
  const touched = new Set();
  let profileFailures = failProfile;
  const state = { moves, labels, profileCalls: 0, tokenCalls: 0, gmailCalls: 0, down: false, expired: false };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  const preflight = (route) =>
    route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" } });
  const gmail = (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return preflight(route);
    const url = new globalThis.URL(request.url());
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    // Every Gmail request the app attempts, answered or not.
    state.gmailCalls += 1;
    // `down`: Google is unreachable (every request fails the way a dead network does).
    if (state.down) return route.abort("internetdisconnected");
    // `expired`: the access token is refused, and the refresh below says invalid_grant.
    if (state.expired) return json(route, { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } }, 401);
    if (path === "/profile") {
      state.profileCalls += 1;
      if (profileFailures > 0) {
        profileFailures -= 1;
        return json(route, { error: { code: 500, message: "Backend Error" } }, 500);
      }
      return json(route, { emailAddress: "me@winnow.example", historyId: String(historyId), messagesTotal: ids.length });
    }
    if (path === "/messages") {
      const q = url.searchParams.get("q") ?? "";
      const has = (label) => ids.filter((id) => labels.get(id).includes(label));
      let list = [];
      if (q.includes("in:inbox") && !q.includes("-in:inbox")) list = has("INBOX");
      else if (q.includes("in:trash")) list = has("TRASH");
      return json(route, list.length ? { messages: list.map((id) => ({ id, threadId: `t-${id}` })), resultSizeEstimate: list.length } : { resultSizeEstimate: 0 });
    }
    const modify = /^\/messages\/(f\d+)\/(modify|trash|untrash)$/.exec(path);
    if (modify) {
      const [, id, verb] = modify;
      const body = verb === "modify" ? JSON.parse(request.postData() ?? "{}") : verb === "trash" ? { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] } : { removeLabelIds: ["TRASH"] };
      moves.push(`${id} +${(body.addLabelIds ?? []).join(",")} -${(body.removeLabelIds ?? []).join(",")}`);
      const next = labels.get(id).filter((label) => !(body.removeLabelIds ?? []).includes(label));
      for (const label of body.addLabelIds ?? []) if (!next.includes(label)) next.push(label);
      labels.set(id, next);
      touched.add(id);
      historyId += 1;
      return json(route, { id, labelIds: next });
    }
    const one = /^\/messages\/(f\d+)$/.exec(path);
    if (one) {
      const n = Number(one[1].slice(1));
      const rich = html[one[1]];
      if (rich) {
        const text = rich.text ?? rich.subject;
        return json(route, {
          id: one[1], threadId: `t-${one[1]}`, labelIds: labels.get(one[1]), snippet: text.slice(0, 120),
          internalDate: String(Date.now() - n * 3_600_000), sizeEstimate: rich.html.length,
          payload: {
            mimeType: "multipart/alternative",
            headers: [
              { name: "From", value: rich.from },
              { name: "To", value: "me@winnow.example" },
              { name: "Subject", value: rich.subject },
              { name: "Date", value: new Date(Date.now() - n * 3_600_000).toUTCString() },
            ],
            body: { size: 0 },
            parts: [
              { partId: "0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { size: text.length, data: b64(text) } },
              { partId: "1", mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { size: rich.html.length, data: b64(rich.html) } },
            ],
          },
        });
      }
      const headers = [
        { name: "From", value: `Sender ${n} <s${n}@fake.example>` },
        { name: "To", value: "me@winnow.example" },
        { name: "Subject", value: `Fake mail ${n}` },
        { name: "Date", value: new Date(Date.now() - n * 3_600_000).toUTCString() },
      ];
      return json(route, {
        id: one[1], threadId: `t-${one[1]}`, labelIds: labels.get(one[1]), snippet: `Fake mail ${n}`,
        internalDate: String(Date.now() - n * 3_600_000), sizeEstimate: 900,
        payload: { mimeType: "text/plain", headers, body: { size: 10, data: b64(`Fake mail ${n}`) } },
      });
    }
    if (path === "/history") {
      const changed = [...touched];
      touched.clear();
      return json(route, { historyId: String(historyId), ...(changed.length ? { history: [{ id: String(historyId), labelsAdded: changed.map((id) => ({ message: { id } })) }] } : {}) });
    }
    if (path === "/drafts") return json(route, {});
    return json(route, {});
  };
  const ctx = await browser.newContext(options);
  if (seed) {
    await ctx.addInitScript((accessToken) => {
      if (window.top !== window) return;
      if (sessionStorage.getItem("seeded-fake-gmail")) return;
      sessionStorage.setItem("seeded-fake-gmail", "1");
      localStorage.setItem("winnow.google.oauthClient", JSON.stringify({ clientId: "1234567890-abc123def.apps.googleusercontent.com" }));
      localStorage.setItem("winnow.gmail.tokens", JSON.stringify({ accessToken, refreshToken: "1//smoke-refresh", expiresAt: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/gmail.modify" }));
    }, FAKE_TOKEN);
  }
  await ctx.route("https://gmail.googleapis.com/**", gmail);
  await ctx.route("https://oauth2.googleapis.com/**", (route) => {
    if (route.request().method() === "OPTIONS") return preflight(route);
    state.tokenCalls += 1;
    return json(route, { error: "invalid_grant" }, 400);
  });
  await ctx.route("https://people.googleapis.com/**", (route) => json(route, {}));
  await ctx.route("https://www.googleapis.com/**", (route) => json(route, {}));
  return { ctx, state };
}
