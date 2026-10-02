/* FACEIT Crosshair Peek - pixel-era crosshair share codes
 *
 * CS2's Rush Hour update (2026-09-22) replaced the resolution-scaled crosshair with one
 * defined in whole pixels at the resolution it was configured on. The share code changed
 * with it, twice:
 *
 *   CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx  18 bytes, version byte 1 (legacy), 3 or 4
 *   CS + 44 characters                  32 bytes, version byte 1 (since 2026-09-30)
 *
 * Both are the same encoding: base 57, least significant digit first, a big-endian byte
 * string whose first byte is the sum of the rest mod 256. Legacy version 1 codes are left
 * to the vendored renderer; this file decodes and draws everything after it.
 *
 * Byte layouts: version 3/4 from akiver/csgo-sharecode (MIT); the CS format as documented
 * by SpiRaL-network/cs2-crosshair-lab. This is an independent implementation of both.
 *
 * Copyright (C) 2026 Filip Tomasovych
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version. See the LICENSE file for details.
 */
(() => {
  "use strict";

  const DICTIONARY = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";
  const LEGACY_PATTERN = new RegExp(`^CSGO(-[${DICTIONARY}]{5}){5}$`);
  const CURRENT_PATTERN = new RegExp(`^CS[${DICTIONARY}]{44}$`);

  /* Styles, numbered as the game numbers them in every pixel-era format:
   * 0 Dynamic Cross, 1 Dynamic Circle, 2 Classic Dynamic Cross, 3 Static Circle,
   * 4 Static Cross, 5 Static Cross (Shot Feedback), 6 Dot Only, 7 Dynamic Quad,
   * 8 Static Square, 9 Static Quadrant. The dynamic ones move with weapon spread, so a
   * still image of them would be a guess. Shot Feedback is a static cross at rest. */
  const DYNAMIC_STYLES = new Set([0, 1, 2, 7]);
  const STYLE_CROSS = new Set([4, 5]);
  const STYLE_DOT = 6;
  const STYLE_CIRCLE = 3;
  const STYLE_SQUARE = 8;

  const OUTLINE_NONE = 0;
  const OUTLINE_HALF = 2;

  function toBytes(digits, length) {
    let num = 0n;
    for (const ch of [...digits].reverse()) num = num * 57n + BigInt(DICTIONARY.indexOf(ch));
    const hex = num.toString(16).padStart(length * 2, "0");
    if (hex.length > length * 2) return null;
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    const sum = bytes.slice(1).reduce((a, b) => a + b, 0) % 256;
    return bytes[0] === sum ? bytes : null;
  }

  const u16 = (bytes, i) => bytes[i] | (bytes[i + 1] << 8);
  const i16 = (bytes, i) => (u16(bytes, i) << 16) >> 16;

  // Fields shared by the 18-byte version 3 and 4 layouts.
  function decodeShortPixel(bytes) {
    return {
      style: bytes[2] & 0xf,
      dot: (bytes[2] & 0x40) !== 0,
      tStyle: (bytes[2] & 0x80) !== 0,
      color: [bytes[3], bytes[4], bytes[5], bytes[6]],
      outlineColor: [0, 0, 0, 255], // configurable only since the CS format
      gap: bytes[7],
      length: bytes[8],
      // Bits 23-27 of the little-endian bit field in bytes 10-13.
      thickness: (bytes[12] >> 7) | ((bytes[13] & 0xf) << 1),
      screenHeight: u16(bytes, 14),
    };
  }

  function decodeCurrent(bytes) {
    return {
      screenHeight: u16(bytes, 2),
      style: bytes[4] & 0x1f,
      dot: (bytes[4] & 0x40) !== 0,
      tStyle: (bytes[4] & 0x80) !== 0,
      color: bytes.slice(5, 9),
      outlineColor: bytes.slice(9, 13),
      thickness: bytes[13] & 0x3f,
      outline: bytes[13] >> 6,
      gap: i16(bytes, 14),
      length: bytes[16],
    };
  }

  /**
   * Classifies a share code:
   *   { kind: "pixel", settings }  decoded, draw with render()
   *   { kind: "legacy" }           a version 1 CSGO- code, for the vendored renderer
   *   { kind: "unsupported" }      well-formed, but a version this file doesn't know
   *   null                         not a share code, or a failed checksum
   */
  function decode(code) {
    if (CURRENT_PATTERN.test(code)) {
      const bytes = toBytes(code.slice(2), 32);
      if (!bytes) return null;
      if (bytes[1] !== 1 || bytes.slice(23).some((b) => b !== 0)) return { kind: "unsupported" };
      return { kind: "pixel", settings: decodeCurrent(bytes) };
    }
    if (LEGACY_PATTERN.test(code)) {
      const bytes = toBytes(code.slice(5).replace(/-/g, ""), 18);
      if (!bytes) return null;
      switch (bytes[1]) {
        case 1:
          return { kind: "legacy" };
        case 3:
          return {
            kind: "pixel",
            settings: { ...decodeShortPixel(bytes), outline: (bytes[2] & 0x20) ? 1 : 0 },
          };
        case 4:
          return {
            kind: "pixel",
            settings: { ...decodeShortPixel(bytes), outline: (bytes[13] >> 4) & 3 },
          };
        default:
          return { kind: "unsupported" };
      }
    }
    return null;
  }

  const isPreviewable = (s) =>
    STYLE_CROSS.has(s.style) || [STYLE_DOT, STYLE_CIRCLE, STYLE_SQUARE].includes(s.style);

  const isDynamic = (s) => DYNAMIC_STYLES.has(s.style);

  /* Shapes in pixel coordinates around the crosshair centre. The thickness band covers
   * [lo, lo + t), so an odd thickness centres on a pixel (centre 0.5) and an even one on
   * a pixel corner (centre 0).
   *
   * The gap is measured from the centre, not from the edge of that band: the right arm
   * starts at pixel `gap` and the left one mirrors it. So gap 0 draws a solid plus, and
   * a 1px crosshair needs gap 2 to show a 1px hole. Valve's notes don't say which; this
   * matches in-game observation (gap 0 is a closed plus, length 0 draws nothing) and
   * procrosshairs.com's renderer, not the band-edge model the obvious reading suggests. */
  function shapes(s, height) {
    const scale = height / (s.screenHeight || height);
    const t = Math.max(1, Math.round(s.thickness * scale));
    const len = Math.round(s.length * scale);
    const gap = Math.round(s.gap * scale);
    const lo = -Math.floor(t / 2);
    const centre = t % 2 ? 0.5 : 0;
    const mirror = (x) => 2 * centre - x;
    const rects = [];
    const rect = (x, y, w, h) => {
      if (w > 0 && h > 0) rects.push({ x, y, w, h });
    };
    let ring = null;

    if (STYLE_CROSS.has(s.style)) {
      rect(gap, lo, len, t);
      rect(mirror(gap) - len, lo, len, t);
      rect(lo, gap, t, len);
      if (!s.tStyle) rect(lo, mirror(gap) - len, t, len);
    } else if (s.style === STYLE_SQUARE) {
      // The same convention for the square's inner edge; not yet checked in game.
      const near = mirror(gap) - t;
      const size = 2 * (gap - centre) + 2 * t;
      rect(near, near, size, t);
      rect(near, near + size - t, size, t);
      rect(near, near + t, t, size - 2 * t);
      rect(near + size - t, near + t, t, size - 2 * t);
    } else if (s.style === STYLE_CIRCLE) {
      ring = { radius: Math.max(t / 2, Math.abs(gap) + t / 2), width: t };
    }
    if (s.dot || s.style === STYLE_DOT) rect(lo, lo, t, t);

    return { rects, ring, centre: t % 2 ? 0.5 : 0 };
  }

  /** A pixel-exact canvas at `height`, or null for a style that can't be drawn still. */
  function render(s, height, minSize = 8) {
    if (!isPreviewable(s)) return null;
    const { rects, ring, centre } = shapes(s, height);
    const outline = s.outline !== OUTLINE_NONE;
    const pad = outline ? 1 : 0;

    let reach = minSize / 2;
    for (const r of rects) {
      reach = Math.max(reach, centre - r.x, r.x + r.w - centre, centre - r.y, r.y + r.h - centre);
    }
    if (ring) reach = Math.max(reach, ring.radius + ring.width / 2);
    reach = Math.ceil(reach + pad - centre) + centre; // keep the centre on the same parity
    const size = 2 * reach;
    const offset = reach - centre;

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.translate(offset, offset);

    const rgba = ([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${a / 255})`;
    const body = new Path2D();
    for (const r of rects) body.rect(r.x, r.y, r.w, r.h);
    const ringPath = (radius) => {
      const p = new Path2D();
      p.arc(centre, centre, radius, 0, Math.PI * 2);
      return p;
    };

    // One path per layer, so overlapping bars don't stack alpha, and the outline is cut
    // out under the body so a translucent crosshair shows the scene rather than the outline.
    if (outline) {
      const half = s.outline === OUTLINE_HALF;
      const border = new Path2D();
      for (const r of rects) {
        border.rect(r.x - 1, r.y - 1, r.w + (half ? 1 : 2), r.h + (half ? 1 : 2));
      }
      ctx.fillStyle = ctx.strokeStyle = rgba(s.outlineColor);
      ctx.fill(border);
      if (ring) {
        ctx.lineWidth = ring.width + 2;
        ctx.stroke(ringPath(ring.radius));
      }
      ctx.globalCompositeOperation = "destination-out";
      ctx.fill(body);
      if (ring) {
        ctx.lineWidth = ring.width;
        ctx.stroke(ringPath(ring.radius));
      }
      ctx.globalCompositeOperation = "source-over";
    }

    ctx.fillStyle = ctx.strokeStyle = rgba(s.color);
    ctx.fill(body);
    if (ring) {
      ctx.lineWidth = ring.width;
      ctx.stroke(ringPath(ring.radius));
    }
    return canvas;
  }

  globalThis.PixelCrosshair = { decode, render, isDynamic, isPreviewable };
})();
