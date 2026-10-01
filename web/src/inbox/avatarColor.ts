/**
 * Derives a pill accent from a sender's profile picture.
 *
 * Wired up ahead of time: `PROFILE_PICTURES` is empty because the app has no
 * avatar source yet, so `cachedAccent` always misses and senders fall back to
 * the flat grey pill. Populate `PROFILE_PICTURES` and call `primeAvatarColors`
 * once at startup (App does) and the pills start picking up colours with no
 * other change.
 */

/** sender address → avatar URL. Empty until the app has a picture source. */
export const PROFILE_PICTURES: Record<string, string> = {};

/** Downscale target. Big enough for a stable dominant hue, cheap to decode. */
const SAMPLE = 24;

/** url → "#rrggbb" of the dominant chromatic colour. */
const CACHE = new Map<string, string>();

/** url → in-flight decode, so a re-render never re-fetches the same avatar. */
const INFLIGHT = new Map<string, Promise<void>>();

/**
 * Buckets pixels by hue sector and returns the best-populated, most saturated
 * sector's average. Greys and near-transparent pixels are skipped so a white
 * background or a monochrome avatar doesn't win the vote.
 */
function dominantColor(pixels: Uint8ClampedArray): string | null {
  const sectors = Array.from({ length: 6 }, () => ({
    r: 0,
    g: 0,
    b: 0,
    n: 0,
    weight: 0,
  }));

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma < 24) continue;

    const sector =
      max === r
        ? g > b
          ? 0 // yellow — red dominant, green above blue
          : 5 // rose — red dominant, blue above green
        : max === g
          ? r > b
            ? 1 // lime
            : 2 // cyan
          : r > g
            ? 3 // blue
            : 4 // violet
      ;

    const t = sectors[sector];
    t.r += r;
    t.g += g;
    t.b += b;
    t.n += 1;
    // Favour sectors that are both populous and strongly coloured.
    t.weight += chroma * Math.sqrt(t.n);
  }

  let best: (typeof sectors)[number] | null = null;
  for (const t of sectors) {
    if (t.n === 0) continue;
    if (!best || t.weight > best.weight) best = t;
  }
  if (!best) return null;

  const hex = (v: number) =>
    Math.round(v / best.n)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}

function sample(img: HTMLImageElement): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    return dominantColor(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } catch {
    // Tainted canvas — the avatar host didn't send CORS headers.
    return null;
  }
}

function load(url: string): Promise<void> {
  const existing = INFLIGHT.get(url);
  if (existing) return existing;

  const pending = new Promise<void>((resolve) => {
    const img = new Image();
    // Without this the canvas is tainted and getImageData throws.
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const color = sample(img);
      if (color) CACHE.set(url, color);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  }).finally(() => INFLIGHT.delete(url));

  INFLIGHT.set(url, pending);
  return pending;
}

/** Kicks off a decode for every known avatar. Safe to call more than once. */
export function primeAvatarColors(): void {
  for (const url of Object.values(PROFILE_PICTURES)) void load(url);
}

/** Synchronous read for render — `undefined` until the decode lands. */
export function cachedAccent(url: string): string | undefined {
  return CACHE.get(url);
}
