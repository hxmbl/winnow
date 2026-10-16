/**
 * Remote content, from the network's point of view.
 *
 * `sanitize.test.ts` asserts on what each rule removes. This file asserts the one thing
 * those rules are for: with images withheld, the sanitised document names *nothing* a
 * browser would fetch. Every vector a tracking email uses to learn that it was opened is
 * thrown at the sanitiser at once, in both the inline form and the "as sent" document,
 * and the output is searched for any remote address outside a link.
 */

import { describe, expect, it } from "vitest";
import { emailDocument, sanitizeMailHtml } from "./sanitize";

const T = "https://t.example/o";

/** One of each way a message can make the reader's browser ask a server for something. */
const VECTORS = [
  `<img src="${T}/img.gif">`,
  `<img src="//t.example/proto.gif">`,
  `<img srcset="${T}/a.gif 1x, ${T}/b.gif 2x">`,
  `<img src="data:image/gif;base64,R0lGOD" srcset="${T}/c.gif 2x">`,
  `<table background="${T}/bg.gif"><tr><td background="${T}/td.gif">x</td></tr></table>`,
  `<body background="${T}/body.gif">`,
  `<div style="background:url(${T}/css.gif)">x</div>`,
  `<div style="background-image:url('${T}/q.gif')">x</div>`,
  `<div style="background:u\\72l(${T}/esc.gif)">x</div>`,
  `<div style="background:image-set('${T}/set.gif' 1x)">x</div>`,
  `<div style="list-style-image:url(${T}/li.gif);cursor:url(${T}/cur.cur),auto">x</div>`,
  `<div style="border-image:url(${T}/border.gif) 30">x</div>`,
  `<div style="background:url(&quot;${T}/ent.gif&quot;)">x</div>`,
  `<style>@import url(${T}/import.css); @import "${T}/import2.css";</style>`,
  `<style>@font-face{font-family:x;src:url(${T}/font.woff)}</style>`,
  `<style>.a{background:url(${T}/sheet.gif)} .b::after{content:url(${T}/after.gif)}</style>`,
  `<link rel="stylesheet" href="${T}/link.css"><link rel="prefetch" href="${T}/prefetch">`,
  `<link rel="dns-prefetch" href="//t.example"><link rel="preconnect" href="${T}">`,
  `<meta http-equiv="refresh" content="0;url=${T}/refresh">`,
  `<iframe src="${T}/frame"></iframe><frame src="${T}/frame2">`,
  `<form action="${T}/form"><input type="image" src="${T}/input.gif"></form>`,
  `<svg><image href="${T}/svg.gif"/><use href="${T}/sprite.svg#a"/></svg>`,
  `<svg><image xlink:href="${T}/svg2.gif"/></svg>`,
  `<image src="${T}/image-tag.gif">`,
  `<video poster="${T}/poster.gif"><source src="${T}/v.mp4"></video><audio src="${T}/a.mp3"></audio>`,
  `<object data="${T}/obj"></object><embed src="${T}/embed">`,
  `<picture><source srcset="${T}/pic.webp"><img src="${T}/pic.gif"></picture>`,
  `<base href="${T}/"><img src="relative.gif">`,
  `<a href="https://shop.example/" ping="${T}/ping">link</a>`,
  `<img src="x" lowsrc="${T}/low.gif" dynsrc="${T}/dyn.gif">`,
  `<bgsound src="${T}/sound.wav"><input type="image" src="${T}/i2.gif">`,
  `<script src="${T}/s.js"></script><noscript><img src="${T}/ns.gif"></noscript>`,
  `<div style="behavior:url(${T}/x.htc)">x</div>`,
].join("\n");

/**
 * Every remote address the output names outside an `href` (a link fetches nothing until
 * clicked) and outside `data-wn-blocked-src` (an inert attribute the reader keeps so the
 * image offer can count what it withheld).
 */
function fetchable(html: string): string[] {
  const inert = html
    .replace(/\shref="[^"]*"/g, "")
    .replace(/\sdata-wn-blocked-src="[^"]*"/g, "");
  return inert.match(/(?:https?:)?\/\/t\.example[^\s"')]*/g) ?? [];
}

describe("withheld remote content leaves nothing to fetch", () => {
  it("inline: no vector survives as something a browser would request", () => {
    const result = sanitizeMailHtml(VECTORS, { allowRemote: false });
    expect(fetchable(result.html)).toEqual([]);
    expect(result.blockedRemote).toBeGreaterThan(0);
  });

  it("as sent: the sender's own stylesheets are kept, and still fetch nothing", () => {
    const result = sanitizeMailHtml(VECTORS, { allowRemote: false, collectStyles: true });
    const doc = emailDocument(result.html, result.stylesheets);
    expect(fetchable(doc)).toEqual([]);
  });

  it("the only link left is the anchor itself, with no ping and no referrer", () => {
    const { html } = sanitizeMailHtml(VECTORS, { allowRemote: false });
    expect(html).not.toMatch(/\sping=/);
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("css never fetches, even when images are allowed", () => {
    const result = sanitizeMailHtml(VECTORS, { allowRemote: true, collectStyles: true });
    const doc = emailDocument(result.html, result.stylesheets);
    const remote = fetchable(doc);
    // Only <img src> / srcset / background attributes may load once the reader says yes.
    expect(remote.every((url) => /img|proto|[abc]\.gif|bg|td|pic|low|dyn/.test(url))).toBe(true);
    expect(remote.some((url) => /css|import|font|sheet|after|esc|set\.gif|border|li\.gif/.test(url))).toBe(false);
  });
});

describe("an allowed image sends no referrer", () => {
  it("every rendered <img> with a src says referrerpolicy=no-referrer", () => {
    const { html } = sanitizeMailHtml(`<img src="${T}/ok.gif"><p><img src="data:image/png;base64,iVBOR"></p>`, {
      allowRemote: true,
    });
    const images = html.match(/<img [^>]*>/g) ?? [];
    expect(images).toHaveLength(2);
    for (const image of images) expect(image).toContain('referrerpolicy="no-referrer"');
  });

  it("the standalone document carries a no-referrer policy for what it loads", () => {
    expect(emailDocument("<p>x</p>")).toContain('<meta name="referrer" content="no-referrer">');
  });
});
