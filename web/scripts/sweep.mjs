/**
 * The theme sweep: every look Winnow can take, photographed, checked and laid out on
 * contact sheets, for the combinations nobody uses day to day.
 *
 *   npm run sweep                       build, capture, check, stitch
 *   WINNOW_SWEEP_OUT=dir npm run sweep  where the PNGs, sheets, sweep.pdf and the report go
 *
 * A manual tool, not a test: it is not part of `npm run smoke` or CI, and it never fails
 * the shell on a finding (only on a crash). Every theme mode (light, dark, OLED; `system`
 * resolves to light or dark and is shot once each) × every accent the Settings offer
 * (`ACCENT_THEMES`, read from `core/model/appearance.ts` so a new accent is swept without
 * touching this file) × a phone (390×844, Android user agent, 40/28px safe-area insets)
 * and a desktop (1440×900), on these screens:
 *
 *   inbox · reader · drawer (phone dock menu / desktop sidebar) · settings (as it opens,
 *   then a long category scrolled to its end) · the Appearance picker · compose ·
 *   the status pill carrying an Undo · inbox clear (a fake Gmail with an empty inbox)
 *   · the phone reader scrolled partway down a long message, its pill folded (extras,
 *   both hands, light/dark/OLED)
 *
 * then each other setting or OS preference that changes how the app looks (sort order,
 * remote images, brand logos, Gravatar, reduced transparency, forced colours, a small
 * phone, a tablet width) once in a default theme.
 *
 * Checks while it shoots, recorded per screen in `results/*.json` and summed up in
 * `sweep-report.md`:
 *   - page errors and console errors;
 *   - text clipped by an `overflow: hidden` box without an ellipsis or line clamp, text
 *     pushed off the viewport, and sideways page scroll;
 *   - WCAG contrast of every visible text run against the pixels actually behind it (the
 *     page is shot a second time with text hidden, so glass, gradients and blur count):
 *     AA (4.5, or 3 for large text) for primary text and for pill/chip text; the rest is
 *     listed separately as informational.
 *
 * Environment:
 *   WINNOW_PORT (4573)        the `vite preview` port
 *   WINNOW_CHROMIUM           a system Chromium instead of Playwright's
 *   WINNOW_SWEEP_OUT          output directory (default web/.sweep, ignored by git)
 *   WINNOW_SWEEP_PHASE        capture | sheets | all (default all)
 *   WINNOW_SWEEP_MODES        comma list to capture a subset (e.g. "oled"), or "extras"
 *   WINNOW_SWEEP_DEVICES      comma list: phone,desktop
 *   WINNOW_SWEEP_JOBS         parallel browser contexts (default 3)
 *
 * Runs in chunks too: each combination writes its own result file, and `sheets` stitches
 * whatever is there.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";
import { signedInContext } from "./fake-gmail.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.WINNOW_PORT ?? 4573);
const URL = `http://localhost:${PORT}/`;
const OUT = path.resolve(process.env.WINNOW_SWEEP_OUT ?? path.join(ROOT, ".sweep"));
const PHASE = process.env.WINNOW_SWEEP_PHASE ?? "all";
const JOBS = Math.max(1, Number(process.env.WINNOW_SWEEP_JOBS ?? 3));
const listEnv = (name) => (process.env[name] ? process.env[name].split(",").map((s) => s.trim()).filter(Boolean) : null);
const ONLY_MODES = listEnv("WINNOW_SWEEP_MODES");
const ONLY_DEVICES = listEnv("WINNOW_SWEEP_DEVICES");
const SHOTS = path.join(OUT, "shots");
const RESULTS = path.join(OUT, "results");

/** The vocabulary, read from the source rather than copied, so a new accent is swept. */
function vocabulary() {
  const source = readFileSync(path.join(ROOT, "src/core/model/appearance.ts"), "utf8");
  const list = (name) => {
    const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
    if (!match) throw new Error(`sweep: cannot find ${name} in appearance.ts`);
    return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  return { appearances: list("APPEARANCES"), accents: list("ACCENT_THEMES") };
}

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";
const DEVICES = {
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: ANDROID_UA, insets: { top: 40, bottom: 28 } },
  desktop: { viewport: { width: 1440, height: 900 } },
  "phone-small": { viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true, userAgent: ANDROID_UA, insets: { top: 24, bottom: 16 }, phone: true },
  tablet: { viewport: { width: 800, height: 1100 } },
};
const isPhone = (device) => device === "phone" || DEVICES[device].phone === true;

const SCREENS = ["inbox", "reader", "drawer", "settings-top", "settings-end", "appearance", "compose", "pill-undo", "inbox-clear"];

/** One job per mode × accent × device, then the extras, each with its own screens. */
function plan() {
  const { appearances, accents } = vocabulary();
  const jobs = [];
  const modes = appearances.filter((a) => a !== "system");
  for (const mode of modes) {
    for (const accent of accents) {
      for (const device of ["phone", "desktop"]) {
        jobs.push({ id: `${mode}-${accent}-${device}`, group: mode, mode, accent, device, scheme: mode === "light" ? "light" : "dark", screens: SCREENS, prefs: {} });
      }
    }
  }
  const extra = (id, mode, scheme, device, screens, more = {}) =>
    jobs.push({ id: `x-${id}-${device}`, group: "extras", label: id, mode, accent: accents[0], device, scheme, screens, prefs: {}, ...more });
  for (const device of ["phone", "desktop"]) {
    if (appearances.includes("system")) {
      extra("system→light", "system", "light", device, ["inbox"]);
      extra("system→dark", "system", "dark", device, ["inbox"]);
    }
    extra("sort-sender", "light", "light", device, ["inbox"], { prefs: { sortBy: "sender" } });
    extra("sort-score", "light", "light", device, ["inbox"], { prefs: { sortBy: "score" } });
    extra("images-always", "light", "light", device, ["reader"], { prefs: { imagePolicy: "always" } });
    extra("images-never", "light", "light", device, ["reader"], { prefs: { imagePolicy: "never" } });
    extra("brand-logos", "light", "light", device, ["inbox", "reader"], { prefs: { brandLogos: true } });
    extra("gravatars", "light", "light", device, ["inbox"], { prefs: { gravatars: true } });
    extra("reduced-transparency-light", "light", "light", device, ["inbox", "drawer", "pill-undo"], { media: { reducedTransparency: true } });
    extra("reduced-transparency-oled", "oled", "dark", device, ["inbox", "drawer", "pill-undo"], { media: { reducedTransparency: true } });
    extra("forced-colors", "light", "light", device, ["inbox", "reader", "drawer", "settings-top", "compose"], { media: { forcedColors: true } });
  }
  // Left-handed mode mirrors the phone's reader pill and compose button (phone only).
  extra("left-handed-light", "light", "light", "phone", ["inbox", "reader", "drawer", "compose"], { prefs: { leftHanded: true } });
  extra("left-handed-oled", "oled", "dark", "phone", ["inbox", "reader", "drawer", "compose"], { prefs: { leftHanded: true } });
  // A Settings dropdown open, phone and desktop, light and dark.
  for (const device of ["phone", "desktop"]) {
    extra("settings-dropdown-light", "light", "light", device, ["appearance-menu"]);
    extra("settings-dropdown-dark", "dark", "dark", device, ["appearance-menu"]);
  }
  // The phone reader while reading down: the long demo newsletter scrolled partway, so the
  // reader pill has folded to its ••• circle. Both hands, the three modes.
  for (const mode of ["light", "dark", "oled"]) {
    const scheme = mode === "light" ? "light" : "dark";
    extra(`reader-scrolled-right-${mode}`, mode, scheme, "phone", ["reader-scrolled"]);
    extra(`reader-scrolled-left-${mode}`, mode, scheme, "phone", ["reader-scrolled"], { prefs: { leftHanded: true } });
  }
  extra("small-phone-dark", "dark", "dark", "phone-small", ["inbox", "drawer", "settings-end", "compose", "pill-undo"]);
  extra("tablet-light", "light", "light", "tablet", ["inbox", "reader", "drawer"]);
  return jobs.filter(
    (job) =>
      (!ONLY_MODES || ONLY_MODES.includes(job.group) || ONLY_MODES.includes(job.mode) && job.group !== "extras") &&
      (!ONLY_DEVICES || ONLY_DEVICES.includes(job.device) || (job.group === "extras" && !["phone", "desktop"].includes(job.device))),
  );
}

// ── In-page audit: overflow and the text runs to measure ──────────────────────────
function auditInPage() {
  const vw = innerWidth;
  const vh = innerHeight;
  const out = { hscroll: Math.max(0, document.scrollingElement.scrollWidth - vw), overflow: [], texts: [] };
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const label = (el) => {
    const keys = [...el.attributes].map((a) => a.name).filter((n) => n.startsWith("data-") && n !== "data-sweep");
    let at = el;
    let named = keys[0];
    while (!named && at.parentElement && at !== document.body) {
      at = at.parentElement;
      named = [...at.attributes].map((a) => a.name).find((n) => n.startsWith("data-"));
    }
    return `${el.tagName.toLowerCase()}${named ? `[${named}]` : ""}`;
  };
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest("script, style, noscript, [inert], [data-row-ghost], [aria-hidden='true'], svg, iframe")) continue;
    // Visible at all, and how opaque.
    let opacity = 1;
    let hidden = false;
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || s.contentVisibility === "hidden") {
        hidden = true;
        break;
      }
      opacity *= Number(s.opacity);
    }
    if (hidden || opacity < 0.15) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    const r = {
      left: Math.min(...rects.map((x) => x.left)),
      top: Math.min(...rects.map((x) => x.top)),
      right: Math.max(...rects.map((x) => x.right)),
      bottom: Math.max(...rects.map((x) => x.bottom)),
    };
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;

    // Clipping by an ancestor, stopping at the first scroll container.
    let ellipsis = false;
    let clamp = false;
    let scroller = false;
    let srOnly = false;
    let clipped = null;
    // The part of the run that is actually painted: cut by every clipping box up to the
    // first scroller (an ellipsised line's range runs on past its box) and the viewport.
    const vis = { left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, vw), bottom: Math.min(r.bottom, vh) };
    const cut = (a) => {
      vis.left = Math.max(vis.left, a.left);
      vis.top = Math.max(vis.top, a.top);
      vis.right = Math.min(vis.right, a.right);
      vis.bottom = Math.min(vis.bottom, a.bottom);
    };
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.textOverflow === "ellipsis") ellipsis = true;
      if (s.webkitLineClamp && s.webkitLineClamp !== "none") clamp = true;
      const ox = s.overflowX;
      const oy = s.overflowY;
      if (ox === "auto" || ox === "scroll" || oy === "auto" || oy === "scroll") {
        cut(e.getBoundingClientRect());
        scroller = true;
        break;
      }
      if (ox === "hidden" || ox === "clip" || oy === "hidden" || oy === "clip" || s.clipPath !== "none") {
        const a = e.getBoundingClientRect();
        if (a.width <= 2 || a.height <= 2) {
          srOnly = true;
          break;
        }
        if (s.clipPath !== "none") continue;
        cut(a);
        const overX = (ox === "hidden" || ox === "clip") && (r.right > a.right + 1.5 || r.left < a.left - 1.5);
        const overY = (oy === "hidden" || oy === "clip") && (r.bottom > a.bottom + 2 || r.top < a.top - 2);
        if ((overX && !ellipsis) || (overY && !clamp && !ellipsis)) {
          clipped ??= { by: label(e), axis: overX ? "x" : "y", text: { ...r }, box: { left: a.left, top: a.top, right: a.right, bottom: a.bottom } };
        }
      }
    }
    if (srOnly || vis.right - vis.left < 2 || vis.bottom - vis.top < 2) continue;
    // Covered by something else (an opaque page, the dock, a sheet): not on screen, so
    // neither its clipping nor its contrast is what the user sees.
    // Sampled at the run's left, middle and right, so text half under the dock or a
    // frosted chip row counts as covered too.
    const cy = Math.min(vh - 1, Math.max(0, (vis.top + vis.bottom) / 2));
    const xs = [vis.left + 2, (vis.left + vis.right) / 2, vis.right - 2].map((x) => Math.min(vw - 1, Math.max(0, x)));
    const hits = (top) => top && (top === el || el.contains(top) || top.contains(el) || (top.closest("label, button, a") !== null && top.closest("label, button, a") === el.closest("label, button, a")));
    if (!xs.every((x) => hits(document.elementFromPoint(x, cy)))) continue;
    const snippet = text.slice(0, 60);
    if (clipped) out.overflow.push({ kind: "clipped", el: label(el), textSample: snippet, ...clipped });
    if (!scroller && (r.right > vw + 1.5 || r.left < -1.5)) out.overflow.push({ kind: "off-viewport", el: label(el), textSample: snippet, text: { ...r } });

    const s = getComputedStyle(el);
    if (el.closest(":disabled, [aria-disabled='true']")) continue;
    const fill = s.webkitTextFillColor && parse(s.webkitTextFillColor)?.[3] > 0 ? s.webkitTextFillColor : s.color;
    const color = parse(fill);
    if (!color || color[3] === 0) continue;
    const size = parseFloat(s.fontSize);
    const weight = Number(s.fontWeight) || 400;
    const kind = el.closest("[data-rail-item], .wn-pill, [data-status-pill], [data-phone-chips], [data-filter-tag], [data-code-chip], [data-dock-badge], [data-pill-text], [data-pill-label], [data-pill-undo], [data-selection-filters]")
      ? "chip"
      : el.closest("[data-row-sender], [data-row-subject], [data-reader-subject], [data-reader-sender], [data-settings-title], [data-clear-headline], [data-settings-row] label, [data-composer] input, [data-composer] textarea, h1, h2, h3, [data-phone-topbar] [data-masthead], [data-nav] button, [data-mail-nav] button, [role='tab'], [role='menuitem'], [data-email-body], [data-reader] p")
        ? "primary"
        : "other";
    out.texts.push({
      text: snippet,
      el: label(el),
      kind,
      color: [color[0], color[1], color[2], color[3] * opacity],
      large: size >= 24 || (size >= 18.66 && weight >= 700),
      size,
      rect: { x: Math.floor(vis.left), y: Math.floor(vis.top), w: Math.ceil(vis.right - vis.left), h: Math.ceil(vis.bottom - vis.top) },
    });
  }
  return out;
}

/** Decode a PNG and read the colours behind each text run (in a helper page). */
function backgroundsInPage({ data, rects }) {
  return (async () => {
    const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    const lum = (r, gg, b) => {
      const c = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * c(r) + 0.7152 * c(gg) + 0.0722 * c(b);
    };
    return rects.map(({ x, y, w, h }) => {
      const W = Math.max(1, Math.min(w, bitmap.width - x));
      const H = Math.max(1, Math.min(h, bitmap.height - y));
      if (x >= bitmap.width || y >= bitmap.height) return null;
      const px = g.getImageData(x, y, W, H).data;
      const samples = [];
      const step = Math.max(1, Math.floor((W * H) / 4000));
      for (let i = 0; i < W * H; i += step) {
        const o = i * 4;
        samples.push([px[o], px[o + 1], px[o + 2], lum(px[o], px[o + 1], px[o + 2])]);
      }
      samples.sort((a, b) => a[3] - b[3]);
      const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * (samples.length - 1)))].slice(0, 3);
      return { low: at(0.1), mid: at(0.5), high: at(0.9) };
    });
  })();
}

const HIDE_TEXT = `*, *::before, *::after, ::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; caret-color: transparent !important; transition: none !important; animation-play-state: paused !important; }
svg, img, video, canvas { visibility: hidden !important; }`;

const lumOf = ([r, g, b]) => {
  const c = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [lumOf(a), lumOf(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = ([r, g, b, a], bg) => [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];

/** Shoot the screen, audit it, and measure its text against what is behind it. */
async function capture(page, helper, job, screen, errors) {
  const file = `${job.id}--${screen}.png`;
  await page.screenshot({ path: path.join(SHOTS, file) });
  const audit = await page.evaluate(auditInPage);
  const style = await page.addStyleTag({ content: HIDE_TEXT });
  await page.waitForTimeout(60);
  const bare = await page.screenshot({ scale: "css" });
  await style.evaluate((node) => node.remove());
  const bgs = await helper.evaluate(backgroundsInPage, { data: bare.toString("base64"), rects: audit.texts.map((t) => t.rect) });
  const contrast = [];
  // Under forced colours the system palette paints text and backgrounds (and ignores the
  // text-hiding style), so there is nothing of Winnow's to measure.
  if (job.media?.forcedColors) audit.texts = [];
  // The lowest ratio measured per kind, so a clean screen still shows the check ran.
  const lowest = {};
  audit.texts.forEach((t, i) => {
    const bg = bgs[i];
    if (!bg) return;
    const worst = Math.min(...[bg.low, bg.mid, bg.high].map((b) => ratio(over(t.color, b), b)));
    const mid = ratio(over(t.color, bg.mid), bg.mid);
    if (!lowest[t.kind] || worst < lowest[t.kind].ratio) lowest[t.kind] = { ratio: +worst.toFixed(2), text: t.text.slice(0, 30), count: (lowest[t.kind]?.count ?? 0) + 1 };
    else lowest[t.kind].count += 1;
    const need = t.large ? 3 : 4.5;
    if (worst < need) {
      contrast.push({ text: t.text, el: t.el, kind: t.kind, worst: +worst.toFixed(2), median: +mid.toFixed(2), need, size: t.size, color: `rgba(${t.color.map((v, k) => (k < 3 ? Math.round(v) : +v.toFixed(2))).join(",")})`, bg: `rgb(${bg.mid.join(",")})` });
    }
  });
  // Chromium's own intervention when the inbox-clear haptic fires before a tap: not the app's error.
  const pageErrors = errors.splice(0).filter((e) => !/Blocked call to navigator\.vibrate/.test(e));
  return { screen, file, hscroll: audit.hscroll, overflow: audit.overflow, contrast, lowest, texts: audit.texts.length, errors: pageErrors };
}

/** Let motion finish: two frames, then a fixed wait. */
async function settle(page, ms = 450) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(ms);
}

/** One finger from the row's middle by dx (the swipe smoke's drag). */
async function swipe(page, cdp, locator, dx = -240) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2 + 60;
  const y = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 12; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 12, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function scrollToEnd(page, within) {
  await page.evaluate((sel) => {
    const root = document.querySelector(sel) ?? document.body;
    for (const el of [root, ...root.querySelectorAll("*")]) {
      const s = getComputedStyle(el);
      if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 2) el.scrollTop = el.scrollHeight;
    }
  }, within);
}

async function newContext(browser, job, { empty = false } = {}) {
  const device = DEVICES[job.device];
  const options = {
    viewport: device.viewport,
    hasTouch: Boolean(device.hasTouch),
    isMobile: Boolean(device.isMobile),
    colorScheme: job.scheme,
    deviceScaleFactor: 1,
    ...(device.userAgent ? { userAgent: device.userAgent } : {}),
    ...(job.media?.forcedColors ? { forcedColors: "active" } : {}),
  };
  const prefs = { appearance: job.mode, accent: job.accent, ...job.prefs };
  const made = empty ? await signedInContext(browser, options, { count: 0 }) : { ctx: await browser.newContext(options) };
  const ctx = made.ctx;
  await ctx.addInitScript((prefs) => {
    if (window.top !== window) return;
    const raw = localStorage.getItem("winnow.preferences.v1");
    const stored = raw ? JSON.parse(raw) : {};
    localStorage.setItem("winnow.preferences.v1", JSON.stringify({ ...stored, ...prefs }));
  }, prefs);
  // No outside network: avatars, logos and remote images that would be fetched answer empty.
  await ctx.route(/^https:\/\/(?!(gmail|oauth2|people|www)\.googleapis\.com)/, (route) => route.fulfill({ status: 204, body: "" }));
  return ctx;
}

async function openPage(ctx, job, errors) {
  const page = await ctx.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error).slice(0, 300)}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 300)}`);
  });
  const cdp = await ctx.newCDPSession(page);
  const device = DEVICES[job.device];
  if (device.insets) await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: device.insets }).catch(() => undefined);
  if (job.media?.reducedTransparency) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }, { name: "prefers-color-scheme", value: job.scheme }] });
  }
  return { page, cdp };
}

async function load(page, { empty = false } = {}) {
  await page.goto(URL, { waitUntil: "networkidle" });
  if (empty) await page.waitForSelector("[data-empty-kind]", { timeout: 10_000 });
  else await page.waitForSelector("[data-row-count] [data-row-id]", { timeout: 10_000 });
  await settle(page, 600);
}

const ROW = "[data-row-count] [data-row-id] button[data-message-id]";

/** Bring one screen up from a fresh load. */
async function stage(page, cdp, job, screen) {
  const phone = isPhone(job.device);
  const tap = (loc) => (phone ? loc.tap() : loc.click());
  switch (screen) {
    case "inbox":
      return;
    case "reader":
      await tap(page.locator(ROW).first());
      await page.locator("[data-reader]").first().waitFor({ timeout: 5_000 });
      await settle(page, 700);
      return;
    case "reader-scrolled": {
      // The demo newsletter ("Introducing Hark Pro") is the longest message, over 1000px
      // of scroll on a phone. The list is windowed, so scroll until its row is mounted.
      const newsletter = page.locator(ROW, { hasText: "Introducing Hark Pro" }).first();
      for (let step = 0; step < 40 && (await newsletter.count()) === 0; step += 1) {
        await page.evaluate(() => {
          const list = document.querySelector("[data-row-count]");
          const scroller = list?.closest(".overflow-y-auto") ?? document.scrollingElement;
          scroller.scrollTop += 400;
        });
        await page.waitForTimeout(120);
      }
      await newsletter.scrollIntoViewIfNeeded();
      await tap(newsletter);
      await page.locator("[data-reader]").first().waitFor({ timeout: 5_000 });
      await settle(page, 700);
      // Partway down, in steps, the way reading scrolls: the pill folds on the way down.
      const scroller = page.locator("[data-reader] .overflow-y-auto").first();
      for (const top of [60, 140, 240, 360, 480]) {
        await scroller.evaluate((el, t) => (el.scrollTop = Math.min(t, el.scrollHeight - el.clientHeight - 40)), top);
        await page.waitForTimeout(70);
      }
      await settle(page, 600);
      const folded = await page.locator("[data-reader-pill]").getAttribute("data-reader-pill").catch(() => null);
      if (folded !== "collapsed") throw new Error(`reader pill did not fold while scrolled (state ${folded})`);
      return;
    }
    case "drawer":
      if (phone) {
        await page.locator("[data-phone-dock] button[data-dock-expand]").tap();
      } else {
        await page.locator("[data-sidebar-toggle]:visible").first().click();
      }
      await page.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
      await settle(page, 450);
      return;
    case "settings-top":
    case "settings-end":
    case "appearance-menu":
    case "appearance": {
      if (phone) {
        await page.locator("[data-phone-dock] button[data-dock-expand]").tap();
        await page.locator("[data-sidebar][data-open]").waitFor({ state: "visible", timeout: 5_000 });
        await page.waitForTimeout(350);
        await page.locator('[data-sidebar] [data-nav-account] button[aria-label="Settings"]').tap();
      } else {
        await page.keyboard.press(",");
      }
      const dialog = page.locator('[role="dialog"][aria-label="Settings"]');
      await dialog.waitFor({ timeout: 5_000 });
      await settle(page, 500);
      if (screen === "settings-top") return;
      // Keyboard shortcuts: the longest category, so "the end" is a real scroll. A touch
      // phone with no keyboard has no such category (1.3.3), so Smart filters there.
      const category = screen.startsWith("appearance") ? "appearance" : phone ? "filters" : "shortcuts";
      const tab = dialog.locator(`[role="tab"][data-category="${category}"]`);
      if ((await tab.count()) > 0) await tab.click();
      else await tap(dialog.locator(`[data-category="${category}"]`).first());
      await settle(page, 450);
      if (screen === "settings-end") {
        await scrollToEnd(page, '[role="dialog"][aria-label="Settings"]');
        await settle(page, 300);
      }
      if (screen === "appearance-menu") {
        // A Settings dropdown open (1.3.3): Mode's list under its pill.
        await tap(page.locator('[data-select="theme-mode"]'));
        await page.locator('[data-select-list="theme-mode"]').waitFor({ timeout: 5_000 });
        await settle(page, 300);
      }
      return;
    }
    case "compose":
      if (phone) await page.locator("[data-compose-fab]:visible").first().tap();
      else await page.locator("[data-compose]:visible").first().click();
      await page.locator("[data-composer]").first().waitFor({ timeout: 5_000 });
      await settle(page, 600);
      return;
    case "pill-undo":
      if (phone) {
        await swipe(page, cdp, page.locator(ROW).nth(1));
      } else {
        await page.keyboard.press("j");
        await page.waitForTimeout(150);
        await page.keyboard.press("e");
      }
      await page.locator("[data-status-pill='undo']").waitFor({ timeout: 5_000 });
      await settle(page, 700);
      return;
    case "inbox-clear":
      return;
    default:
      throw new Error(`unknown screen ${screen}`);
  }
}

async function runJob(browser, helper, job) {
  const results = [];
  const errors = [];
  const regular = job.screens.filter((s) => s !== "inbox-clear");
  if (regular.length) {
    const ctx = await newContext(browser, job);
    const { page, cdp } = await openPage(ctx, job, errors);
    for (const screen of regular) {
      try {
        await load(page);
        await stage(page, cdp, job, screen);
        results.push(await capture(page, helper, job, screen, errors));
      } catch (error) {
        results.push({ screen, failed: String(error).split("\n")[0], errors: errors.splice(0) });
        await page.screenshot({ path: path.join(SHOTS, `${job.id}--${screen}.png`) }).catch(() => undefined);
      }
      // A fresh demo for the next screen (the pill screen moves a message).
      await page.evaluate(() => {
        const keep = localStorage.getItem("winnow.preferences.v1");
        localStorage.clear();
        if (keep) localStorage.setItem("winnow.preferences.v1", keep);
      }).catch(() => undefined);
    }
    await ctx.close();
  }
  if (job.screens.includes("inbox-clear")) {
    const ctx = await newContext(browser, job, { empty: true });
    const { page } = await openPage(ctx, job, errors);
    try {
      await load(page, { empty: true });
      await page.waitForTimeout(2_000); // the one-time celebration ends
      results.push(await capture(page, helper, job, "inbox-clear", errors));
    } catch (error) {
      results.push({ screen: "inbox-clear", failed: String(error).split("\n")[0], errors: errors.splice(0) });
    }
    await ctx.close();
  }
  const record = { ...job, results };
  writeFileSync(path.join(RESULTS, `${job.id}.json`), JSON.stringify(record, null, 1));
  const issues = results.reduce((n, r) => n + (r.failed ? 1 : 0) + (r.errors?.length ?? 0) + (r.overflow?.length ?? 0) + (r.contrast?.filter((c) => c.kind !== "other").length ?? 0), 0);
  console.log(`  ${job.id.padEnd(46)} ${results.length} screens, ${issues} findings`);
}

async function capturePhase() {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(RESULTS, { recursive: true });
  if (!existsSync(path.join(ROOT, "dist", "index.html"))) await build({ root: ROOT, logLevel: "warn" });
  const server = await preview({ root: ROOT, logLevel: "warn", preview: { port: PORT, strictPort: true, open: false } });
  const browser = await chromium.launch(process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM } : {});
  try {
    const jobs = plan();
    console.log(`sweep: ${jobs.length} combinations → ${OUT}`);
    const helpers = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(JOBS, jobs.length) }, async () => {
        const helperCtx = await browser.newContext();
        const helper = await helperCtx.newPage();
        helpers.push(helperCtx);
        while (next < jobs.length) {
          const job = jobs[next++];
          try {
            await runJob(browser, helper, job);
          } catch (error) {
            console.log(`  ${job.id}: crashed — ${String(error).split("\n")[0]}`);
          }
        }
      }),
    );
    await Promise.all(helpers.map((h) => h.close()));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
}

// ── Sheets, PDF and report ────────────────────────────────────────────────────────
function loadResults() {
  if (!existsSync(RESULTS)) return [];
  return readdirSync(RESULTS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(RESULTS, f), "utf8")));
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function sheetHtml(title, tiles, columns, tileWidth) {
  const cells = tiles
    .map((t) => {
      const flags = [t.failed ? "FAILED" : "", t.errors ? `${t.errors} err` : "", t.overflow ? `${t.overflow} overflow` : "", t.contrast ? `${t.contrast} contrast` : ""].filter(Boolean).join(" · ");
      return `<figure><figcaption><b>${escape(t.label)}</b><span>${escape(t.screen)}</span>${flags ? `<em>${escape(flags)}</em>` : ""}</figcaption><img src="${pathToFileURL(path.join(SHOTS, t.file)).href}"></figure>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 24px; background: #8a8a92; font: 15px/1.3 system-ui, sans-serif; color: #111; }
    h1 { margin: 0 0 16px; font-size: 26px; color: #fff; }
    main { display: grid; grid-template-columns: repeat(${columns}, ${tileWidth}px); gap: 16px; }
    figure { margin: 0; background: #fff; border-radius: 6px; overflow: hidden; break-inside: avoid; }
    figcaption { display: flex; gap: 8px; align-items: baseline; padding: 6px 8px; font-size: 14px; flex-wrap: wrap; }
    figcaption span { color: #444; }
    figcaption em { color: #b00020; font-style: normal; font-weight: 600; font-size: 12px; }
    img { display: block; width: 100%; outline: 1px solid #0003; }
  </style><h1>${escape(title)}</h1><main>${cells}</main>`;
}

async function sheetsPhase() {
  const records = loadResults();
  if (!records.length) throw new Error(`sweep: no results in ${RESULTS}; run the capture phase first`);
  const order = (r) => [["light", "dark", "oled", "extras"].indexOf(r.group), r.id];
  records.sort((a, b) => (order(a)[0] - order(b)[0]) || order(a)[1].localeCompare(order(b)[1]));
  const { accents } = vocabulary();
  const groups = [];
  for (const group of [...new Set(records.map((r) => r.group))]) {
    for (const device of ["phone", "desktop"]) {
      const rs = records.filter((r) => r.group === group && (group === "extras" ? (device === "phone" ? isPhone(r.device) : !isPhone(r.device)) : r.device === device));
      if (!rs.length) continue;
      if (group !== "extras") rs.sort((a, b) => accents.indexOf(a.accent) - accents.indexOf(b.accent));
      const tiles = rs.flatMap((r) =>
        r.results.map((x) => ({
          label: group === "extras" ? `${r.label} (${r.device})` : `${r.mode} · ${r.accent}`,
          screen: x.screen,
          file: x.file ?? `${r.id}--${x.screen}.png`,
          failed: Boolean(x.failed),
          errors: x.errors?.length ?? 0,
          overflow: (x.overflow?.length ?? 0) + (x.hscroll > 1 ? 1 : 0),
          contrast: x.contrast?.filter((c) => c.kind !== "other").length ?? 0,
        })),
      );
      const phone = device === "phone";
      const columns = phone ? (group === "extras" ? 6 : SCREENS.length) : group === "extras" ? 3 : 3;
      const tileWidth = phone ? 300 : 720;
      groups.push({ name: `${group}-${device}`, title: `Winnow theme sweep — ${group} · ${device}`, html: sheetHtml(`Winnow theme sweep — ${group} · ${device}`, tiles, columns, tileWidth), width: columns * tileWidth + (columns - 1) * 16 + 48 });
    }
  }
  const browser = await chromium.launch(process.env.WINNOW_CHROMIUM ? { executablePath: process.env.WINNOW_CHROMIUM } : {});
  const sheets = [];
  try {
    for (const g of groups) {
      const htmlFile = path.join(OUT, `sheet-${g.name}.html`);
      writeFileSync(htmlFile, g.html);
      const page = await browser.newPage({ viewport: { width: g.width, height: 800 } });
      await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "load" });
      const png = path.join(OUT, `sheet-${g.name}.png`);
      await page.screenshot({ path: png, fullPage: true });
      sheets.push({ ...g, png });
      await page.close();
      rmSync(htmlFile);
    }
    // One PDF, a page per sheet, each sheet scaled to fit the page width.
    const pdfHtml = `<!doctype html><meta charset="utf-8"><style>@page { size: 420mm 297mm; margin: 8mm; } body { margin: 0; font: 12px system-ui; }
      section { page-break-after: always; } img { display: block; max-width: 100%; max-height: 270mm; margin: 0 auto; } h2 { margin: 0 0 4mm; }</style>
      ${sheets.map((s) => `<section><h2>${escape(s.title)}</h2><img src="${pathToFileURL(s.png).href}"></section>`).join("")}`;
    const pdfFile = path.join(OUT, "sweep-pdf.html");
    writeFileSync(pdfFile, pdfHtml);
    const page = await browser.newPage();
    await page.goto(pathToFileURL(pdfFile).href, { waitUntil: "load" });
    await page.pdf({ path: path.join(OUT, "sweep.pdf"), width: "420mm", height: "297mm", printBackground: true });
    await page.close();
    rmSync(pdfFile);
  } finally {
    await browser.close();
  }
  writeFileSync(path.join(OUT, "sweep-report.md"), report(records, sheets));
  console.log(`sweep: ${sheets.length} sheets, sweep.pdf and sweep-report.md in ${OUT}`);
}

function report(records, sheets) {
  const shots = records.reduce((n, r) => n + r.results.length, 0);
  const lines = [];
  lines.push("# Winnow theme sweep", "");
  lines.push(`${records.length} combinations, ${shots} screenshots. Generated by \`web/scripts/sweep.mjs\` on ${new Date().toISOString()}.`, "");
  lines.push("Sheets:", ...sheets.map((s) => `- \`${path.basename(s.png)}\``), "- `sweep.pdf` (all sheets)", "");
  const failed = records.flatMap((r) => r.results.filter((x) => x.failed).map((x) => `- ${r.id} / ${x.screen}: ${x.failed}`));
  lines.push("## Screens that could not be staged", "", ...(failed.length ? failed : ["None."]), "");
  const errs = records.flatMap((r) => r.results.flatMap((x) => (x.errors ?? []).map((e) => `- ${r.id} / ${x.screen}: ${e}`)));
  lines.push("## Page and console errors", "", ...(errs.length ? errs : ["None."]), "");
  const ov = [];
  for (const r of records) {
    for (const x of r.results) {
      if (x.hscroll > 1) ov.push(`- ${r.id} / ${x.screen}: page scrolls sideways by ${x.hscroll}px`);
      for (const o of x.overflow ?? []) ov.push(`- ${r.id} / ${x.screen}: ${o.kind}${o.axis ? ` (${o.axis})` : ""} — “${o.textSample}” in ${o.el}${o.by ? `, cut by ${o.by}` : ""}`);
    }
  }
  lines.push("## Text overflow / clipping", "", ...(ov.length ? ov : ["None detected."]), "");
  const aa = (kind) => {
    // Group identical findings across combos so a shared bug is one line with its combos.
    const map = new Map();
    for (const r of records) {
      for (const x of r.results) {
        for (const c of (x.contrast ?? []).filter((c) => (kind === "other" ? c.kind === "other" : c.kind !== "other"))) {
          const key = `${x.screen} | ${c.kind} | ${c.el} | “${c.text}”`;
          const entry = map.get(key) ?? { combos: [], worst: 99, median: 99, need: c.need };
          entry.combos.push(r.label ?? `${r.mode}/${r.accent}/${r.device}`);
          entry.worst = Math.min(entry.worst, c.worst);
          entry.median = Math.min(entry.median, c.median);
          map.set(key, entry);
        }
      }
    }
    return [...map.entries()].sort((a, b) => a[1].worst - b[1].worst).map(([k, e]) => `- ${k}: worst ${e.worst}:1 (median ${e.median}:1, needs ${e.need}) — ${e.combos.length} combo(s): ${e.combos.slice(0, 8).join(", ")}${e.combos.length > 8 ? ", …" : ""}`);
  };
  const primary = aa("primary");
  lines.push("## WCAG AA contrast — primary text and pill/chip text", "", "Measured against the pixels behind each text run (10th/50th/90th percentile of the background with text hidden); “worst” is the lowest of the three.", "", ...(primary.length ? primary : ["None below AA."]), "");
  // The floor actually measured, so a clean section still says how close it came.
  const floor = {};
  for (const r of records) {
    for (const x of r.results) {
      for (const [kind, low] of Object.entries(x.lowest ?? {})) {
        if (!floor[kind] || low.ratio < floor[kind].ratio) floor[kind] = { ...low, where: `${r.id} / ${x.screen}` };
      }
    }
  }
  const runs = records.reduce((n, r) => n + r.results.reduce((m, x) => m + (x.texts ?? 0), 0), 0);
  lines.push(`Lowest measured (${runs} text runs; forced-colours combos excluded, the system palette paints those):`, "", ...["primary", "chip", "other"].filter((k) => floor[k]).map((k) => `- ${k}: ${floor[k].ratio}:1 — “${floor[k].text}” in ${floor[k].where}`), "");
  const other = aa("other");
  lines.push("## Contrast below AA — other text (informational)", "", ...(other.length ? other.slice(0, 80) : ["None."]), ...(other.length > 80 ? [`- … ${other.length - 80} more in results/*.json`] : []), "");
  return lines.join("\n");
}

if (PHASE === "capture" || PHASE === "all") await capturePhase();
if (PHASE === "sheets" || PHASE === "all") await sheetsPhase();
