/**
 * One message, with the HTML half of it, for the demo mailbox to show what the
 * reader does with a real newsletter.
 *
 * It is here for a specific reason rather than as decoration. The change that made
 * a newsletter render like a newsletter also introduced a sanitiser, a three-way
 * view switch, an image-consent flow that only appears when there is something to
 * consent to, and a proxy. All of that is invisible in a demo whose messages are
 * plain text — and an invisible feature is one nobody reviews.
 *
 * So this body is written to be *awkward*, in the ways real marketing mail is:
 *
 *   - it arrives as a whole document, because most HTML mail does, and an
 *     implementation that treats `html`/`body`/`head` as content to skip shows an
 *     empty reader;
 *   - it has its layout in a `<style>` block rather than in attributes, which the
 *     app drops and the proxy keeps — so the same message looks like two different
 *     emails in two different views, which is the honest answer;
 *   - it names two remote images and embeds one, so the "images are off" offer has
 *     something to be an offer about;
 *   - it has an `onclick`, a `<script>`, a `javascript:` link, a tracking pixel and
 *     a conditional comment, so the sanitiser's rules are doing visible work on the
 *     one screen somebody will actually look at;
 *   - its remote images are `https://cdn.winnow.example`, which does not resolve.
 *     A demo that reached the real internet would be a demo that made a request
 *     because somebody clicked something, and a placeholder that 404s is both safer
 *     and a more honest demonstration of what "blocked" looks like.
 */

/** A 1×1 transparent GIF, the shape an inline logo usually takes. */
const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * A wide illustration, so an embedded image has some actual size on screen.
 *
 * A 2px gradient bar would be the same picture; this is three phone-shaped
 * panels, because the thing a reader is checking is whether an `<img>` inside a
 * `<td>` inside a table lands at the right width, and a bar that thin cannot tell
 * them. Which is also why it is an SVG rather than a PNG: most brand logos now
 * are, and the sanitiser has to treat `data:image/svg+xml` in an image slot as
 * inert while treating the same bytes behind a link as a document.
 */
const HERO = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1NzYgMTgwIiB3aWR0aD0iNTc2IiBoZWlnaHQ9IjE4MCI+CjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iYmciIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNkM5Q0ZEIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMEEzRUVGIi8+CjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgo8cmVjdCB3aWR0aD0iNTc2IiBoZWlnaHQ9IjE4MCIgZmlsbD0idXJsKCNiZykiLz4KPGcgZmlsbD0iI0ZGRkZGRiI+CjxyZWN0IHg9IjQwIiB5PSIyNiIgd2lkdGg9IjE1MCIgaGVpZ2h0PSIxMjgiIHJ4PSIxNCIgZmlsbC1vcGFjaXR5PSIwLjk1Ii8+CjxyZWN0IHg9IjIxMyIgeT0iMjYiIHdpZHRoPSIxNTAiIGhlaWdodD0iMTI4IiByeD0iMTQiIGZpbGwtb3BhY2l0eT0iMC44Ii8+CjxyZWN0IHg9IjM4NiIgeT0iMjYiIHdpZHRoPSIxNTAiIGhlaWdodD0iMTI4IiByeD0iMTQiIGZpbGwtb3BhY2l0eT0iMC42NSIvPgo8L2c+CjxnIGZpbGw9IiMyRjVCRDAiPgo8cmVjdCB4PSI1NiIgeT0iNDQiIHdpZHRoPSI4NiIgaGVpZ2h0PSI5IiByeD0iNC41Ii8+CjxyZWN0IHg9IjU2IiB5PSI2MiIgd2lkdGg9IjExOCIgaGVpZ2h0PSI3IiByeD0iMy41IiBmaWxsLW9wYWNpdHk9IjAuNTUiLz4KPHJlY3QgeD0iMjI5IiB5PSI0NCIgd2lkdGg9IjEwMCIgaGVpZ2h0PSI5IiByeD0iNC41Ii8+CjxyZWN0IHg9IjIyOSIgeT0iNjIiIHdpZHRoPSI3MiIgaGVpZ2h0PSI3IiByeD0iMy41IiBmaWxsLW9wYWNpdHk9IjAuNSIvPgo8cmVjdCB4PSI0MDIiIHk9IjQ0IiB3aWR0aD0iOTQiIGhlaWdodD0iOSIgcng9IjQuNSIvPgo8cmVjdCB4PSI0MDIiIHk9IjYyIiB3aWR0aD0iMTE4IiBoZWlnaHQ9IjciIHJ4PSIzLjUiIGZpbGwtb3BhY2l0eT0iMC40NSIvPgo8cmVjdCB4PSI0MDIiIHk9Ijc4IiB3aWR0aD0iODgiIGhlaWdodD0iNyIgcng9IjMuNSIgZmlsbC1vcGFjaXR5PSIwLjQ1Ii8+CjwvZz4KPGcgZmlsbD0iIzJGNUJEMCIgZmlsbC1vcGFjaXR5PSIwLjIyIj4KPHJlY3QgeD0iNTYiIHk9Ijg2IiB3aWR0aD0iMTE4IiBoZWlnaHQ9IjUyIiByeD0iOCIvPgo8cmVjdCB4PSIyMjkiIHk9Ijg2IiB3aWR0aD0iMTE4IiBoZWlnaHQ9IjUyIiByeD0iOCIvPgo8cmVjdCB4PSI0MDIiIHk9IjEwMCIgd2lkdGg9IjExOCIgaGVpZ2h0PSIzOCIgcng9IjgiLz4KPC9nPgo8L3N2Zz4=";

/**
 * The HTML half of the demo newsletter.
 *
 * Exported rather than inlined so `demo.ts` keeps one seed entry readable, and so
 * this can be pointed at from a test without dragging the whole seed in.
 */
export const DEMO_NEWSLETTER_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!--[if mso]><table><tr><td><![endif]-->
<style>
  .hero { background: #6C9CFD; padding: 44px 32px; }
  .hero h1 { font-family: Georgia, "Times New Roman", serif; font-size: 40px;
             line-height: 1.1; margin: 0 0 14px; font-weight: 400; }
  .hero h1 em { color: #1F3F7A; font-style: italic; }
  .hero p { margin: 0 0 26px; font-size: 15px; color: #16305C; max-width: 34em; }
  .button { display: inline-block; background: #101828; color: #FFFFFF;
            padding: 15px 40px; border-radius: 999px; text-decoration: none;
            font-size: 16px; font-weight: 600; }
  .card { border: 1px solid #E3E7EB; border-radius: 14px; padding: 22px;
          margin: 0 0 14px; }
  .card h2 { font-size: 16px; margin: 0 0 6px; }
  .card p { margin: 0; color: #56616B; font-size: 14px; }
  .foot { color: #7A838C; font-size: 12px; padding: 28px 32px 40px; }
  .foot a { color: #7A838C; }
</style>
<!--[if mso]></td></tr></table><![endif]-->
</head>
<body style="margin:0;padding:0;background:#F4F6F8;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    Hark Pro is here — the operating system for your life.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:#F4F6F8;">
    <tr><td align="center" style="padding:0;">

      <table role="presentation" width="640" cellpadding="0" cellspacing="0"
             style="width:640px;max-width:100%;background:#FFFFFF;border-radius:16px;
                    overflow:hidden;box-shadow:0 8px 32px rgba(16,24,40,0.08);">

        <tr><td style="padding:30px 32px 8px;">
          <table role="presentation" width="100%"><tr>
            <td><img src="${PIXEL}" width="120" height="40" alt="hark"
                       style="width:120px;height:40px;"></td>
            <td align="right" style="color:#7A838C;font-size:12px;">No. 14</td>
          </tr></table>
        </td></tr>

        <tr><td class="hero" style="background:#6C9CFD;padding:44px 32px;">
          <h1>hark <em>pro</em> is here</h1>
          <p>
            It remembers what you tell it, uses its own cloud computer, and solves
            problems you might not realise you had — across your whole day, not just
            your inbox.
          </p>
          <a class="button" href="https://hark.example/login"
             onclick="track('cta-hero')">Sign in</a>
        </td></tr>

        <tr><td style="padding:30px 32px 8px;">
          <img src="${HERO}" width="576" alt="Three screens: chat, flights, and your day"
               style="width:100%;height:auto;border-radius:12px;">
          <p style="color:#7A838C;font-size:12px;margin:8px 0 24px;">
            Chat, travel, and the morning brief — one thing instead of five.
          </p>

          <div class="card">
            <h2>It keeps track of life, work and school</h2>
            <p>Buys groceries to concert tickets. Stores logins securely, pays bills,
               and spots the offers you would have liked.</p>
          </div>

          <div class="card">
            <h2>It plans a week ahead</h2>
            <p>Six weeks of migration and a compliance window in the middle of it —
               and it notices the collision before you do.</p>
          </div>

          <div class="card">
            <h2>It is not a chatbot</h2>
            <p>Not a personal assistant, not an agent, not a cartoon character.
               Something that learns who you are in order to prioritise your
               wellbeing rather than exploit it.</p>
          </div>
        </td></tr>

        <tr><td class="foot" style="color:#7A838C;font-size:12px;padding:28px 32px 40px;">
          <p style="margin:0 0 10px;">
            You are receiving this because you subscribed to our list.
            <a href="https://hark.example/unsubscribe">Unsubscribe</a>
          </p>
          <p style="margin:0;">
            <a href="https://app.example/ios">iOS</a> ·
            <a href="https://app.example/android">Android</a> ·
            <a href="https://app.example/web">Web</a>
          </p>
          <!-- The tracking pixel. It is here on purpose: this is the thing the
               reader's image offer exists for, and a demo without one cannot
               demonstrate an offer to decide about a pixel. -->
          <img src="https://cdn.winnow.example/open.gif" width="1" height="1" alt=""
               style="width:1px;height:1px;">
          <img src="https://cdn.winnow.example/hero@2x.png" width="576" alt=""
               style="width:100%;height:auto;" aria-hidden="true">
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

/**
 * The text half of the same message.
 *
 * Written out rather than extracted from the HTML, and that is the point: the text
 * is what the classifier reads and what a reply quotes, so it has to be a real
 * rendering of the message rather than whatever a tag stripper produced.
 */
export const DEMO_NEWSLETTER_TEXT = `Introducing Hark Pro

Hark Pro is here. It remembers what you tell it, uses its own cloud computer, and solves problems you might not realise you had.

Sign in: https://hark.example/login

It keeps track of life, work and school, and buys everything from groceries to concert tickets. It stores logins securely, pays bills, and spots opportunities you'll love.

It plans a week ahead — six weeks of migration and a compliance window in the middle of it — and it notices the collision before you do.

Our goal is true personal intelligence. Not a chatbot, not a personal assistant, not an AI agent, not a cartoon character. Something that learns who you are to prioritise your wellbeing rather than exploiting it.

See for yourself: https://app.example/web

© 2026 Hark, Inc. · 4000 N 1st St, San Jose, CA 95134 · USA
You received this email because you subscribed to our list. Unsubscribe: https://hark.example/unsubscribe`;