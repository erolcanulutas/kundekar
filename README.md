# Kündekâr

Image-to-inlay CAM for multi-wood V-carve artwork, in the browser.

**Open the app:** https://erolcanulutas.github.io/kundekar/

Kundekar turns an image into a multi-wood V-carve inlay. It reduces the image to the
colors of the woods you actually have, plans the order of the inlay rounds, and will
output ready-to-run G-code plus step-by-step shop instructions.

A *kündekâr* is a master of *kündekari*, the traditional Seljuk/Ottoman technique of
fitting wooden pieces together into patterns.

## How it works

The app is a sequence of steps with **Back / Next**. A project takes days (glue has to
cure between rounds), so everything is saved in your browser automatically. Use
**Export** for a backup file or to move a project to another computer.

| Step | What happens |
|---|---|
| 1. Image & size | Add artwork; set the base board size and place the image on it. Optional AI background removal. |
| 2. Wood stock | Choose base and tone woods from presets (or custom colors) with their thickness. |
| 3. Bit & depths | V-bit angle, pocket depth, glue gap, surfacing per round. Shows the narrowest region the bit can hold, with a to-scale cross-section. |
| 4. Simplify | The image is reduced to your woods; lines thinner and areas smaller than your limits are merged away. Vector preview, SVG export. |
| 5. Refine | Fix regions by hand: fill, remove, brush, lasso. Edits are re-applied when woods or settings change. |
| 6. Rounds | Round plan (touching woods never share a round), pocket and mirrored plug SVGs per round in mm, a checklist with Z depths per step, and a glue-cure timer. |

Everything runs locally in the browser. Images are never uploaded. AI background removal uses
[ORMBG](https://huggingface.co/onnx-community/ormbg-ONNX) (Apache-2.0) via
[transformers.js](https://github.com/huggingface/transformers.js); the model (~45 MB) is
downloaded from Hugging Face on first use and cached.

## Roadmap

- [x] Repo setup
- [x] **MVP 1:** wood stock with presets, image → wood-color simplification, minimum-feature
      cleanup, real-scale preview, saved multi-day projects
- [x] **MVP 2:** round planning, per-round pocket and plug SVGs, workshop checklist (DXF later if needed)
- [ ] **MVP 3:** native G-code (clearing, V-carve, plug, surfacing, registration holes)
      with a generic post-processor (Mach3 profile first)
- [ ] Downloadable/offline version (same TypeScript core)
- [ ] Extras: engraving lines, 2.5D relief

See [PLAN.md](PLAN.md) for the full design.

## Development

Requires Node 20+.

```sh
npm install
npm run dev       # local dev server
npm run build     # type-check + production build into dist/
npm run deploy    # build and publish dist/ to the gh-pages branch
```

The core (`src/core/`) has no DOM dependencies, so it can later run in Node for a
command-line or desktop version.

## Safety

Generated G-code drives a real machine. Always simulate it first (e.g. in Kiri:Moto or
another G-code viewer), check the zero points, and run air cuts before cutting wood.
