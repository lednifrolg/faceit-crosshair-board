# Third-party code

## src/lib/crosshairRenderer.js

- **Source:** https://github.com/girlglock/cs2-crosshair (`public/static/crosshairRenderer.js`),
  taken unmodified from the sibling project
  [FACEIT Crosshair Peek](https://github.com/lednifrolg/faceit-crosshair-peek).
- **License:** GPL-3.0
- **Modifications:** none to the code. A provenance header comment was prepended, because
  upstream ships the file without any copyright or licence notice of its own and the release
  zip needs to carry that attribution with it.

This file decodes CS2 crosshair share codes (the original, version 1 format) and renders
them to a canvas using the game's own pixel math. It is GPL-3, which is why this project is
GPL-3: linking it into the extension makes the whole extension a derivative work.

## src/lib/pixelCrosshair.js

Not third-party code: written for FACEIT Crosshair Peek by the same author and copied here
unmodified. It decodes and draws the pixel-era share codes CS2 introduced on 2026-09-22.
Its byte layouts follow [akiver/csgo-sharecode](https://github.com/akiver/csgo-sharecode)
(MIT) and the format notes of SpiRaL-network/cs2-crosshair-lab; no code was copied from
either.

The full GPL-3 text is in [LICENSE](LICENSE) and covers the two files above and all other
code in the project.

## src/fonts/JetBrainsMono-*.woff2

- **Source:** https://github.com/JetBrains/JetBrainsMono, release v2.304
  (`fonts/webfonts/`), Regular and Bold.
- **License:** SIL Open Font License 1.1, text in
  [src/fonts/JetBrainsMono-OFL.txt](src/fonts/JetBrainsMono-OFL.txt), shipped next to the
  fonts as the licence requires.
- **Modifications:** none.

Bundled so the new tab page never loads anything from the network.
