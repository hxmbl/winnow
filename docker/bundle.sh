#!/bin/sh
# Lay out what a container runs, from a checkout.
#
#   bundle.sh web   <repo-root> <out-dir>   # needs web/dist (npx vite build) first
#   bundle.sh proxy <repo-root> <out-dir>
#
# One list, used twice: the Dockerfiles bake this layout into the images, and the
# release workflow tars the same layout into `winnow-<kind>-<version>.tar.gz`, which
# a running container downloads on start (docker/fetch-release.sh). Each holds a
# VERSION file with the app's version, which is how the fetcher tells them apart.
#
# The proxy's layout keeps the repository's paths, because `proxy/server.ts` imports
# the sanitiser from `../web/src/core/mail/` (one sanitiser, shared with the app).
set -eu

kind=$1
root=$2
out=$3

version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$root/web/package.json" | head -n 1)
[ -n "$version" ] || { echo "bundle.sh: no version in web/package.json" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out"
case $kind in
  web)
    [ -f "$root/web/dist/index.html" ] || { echo "bundle.sh: build web/dist first" >&2; exit 1; }
    cp -R "$root/web/dist/." "$out/"
    ;;
  proxy)
    mkdir -p "$out/proxy" "$out/web/src/core/mail"
    for file in "$root"/proxy/*.ts; do
      case $file in *.test.ts) continue ;; esac
      cp "$file" "$out/proxy/"
    done
    cp "$root/proxy/README.md" "$out/proxy/"
    # The sanitiser and what it imports. The release workflow starts the bundled
    # proxy and asks it for /health, so a new import missing here fails the release
    # rather than a container.
    for file in sanitize.ts html.ts emailDark.ts; do
      cp "$root/web/src/core/mail/$file" "$out/web/src/core/mail/"
    done
    ;;
  *)
    echo "bundle.sh: unknown kind $kind" >&2
    exit 1
    ;;
esac
printf '%s\n' "$version" > "$out/VERSION"
echo "$out: winnow-$kind $version"
