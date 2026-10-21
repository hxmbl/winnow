/*
 * Runtime configuration, loaded before the bundle (src/platform/runtimeConfig.ts).
 *
 * Empty on purpose: in dev, a plain static deployment and the desktop and Android
 * builds, every value comes from the build. The Docker image overwrites this file on
 * each start (docker/web/configure.sh) to name its render proxy and how it updates.
 * A classic script from 'self', like theme-boot.js, because the CSP forbids inline
 * script.
 */
