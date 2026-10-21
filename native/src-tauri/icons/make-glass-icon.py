#!/usr/bin/env python3
"""Generate the macOS app icon sources from source-icon.svg.

Writes
  Winnow.icon/              the Icon Composer bundle (macOS 26 Tahoe, Liquid Glass).
                            The bundler compiles it into Contents/Resources/Assets.car
                            with actool (Xcode 26+) and sets CFBundleIconName.
  icon.icns                 the pre-Tahoe fallback: an opaque squircle tile on Apple's
                            1024 grid (824 px shape), so older macOS draws it as-is.

The planes are the two polygons in source-icon.svg. Each is drawn the way the SVG
paints it: the body plus its fold, stroked 5 units with round joins, with the fold's
white inside (the fold minus that stroke) cut out. In the .icon the cut-out shows the
glass behind, so the glyph is one shape per plane that the system can tint or clear.

Needs: pip install shapely cairosvg pillow
Run from anywhere: python3 native/src-tauri/icons/make-glass-icon.py
"""
import json
import re
import shutil
from io import BytesIO
from pathlib import Path

import cairosvg
from PIL import Image
from shapely.geometry import Polygon
from shapely.ops import unary_union

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "source-icon.svg"

# Glyph width on the 1024-pt Icon Composer canvas, which is the whole icon shape.
GLYPH_WIDTH = 640
STROKE = 5.0  # source-icon.svg's stroke-width


def polygons(svg: str):
    """Yield (body, fold) for each plane: relative m/l paths, optional translate()."""
    for group in re.finditer(r'<g transform="translate\(([-\d. ]+)\)">(.*?)</g>', svg, re.S):
        tx, ty = map(float, group.group(1).split())
        yield tuple(_paths(group.group(2), tx, ty))
    rest = re.sub(r'<g transform=.*?</g>', "", svg, flags=re.S)
    yield tuple(_paths(rest, 0.0, 0.0))


def _paths(chunk: str, tx: float, ty: float):
    for d in re.findall(r'<path fill="#[0-9a-f]+" d="([^"]+)"', chunk):
        pairs = [tuple(map(float, p.split(","))) for p in re.findall(r"-?[\d.]+,-?[\d.]+", d)]
        x, y = pairs[0]
        pts = [(x, y)]
        for dx, dy in pairs[1:]:
            x, y = x + dx, y + dy
            pts.append((x, y))
        yield Polygon([(px + tx, py + ty) for px, py in pts])


def plane_shapes():
    planes = []
    for body, fold in polygons(SOURCE.read_text()):
        ink = unary_union([body, fold]).buffer(STROKE / 2, join_style="round")
        paper = fold.buffer(-STROKE / 2, join_style="round")
        planes.append((ink, paper))
    return planes


def path_d(geom, scale, ox, oy):
    """SVG path data (evenodd) for a shapely polygon, mapped into canvas px."""
    def ring(coords):
        pts = [f"{(x - ox) * scale:.2f},{(y - oy) * scale:.2f}" for x, y in coords]
        return "M" + " L".join(pts) + " Z"
    polys = getattr(geom, "geoms", [geom])
    return " ".join(ring(p.exterior.coords) + "".join(" " + ring(i.coords) for i in p.interiors) for p in polys)


def layout(planes, width, canvas, centre_y=None):
    """Scale and origin so the planes' bbox is `width` wide, centred on the canvas."""
    allink = unary_union([ink for ink, _ in planes])
    minx, miny, maxx, maxy = allink.bounds
    scale = width / (maxx - minx)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    ox = cx - (canvas / 2) / scale
    oy = cy - ((centre_y if centre_y is not None else canvas / 2)) / scale
    return scale, ox, oy


def svg_doc(body, size=1024):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 {size} {size}">\n{body}\n</svg>\n')


# ---------- Winnow.icon ----------

def c(r, g, b, a=1.0):
    return f"extended-srgb:{r:.5f},{g:.5f},{b:.5f},{a:.5f}"


INK_LIGHT = c(0.11, 0.11, 0.12)   # near-black planes on the light glass
INK_DARK = c(0.96, 0.96, 0.97)    # white planes on the dark glass


def write_icon_bundle(planes):
    bundle = HERE / "Winnow.icon"
    if bundle.exists():
        shutil.rmtree(bundle)
    (bundle / "Assets").mkdir(parents=True)
    scale, ox, oy = layout(planes, GLYPH_WIDTH, 1024)
    # polygons() yields the translated (lower-right) plane first.
    order = sorted(zip(planes, ["lower", "upper"]), key=lambda t: t[1] != "upper")
    layers = []
    for (ink, paper), which in order:
        glyph = ink.difference(paper)
        name = f"plane-{which}.svg"
        (bundle / "Assets" / name).write_text(svg_doc(
            f'  <path fill="#000000" fill-rule="evenodd" d="{path_d(glyph, scale, ox, oy)}"/>'))
        layers.append({
            "name": f"Plane ({which})",
            "image-name": name,
            "glass": True,
            "fill-specializations": [
                {"value": {"solid": INK_LIGHT}},
                {"appearance": "dark", "value": {"solid": INK_DARK}},
            ],
        })
    doc = {
        # Light frosted glass; a deep graphite glass in Dark. Tinted and Clear are
        # derived by the system from these.
        "fill-specializations": [
            {"value": {"linear-gradient": [c(1.0, 1.0, 1.0), c(0.86, 0.89, 0.93)]}},
            {"appearance": "dark", "value": {"linear-gradient": [c(0.24, 0.25, 0.28), c(0.08, 0.08, 0.09)]}},
        ],
        "groups": [
            {
                "name": "Paper planes",
                "layers": layers,
                "lighting": "individual",
                "specular": True,
                "shadow": {"kind": "neutral", "opacity": 0.5},
                "translucency": {"enabled": True, "value": 0.2},
            }
        ],
        "supported-platforms": {"squares": ["macOS"]},
    }
    (bundle / "icon.json").write_text(json.dumps(doc, indent=2) + "\n")
    return bundle


# ---------- icon.icns (pre-Tahoe fallback) ----------

def squircle_d(size=824, offset=100, n=5.0, steps=720):
    """Superellipse |x|^n + |y|^n = 1, close to Apple's continuous-corner icon shape."""
    import math
    r = size / 2
    cx = cy = offset + r
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = cx + r * math.copysign(abs(ct) ** (2 / n), ct)
        y = cy + r * math.copysign(abs(st) ** (2 / n), st)
        pts.append(f"{x:.2f},{y:.2f}")
    return "M" + " L".join(pts) + " Z"


def write_icns(planes):
    # The glyph keeps the same share of the tile as it has of the .icon canvas.
    scale, ox, oy = layout(planes, GLYPH_WIDTH * 824 / 1024, 1024)
    shape = squircle_d()
    ink = " ".join(path_d(i, scale, ox, oy) for i, _ in planes)
    paper = " ".join(path_d(p, scale, ox, oy) for _, p in planes)
    svg = svg_doc(f"""  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#DBE2EC"/>
    </linearGradient>
  </defs>
  <path fill="url(#g)" d="{shape}"/>
  <path fill="#1C1C1F" d="{ink}"/>
  <path fill="#FFFFFF" d="{paper}"/>""")
    (HERE / "glass-tile.svg").write_text(svg)
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=1024, output_height=1024)
    img = Image.open(BytesIO(png)).convert("RGBA")
    img.save(HERE / "icon.icns", sizes=[(16, 16), (32, 32), (64, 64), (128, 128),
                                         (256, 256), (512, 512), (1024, 1024)])
    return img


if __name__ == "__main__":
    planes = plane_shapes()
    print("wrote", write_icon_bundle(planes))
    write_icns(planes)
    print("wrote", HERE / "icon.icns")
