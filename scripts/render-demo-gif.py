#!/usr/bin/env python3
"""Rasterizes the demo scene model into docs/demo.gif.

Consumes the frame spec emitted by `node scripts/gen-demo-svg.mjs --frames`,
so the README GIF and docs/demo.svg are the SAME demo — chrome, colors,
timing — differing only in delivery format (GitHub strips SVG animation in
READMEs; it always animates GIFs).

Regeneration-only tooling: needs Python 3 + Pillow and a monospace TTF
(Consolas / DejaVu Sans Mono / Menlo). Not part of the build or CI.

Usage: node scripts/gen-demo-svg.mjs --frames frames.json
       python scripts/render-demo-gif.py frames.json docs/demo.gif
"""

import json
import sys

from PIL import Image, ImageDraw, ImageFont

SCALE = 2  # render at 2x for crisp text, like the SVG at any zoom

FONT_CANDIDATES = [
    "C:/Windows/Fonts/consola.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    raise SystemExit("no monospace TTF found; add yours to FONT_CANDIDATES")


def main(spec_path, out_path):
    spec = json.load(open(spec_path, encoding="utf-8"))
    W, H = spec["W"] * SCALE, spec["H"] * SCALE
    font = load_font(spec["FS"] * SCALE)
    title_font = load_font(spec["FS"] * SCALE)
    lines = spec["lines"]

    # Frame boundaries: every reveal and every scene end, deduplicated.
    times = sorted({0.0, spec["TOTAL"], *(l["t"] for l in lines), *(l["end"] for l in lines)})
    frames, durations = [], []
    for i, t0 in enumerate(times[:-1]):
        dur = times[i + 1] - t0
        if dur < 0.01:
            continue
        visible = [l for l in lines if l["t"] <= t0 + 1e-6 < l["end"]]
        frames.append(draw_frame(spec, visible, font, title_font, W, H))
        durations.append(max(30, round(dur * 1000)))

    # One shared adaptive palette keeps the file small and colors stable.
    base = frames[0].quantize(colors=64)
    quantized = [f.quantize(colors=64, palette=base) for f in frames]
    quantized[0].save(
        out_path,
        save_all=True,
        append_images=quantized[1:],
        duration=durations,
        loop=0,
        optimize=True,
    )
    print(f"wrote {out_path} ({len(quantized)} frames, {sum(durations) / 1000:.1f}s loop, {W}x{H})")


def draw_frame(spec, visible, font, title_font, W, H):
    s = SCALE
    im = Image.new("RGB", (W, H), "#0d1117")
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=8 * s, outline="#30363d", fill="#0d1117")
    d.rounded_rectangle([0, 0, W - 1, 28 * s], radius=8 * s, fill="#161b22")
    d.rectangle([0, 20 * s, W - 1, 28 * s], fill="#161b22")
    for cx, color in [(19, "#f85149"), (37, "#e3b341"), (55, "#3fb950")]:
        d.ellipse([(cx - 5) * s, 9 * s, (cx + 5) * s, 19 * s], fill=color)
    title = spec["title"]
    tw = d.textlength(title, font=title_font)
    d.text(((W - tw) / 2, 8 * s), title, font=title_font, fill="#8b949e")

    for l in visible:
        x = 16 * s
        y = (spec["TOP"] + 14 + l["row"] * spec["LH"]) * s - spec["FS"] * s  # baseline -> top
        for text, color in l["runs"]:
            d.text((x, y), text, font=font, fill=color)
            x += d.textlength(text, font=font)
    return im


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
