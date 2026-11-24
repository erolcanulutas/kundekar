# Kundekar

Image-to-inlay CAM for multi-wood V-carve artwork.

Kundekar turns an image into a multi-wood V-carve inlay. It reduces the image to the
colors of the woods you actually have, plans the order of the inlay rounds, and outputs
ready-to-run G-code plus step-by-step shop instructions.

A *kündekâr* is a master of *kündekari*, the traditional Seljuk/Ottoman technique of
fitting wooden pieces together into patterns.

> **Status:** early development. Nothing is usable yet. See [PLAN.md](PLAN.md) for the
> full design and roadmap.

## How it works

1. **Simplify.** The image is resized to the physical size of the piece and quantized
   to the base wood plus 3–5 tone woods. Regions too small for the V-bit to cut reliably
   are merged into their neighbours.
2. **Plan rounds.** Touching colors cannot be pocketed in the same round. Kundekar
   builds a region adjacency graph and groups colors into as few rounds as possible,
   large/background colors first and fine detail last.
3. **Generate toolpaths.** For each round: clearing pass (flat end mill), V-carve
   pocket in the base, mirrored V-carve plug in the tone wood, and a surfacing pass to
   a known Z. One G-code file per tool per step.
4. **Instruct.** A step-by-step sheet says which bit to mount, where to zero, which file
   to run, and when to glue and wait.

The final piece is completely flat.

## Roadmap

- [x] Repo setup
- [ ] **MVP 1:** image → wood-color simplification → minimum-feature cleanup →
      real-scale preview
- [ ] **MVP 2:** round planning + SVG/DXF export of pocket and plug per round
- [ ] **MVP 3:** native G-code (clearing, V-carve, plug, surfacing, registration holes)
      with a generic post-processor (Mach3 profile first)
- [ ] Extras: engraving lines, 2.5D relief, UI polish

## Development

Requires Python 3.11+.

```sh
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS / Linux
pip install -e ".[dev]"
pytest
```

## Safety

Generated G-code drives a real machine. Always simulate it first (e.g. in Kiri:Moto or
another G-code viewer), check the zero points, and run air cuts before cutting wood.
