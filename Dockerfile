# syntax=docker/dockerfile:1
#
# Winnow's web app, served by nginx as an unprivileged user on port 8080.
#
#   docker compose up -d                      # see docker-compose.yml and the README
#   docker build -t winnow .                  # from source
#
# Restarting the container is the update: on every start the entrypoint fetches the
# newest release's prebuilt bundle from GitHub (checksum-verified), and falls back to
# the last one it downloaded, then to the copy built into this image
# (docker/fetch-release.sh). The render proxy is configured at run time
# (docker/web/configure.sh adds a <meta name="winnow-config"> to index.html), so one
# image works for everyone.

# ── Build: the same `vite build` as any web deployment, with no render proxy baked in.
# On the build machine's own platform: the output is plain files, the same for every
# architecture.
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY docker/ /src/docker/
RUN VITE_RENDER_PROXY= npx vite build --logLevel warn \
  && sh /src/docker/bundle.sh web /src /out

# ── Serve.
FROM nginxinc/nginx-unprivileged:stable-alpine
LABEL org.opencontainers.image.title="Winnow" \
      org.opencontainers.image.description="Winnow, the Gmail client, as a self-hosted web app" \
      org.opencontainers.image.source="https://github.com/hxmbl/winnow" \
      org.opencontainers.image.licenses="MIT"
USER root
RUN apk add --no-cache curl jq \
  && mkdir -p /var/lib/winnow \
  && chown 101:101 /var/lib/winnow
COPY docker/web/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=755 docker/fetch-release.sh /opt/winnow/fetch-release.sh
COPY --chmod=755 docker/web/configure.sh /opt/winnow/configure.sh
COPY --chmod=755 docker/web/entrypoint.sh /opt/winnow/entrypoint.sh
COPY --from=build /out /opt/winnow/web
USER 101
ENV WINNOW_DATA=/var/lib/winnow
# Downloaded releases live here, so a restart without network still serves the newest.
VOLUME /var/lib/winnow
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/opt/winnow/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
