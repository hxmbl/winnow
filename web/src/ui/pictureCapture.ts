/**
 * The webview's half of the picture-bytes cache (`core/avatars/pictureBytes.ts`): load a
 * sender picture the way a notification's rasteriser does and keep a small copy.
 *
 * The load is an `Image` with `crossOrigin="anonymous"` and no referrer, so it carries no
 * cookies and tells the host nothing the avatar's own `<img>` did not; the CSP's
 * `connect-src` rules out `fetch`ing the bytes, and needs no exception for this. A host
 * that answers without `Access-Control-Allow-Origin` either fails the anonymous load or
 * taints the canvas (reading it back throws): either way the answer is `null`, the
 * picture is simply not cached, and the avatar keeps drawing it from its URL as before.
 *
 * The picture is drawn as the avatar shows it (`drawPicture`: covering the square,
 * centred) with no backdrop, so a logo's transparency survives: the avatar paints its own
 * behind it. Encoded as WebP, or PNG on an engine that cannot write WebP (`toDataURL`
 * falls back to PNG by itself).
 */

import { MAX_PICTURE_SOURCE_PX, isPictureData, type CapturePicture } from "../core/avatars/pictureBytes";
import { drawPicture } from "./notificationActions";
import { dominantColor } from "./ringColor";

/** How long one background capture may take before it is given up, ms. */
export const PICTURE_CAPTURE_MS = 8000;

export function canvasCapture(timeoutMs = PICTURE_CAPTURE_MS): CapturePicture {
  return (url, px) =>
    new Promise<string | null>((resolve) => {
      if (typeof Image === "undefined" || typeof document === "undefined") return resolve(null);
      const img = new Image();
      const timer = setTimeout(() => done(null), timeoutMs);
      let settled = false;
      function done(value: string | null) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve(value);
      }
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.decoding = "async";
      img.onerror = () => done(null);
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = px;
          canvas.height = px;
          const context = canvas.getContext("2d");
          if (!context) return done(null);
          if (Math.max(img.naturalWidth, img.naturalHeight) > MAX_PICTURE_SOURCE_PX) return done(null);
          if (!drawPicture(context, img, { width: img.naturalWidth, height: img.naturalHeight }, px, null)) return done(null);
          // WebP at 0.85, then 0.6 if that is over the size cap, then PNG (an engine with
          // no WebP encoder hands back PNG for both); whichever first fits is kept.
          for (const data of [canvas.toDataURL("image/webp", 0.85), canvas.toDataURL("image/webp", 0.6), canvas.toDataURL("image/png")]) {
            if (isPictureData(data)) return done(data);
          }
          done(null);
        } catch {
          // A tainted canvas (no CORS header) throws on `getImageData` / `toDataURL`.
          done(null);
        }
      };
      img.src = url;
    });
}

/** How many pixels a side the halo colour is sampled at: plenty for one colour. */
export const PICTURE_COLOR_PX = 32;

/**
 * The most dominant colour of an account's own profile picture (`ui/ringColor.ts`
 * `dominantColor`), for its halo. Read from the kept `data:` copy when there is one (a
 * `data:` image never taints the canvas, so no network and no CORS at all), else from
 * the URL with the same anonymous, no-referrer load as `canvasCapture` (Google's lh3
 * host sends `Access-Control-Allow-Origin`). Any failure, a tainted canvas included, is
 * `null`: the halo then keeps the account colour.
 */
export function canvasPictureColor(timeoutMs = PICTURE_CAPTURE_MS): (src: string) => Promise<string | null> {
  return (src) =>
    new Promise<string | null>((resolve) => {
      if (typeof Image === "undefined" || typeof document === "undefined") return resolve(null);
      const img = new Image();
      const timer = setTimeout(() => done(null), timeoutMs);
      let settled = false;
      function done(value: string | null) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve(value);
      }
      if (!src.startsWith("data:")) {
        img.crossOrigin = "anonymous";
        img.referrerPolicy = "no-referrer";
      }
      img.decoding = "async";
      img.onerror = () => done(null);
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = PICTURE_COLOR_PX;
          canvas.height = PICTURE_COLOR_PX;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) return done(null);
          if (Math.max(img.naturalWidth, img.naturalHeight) > MAX_PICTURE_SOURCE_PX) return done(null);
          if (!drawPicture(context, img, { width: img.naturalWidth, height: img.naturalHeight }, PICTURE_COLOR_PX, null)) return done(null);
          // Only what the round avatar shows: the corners outside its circle are left out.
          done(dominantColor(circleOnly(context.getImageData(0, 0, PICTURE_COLOR_PX, PICTURE_COLOR_PX).data, PICTURE_COLOR_PX)));
        } catch {
          // A tainted canvas (no CORS header) throws on `getImageData`.
          done(null);
        }
      };
      img.src = src;
    });
}

/** RGBA pixels of a `size`×`size` square with everything outside its inscribed circle made see-through. */
export function circleOnly(rgba: Uint8ClampedArray, size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const c = (size - 1) / 2;
  const r2 = (size / 2) ** 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - c) ** 2 + (y - c) ** 2 > r2) out[(y * size + x) * 4 + 3] = 0;
    }
  }
  return out;
}
