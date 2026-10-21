# syntax=docker/dockerfile:1
#
# The Winnow render proxy (proxy/README.md), as an unprivileged Node process on
# port 8787. Build from the repository root, because the proxy imports the app's
# sanitiser:
#
#   docker build -f proxy/Dockerfile -t winnow-proxy .
#
# Like the web image, restarting it is the update: the entrypoint fetches the newest
# release's `winnow-proxy-<version>.tar.gz` (checksum-verified) and falls back to the
# last download, then to the copy built into this image (docker/fetch-release.sh).
#
# It listens on all interfaces *inside* the container so the web container can reach
# it. Do not publish its port: put it behind the app (docker-compose.proxy.yml does),
# or, if it must be reached directly, set ALLOWED_ORIGINS (see the README).

FROM node:24-alpine AS bundle
WORKDIR /src
COPY web/package.json web/package.json
COPY web/src/core/mail web/src/core/mail
COPY proxy proxy
COPY docker/bundle.sh docker/bundle.sh
RUN sh docker/bundle.sh proxy /src /out

FROM node:24-alpine
LABEL org.opencontainers.image.title="Winnow render proxy" \
      org.opencontainers.image.description="Fetches a message's images server-side so the sender never sees the reader" \
      org.opencontainers.image.source="https://github.com/hxmbl/winnow" \
      org.opencontainers.image.licenses="MIT"
RUN apk add --no-cache curl jq \
  && mkdir -p /var/lib/winnow \
  && chown node:node /var/lib/winnow
COPY --chmod=755 docker/fetch-release.sh /opt/winnow/fetch-release.sh
COPY --chmod=755 docker/proxy/entrypoint.sh /opt/winnow/entrypoint.sh
COPY --from=bundle /out /opt/winnow/proxy
USER node
ENV HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production \
    WINNOW_DATA=/var/lib/winnow
VOLUME /var/lib/winnow
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1
ENTRYPOINT ["/opt/winnow/entrypoint.sh"]
