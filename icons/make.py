#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Generates src/icons/icon{16,32,48,128}.png.

Each size is laid out on its own pixel grid (whole-pixel rects, crispEdges) instead of
scaling one drawing, so the 16 px toolbar icon stays sharp. The motif is the board itself:
a 2x2 grid of crosshairs, the newest (top left) in orange as a changed cell would be.

Needs rsvg-convert (librsvg). Run from the repo root: python3 icons/make.py
"""
import pathlib
import subprocess

GREEN = "#00ff41"
ORANGE = "#ff5500"
BG = "#000000"
RIM = "#0d3a18"  # keeps the black tile visible on a dark toolbar

# size: (radius, margin, cell, gap, thickness, arm, crossgap, cell_border)
LAYOUT = {
    16: (3, 1, 7, 0, 1, 2, 0, 0),  # solid pluses: a gap would turn them into dots
    32: (6, 3, 12, 2, 2, 3, 1, 0),
    48: (9, 5, 16, 6, 2, 3, 2, 1),
    128: (24, 16, 44, 8, 4, 10, 4, 2),
}


def crosshair(cx0, cy0, cell, t, arm, gap, color):
    """Four arms around the cell centre; cx0/cy0 is the cell's top-left corner."""
    size = 2 * (gap + arm) + t
    x = cx0 + (cell - size) // 2
    y = cy0 + (cell - size) // 2
    mid = gap + arm
    rects = [
        (x, y + mid, arm, t),                    # left
        (x + mid + t + gap, y + mid, arm, t),    # right
        (x + mid, y, t, arm),                    # top
        (x + mid, y + mid + t + gap, t, arm),    # bottom
    ]
    return "".join(f'<rect x="{a}" y="{b}" width="{w}" height="{h}" fill="{color}"/>' for a, b, w, h in rects)


def svg(size):
    radius, margin, cell, gap, t, arm, cgap, border = LAYOUT[size]
    assert 2 * margin + 2 * cell + gap == size, size
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">',
        f'<rect width="{size}" height="{size}" rx="{radius}" fill="{RIM}"/>',
        f'<rect x="1" y="1" width="{size - 2}" height="{size - 2}" rx="{radius - 1}" fill="{BG}"/>',
        '<g shape-rendering="crispEdges">',
    ]
    for row in range(2):
        for col in range(2):
            x0 = margin + col * (cell + gap)
            y0 = margin + row * (cell + gap)
            newest = row == 0 and col == 0
            if border:
                stroke = ORANGE if newest else RIM
                half = border / 2
                parts.append(
                    f'<rect x="{x0 + half}" y="{y0 + half}" width="{cell - border}" height="{cell - border}" '
                    f'fill="none" stroke="{stroke}" stroke-width="{border}"/>'
                )
            parts.append(crosshair(x0, y0, cell, t, arm, cgap, ORANGE if newest else GREEN))
    parts.append("</g></svg>")
    return "".join(parts)


def main():
    root = pathlib.Path(__file__).resolve().parent.parent
    out = root / "src" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for size in LAYOUT:
        png = out / f"icon{size}.png"
        subprocess.run(["rsvg-convert", "-o", str(png)], input=svg(size).encode(), check=True)
        print(png.relative_to(root))


if __name__ == "__main__":
    main()
