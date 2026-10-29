/**
 * The web build's Content-Security-Policy, in one place.
 *
 * `vite.config.ts` writes it into the built `index.html` as a `<meta>` tag and into
 * `dist/_headers` for static hosts that read one (Netlify, Cloudflare Pages). The
 * desktop and Android builds get neither: Tauri serves the same `dist/` under its own
 * policy (`native/src-tauri/tauri.conf.json`), and a second policy in the page would be
 * intersected with it — the meta tag would take away the IPC origins the shell needs.
 * The dev server does not get it either, because Vite's dev client and React's refresh
 * preamble are inline scripts by design.
 *
 * Every source is here because the app uses it, and nothing else is:
 *
 *   - **Scripts: `'self'` only.** No `'unsafe-inline'`, no `'unsafe-eval'`. The theme
 *     boot script is a file for exactly this reason.
 *   - **Styles: `'self' 'unsafe-inline'`.** Required, not a convenience. Winnow's own
 *     CSS is a file, but every message is shown in a `sandbox=""` frame built by
 *     `emailDocument()` (`core/mail/sanitize`): a `srcdoc` document whose `<style>`
 *     blocks are the sender's sanitised stylesheets plus the reader's own, and whose
 *     body keeps `style=""` attributes. A `srcdoc` frame inherits this policy, and that
 *     CSS is different for every message, so neither a hash nor a nonce (a static host
 *     cannot mint one per response) can cover it. Without it mail renders unstyled.
 *     The frame grants nothing to the sandbox, so no script runs in it: inline style is
 *     presentation only. (React's `style` props go through the CSSOM, which CSP does
 *     not govern, so the app shell alone would not need it.)
 *   - **Images: `'self' data: blob: https:`.** The broad one, deliberately: remote
 *     images in mail come from any host and load only when the reader's image policy
 *     allows them (Ask each time / Always, `core/mail/imageConsent`); a BIMI brand
 *     logo's address is whatever the sender's DNS record names; Gravatar and Google
 *     contact photos are https too. `data:` and `blob:` cover inline parts and local
 *     previews. Plain `http:` images stay blocked, as in the desktop build.
 *   - **Connections:** Gmail, Google's token and revoke endpoint, the People API (the
 *     optional contacts grant), Drive v3 on www.googleapis.com (the optional
 *     `drive.file` grant: large files as links, upload and sharing), Cloudflare's DNS-over-HTTPS resolver (only used when
 *     Sender pictures is on), and the render proxy when the build was given one.
 *   - **Frames:** `'self'` — the reader's frames are `srcdoc`. **Objects:** none.
 *     **Base:** none — nothing sets a `<base>`, and the sanitiser strips a sender's.
 *     **Forms:** none — nothing in Winnow posts a form (the setup and compose forms are
 *     handled in script and never submit); sign-in is a top-level redirect.
 *   - **Framing:** `frame-ancestors 'none'`, in `_headers` only: a `<meta>` policy
 *     cannot carry it, and browsers ignore it there.
 */

/**
 * Gmail, OAuth (token exchange and revoke), the People API, and Drive v3 (the optional
 * `drive.file` grant for large files as links), which Google serves only from
 * www.googleapis.com — what the token may do there is limited by its scopes.
 */
export const GOOGLE_CONNECT = [
  "https://gmail.googleapis.com",
  "https://oauth2.googleapis.com",
  "https://people.googleapis.com",
  "https://www.googleapis.com",
] as const;

/**
 * Update checks: GitHub's `releases/latest` for the repository (`core/updates`). One
 * unauthenticated GET every few hours, carrying nothing about the user or their mail.
 */
export const UPDATES_CONNECT = "https://api.github.com";

/** Brand logos: the DNS-over-HTTPS resolver BIMI records are read through. */
export const DOH_CONNECT = "https://cloudflare-dns.com";

export type CspOptions = {
  /** `VITE_RENDER_PROXY`, when the build has one: its origin may be fetched from. */
  renderProxy?: string | null;
  /**
   * For an HTTP header rather than a `<meta>`: adds what a meta tag cannot carry
   * (`frame-ancestors`), so the app cannot be framed by another site.
   */
  header?: boolean;
};

/** The origin of a proxy URL, or `null` when it is not an http(s) URL. */
function originOf(url: string | null | undefined): string | null {
  if (!url || url.trim() === "") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The policy as directive → sources, in a stable order. */
export function cspDirectives(options: CspOptions = {}): Array<[string, string[]]> {
  const proxy = originOf(options.renderProxy);
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", ["'self'", ...GOOGLE_CONNECT, DOH_CONNECT, UPDATES_CONNECT, ...(proxy ? [proxy] : [])]],
    ["frame-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
  ];
  if (options.header) directives.push(["frame-ancestors", ["'none'"]]);
  return directives;
}

/** The policy as one header value. */
export function contentSecurityPolicy(options: CspOptions = {}): string {
  return cspDirectives(options)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}
