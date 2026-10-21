#!/bin/sh
# The render proxy image's entrypoint: choose the newest proxy release
# (docker/fetch-release.sh), then run it. Restarting the container is the update;
# WINNOW_AUTO_UPDATE=false keeps the copy baked into the image, WINNOW_VERSION pins one.
set -eu

bundle=$(/opt/winnow/fetch-release.sh proxy /opt/winnow/proxy "${WINNOW_DATA:-/var/lib/winnow}")
echo "winnow: render proxy $(cat "$bundle/VERSION" 2>/dev/null || echo unknown)" >&2
cd "$bundle/proxy"
exec node --experimental-strip-types server.ts
