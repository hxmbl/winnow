# The Winnow render proxy

Gmail does not render a newsletter in your browser. It fetches the images itself,
serves them from `googleusercontent.com`, and hands you a document that names *its*
addresses. That one move is why Gmail can show you a marketing email full of images
without telling the sender where you are, or whether you opened it at all.

This is that move, for Winnow.

## What it does

```
POST /render   {"html": "<the message body>"}   ->  a complete HTML document
GET  /asset/<id>                                ->  an image the proxy fetched
GET  /health
```

Given a message body it will:

1. **Plan** every address the message names — `src`, `srcset`, `background`,
   `poster`, `style="…url()"` and the rules inside `<style>` blocks.
2. **Fetch** each one, subject to the address policy in `addressPolicy.ts`.
3. **Sanitise** the body, substituting the fetched addresses as it walks
   (`rewriteUrls` on `core/mail/sanitize.ts`).
4. **Return** a self-contained document: the sender's own CSS, re-homed into a
   document that contains nothing else.

The response carries `X-Winnow-Assets-Fetched` and `X-Winnow-Assets-Blocked`, which
is how Winnow tells the reader what it did and did not fetch on their behalf.

## Running it

```sh
cd web
npm run proxy            # http://127.0.0.1:8787
PORT=9000 npm run proxy  # or somewhere else
```

No dependencies, no build step — Node 22.6+ strips the types.

### Cross-origin

Same-origin by default: with the proxy behind the app's own host, no CORS header is
emitted and none is needed.

If it is on a different host — a split deployment, or the app on `localhost:5173`
during development — say who may call it:

```sh
ALLOWED_ORIGINS=http://127.0.0.1:5173,https://app.example npm run proxy
```

Exact origins: scheme, host and port. No trailing slash, no wildcard, and **no `*`**
— the list is empty unless somebody fills it in. A wildcard would make the proxy
callable from any page a signed-in reader happens to visit, which is a way to have
somebody's browser ask a server to fetch things. The address policy still applies to
those fetches, but *who may talk to this service at all* ought to be a deliberate
decision rather than a default.

## Pointing Winnow at it

```sh
cd web
VITE_RENDER_PROXY=http://127.0.0.1:8787 npm run build
```

Winnow then offers a **Proxied** option in every message's view switch. Without the
variable, that option does not appear and nothing else changes: the app renders
sanitised markup inline and withholds remote images until the reader says otherwise,
which is still correct and is what `core/mail/imageConsent` governs either way.

It is a build-time constant rather than a preference on purpose. Pointing a reader's
app at an arbitrary URL that receives their mail and returns markup would be a
remote-administration hole dressed as a setting, and a setting is exactly the thing
a message could try to change. The proxy is an operator decision about where a
deployment assembles mail.

The Docker image keeps that rule while letting one published image serve everyone:
the operator names the proxy in the container's environment
(`WINNOW_PROXY_UPSTREAM=http://proxy:8787`, or `WINNOW_RENDER_PROXY` for one
elsewhere), and the container writes it into a same-origin `/config.js` on start
(`docker/web/configure.sh`, read by `web/src/platform/runtimeConfig.ts`). Nothing the
app or a message can do writes that file, and a value that is not a plain http(s) URL
is refused. With an upstream, nginx in the web container forwards `/render` and
`/asset/` here, so the proxy is same-origin with the app; it drops an `Origin` that
names the app's own host before forwarding and passes any other through, so this
server's allowlist still refuses every other page. The proxy's own container
(`proxy/Dockerfile`) runs as an unprivileged user and listens on all interfaces only
inside its network: `docker-compose.proxy.yml` does not publish its port.

## The security argument, in order of how much it matters

**The address policy.** This is a server that will fetch a URL chosen by whoever sent
you mail, which is the oldest request-forgery gadget there is. The rule is in
`addressPolicy.ts` and it is: *an address is judged after it is resolved, and every
address a hostname resolves to is judged.* Checking the text of a URL proves only
that the text is innocent — `http://127.0.0.1/`, `http://localhost/`, and any A
record pointing at `169.254.169.254` all reach the inside of a machine, and the last
of those is the cloud metadata endpoint whose contents are the instance's
credentials. Refused ranges are written out in the table with a note on what each one
is for, and the three ways an IPv6 literal can *wrap* a blocked IPv4 address —
`::ffff:`, NAT64 and 6to4 — are unwrapped and judged as IPv4.

**The sanitiser.** A proxy that assembles documents from strangers' markup needs an
allowlist, and it is `web/src/core/mail/sanitize.ts` — the same one the app uses, so
there is one implementation of the rule rather than two. The substitution happens
*inside* the sanitising walk rather than in a second pass over a finished document,
because a second pass has to remember to cover every place a `url()` can appear and a
`<style>` block is the place it forgets. A `rewriteUrls` map is **exhaustive**: an
address not in it is withheld and counted, even under `allowRemote: true`. That is
what makes it safe for the proxy to allow itself remote content, and removing the
clause is how a loopback literal ends up in a document the *reader's* browser acts
on.

**The document is still sandboxed.** Winnow mounts what the proxy returns in a
`sandbox=""` frame with nothing granted, exactly as it mounts the untouched
original. A proxy is a third party: it can be misconfigured, compromised, or replaced
by whoever deploys it. It makes the document *more faithful*, not more safe, and
treating its output as safe because the proxy sanitised it would be trusting the
wrong end of the pipe.

**What it does not do.** No authentication, no record of who asked, and no cache of
message bodies — a cached document is a copy of somebody's mail sitting in a log.
Assets are cached for fifteen minutes, bounded in count as well as in age, because
expiry alone bounds memory by *rate*.

## Deploying it

Put it behind something that terminates TLS and, ideally, a rate limit. It is a
small stateless service apart from its fifteen-minute asset cache, so it scales
horizontally with no coordination — at the cost of each instance fetching its own
copy of an image, which is exactly the right trade for a service whose entire purpose
is not telling senders where their readers are.

Point it at a network where `169.254.169.254` does not lead to anything valuable.
The policy already refuses it; this is about not being the reason that matters.

## Tests

```sh
cd web
npm run test        # includes proxy/**/*.test.ts
npm run lint:proxy
```

The two test files are the ones worth reading first: `addressPolicy.test.ts` is the
threat model written as assertions, and `assets.test.ts` runs over a newsletter
written to be as awkward as real mail — because the property that matters is that no
address is left behind, and that is the one a rendered screenshot will not show you.