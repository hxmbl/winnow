#!/bin/sh
# Pick the copy of Winnow a container runs, fetching the newest release on the way.
#
#   fetch-release.sh <web|proxy> <baked-dir> <cache-dir>
#
# Prints the directory to serve on stdout (one line) and logs to stderr. It never
# fails the container: anything that goes wrong falls back, in order, to the copy
# downloaded last time and then to the copy baked into the image.
#
# On every start, unless told otherwise:
#   1. Ask GitHub which release is newest (`releases/latest`, which never returns a
#      draft or a pre-release), or read the pinned one (WINNOW_VERSION=v1.5.0).
#   2. If that is the version baked into the image, or one already downloaded and
#      verified, use it without downloading anything.
#   3. Otherwise download `winnow-<kind>-<version>.tar.gz` and its `.sha256` from the
#      release, check the checksum (and GitHub's own digest of the asset, when the API
#      gives one), check the archive holds only plain files under one directory, and
#      unpack it into <cache-dir>/<kind>/<tag>.
#
# Network rules: https only (curl --proto =https), and every URL — redirects included,
# which are followed by hand — must be on github.com, api.github.com or GitHub's
# release-asset hosts. Nothing is ever run from an archive that failed a check.
#
# Environment:
#   WINNOW_AUTO_UPDATE=false   never contact GitHub; run the baked copy
#   WINNOW_VERSION=v1.5.0      run that release instead of the newest
#   WINNOW_REPO=owner/name     a fork's releases (default hxmbl/winnow)
#   WINNOW_FETCH_LIB=1         define the functions and return (for the tests)

set -u

KIND=${1:-}
BAKED=${2:-}
CACHE=${3:-}
REPO=${WINNOW_REPO:-hxmbl/winnow}
UA="winnow-docker"

log() { printf 'winnow-update[%s]: %s\n' "$KIND" "$*" >&2; }

# Exact hosts only. GitHub serves release downloads by redirecting from github.com to
# one of its asset hosts; objects.githubusercontent.com is the older one.
allowed_url() {
  case $1 in
    https://*) ;;
    *) return 1 ;;
  esac
  rest=${1#https://}
  host=${rest%%/*}
  case $host in
    github.com | api.github.com | objects.githubusercontent.com | release-assets.githubusercontent.com) return 0 ;;
    *) return 1 ;;
  esac
}

# A release tag: v<MAJOR>.<MINOR>.<PATCH>, optionally -<suffix>. Nothing else is ever
# put into a URL or a path.
valid_tag() {
  printf '%s\n' "$1" | grep -Eqx 'v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[0-9A-Za-z.]{1,32})?'
}

valid_repo() {
  printf '%s\n' "$1" | grep -Eqx '[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}'
}

# GET $1 into $2, following at most five redirects, each re-checked against the
# allowlist. curl's own -L would follow a redirect to anywhere.
safe_get() {
  url=$1
  out=$2
  hops=0
  while :; do
    if ! allowed_url "$url"; then
      log "refusing ${url%%\?*}: not an https URL on GitHub"
      return 1
    fi
    accept="Accept: */*"
    case $url in https://api.github.com/*) accept="Accept: application/vnd.github+json" ;; esac
    result=$(curl -sS --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 120 \
      --max-filesize 104857600 -A "$UA" -H "$accept" \
      -o "$out" -w '%{http_code} %{redirect_url}' "$url") || {
      log "could not reach ${url%%\?*}"
      return 1
    }
    code=${result%% *}
    location=${result#* }
    case $code in
      200) return 0 ;;
      301 | 302 | 303 | 307 | 308)
        hops=$((hops + 1))
        if [ "$hops" -gt 5 ] || [ -z "$location" ]; then
          log "too many redirects from ${1%%\?*}"
          return 1
        fi
        url=$location
        ;;
      *)
        log "GitHub answered $code for ${url%%\?*}"
        return 1
        ;;
    esac
  done
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# The archive must be plain files and directories with relative names and no `..`:
# no links, no devices, nothing that could land outside the directory it unpacks into.
safe_archive() {
  listing=$(tar -tzvf "$1" 2>/dev/null) || return 1
  [ -n "$listing" ] || return 1
  if printf '%s\n' "$listing" | cut -c1 | grep -qv '^[-d]$'; then return 1; fi
  names=$(tar -tzf "$1" 2>/dev/null) || return 1
  if printf '%s\n' "$names" | grep -Eq '^/|(^|/)\.\.(/|$)'; then return 1; fi
  return 0
}

# What the unpacked copy must contain to be worth serving.
looks_complete() {
  dir=$1
  version=$2
  [ -f "$dir/VERSION" ] && [ "$(cat "$dir/VERSION")" = "$version" ] || return 1
  case $KIND in
    web) [ -f "$dir/index.html" ] ;;
    proxy) [ -f "$dir/proxy/server.ts" ] ;;
    *) return 1 ;;
  esac
}

# Is version $1 newer than $2? MAJOR.MINOR.PATCH compared as numbers; a suffix
# (1.5.0-beta) counts as older than the plain release.
newer_than() {
  a=$1
  b=$2
  [ -n "$b" ] || return 0
  ia=${a%%-*}
  ib=${b%%-*}
  oldifs=$IFS
  IFS=.
  # shellcheck disable=SC2086
  set -- $ia $ib
  IFS=$oldifs
  [ $# -eq 6 ] || return 1
  for _ in 1 2 3; do
    x=$1
    y=$4
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
    shift
  done
  case $a in *-*) ;; *) case $b in *-*) return 0 ;; esac ;; esac
  return 1
}

# The last copy that was downloaded and verified, else the baked one — whichever is
# newer, so pulling a newer image is never undone by an older download.
fallback() {
  target=""
  if [ -L "$CACHE/$KIND/current" ] && [ -d "$CACHE/$KIND/current/" ]; then
    target=$(readlink "$CACHE/$KIND/current")
  fi
  baked_version=$(cat "$BAKED/VERSION" 2>/dev/null || echo "")
  if [ -n "$target" ] && newer_than "${target#v}" "$baked_version"; then
    log "serving the last downloaded copy ($target)"
    printf '%s\n' "$CACHE/$KIND/$target"
  else
    log "serving the copy baked into the image ($(cat "$BAKED/VERSION" 2>/dev/null || echo unknown))"
    printf '%s\n' "$BAKED"
  fi
}

# Point `current` at $1 (a tag directory) and drop every other download but the one
# it replaces.
promote() {
  tag=$1
  previous=""
  [ -L "$CACHE/$KIND/current" ] && previous=$(readlink "$CACHE/$KIND/current")
  rm -f "$CACHE/$KIND/current"
  ln -s "$tag" "$CACHE/$KIND/current"
  for old in "$CACHE/$KIND"/v*; do
    [ -d "$old" ] || continue
    name=${old##*/}
    [ "$name" = "$tag" ] || [ "$name" = "$previous" ] || rm -rf "$old"
  done
}

run() {
  case $KIND in
    web | proxy) ;;
    *)
      log "usage: fetch-release.sh <web|proxy> <baked-dir> <cache-dir>"
      printf '%s\n' "$BAKED"
      return 0
      ;;
  esac
  baked_version=$(cat "$BAKED/VERSION" 2>/dev/null || echo "")

  case ${WINNOW_AUTO_UPDATE:-true} in
    false | 0 | no | off)
      log "WINNOW_AUTO_UPDATE is off; serving the baked copy ($baked_version)"
      printf '%s\n' "$BAKED"
      return 0
      ;;
  esac

  if ! valid_repo "$REPO"; then
    log "WINNOW_REPO is not owner/name"
    fallback
    return 0
  fi
  if ! mkdir -p "$CACHE/$KIND" 2>/dev/null || ! [ -w "$CACHE/$KIND" ]; then
    log "$CACHE is not writable; serving the baked copy"
    printf '%s\n' "$BAKED"
    return 0
  fi

  work=$(mktemp -d "$CACHE/$KIND/.download.XXXXXX") || {
    fallback
    return 0
  }
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT

  pinned=${WINNOW_VERSION:-}
  if [ -n "$pinned" ]; then
    case $pinned in v*) ;; *) pinned="v$pinned" ;; esac
    if ! valid_tag "$pinned"; then
      log "WINNOW_VERSION=$pinned is not a release tag like v1.5.0"
      fallback
      return 0
    fi
    api="https://api.github.com/repos/$REPO/releases/tags/$pinned"
  else
    api="https://api.github.com/repos/$REPO/releases/latest"
  fi

  if ! safe_get "$api" "$work/release.json"; then
    fallback
    return 0
  fi
  tag=$(jq -r '.tag_name // empty' "$work/release.json" 2>/dev/null)
  if ! valid_tag "$tag"; then
    log "the release has no usable tag"
    fallback
    return 0
  fi
  version=${tag#v}

  if [ "$version" = "$baked_version" ]; then
    log "$tag is the version in the image"
    printf '%s\n' "$BAKED"
    return 0
  fi
  if [ -d "$CACHE/$KIND/$tag" ] && looks_complete "$CACHE/$KIND/$tag" "$version"; then
    log "$tag was downloaded before"
    promote "$tag"
    printf '%s\n' "$CACHE/$KIND/$tag"
    return 0
  fi

  asset="winnow-$KIND-$version.tar.gz"
  base="https://github.com/$REPO/releases/download/$tag"
  log "downloading $asset"
  if ! safe_get "$base/$asset.sha256" "$work/sum" || ! safe_get "$base/$asset" "$work/archive.tar.gz"; then
    log "$tag has no $asset (or it could not be downloaded)"
    fallback
    return 0
  fi

  expected=$(cut -d' ' -f1 "$work/sum" | head -n 1)
  actual=$(sha256_of "$work/archive.tar.gz")
  if ! printf '%s\n' "$expected" | grep -Eqx '[0-9a-f]{64}' || [ "$expected" != "$actual" ]; then
    log "checksum mismatch for $asset; not using it"
    fallback
    return 0
  fi
  digest=$(jq -r --arg n "$asset" '.assets[]? | select(.name == $n) | .digest // empty' "$work/release.json" 2>/dev/null)
  if [ -n "$digest" ] && [ "$digest" != "sha256:$actual" ]; then
    log "GitHub's digest for $asset disagrees with the download; not using it"
    fallback
    return 0
  fi

  if ! safe_archive "$work/archive.tar.gz"; then
    log "$asset holds something other than plain files; not using it"
    fallback
    return 0
  fi
  mkdir -p "$work/unpacked"
  if ! tar -xzf "$work/archive.tar.gz" -C "$work/unpacked" 2>/dev/null || ! looks_complete "$work/unpacked" "$version"; then
    log "$asset did not unpack to a complete copy of $tag; not using it"
    fallback
    return 0
  fi

  rm -rf "$CACHE/$KIND/$tag"
  if ! mv "$work/unpacked" "$CACHE/$KIND/$tag"; then
    fallback
    return 0
  fi
  promote "$tag"
  log "now serving $tag"
  printf '%s\n' "$CACHE/$KIND/$tag"
}

[ "${WINNOW_FETCH_LIB:-}" = 1 ] && return 0 2>/dev/null
run
