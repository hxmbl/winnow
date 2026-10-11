/**
 * What a message is going to ask for, before anything is fetched.
 *
 * The proxy's whole argument for existing is one sentence: *the sender's server
 * learns the proxy's address, not the reader's.* Which means it has to fetch the
 * message's images itself and hand the reader a document that names only the
 * proxy's own addresses — and a message names its images in five different places,
 * so getting this wrong leaves one of them pointing at the sender anyway, which
 * makes the whole service a privacy claim that is sometimes true.
 *
 * **This runs on the raw body, before sanitising, and that is the point.** The
 * sanitiser rewrites `url()` in a stylesheet to `none` and drops a `src` it has
 * refused, so a planner that ran afterwards would be reading a document in which
 * the interesting references have already been removed — it would find four of the
 * five shapes and report success. So: plan from the raw HTML, fetch, then sanitise
 * *with the answers*, substituting as it walks. One mechanism, in one place, and a
 * proxied document never holds a remote address at any point.
 *
 * It is deliberately pure. No network, no clock, no cache — so the property that
 * matters (every address a realistic newsletter names is accounted for) can be
 * asserted by a test rather than by looking at a rendered page and hoping.
 */

import { checkUrl } from "./addressPolicy.ts";

/**
 * The attributes that actually make a browser fetch something.
 *
 * The same set `html.ts` counts, and the same set on purpose: `src`, `srcset`,
 * `background`, `poster`. `href` is deliberately absent — a link is not a request
 * until somebody clicks it, a click is a deliberate act with its own consent, and
 * proxying one would mean the proxy fetched a landing page and served it as if it
 * were an image.
 */
const URL_ATTRIBUTES = ["src", "background", "poster"] as const;

/** One thing the document is going to want fetched. */
export type AssetPlan = {
  /** The address as the message wrote it. */
  url: string;
  /** Which shape asked for it. For the log, and for the failure message. */
  via: "attribute" | "srcset" | "css" | "stylesheet";
  /** False when the address policy refused it. */
  allowed: boolean;
  /** Why it was refused, when it was. */
  reason?: string;
};

/** A `url(...)` inside a stylesheet, which is an image the CSS wants. */
const CSS_URL = /url\(\s*['"]?(?!data:|#)([^)'"\s]+)['"]?\s*\)/gi;

/**
 * An `@import` inside a stylesheet.
 *
 * Named, because the bare `@import "…"` spelling — no `url()` around it — is the
 * common one and `CSS_URL` will not see it. The proxy does not fetch stylesheets;
 * it fetches images. Planning it anyway means it is *counted*, which is the part
 * that matters: a document that silently drops an imported sheet reads as one that
 * simply had none.
 */
const CSS_IMPORT = /@import\s+(?:url\(\s*)?['"]?([^;)'"\s]+)['"]?\s*\)?\s*;?/gi;

/** A `<style>` element and its contents, in the raw body. */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/** A tag, so a quoted attribute value containing `>` is not mistaken for one. */
const TAG = /<[a-zA-Z][^>]*>/g;
const ATTRIBUTE =
  /([a-zA-Z][a-zA-Z0-9:_.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** Every `<style>` block in a raw body. */
export function styleBlocks(html: string): string[] {
  return [...html.matchAll(STYLE_BLOCK)].map((block) => block[1] ?? "");
}

/**
 * Every remote reference a message is going to make, and whether the policy allows
 * each one.
 *
 * Nothing here trusts the input, even though the only caller has not sanitised it
 * yet: `checkUrl` is applied to every address found, so a `file://` or a loopback
 * literal that survived the raw body is refused here rather than becoming a fetch.
 * A proxy that trusts its input is a request-forgery gadget with better manners.
 */
export function planAssets(html: string): { assets: AssetPlan[]; byUrl: Map<string, AssetPlan> } {
  const assets: AssetPlan[] = [];
  const byUrl = new Map<string, AssetPlan>();

  const add = (raw: string, via: AssetPlan["via"]) => {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    // Bytes already inside the message, a reference to something in this document,
    // and a `cid:` — the message's own inline part, which came with the mail and
    // involves nobody.
    if (trimmed.startsWith("#") || trimmed.startsWith("data:") || /^cid:/i.test(trimmed)) return;
    // One entry per distinct address: a message names its logo six times, and the
    // proxy must fetch it once — both because that is what a cache is for, and
    // because the count the reader is shown should be about distinct things.
    if (byUrl.has(trimmed)) return;

    const verdict = checkUrl(trimmed);
    const plan: AssetPlan = { url: trimmed, via, allowed: verdict.ok };
    if (!verdict.ok) plan.reason = verdict.reason;
    assets.push(plan);
    byUrl.set(trimmed, plan);
  };

  const walk = (markup: string) => {
    for (const tag of markup.matchAll(TAG)) {
      for (const attribute of tag[0].matchAll(ATTRIBUTE)) {
        const name = attribute[1].toLowerCase();
        const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";

        if (name === "srcset") {
          // A candidate list, and the descriptor after each address has to come
          // off before the address is read — `a.png 2x` is not a URL.
          for (const candidate of value.split(",")) {
            add(candidate.trim().split(/\s/)[0] ?? "", "srcset");
          }
          continue;
        }

        if ((URL_ATTRIBUTES as readonly string[]).includes(name)) {
          add(value, "attribute");
          continue;
        }

        if (name === "style") {
          for (const match of value.matchAll(CSS_URL)) add(match[1] ?? "", "css");
        }
      }
    }
  };

  walk(html);

  for (const sheet of styleBlocks(html)) {
    for (const match of sheet.matchAll(CSS_URL)) add(match[1] ?? "", "css");
    for (const match of sheet.matchAll(CSS_IMPORT)) add(match[1] ?? "", "stylesheet");
  }

  return { assets, byUrl };
}