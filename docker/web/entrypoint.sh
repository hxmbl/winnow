#!/bin/sh
# The web image's entrypoint: choose the newest Winnow (docker/fetch-release.sh),
# prepare it (docker/web/configure.sh), then hand the process to nginx.
#
# Restarting the container is the update: every start asks GitHub for the newest
# release, so `docker compose restart` picks it up. WINNOW_AUTO_UPDATE=false keeps the
# copy baked into the image; WINNOW_VERSION=v1.5.0 pins a release.
set -eu

mkdir -p /tmp/nginx /tmp/winnow
bundle=$(/opt/winnow/fetch-release.sh web /opt/winnow/web "${WINNOW_DATA:-/var/lib/winnow}")
if ! /opt/winnow/configure.sh "$bundle" /tmp/winnow/www /tmp/winnow/nginx; then
  # A downloaded copy that cannot be configured is not served; the baked one is.
  [ "$bundle" = /opt/winnow/web ] && exit 1
  echo "winnow: falling back to the baked copy" >&2
  /opt/winnow/configure.sh /opt/winnow/web /tmp/winnow/www /tmp/winnow/nginx
fi
echo "winnow: serving $(cat /tmp/winnow/www/VERSION 2>/dev/null || echo unknown) on :8080" >&2
exec "$@"
