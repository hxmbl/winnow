/**
 * The body of a message, in whichever of the forms the reader asks for.
 *
 * Three reasonable answers to "how should a message render?" and choosing between them
 * is a decision rather than an implementation detail:
 *
 *   - **Rich** — the sender's markup, sanitised, inline. The default, because it is what
 *     a mail client is for; a newsletter reduced to a column of words with its URLs
 *     spelled out is not what the sender sent.
 *   - **Plain** — the text, which is what the classifier read and what a reply quotes.
 *   - **As sent** — the untouched original in a `sandbox=""` frame, the escape hatch.
 *
 * **Why the rich form can be inline when the original could not.** A sender must never
 * run markup in the app's origin, but `core/mail/sanitize.ts` now backs "sanitised" with
 * an allowlist and a test for every attack, so it is a claim that can be checked. The
 * sandbox stays what "as sent" is, for the one context the reader chooses on purpose.
 *
 * **It deliberately does not decide about images.** Whether remote content loads is
 * `core/mail/imageConsent`'s decision, arriving as a boolean, and every refused
 * reference is still counted and stated.
 */

import { plainTextForReading } from "../../core/mail/plainView";
import { censorHtmlDocument, originalAttribute, sessionScrambler } from "../censorDom";
import { useCensorActive } from "../useCensor";
import { useEffect, useId, useLayoutEffect, useMemo, useState, useRef, type RefObject } from "react";
import { Moon, Server, Sun } from "lucide-react";
import {
  emailDocument,
  inlineEmailCss,
  inlineEmailDarkCss,
  sanitizeMailHtml,
} from "../../core/mail/sanitize";
import {
  detectOwnDarkStyles,
  emailDarkMode,
  type DarkPalette,
  type EmailDarkMode,
} from "../../core/mail/emailDark";
import {
  renderThroughProxy,
  type ProxiedRender,
} from "../../core/mail/proxy";
import type { Email } from "../../core/model/email";
import { fitScale, overflowAfterFit } from "../emailFit";
import { scopeSenderCss, sheetScope } from "../../core/mail/scopedSheet";

/**
 * Which of the forms a message body is being shown in.
 *
 * `proxied` exists only when the deployment names a proxy (`VITE_RENDER_PROXY`, or the
 * Docker image's runtime config, `platform/runtimeConfig.ts`) — the one
 * form whose *images* load without the reader answering, because the fetch comes from
 * the server, so a tracking pixel reports the server's address and not the reader's.
 */
export type BodyView = "rich" | "plain" | "proxied" | "sent";

/**
 * The stylesheet the inline form needs, mounted once.
 *
 * Every selector descends from `[data-wn-email]`, which is what makes it safe to put in
 * the app's document. It lives here rather than in `index.css` because `sanitize.ts` owns
 * the rules, and a second copy would be the first place for them to drift apart.
 */
function EmailStyles() {
  const css = useMemo(() => inlineEmailCss(), []);
  return <style data-wn-email-styles="" dangerouslySetInnerHTML={{ __html: css }} />;
}

/**
 * Sanitised once per message and once per answer to the image offer.
 *
 * Memoised on what can change the result rather than the HTML alone: re-scanning a 200KB
 * body when the reader presses a button in the offer would be visible as a stutter in
 * the very message they are deciding whether to trust.
 */
function useSanitised(
  email: Email,
  imagesAllowed: boolean,
  inlineParts: Record<string, string> | undefined,
  recolour: DarkPalette | undefined,
) {
  return useMemo(
    () =>
      sanitizeMailHtml(email.bodyHtml ?? "", {
        allowRemote: imagesAllowed,
        inlineParts,
        // Kept, and fenced into this message's container by `scopeSenderCss` before
        // they reach the document (1.3.5): a responsive newsletter's phone layout lives
        // in its `@media` rules, and without them a phone draws the desktop table and
        // the fit zoom shrinks it to half size.
        collectStyles: true,
        // Email dark mode's adaptive path recolours inline colours while sanitising.
        recolour,
        // Only a URL-length token may break anywhere; words stay whole, so a table
        // column never shrinks below its longest word and a too-wide message is zoomed
        // to fit instead of squeezed (STRM-318).
        markLongTokens: true,
      }),
    [email.bodyHtml, imagesAllowed, inlineParts, recolour],
  );
}

/**
 * The plain text: tidied of invisible filler and runs of blank lines, or with Dev Options
 * → Pure Plain Text (`pure`) exactly as sent (`core/mail/plainView.ts`).
 *
 * `whitespace-pre-wrap` so the sender's own paragraph breaks survive without re-wrapping
 * to the pane width. System sans rather than monospace, because this is prose a person
 * wrote. Always a text node, pure or not: nothing in it is ever parsed as markup.
 */
function PlainText({ email, pure }: { email: Email; pure: boolean }) {
  const text = useMemo(
    () => plainTextForReading(email, { pure }),
    [email, pure],
  );
  // Censor email addresses: each address its own blurred span, scrambled here rather
  // than by the document watcher, which can only blur a whole element.
  const censor = useCensorActive();
  const parts = useMemo(() => (censor ? sessionScrambler().censorParts(text) : null), [censor, text]);
  return (
    <div
      className="selectable max-w-[68ch] whitespace-pre-wrap text-read text-ink-body"
      data-plain-text={pure ? "pure" : "tidy"}
    >
      {parts
        ? parts.map((part, index) =>
            part.censored ? (
              <span key={index} data-wn-censored="">
                {part.text}
              </span>
            ) : (
              part.text
            ),
          )
        : text}
    </div>
  );
}

/**
 * The rich form: sanitised markup, in this document.
 *
 * **The container is the message's own page — a light surface with a hairline, which is
 * what Gmail and Apple Mail both do, and what keeps a `#333`-on-`#fff` newsletter legible
 * inside a dark reader.** Unless email dark mode (1.4.0) is drawing it dark: then the card
 * is the theme's surface and the sender's colours are honoured or re-mapped
 * (`core/mail/emailDark.ts`), never a blunt invert.
 *
 * **A fixed-width message is shrunk to fit, as mail clients do (1.3.3).** HTML mail is
 * laid out in fixed-width tables (600–640px), wider than a phone, and the container's
 * `contain: paint` (which keeps a sender's markup in its box) used to cut the right-hand
 * column off. `useFitToWidth` measures the message and zooms it down to the card's width
 * (`ui/emailFit.ts`); a message that already fits is left alone. Only past the smallest
 * legible scale, or where `zoom` is unsupported, does it scroll sideways instead.
 *
 * **The click handler is what makes an inlined link safe to click.** The click is taken
 * here and handed to the caller, which opens it in the system browser. The URL is read
 * off the rendered anchor, so it is the value that survived the sanitiser by
 * construction.
 */
/**
 * Zoom the message in `ref` down to its container's width when its content is wider.
 *
 * Measured at zoom 1 on every change that can move either width: the message, the
 * card's width (ResizeObserver; height changes, including the ones this causes, are
 * ignored) and an image arriving. Writes go straight to the element, no React state.
 */
function useFitToWidth(ref: RefObject<HTMLDivElement | null>, html: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const zoomable = globalThis.CSS?.supports?.("zoom", "0.5") ?? false;
    const fit = () => {
      el.style.removeProperty("zoom");
      el.style.removeProperty("overflow-x");
      delete el.dataset.wnFit;
      const available = el.clientWidth;
      const natural = el.scrollWidth;
      const scale = zoomable ? fitScale(natural, available) : 1;
      if (scale < 1) {
        el.style.zoom = String(scale);
        el.dataset.wnFit = String(scale);
      }
      if (overflowAfterFit(natural, available, scale)) el.style.overflowX = "auto";
    };
    fit();
    const parent = el.parentElement;
    let parentWidth = parent?.clientWidth ?? -1;
    const observer =
      typeof ResizeObserver === "undefined" || !parent
        ? null
        : new ResizeObserver(() => {
            // Unzoomed, the message's own box is the card's content width.
            const width = parent.clientWidth;
            if (width !== parentWidth) {
              parentWidth = width;
              fit();
            }
          });
    if (observer && parent) observer.observe(parent);
    const onLoad = (event: Event) => {
      if ((event.target as Element | null)?.tagName === "IMG") fit();
    };
    el.addEventListener("load", onLoad, true);
    return () => {
      observer?.disconnect();
      el.removeEventListener("load", onLoad, true);
    };
  }, [ref, html]);
}

function RichBody({
  html,
  stylesheets,
  onOpenLink,
  dark,
}: {
  html: string;
  stylesheets: readonly string[];
  onOpenLink: (url: string) => void;
  /** Email dark mode, when this message is being drawn dark. */
  dark: { mode: Exclude<EmailDarkMode, "off">; palette: DarkPalette } | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scope = sheetScope(useId());
  const darkMode = dark?.mode;
  const darkPalette = dark?.palette;
  // The sender's sheet, every selector fenced under this one message. See `scopedSheet.ts`.
  const senderCss = useMemo(
    () =>
      scopeSenderCss(
        stylesheets,
        scope.selector,
        darkMode && darkPalette ? { mode: darkMode, palette: darkPalette } : undefined,
      ),
    [stylesheets, scope.selector, darkMode, darkPalette],
  );
  const darkCss = useMemo(() => (darkPalette ? inlineEmailDarkCss(darkPalette) : ""), [darkPalette]);
  // Re-fit when the sheet changes too: its media rules can change the natural width.
  useFitToWidth(containerRef, html + senderCss);

  // Add copy buttons to code blocks after the HTML is rendered
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const codeBlocks = container.querySelectorAll('pre[data-wn-code-block]');
    codeBlocks.forEach((pre) => {
      const preElement = pre as HTMLPreElement;
      if (getComputedStyle(preElement).position === "static") {
        preElement.style.position = "relative";
      }

      if (preElement.querySelector('[data-wn-copy-button]')) return;

      const buttonWrapper = document.createElement("div");
      buttonWrapper.setAttribute("data-wn-copy-button", "");
      buttonWrapper.style.position = "absolute";
      buttonWrapper.style.top = "0.5em";
      buttonWrapper.style.right = "0.5em";
      // Keep the control available on touch screens, where hover does not exist.
      // On pointer devices it appears on hover or keyboard focus.
      const canHover = window.matchMedia?.("(hover: hover)").matches ?? false;
      buttonWrapper.style.opacity = canHover ? "0" : "1";
      buttonWrapper.style.transition = "opacity 0.15s ease";

      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "flex h-7 w-7 items-center justify-center rounded-full bg-white text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
      button.setAttribute("aria-label", "Copy code");
      button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

      let copied = false;
      let timeoutId: number | null = null;
      const copyIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
      const showButton = () => { buttonWrapper.style.opacity = "1"; };
      const hideButton = () => {
        if (!copied && document.activeElement !== button) buttonWrapper.style.opacity = canHover ? "0" : "1";
      };

      const handleCopy = async () => {
        try {
          await navigator.clipboard.writeText(preElement.textContent || "");
          copied = true;
          button.setAttribute("aria-label", "Copied");
          button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
          if (timeoutId !== null) {
            window.clearTimeout(timeoutId);
          }
          timeoutId = window.setTimeout(() => {
            copied = false;
            button.setAttribute("aria-label", "Copy code");
            button.innerHTML = copyIcon;
            hideButton();
          }, 2000);
        } catch (error) {
          console.error("Failed to copy code:", error);
          button.setAttribute("aria-label", "Could not copy code");
          button.title = "Could not copy code. Clipboard access was blocked.";
          if (timeoutId !== null) window.clearTimeout(timeoutId);
          timeoutId = window.setTimeout(() => {
            button.setAttribute("aria-label", "Copy code");
            button.removeAttribute("title");
          }, 3000);
        }
      };

      button.addEventListener("click", handleCopy);
      button.addEventListener("focus", showButton);
      button.addEventListener("blur", hideButton);
      preElement.addEventListener("mouseenter", showButton);
      preElement.addEventListener("mouseleave", hideButton);

      buttonWrapper.appendChild(button);
      preElement.appendChild(buttonWrapper);
    });

    return () => {
      codeBlocks.forEach((pre) => {
        const button = pre.querySelector('[data-wn-copy-button]');
        if (button) {
          button.remove();
        }
      });
    };
  }, [html]);

  return (
    // The card is a wrapper because the email baseline zeroes the container's own
    // padding (it must, for the "as sent" document's body), which left the text flush
    // against the card's edge.
    //
    // In email dark mode the card is the theme's surface instead of white, and the
    // container carries `data-wn-dark` for `inlineEmailDarkCss`.
    //
    // On a phone (STRM-318) the card is the screen's width, as Gmail draws it: it bleeds
    // through the reader's 24px gutters (`-mx-6`, the article's `px-6`), with no hairline
    // or rounding and a thin inset, so a message gets every pixel across (a fixed-width
    // one is zoomed less) and none of the frame above and around it.
    <div
      data-wn-email-card=""
      className={`selectable overflow-x-auto overflow-y-hidden max-sm:-mx-6 max-sm:px-3 max-sm:py-2 sm:rounded-pane sm:border sm:border-hairline sm:px-6 sm:py-5 ${dark ? "" : "bg-white"}`}
      style={dark ? { background: dark.palette.surface } : undefined}
    >
      {darkCss !== "" && <style data-wn-dark-styles="" dangerouslySetInnerHTML={{ __html: darkCss }} />}
      {senderCss !== "" && (
        <style data-wn-sender-styles="" dangerouslySetInnerHTML={{ __html: senderCss }} />
      )}
      <div
        ref={containerRef}
        data-wn-email=""
        {...(dark ? { "data-wn-dark": dark.mode } : {})}
        {...{ [scope.attribute]: scope.value }}
        onClick={(event) => {
          const anchor = (event.target as HTMLElement).closest?.("a[href]");
          if (!anchor || !event.currentTarget.contains(anchor)) return;
          // A modified click is the user asking for the browser's own answer — a new
          // tab, a download — so it is left alone rather than swallowed.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          // The real target: Censor email addresses scrambles a `mailto:` on screen,
          // never where it goes.
          const href = originalAttribute(anchor, "href");
          // A fragment stays in the document, and a message's own anchors were not given
          // ids (a sender's `id` would collide with the app's), so there is nowhere for
          // one to go.
          if (!href || href.startsWith("#")) return;
          event.preventDefault();
          onOpenLink(href);
        }}
        // The only place in the app where a sender's markup lands, and the reason the
        // sanitiser exists at all.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/**
 * The message as its sender wrote it, in a `sandbox=""` frame.
 *
 * `sandbox=""` — the empty string, with *no token named* — is the most restrictive value
 * the attribute can take: no scripts, forms, popups, top-level navigation or plugins, and
 * an opaque origin rather than this app's. None of them is needed for tables, styles and
 * images to render, and adding `allow-same-origin` or `allow-scripts` would hand a sender
 * the store or the ability to run code.
 *
 * **It still sanitises, and still obeys the image answer.** A sandbox does not block
 * remote images, so this is sanitised with the same `allowRemote` as the rich form. "As
 * sent" means *layout*, not *consent*: the sender's CSS and `cid:` parts, which the rich
 * form has to drop or rewrite.
 *
 * The frame is a fixed height: measuring it would require the frame to script, and
 * granting `allow-scripts` to save the reader a scrollbar is a bad trade.
 */
function AsSent({ email, imagesAllowed }: { email: Email; imagesAllowed: boolean }) {
  const document = useMemo(() => {
    const sanitised = sanitizeMailHtml(email.bodyHtml ?? "", {
      allowRemote: imagesAllowed,
      // The sender's stylesheets go here, in a document that contains nothing else and so
      // cannot reach the reader. Sanitised first — no `@import`, no fetching `url()`, no
      // `expression()`.
      collectStyles: true,
    });
    return emailDocument(sanitised.html, sanitised.stylesheets);
  }, [email.bodyHtml, imagesAllowed]);
  // The frame's opaque origin is out of the document watcher's reach: censor the srcdoc.
  const censor = useCensorActive();
  const shown = useMemo(() => (censor ? censorHtmlDocument(document) : document), [censor, document]);

  return (
    <iframe
      key={`${email.id}:${imagesAllowed}:${censor}`}
      title="Message as sent"
      srcDoc={shown}
      sandbox=""
      referrerPolicy="no-referrer"
      className="h-[38rem] w-full rounded-pane border border-hairline bg-white"
    />
  );
}

/**
 * The message as Winnow's own render proxy built it.
 *
 * **The document this frame shows is not trusted, and it is the sandbox that says so
 * rather than the code that fetched it.** A proxy is a third party that can be
 * misconfigured or compromised, so its output is mounted in the same `sandbox=""` frame
 * as the untouched original: the proxy makes the document *more* faithful, not more safe.
 *
 * Worth having anyway: it is the only form in which the images load without the reader
 * being asked, because the sender's server saw the proxy and not the reader.
 */
function Proxied({ email, document, fetched, blocked }: {
  email: Email;
  document: string;
  fetched: number;
  blocked: number;
}) {
  const censor = useCensorActive();
  const shown = useMemo(() => (censor ? censorHtmlDocument(document) : document), [censor, document]);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-meta font-medium text-ink-muted">
          <Server size={13} strokeWidth={1.9} aria-hidden="true" />
          {fetched} {fetched === 1 ? "image" : "images"} fetched by Winnow&rsquo;s server,
          not by your browser
          {blocked > 0 && ` · ${blocked} withheld`}
        </p>
      </div>
      <iframe
        key={`${email.id}:proxied:${censor}`}
        title="Message, rendered by Winnow's server"
        srcDoc={shown}
        sandbox=""
        referrerPolicy="no-referrer"
        className="h-[38rem] w-full rounded-pane border border-hairline bg-white"
      />
    </div>
  );
}

type Props = {
  email: Email;
  /**
   * May this message's remote content load? Resolved upstream by
   * `core/mail/imageConsent` and passed as a boolean.
   */
  imagesAllowed: boolean;
  /** The message's inline parts as data URIs, when they have been fetched. */
  inlineParts?: Record<string, string>;
  /** Open a link from the message in the system browser, a different origin. */
  onOpenLink: (url: string) => void;
  /** Which form to show. Owned by the reader, whose menu picks it. */
  view: BodyView;
  /**
   * Email dark mode (1.4.0): the palette to draw the rich form in, or null when the
   * reader is light or Settings → Appearance → Email dark mode is off. The reader can
   * still ask for this one message's original colours with the sun/moon button.
   */
  emailDark?: DarkPalette | null;
  /** Dev Options → Pure Plain Text: the Plain text form shows the text exactly as sent. */
  purePlainText?: boolean;
};

/**
 * "Show original colours" / "Show in dark": the per-message escape hatch, beside the
 * card, so a message the recolouring got wrong is one tap from the sender's own look.
 * Not persisted: the next message opens dark again.
 */
function DarkToggle({ original, onToggle }: { original: boolean; onToggle: () => void }) {
  const label = original ? "Show in dark" : "Show original colours";
  return (
    <div className="mb-1.5 flex justify-end">
      <button
        type="button"
        data-wn-dark-toggle=""
        aria-pressed={original}
        title={label}
        onClick={onToggle}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-meta font-medium text-ink-muted transition-colors hover:bg-sheen hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {original ? <Moon size={13} strokeWidth={1.9} aria-hidden="true" /> : <Sun size={13} strokeWidth={1.9} aria-hidden="true" />}
        {label}
      </button>
    </div>
  );
}

/**
 * A message body, and the control that picks its form.
 *
 * The chosen form is per message and is not persisted — a decision, not an oversight: a
 * preference would need a fourth `Preferences` key, a migration and a Settings control,
 * for a thing most readers change once.
 */
export function MessageBody({
  email,
  imagesAllowed,
  inlineParts,
  onOpenLink,
  view,
  emailDark = null,
  purePlainText = false,
}: Props) {
  const bodyHtml = email.bodyHtml;

  const hasHtml = Boolean(bodyHtml);

  // Email dark mode: which path this message takes, and the reader's per-message
  // "original colours", back to dark when the message changes.
  const [original, setOriginal] = useState(false);
  useEffect(() => setOriginal(false), [email.id]);
  const own = useMemo(() => (bodyHtml ? detectOwnDarkStyles(bodyHtml, []) : null), [bodyHtml]);
  const mode = emailDarkMode(emailDark !== null && !original, own);
  const darkFor = emailDark && mode !== "off" ? { mode, palette: emailDark } : null;
  const sanitised = useSanitised(email, imagesAllowed, inlineParts, mode === "adaptive" && emailDark ? emailDark : undefined);

  /**
   * The proxy's document, fetched when this form is on screen.
   *
   * `null` until it arrives, `null` forever if it fails. `undefined` means "not asked
   * yet", `null` means "asked, and there is no answer", and the form falls back to the
   * local renderer.
   */
  const [proxied, setProxied] = useState<ProxiedRender | null | undefined>(undefined);

  useEffect(() => {
    if (view !== "proxied" || bodyHtml === undefined) return;
    let live = true;
    setProxied(undefined);
    void renderThroughProxy(bodyHtml).then((result) => {
      if (live) setProxied(result);
    });
    return () => {
      live = false;
    };
  }, [view, bodyHtml]);

  // A plain-text message has no rich form, so it is *shown* as text whichever control is
  // pressed. Claiming otherwise would be a control that lies.
  const shown: BodyView =
    !hasHtml && (view === "rich" || view === "proxied") ? "plain" : view;

  return (
    <div className="mt-3 sm:mt-5">
      <EmailStyles />

      {hasHtml && sanitised.html === "" && (
        <p className="mb-3 text-meta text-ink-subtle">
          Nothing in this message could be rendered safely. Plain text, in the &hellip; menu,
          is all of it.
        </p>
      )}

      {emailDark && hasHtml && (shown === "rich" || (shown === "proxied" && proxied === null)) && (
        <DarkToggle original={original} onToggle={() => setOriginal((was) => !was)} />
      )}
      {shown === "rich" && <RichBody html={sanitised.html} stylesheets={sanitised.stylesheets} onOpenLink={onOpenLink} dark={darkFor} />}
      {shown === "plain" && <PlainText email={email} pure={purePlainText} />}
      {shown === "sent" && <AsSent email={email} imagesAllowed={imagesAllowed} />}
      {shown === "proxied" &&
        (proxied === undefined ? (
          <p className="text-meta text-ink-subtle" role="status" aria-live="polite">
            Asking the render proxy…
          </p>
        ) : proxied === null ? (
          <div>
            <p className="mb-2 text-meta text-ink-subtle">
              The render proxy is not answering, so this message is being rendered here
              instead.
            </p>
            <RichBody html={sanitised.html} stylesheets={sanitised.stylesheets} onOpenLink={onOpenLink} dark={darkFor} />
          </div>
        ) : (
          <Proxied
            email={email}
            document={proxied.html}
            fetched={proxied.fetched}
            blocked={proxied.blocked}
          />
        ))}
    </div>
  );
}
