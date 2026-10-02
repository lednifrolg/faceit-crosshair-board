// SPDX-License-Identifier: GPL-3.0-or-later
//
// crosshair.js reads the two renderers from globalThis, as newtab.html loads them as
// classic scripts; load them the same way here, then import the module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";

for (const file of ["crosshairRenderer.js", "pixelCrosshair.js"]) {
  const url = new URL(`../src/lib/${file}`, import.meta.url);
  runInThisContext(readFileSync(url, "utf8"), { filename: url.pathname });
}
const { crosshairKey, renderCode } = await import("../src/crosshair.js");

// Real pairs from the board: one player each, same crosshair before and after CS2's
// 2026-09-30 switch from CSGO- (v3/v4) to CS + 44 share codes.
const SAME = [
  ["CSGO-6zGWQ-iJ8rG-J7XQM-z6xX9-dG4UO", "CSXwt39KAsesoNjY9wsLSc3Qw9qsWbKyUTYUfKO8hd4xPm"],
  ["CSGO-VVdMn-jvs9n-R3jEB-QqGB8-wCAoM", "CSFeAhMytDBJkjSqfaPA9r9fAyxGAiouiB9qhqyK3ZbeHi"],
  ["CSGO-PNGdP-cjK2S-FnQss-rJj7j-9UmPK", "CSbOXFDBwGtO59o4oRY4OiRbfGFSnN4DN2O2fDv8WGwAfK"],
];

test("crosshairKey: the same crosshair in both share code formats is the same key", () => {
  for (const [legacy, current] of SAME) assert.equal(crosshairKey(legacy), crosshairKey(current), `${legacy} vs ${current}`);
});

test("crosshairKey: different crosshairs stay different", () => {
  const keys = new Set(SAME.map(([a]) => crosshairKey(a)));
  assert.equal(keys.size, SAME.length);
});

test("crosshairKey: legacy v1 codes key by their settings, garbage by itself", () => {
  const v1 = "CSGO-43Xd3-akOjE-fOHmW-GoRhM-sPcAB"; // from tests/fixtures/scoreboard.json
  assert.match(crosshairKey(v1), /^(legacy|pixel):/);
  assert.equal(crosshairKey("not a code"), "not a code");
});

test("renderCode: undrawable codes explain themselves without a DOM", () => {
  assert.deepEqual(renderCode("not a code"), { text: "invalid", title: "couldn't decode this share code" });
});
