/**
 * The body of a message, in whichever of three forms the reader asks for.
 *
 * This component exists because there are now three reasonable answers to "how
 * should a message render?" and choosing between them is a decision rather than an
 * implementation detail:
 *
 *   - **Rich** — the sender's markup, sanitised, inline. The default, because it
 *     is what a mail client is for. The comparison that started this showed the
 *     alternative: a newsletter reduced to a column of words with its URLs spelled
 *     out, which is not what the sender sent and is not what anybody wants to read.
 *   - **Plain** — the text, which is what the classifier read and what a reply
 *     quotes. Always available, and the answer for anybody who prefers it and for a
 *     message that has no HTML part at all.
 *   - **As sent** — the untouched original in a `sandbox=""` frame. The escape
 *     hatch, and the only form in which a sender's own CSS is taken at its word.
 *
 * **Why the rich form can be inline when the original could not.** `html.ts` and
 * the reader it was written for are both right that a sender must never get to run
 * markup in the app's origin. What changed is that there is now a sanitiser
 * (`core/mail/sanitize.ts`) with an allowlist and a test for every way a sender
 * attacks one, so "sanitised" became a claim that can be checked instead of a hope.
 * The sandbox has not gone anywhere: it is what "as sent" is, so the one context
 * that is *not* sanitised stays a context the reader chooses on purpose.
 *
 * **What this component deliberately does not do is decide about images.** Whether a
 * message's remote content loads is `core/mail/imageConsent`'s decision, it arrives
 * as a boolean, and every reference that was refused is still counted and still
 * stated. Rendering inline changes where the markup lands; it does not change who
 * gets to learn that a message was opened.
 */

import { useEffect, useMemo, useState, useRef } from "react";
import { Code2, Eye, Server, Type } from "lucide-react";
import {
  emailDocument,
  inlineEmailCss,
  sanitizeMailHtml,
} from "../../core/mail/sanitize";
import {
  renderProxyUrl,
  renderThroughProxy,
  type ProxiedRender,
} from "../../core/mail/proxy";
import type { Email } from "../../core/model/email";

/**
 * Which of the forms a message body is being shown in.
 *
 * `proxied` exists only when `VITE_RENDER_PROXY` named a proxy at build time. It is
 * the one form where the *images* are loaded without the reader answering anything
 * first, which is exactly what the proxy is for: the fetch comes from the server,
 * so a tracking pixel reports the server's address and not the reader's, and the
 * reader gets a newsletter's images without agreeing to tell anybody anything.
 */
export type BodyView = "rich" | "plain" | "proxied" | "sent";

/**
 * The stylesheet the inline form needs, mounted once.
 *
 * Every selector in it descends from `[data-wn-email]`, which is the entire reason
 * it is safe to put in the app's document at all. It lives here rather than in
 * `index.css` because `sanitize.ts` owns the rules; a second copy in the app's
 * stylesheet would be a second statement of them and the first place for them to
 * drift apart.
 */
function EmailStyles() {
  const css = useMemo(() => inlineEmailCss(), []);
  return <style data-wn-email-styles="" dangerouslySetInnerHTML={{ __html: css }} />;
}

/**
 * Sanitised once per message and once per answer to the image offer.
 *
 * Memoised on what can change the result rather than on the HTML alone, because
 * flipping `imagesAllowed` when the reader presses a button in the offer has to
 * show the message *now* — re-scanning a 200KB body inside that press is visible
 * as a stutter in the very message the reader is deciding whether to trust.
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
        // Collected rather than dropped, and then not used here: there is nowhere to
        // put a stylesheet in the app's document without it reaching the reader.
        // "As sent" below is where they go, and the render proxy is the other.
        collectStyles: false,
      }),
    [email.bodyHtml, imagesAllowed, inlineParts],
  );
}

/**
 * The plain text, unchanged.
 *
 * `whitespace-pre-wrap` so the sender's own paragraph breaks survive without
 * re-wrapping to the pane width — an email body is pre-formatted by convention, and
 * reflowing it shreds the quoted reply underneath. The font is the system sans
 * rather than a monospace one, because this is prose a person wrote.
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
 * **The container is the message's own page — a light surface with a hairline, which
 * is what Gmail and Apple Mail both do, and what keeps a `#333`-on-`#fff` newsletter
 * legible inside a dark reader.** Darkening the message to match the app would be a
 * prettier idea that produces unreadable text.
 *
 * **It scrolls sideways, and that is the standard answer.** HTML mail is laid out in
 * fixed-width tables — 600px is the traditional measure and a lot of it is still
 * exactly that — and the reader pane is a third of a window. So a faithfully
 * rendered message is usually wider than the pane, and the two possible answers are
 * to let it scroll or to cut it off. Cutting it off loses the right-hand column of
 * every newsletter that has one, silently, which is the same failure mode as the
 * inflated blocked-count this codebase keeps warning about: the app looks fine and
 * is telling the reader something untrue. Scrolling is what every mail client does,
 * and it is honest.
 *
 * `overflow-x-auto` rather than `auto` because a vertically-scrolling frame inside
 * a vertically-scrolling pane is a scroll trap.
 *
 * **The click handler is what makes an inlined link safe to click.** A link in a
 * message must not navigate this window, and must not get a handle on it either, so
 * the click is taken here and handed to the caller, which opens it in the system
 * browser. The URL is read off the rendered anchor rather than off the sender's
 * markup on the way in, so it is the value that survived the sanitiser's judgement
 * by construction — and a `<base>` or a relative path, both of which the sanitiser
 * drops, cannot turn into a request against the app's own origin.
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
      // Set position relative on the pre element if it's not already
      if (getComputedStyle(preElement).position === "static") {
        preElement.style.position = "relative";
      }

      // Check if a copy button already exists
      if (preElement.querySelector('[data-wn-copy-button]')) return;

      // Create a wrapper for the copy button
      const buttonWrapper = document.createElement("div");
      buttonWrapper.setAttribute("data-wn-copy-button", "");
      buttonWrapper.style.position = "absolute";
      buttonWrapper.style.top = "0.5em";
      buttonWrapper.style.right = "0.5em";
      buttonWrapper.style.opacity = "0";
      buttonWrapper.style.transition = "opacity 0.15s ease";

      // Create the button element
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "flex h-7 w-7 items-center justify-center rounded bg-white text-ink-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
      button.setAttribute("aria-label", "Copy code");
      button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

      let copied = false;
      let timeoutId: number | null = null;

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
            button.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
            if (!copied) {
              buttonWrapper.style.opacity = "0";
            }
          }, 2000);
        } catch (error) {
          console.error("Failed to copy code:", error);
        }
      };

      button.addEventListener("click", handleCopy);

      // Show/hide on hover
      preElement.addEventListener("mouseenter", () => {
        buttonWrapper.style.opacity = "1";
      });
      preElement.addEventListener("mouseleave", () => {
        if (!copied) {
          buttonWrapper.style.opacity = "0";
        }
      });

      buttonWrapper.appendChild(button);
      preElement.appendChild(buttonWrapper);
    });

    return () => {
      // Clean up on unmount
      codeBlocks.forEach((pre) => {
        const button = pre.querySelector('[data-wn-copy-button]');
        if (button) {
          button.remove();
        }
      });
    };
  }, [html]);

  return (
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
        // A fragment stays in the document, and a message's own anchors were not
        // given ids (a sender's `id` would collide with the app's), so there is
        // nowhere for one to go and it is left to the browser to do nothing.
        if (!href || href.startsWith("#")) return;
        event.preventDefault();
        onOpenLink(href);
      }}
      className="selectable overflow-x-auto overflow-y-hidden rounded-pane border border-hairline bg-white shadow-pane"
      // The only place in the app where a sender's markup lands, and the reason the
      // sanitiser exists at all.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * The message as its sender wrote it, in a `sandbox=""` frame.
 *
 * `sandbox=""` — the empty string, with *no token named* — is the most restrictive
 * value the attribute can take: no scripts, no forms, no popups, no top-level
 * navigation, no plugins, and an opaque origin rather than this app's. Every one of
 * those is load-bearing, and none of them is needed for tables, styles and images
 * to render. Adding `allow-same-origin` would hand a message the store, the keybind
 * listener and `localStorage`; adding `allow-scripts` would let a sender run code.
 * This form exists so that the one place where the sanitiser's judgement is *not*
 * in force is a place the reader went on purpose.
 *
 * **It still sanitises, and still obeys the image answer.** A sandbox does not block
 * remote images — mounting the frame at all would fetch them — so "as sent" is
 * sanitised with the same `allowRemote` as the rich form and nothing loads that the
 * reader has not agreed to. "As sent" means *layout*, not *consent*: the difference
 * is the sender's CSS and the message's own `cid:` parts, both of which the rich
 * form has to drop or rewrite.
 *
 * The frame is a fixed height rather than a measured one. Measuring it would require
 * the frame to script — `postMessage` is the only way a sandboxed document can
 * report its size — and granting `allow-scripts` to save the reader a scrollbar is a
 * bad trade. The frame scrolls, which is what a frame does.
 */
function AsSent({ email, imagesAllowed }: { email: Email; imagesAllowed: boolean }) {
  const document = useMemo(() => {
    const sanitised = sanitizeMailHtml(email.bodyHtml ?? "", {
      allowRemote: imagesAllowed,
      // The sender's stylesheets go here, in a document that contains nothing else
      // and so cannot reach the reader. Sanitised first — no `@import`, no `url()`
      // that fetches, no `expression()`.
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
 * **The document this frame shows is not trusted, and it is the sandbox that says
 * so rather than the code that fetched it.** A proxy is a third party: it can be
 * misconfigured, compromised, or simply replaced by whoever deploys it, and a
 * message rendered through one is still a message from a stranger. So the answer it
 * hands back is mounted in the same `sandbox=""` frame as the untouched original,
 * with the same nothing granted — the proxy makes this document *more* faithful, not
 * more safe, and treating its output as sanitised-by-construction because the proxy
 * sanitised it would be trusting the wrong end of the pipe.
 *
 * Why it is worth having anyway: it is the only form in which the images are loaded
 * without the reader being asked, and the asking is the whole friction. The proxy
 * has already fetched them, so the sender's server saw the proxy and not the reader.
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

/**
 * The control that picks between the forms.
 *
 * Two choices rather than four when the message has no HTML part. A switch whose
 * "Rich" option renders nothing is a control lying about the message, which is the
 * same complaint the old "Load images" toggle drew.
 */
function ViewSwitch({
  view,
  onChange,
  hasHtml,
}: {
  view: BodyView;
  onChange: (next: BodyView) => void;
  hasHtml: boolean;
}) {
  const options: Array<{ id: BodyView; label: string; Icon: typeof Type }> = [
    ...(hasHtml ? [{ id: "rich" as BodyView, label: "Rich", Icon: Eye }] : []),
    ...(hasHtml && renderProxyUrl !== null
      ? [{ id: "proxied" as BodyView, label: "Proxied", Icon: Server }]
      : []),
    { id: "plain", label: "Plain text", Icon: Type },
    { id: "sent", label: "As sent", Icon: Code2 },
  ];

  return (
    <div
      role="group"
      aria-label="How to show this message"
      className="inline-flex items-center gap-0.5 rounded-full bg-sheen p-0.5"
    >
      {options.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          onClick={() => onChange(id)}
          title={`Show this message as ${label.toLowerCase()}`}
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
            view === id ? "bg-surface text-ink shadow-pane" : "text-ink-muted hover:text-ink"
          }`}
        >
          <Icon size={12} strokeWidth={1.9} aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

type Props = {
  email: Email;
  /**
   * May this message's remote content load? Resolved upstream by
   * `core/mail/imageConsent` and passed as a boolean, so this component never has to
   * know which of the two answers is in force.
   */
  imagesAllowed: boolean;
  /** The message's inline parts as data URIs, when they have been fetched. */
  inlineParts?: Record<string, string>;
  /** Open a link from the message in the system browser, a different origin. */
  onOpenLink: (url: string) => void;
};

/**
 * A message body, and the control that picks its form.
 *
 * The chosen form is per message and is not persisted. That is a decision, not an
 * oversight: a preference would need a fourth key in `Preferences`, a migration in
 * `main.tsx` and a control in Settings, for a thing most readers change once. The
 * default — rich — is the one the screenshots were arguing for, so the preference
 * would only ever be a way to go back to the thing this component replaced.
 */
export function MessageBody({ email, imagesAllowed, inlineParts, onOpenLink }: Props) {
  const [view, setView] = useState<BodyView>("rich");
  const emailId = email.id;
  const bodyHtml = email.bodyHtml;

  // Back to the default when the selection moves, so a message you read as text is
  // not the reason the next one is.
  useEffect(() => {
    setView("rich");
  }, [emailId]);

  const hasHtml = Boolean(bodyHtml);
  const sanitised = useSanitised(email, imagesAllowed, inlineParts);

  /**
   * The proxy's document, fetched when this form is on screen.
   *
   * `null` until it arrives, `null` forever if it fails — and the effect is written
   * so that a failure is *not* retried on every render, which is the bug a
   * dependency list built from a `null` state invites. `undefined` means "not asked
   * yet", `null` means "asked, and there is no answer", and the form falls back to
   * the local renderer, which needs no network at all and is the better answer
   * anyway.
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

  // A plain-text message has no rich form, so it is *shown* as text whichever
  // control is pressed. Claiming otherwise would be a control that lies.
  const shown: BodyView =
    !hasHtml && (view === "rich" || view === "proxied") ? "plain" : view;

  return (
    <div className="mt-4">
      <EmailStyles />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <ViewSwitch view={view} onChange={setView} hasHtml={hasHtml} />
        {hasHtml && sanitised.html === "" && (
          <p className="text-[12px] text-ink-subtle">
            Nothing in this message could be rendered safely. The plain text above is
            all of it.
          </p>
        )}
      </div>

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