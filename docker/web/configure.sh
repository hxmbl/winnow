#!/bin/sh
# Prepare the web bundle a container serves, from the operator's environment.
#
#   configure.sh <bundle-dir> <serve-dir> <nginx-dir>
#
# Copies the bundle into <serve-dir> and, there:
#   - adds the app's runtime configuration to index.html's <head>, as
#     <meta name="winnow-config" content="distribution=docker; updates=…; renderProxy=…">
#     (read by `src/platform/runtimeConfig.ts`);
#   - when the render proxy is on another origin, adds that origin to `connect-src` in
#     the `<meta>` Content-Security-Policy — the one change the policy can need;
# and writes <nginx-dir>/headers.conf (the response headers, from the bundle's own
# `_headers`, with the same change) and <nginx-dir>/proxy.conf (forwarding /render
# and /asset/ to a proxy container, or nothing).
#
# Environment:
#   WINNOW_PROXY_UPSTREAM=http://proxy:8787   forward /render and /asset/ to this proxy,
#                                             so it is same-origin with the app
#   WINNOW_RENDER_PROXY=self | https://…      where the app sends renders; defaults to
#                                             `self` when an upstream is set
#   WINNOW_AUTO_UPDATE, WINNOW_VERSION        only to tell the app how it is updated
#
# The render proxy stays an operator decision (proxy/README.md, "Pointing Winnow at
# it"): it comes from the container's environment into the page the server sends,
# never from anything the app or a message can write. A value that is not a plain http(s) URL is
# refused and the app runs without a proxy.
set -eu

bundle=$1
serve=$2
nginx=$3

log() { printf 'winnow-config: %s\n' "$*" >&2; }

rm -rf "$serve"
mkdir -p "$serve" "$nginx"
cp -R "$bundle/." "$serve/"

# ── The proxy ────────────────────────────────────────────────────────────────

upstream=${WINNOW_PROXY_UPSTREAM:-}
proxy=${WINNOW_RENDER_PROXY:-}
: > "$nginx/proxy.conf"
if [ -n "$upstream" ]; then
  if printf '%s\n' "$upstream" | grep -Eqx 'http://[a-z0-9]([a-z0-9.-]{0,253}[a-z0-9])?(:[0-9]{1,5})?'; then
    resolver=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf 2>/dev/null || true)
    case $resolver in *:*) resolver="[$resolver]" ;; esac
    {
      # A variable, so nginx resolves the proxy's name per request and starts even
      # while the proxy container is still coming up.
      [ -n "$resolver" ] && printf 'resolver %s valid=30s ipv6=off;\n' "$resolver"
      printf 'set $winnow_proxy %s;\n' "$upstream"
      cat <<'EOF'
location = /render {
  client_max_body_size 16m;
  proxy_pass $winnow_proxy;
  proxy_set_header Origin $winnow_forward_origin;
  proxy_read_timeout 30s;
  proxy_buffering off;
}
location ^~ /asset/ {
  proxy_pass $winnow_proxy;
  proxy_set_header Origin $winnow_forward_origin;
}
EOF
    } > "$nginx/proxy.conf"
    [ -n "$proxy" ] || proxy=self
    log "forwarding /render and /asset/ to $upstream"
  else
    log "WINNOW_PROXY_UPSTREAM must look like http://proxy:8787; ignoring it"
  fi
fi

origin=""
case $proxy in
  "") ;;
  self) ;;
  *)
    if printf '%s\n' "$proxy" | grep -Eqx 'https?://[a-z0-9]([a-z0-9.-]{0,253}[a-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?'; then
      scheme=${proxy%%://*}
      rest=${proxy#*://}
      hostport=${rest%%/*}
      # As the browser spells an origin: no default port.
      case "$scheme:$hostport" in
        https:*:443) hostport=${hostport%:443} ;;
        http:*:80) hostport=${hostport%:80} ;;
      esac
      origin="$scheme://$hostport"
    else
      log "WINNOW_RENDER_PROXY must be self or an http(s) URL with a lowercase host; running without a proxy"
      proxy=""
    fi
    ;;
esac

# ── How this copy is updated ─────────────────────────────────────────────────

updates=auto
case ${WINNOW_AUTO_UPDATE:-true} in false | 0 | no | off) updates=image ;; esac
[ "$updates" = auto ] && [ -n "${WINNOW_VERSION:-}" ] && updates=pinned

# ── The runtime configuration ────────────────────────────────────────────────

# Every value is one of a fixed set or matched a strict pattern above (no quotes, `<`,
# `&`, `;` or `#`), so none can leave the attribute or the pair it is written into.
content="distribution=docker; updates=$updates"
[ -n "$proxy" ] && content="$content; renderProxy=$proxy"
if grep -q 'name="winnow-config"' "$serve/index.html"; then
  log "the bundle's index.html already carries a winnow-config tag; refusing to serve it"
  exit 1
fi
sed "s#<head>#<head><meta name=\"winnow-config\" content=\"$content\">#" "$serve/index.html" > "$serve/index.html.tmp"
mv "$serve/index.html.tmp" "$serve/index.html"
if [ "$(grep -c 'name="winnow-config"' "$serve/index.html")" != 1 ]; then
  log "could not add the runtime configuration to index.html"
  exit 1
fi

# ── Content-Security-Policy ──────────────────────────────────────────────────

# A cross-origin proxy is the only source the policy ever gains, appended last in
# connect-src exactly as `cspDirectives` does (`src/platform/csp.ts`); docker.test.ts
# holds the two to each other.
add_origin() {
  if [ -n "$origin" ]; then
    # The meta tag spells ' as &#39;, whose `;` is not the end of the directive.
    sed -E "s@(connect-src ([^;&]|&#39;)*)@\1 $origin@"
  else
    cat
  fi
}

if [ -n "$origin" ] && [ -f "$serve/index.html" ]; then
  add_origin < "$serve/index.html" > "$serve/index.html.tmp"
  mv "$serve/index.html.tmp" "$serve/index.html"
fi

: > "$nginx/headers.conf"
if [ -f "$serve/_headers" ]; then
  sed -n 's/^  \([A-Za-z-]*\): \(.*\)$/\1|\2/p' "$serve/_headers" | add_origin |
    while IFS='|' read -r name value; do
      printf 'add_header %s "%s" always;\n' "$name" "$value"
    done > "$nginx/headers.conf"
  rm -f "$serve/_headers"
fi
if ! grep -q '^add_header Content-Security-Policy ' "$nginx/headers.conf"; then
  log "the bundle has no _headers policy; refusing to serve it without one"
  exit 1
fi
log "render proxy: ${proxy:-none}; updates: $updates"
