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
