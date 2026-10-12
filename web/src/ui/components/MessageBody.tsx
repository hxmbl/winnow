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

import { useEffect, useMemo, useState, useRef } from "react";
import { Server } from "lucide-react";
import {
  emailDocument,
  inlineEmailCss,
  sanitizeMailHtml,
} from "../../core/mail/sanitize";
import {
  renderThroughProxy,
  type ProxiedRender,
} from "../../core/mail/proxy";
import type { Email } from "../../core/model/email";

/**
 * Which of the forms a message body is being shown in.
 *
 * `proxied` exists only when `VITE_RENDER_PROXY` named a proxy at build time — the one
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
) {
  return useMemo(
    () =>
      sanitizeMailHtml(email.bodyHtml ?? "", {
        allowRemote: imagesAllowed,
        inlineParts,
        // Collected rather than dropped, and then not used here: there is nowhere to put
        // a stylesheet in the app's document without it reaching the reader. "As sent"
        // below is where they go, and the render proxy is the other.
        collectStyles: false,
      }),
    [email.bodyHtml, imagesAllowed, inlineParts],
  );
}

/**
 * The plain text, unchanged.
 *
 * `whitespace-pre-wrap` so the sender's own paragraph breaks survive without re-wrapping
 * to the pane width. System sans rather than monospace, because this is prose a person
 * wrote.
 */
function PlainText({ email }: { email: Email }) {
  return (
    <div className="selectable max-w-[68ch] whitespace-pre-wrap text-body text-ink-body">
      {email.body}
    </div>
  );
}

/**
 * The rich form: sanitised markup, in this document.
 *
 * **The container is the message's own page — a light surface with a hairline, which is
 * what Gmail and Apple Mail both do, and what keeps a `#333`-on-`#fff` newsletter legible
 * inside a dark reader.**
 *
 * **It scrolls sideways, and that is the standard answer.** HTML mail is laid out in
 * fixed-width tables (600px traditionally), usually wider than the pane, and the choice
 * is between scrolling and silently cutting off the right-hand column of every
 * newsletter. `overflow-x-auto` rather than `auto`, because a vertically-scrolling frame
 * inside a vertically-scrolling pane is a scroll trap.
 *
 * **The click handler is what makes an inlined link safe to click.** The click is taken
 * here and handed to the caller, which opens it in the system browser. The URL is read
 * off the rendered anchor, so it is the value that survived the sanitiser by
 * construction.
 */
function RichBody({
  html,
  onOpenLink,
}: {
  html: string;
  onOpenLink: (url: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

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
        "flex h-7 w-7 items-center justify-center rounded bg-white text-ink-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
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
    <div className="selectable overflow-x-auto overflow-y-hidden rounded-pane border border-hairline bg-white px-6 py-5">
      <div
        ref={containerRef}
        data-wn-email=""
        onClick={(event) => {
          const anchor = (event.target as HTMLElement).closest?.("a[href]");
          if (!anchor || !event.currentTarget.contains(anchor)) return;
          // A modified click is the user asking for the browser's own answer — a new
          // tab, a download — so it is left alone rather than swallowed.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const href = anchor.getAttribute("href");
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

  return (
    <iframe
      key={`${email.id}:${imagesAllowed}`}
      title="Message as sent"
      srcDoc={document}
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
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[12px] font-medium text-ink-muted">
          <Server size={13} strokeWidth={1.9} aria-hidden="true" />
          {fetched} {fetched === 1 ? "image" : "images"} fetched by Winnow&rsquo;s server,
          not by your browser
          {blocked > 0 && ` · ${blocked} withheld`}
        </p>
      </div>
      <iframe
        key={`${email.id}:proxied`}
        title="Message, rendered by Winnow's server"
        srcDoc={document}
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
};

/**
 * A message body, and the control that picks its form.
 *
 * The chosen form is per message and is not persisted — a decision, not an oversight: a
 * preference would need a fourth `Preferences` key, a migration and a Settings control,
 * for a thing most readers change once.
 */
export function MessageBody({ email, imagesAllowed, inlineParts, onOpenLink, view }: Props) {
  const bodyHtml = email.bodyHtml;

  const hasHtml = Boolean(bodyHtml);
  const sanitised = useSanitised(email, imagesAllowed, inlineParts);

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
    <div className="mt-5">
      <EmailStyles />

      {hasHtml && sanitised.html === "" && (
        <p className="mb-3 text-[12px] text-ink-subtle">
          Nothing in this message could be rendered safely. Plain text, in the &hellip; menu,
          is all of it.
        </p>
      )}

      {shown === "rich" && <RichBody html={sanitised.html} onOpenLink={onOpenLink} />}
      {shown === "plain" && <PlainText email={email} />}
      {shown === "sent" && <AsSent email={email} imagesAllowed={imagesAllowed} />}
      {shown === "proxied" &&
        (proxied === undefined ? (
          <p className="text-[12px] text-ink-subtle" role="status" aria-live="polite">
            Asking the render proxy…
          </p>
        ) : proxied === null ? (
          <div>
            <p className="mb-2 text-[12px] text-ink-subtle">
              The render proxy is not answering, so this message is being rendered here
              instead.
            </p>
            <RichBody html={sanitised.html} onOpenLink={onOpenLink} />
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
