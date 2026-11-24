# Kundekar — Project Plan & Decisions

> Image-to-inlay CAM for multi-wood V-carve artwork.

Kundekar turns an image into a multi-wood V-carve inlay. It reduces the image to the
colors of the user's actual woods, plans the order of the inlay rounds, and outputs
ready-to-run G-code plus step-by-step instructions. It is meant to replace a separate
CAM program for this workflow.

Name: a *kündekâr* is a master of *kündekari*, the traditional Seljuk/Ottoman woodwork
technique of fitting wooden pieces together into patterns. The repo name is `kundekar`,
without diacritics.

---

## 1. Goal

- Input:
  - **Base wood**, about 10 mm thick. It is also one of the image colors.
  - **3–5 tone woods**, 3–5 mm thick. The user enters each wood's color and thickness.
    A later option is to sample the color from a photo of the wood.
  - **Machine and bit information**.
  - **An image**. The target is detailed artwork, e.g. the painting "Fatih's entry into
    Istanbul", not just flags.
- Output:
  - A simplified image built only from the wood colors: base wood plus the tone woods,
    5–6 colors in total.
  - An ordered sequence of rounds with G-code files and instructions.
  - A preview with wood textures, shown at real scale.
- The final piece is **completely flat**.

## 2. Process (per round)

1. Cut the **V-carve pocket** into the base, which already contains the earlier inlays.
2. Cut the **mirrored V-carve plug** out of the tone wood.
3. Glue the plug in and let it cure.
4. **Surface on the CNC to a known Z.** This removes the plug board's excess plus about
   0.05–0.1 mm of the base.
5. Move to the next round.

Rules:
- Two colors that touch **cannot be pocketed in the same round**, because the wall
  between them would disappear. Colors that don't touch can share a round. The program
  should build a region adjacency graph and minimise the number of rounds, using
  something like graph colouring.
- Order: **large and background colors first, fine details last**. A later pocket may
  cut into wood that an earlier round inlaid; that is fine because the surface was
  flattened.
- Separate islands of the same color can be **nested onto one plug board**. Tone wood
  may also come as several smaller pieces ("parçalı").
- Plugs are always **mirrored**.

## 3. Key technical decisions

- **V-carve inlay.** A flat end mill leaves rounded inside corners that don't fit, so it
  is not used for the inlay itself.
- **Default V-bit angle is 90°**, and it must be configurable (60°, 30°, …).
- **Clearing tool:** a flat end mill (3–6 mm) clears large areas, and the V-bit cuts the
  edges. Without it, big areas take hours with the V-bit alone.
- **Pocket and plug depths:** typical V-inlay numbers are a pocket of about 2 mm and a
  slightly deeper plug with a glue gap. Everything must be parameterised.
- **Height tracking:** because surfacing happens on the CNC, the program always knows
  the current top Z (10.0 → 9.9 → 9.8 …), so there is no re-probing.
  - It must also track how much depth the earlier inlays keep after each surfacing pass,
    and warn when an old inlay would become too thin.
- **Registration:** the base has to return to exactly the same X/Y every round. Use a
  fixed corner stop, or 2 pin holes in the waste margin; the program can drill these in
  round 1.
- **Minimum detail width:** with a V-bit, cut width = 2 · depth · tan(angle/2). Narrow
  regions are cut shallow, and shallow parts can vanish during surfacing or fail to bond.
  The program computes a minimum feature width from the angle, depth and surfacing
  allowance, then merges or removes smaller regions.
- **Size range:** from a coaster to a poster. A4 must work. The simplification level
  adapts to the physical size and the bit, so a coaster gets a coarser result than a
  poster.

## 4. Image processing pipeline

Implemented in `src/core/simplify.ts` (steps 1–3 and a colour-level version of 5).

1. Load the image and resize it to the physical size and a working resolution.
2. Quantize the colors **to the actual wood colors**, e.g. nearest color in Lab space or
   k-means followed by mapping. Optional manual mapping and editing.
3. Clean up regions: remove anything below the minimum feature size by merging it into
   a neighbour, and smooth the region shapes.
4. Vectorize the region contours, e.g. potrace-style, and smooth them.
5. Build the adjacency graph and plan the rounds and their order.
6. Render a preview with wood textures, optionally with grain direction per region.

## 5. Toolpaths / G-code

- **Generic G-code output** (.nc / .tap), not tied to Mach3. Post-processor style
  profiles per controller; Mach3 is one of them.
- **One file per tool per step**, to avoid tool-change problems. Example:
  ```
  Round1_01_pocket_clear_3mm.tap
  Round1_02_pocket_V90.tap
  Round1_03_plug_V90.tap      (separate stock, mirrored)
  Round1_04_surfacing.tap
  ```
- Generate a **step-by-step instruction sheet**: which bit to mount, where to zero,
  which file to run, glue/cure, and so on.
- V-carve toolpaths are based on the medial axis and are the hardest math in the
  project, so leave them for last.
- Validation: early outputs can be simulated and checked in **Kiri:Moto**, the user's
  current CAM.

## 6. Optional features

- **Engraving lines:** fine V-grooves for details such as faces and fabric folds, filled
  with dark epoxy or filler and then sanded flat. The surface stays flat.
- **2.5D relief:** some regions left intentionally lower or textured. Lower priority.
- **Grain direction per region** as an artistic parameter.

## 7. User's setup

- CNC router with a 600 × 800 mm work area and a **Mach3** controller.
- Current CAM: Kiri:Moto.
- No bits owned yet. Planned purchases:
  - 90° V-bit (main) and 60° V-bit (fine detail)
  - 3–6 mm flat end mill (clearing)
  - Surfacing bit, about 20–25 mm
  - Collet size (6 mm vs 1/4") still to be confirmed

## 8. Roadmap

1. **Repo setup:** done. Stack decided (2026-11-24): **TypeScript + Vite**, a static
   web app on GitHub Pages (https://erolcanulutas.github.io/kundekar/). Python was
   dropped because Pages cannot run it. The DOM-free core in `src/core/` can later run
   in Node for a downloadable version.
2. **MVP 1:** done. Wood stock with presets and thickness, image → wood-color
   simplification → minimum-feature cleanup → real-scale preview. Step-by-step UI with
   Back/Next. Projects are autosaved in IndexedDB and can be exported/imported as files,
   because one project spans days of glue curing.
3. **MVP 2:** done (2026-11-24). Round planning at wood level (greedy colouring of the
   adjacency graph, largest area first), per-round pocket SVG on the base and mirrored
   plug SVG per wood, a checklist with Z depths and a glue-cure timer. Holes holding
   only later-round woods are filled in the pocket/plug. Cut these in existing CAM first
   to validate the process. Not yet: nesting several islands onto smaller plug boards,
   DXF, region-level (rather than wood-level) round planning.
4. **MVP 3:** native G-code generation: clearing, V-carve, plug, surfacing,
   registration holes. Generic post-processor.
5. Downloadable/offline version reusing the same core.
6. Extras: engraving lines, 2.5D, UI polish.

## 9. Security note

- `fgt.txt` in this folder probably holds a GitHub fine-grained token.
  **Never commit it.** It is listed in `.gitignore`. Better still, move it out of the
  project folder.
- Recommended auth: Git Credential Manager browser login or `gh auth login`. If a
  fine-grained token is used, give it access to the `kundekar` repo only, with
  Contents: read/write and Metadata: read, plus Pull requests and Workflows only if
  needed, and a limited expiration.
