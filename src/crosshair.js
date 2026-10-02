/* FACEIT Crosshair Board - share code -> DOM
 *
 * Routing and failure handling ported from FACEIT Crosshair Peek's content.js; the two
 * renderers (lib/crosshairRenderer.js, lib/pixelCrosshair.js) are loaded as classic
 * scripts by newtab.html and read from globalThis here.
 *
 * Copyright (C) 2026 Filip Tomasovych
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. See the LICENSE file for details.
 */

/* One fixed scale for every cell, so a bigger crosshair looks bigger: comparing sizes
 * across a row is part of the point. A crosshair larger than its cell is cropped around
 * its centre by CSS, never rescaled. */
export const RENDER_SCALE = 3;
const REFERENCE_HEIGHT = 1080; // game resolution the crosshair is drawn for

const renderer = new globalThis.CS2CrosshairRenderer();
const { PixelCrosshair } = globalThis;

/* parseCode() never throws. On a bad pattern or a failed checksum it returns its own
 * defaultSettings object *by reference*, and those defaults render as a perfectly
 * plausible green crosshair - i.e. someone else's. Identity is the only reliable failure
 * signal: a valid code always yields a fresh object, even one that happens to decode to
 * exactly the defaults. Don't "improve" this into a deep equality check. */
function parseShareCode(code) {
  if (!renderer.CODE_PATTERN.test(code)) return null;
  const settings = renderer.parseCode(code);
  return settings === renderer.defaultSettings ? null : settings;
}

/**
 * `{ canvas }` for a drawable code, otherwise `{ text, title }` saying why not.
 * Never throws.
 */
export function renderCode(code) {
  /* The vendored renderer only knows the original layout and never reads the version
   * byte. Pixel-era version 3/4 codes keep its CSGO-xxxxx shape and checksum, so it
   * would accept them and draw a plausible but wrong crosshair. Route by version first. */
  const decoded = PixelCrosshair.decode(code);
  if (!decoded) return { text: "invalid", title: "couldn't decode this share code" };
  if (decoded.kind === "unsupported") return { text: "new fmt", title: "this share code version isn't supported yet" };

  try {
    if (decoded.kind === "pixel") {
      const s = decoded.settings;
      if (PixelCrosshair.isDynamic(s)) return { text: "dynamic", title: `style ${s.style} follows weapon spread` };
      if (!PixelCrosshair.isPreviewable(s)) return { text: "no preview", title: `style ${s.style} is not previewable yet` };
      return { canvas: scaled(PixelCrosshair.render(s, REFERENCE_HEIGHT)) };
    }

    const settings = parseShareCode(code);
    if (!settings) return { text: "invalid", title: "couldn't decode this share code" };
    // Styles 0 and 1 are the legacy dynamic ones and can't be drawn statically.
    const style = Number(settings.cl_crosshairstyle);
    if (style < 2) return { text: "dynamic", title: `crosshairstyle ${style} follows weapon spread` };
    return { canvas: scaled(renderer.renderCrosshair(settings, REFERENCE_HEIGHT)) };
  } catch {
    return { text: "?", title: "render failed" };
  }
}

/* What the crosshair looks like, as a string: equal for two share codes of one crosshair.
 * CS2 has three encodings in use (legacy CSGO- v1, pixel-era CSGO- v3/v4, and CS + 44
 * since 2026-09-30), so a player who kept their crosshair across the switch has a new code
 * for it; comparing codes as strings would mark that as a change. Fields are listed
 * explicitly so an encoding-only difference (field order, padding) can't leak in. Codes
 * that don't decode fall back to themselves. */
const PIXEL_FIELDS = ["style", "dot", "tStyle", "color", "outline", "outlineColor", "thickness", "gap", "length", "screenHeight"];
const keys = new Map();

export function crosshairKey(code) {
  let key = keys.get(code);
  if (key != null) return key;
  key = code;
  try {
    const decoded = PixelCrosshair.decode(code);
    if (decoded?.kind === "pixel") {
      key = "pixel:" + JSON.stringify(PIXEL_FIELDS.map((f) => decoded.settings[f]));
    } else if (decoded?.kind === "legacy") {
      const settings = parseShareCode(code);
      if (settings) key = "legacy:" + JSON.stringify(Object.keys(settings).sort().map((k) => [k, settings[k]]));
    }
  } catch {
    // keep the code itself
  }
  keys.set(code, key);
  return key;
}

function scaled(canvas) {
  canvas.style.width = `${canvas.width * RENDER_SCALE}px`;
  canvas.style.height = `${canvas.height * RENDER_SCALE}px`;
  return canvas;
}
