// Machine / bit settings and the V-carve geometry derived from them.

import type { Wood } from "./woods";

export type SizeMode = "image" | "board"; // height follows the image, or the board is entered
export type FitMode = "contain" | "cover" | "stretch" | "custom";

export interface MachineSettings {
  widthMm: number; // base board width
  heightMm: number; // base board height (entered in "board" mode, derived in "image" mode)
  marginMm: number; // plain base-wood border around the artwork
  sizeMode: SizeMode;
  fit: FitMode; // how the image sits on an entered board
  imgX: number; // "custom" placement: image top-left on the board, mm
  imgY: number;
  imgWidthMm: number; // "custom" placement: image width, mm (height keeps the image's proportions)
  vAngle: number; // included angle of the V-bit, degrees
  pocketDepth: number; // mm
  glueGap: number; // extra plug depth so the plug bottoms out on the walls, mm
  surfacePerRound: number; // material removed by each surfacing pass, mm
  minRetained: number; // thinnest inlay edge still worth keeping, mm
  minLineMm: number; // thinnest line / narrowest region kept (never below what the bit can hold)
  minAreaMm2: number; // islands smaller than this are filled by the surrounding wood
  colorWeight: number; // 0 = "Light & dark" (lightness only), 1 = "Color" (full perceptual distance)
  smoothing: number; // 0 = raw pixel edges, 1 = strongly rounded region borders
  cureHours: number; // glue cure time before surfacing
}

export type NumericSetting = { [K in keyof MachineSettings]: MachineSettings[K] extends number ? K : never }[keyof MachineSettings];

export const DEFAULT_SETTINGS: MachineSettings = {
  widthMm: 297,
  heightMm: 210,
  marginMm: 0,
  sizeMode: "image",
  fit: "contain",
  imgX: 0,
  imgY: 0,
  imgWidthMm: 0,
  vAngle: 90,
  pocketDepth: 2,
  glueGap: 0.5,
  surfacePerRound: 0.1,
  minRetained: 0.5,
  minLineMm: 2,
  minAreaMm2: 4,
  colorWeight: 0,
  smoothing: 0.7,
  cureHours: 24,
};

export const SIZE_PRESETS: { label: string; widthMm: number; heightMm: number }[] = [
  { label: "Coaster", widthMm: 100, heightMm: 100 },
  { label: "A5", widthMm: 210, heightMm: 148 },
  { label: "A4", widthMm: 297, heightMm: 210 },
  { label: "A3", widthMm: 420, heightMm: 297 },
  { label: "Poster", widthMm: 600, heightMm: 400 },
];

export interface Rect { x: number; y: number; w: number; h: number }

/** Board size, the artwork area inside the border, and where the image is drawn (all mm). */
export function boardLayout(s: MachineSettings, imgW: number, imgH: number): { wMm: number; hMm: number; art: Rect; draw: Rect } {
  const m = Math.max(0, s.marginMm);
  const ar = imgH / imgW;
  if (s.sizeMode === "image") {
    const artW = Math.max(1, s.widthMm - 2 * m), artH = artW * ar;
    const art = { x: m, y: m, w: artW, h: artH };
    return { wMm: s.widthMm, hMm: artH + 2 * m, art, draw: art };
  }
  const art = { x: m, y: m, w: Math.max(1, s.widthMm - 2 * m), h: Math.max(1, s.heightMm - 2 * m) };
  if (s.fit === "stretch") return { wMm: s.widthMm, hMm: s.heightMm, art, draw: art };
  if (s.fit === "custom" && s.imgWidthMm > 0) {
    return { wMm: s.widthMm, hMm: s.heightMm, art, draw: { x: s.imgX, y: s.imgY, w: s.imgWidthMm, h: s.imgWidthMm * ar } };
  }
  const k = s.fit === "cover" ? Math.max(art.w / imgW, art.h / imgH) : Math.min(art.w / imgW, art.h / imgH); // "custom" not yet sized: start as Fit
  const dw = imgW * k, dh = imgH * k;
  return { wMm: s.widthMm, hMm: s.heightMm, art, draw: { x: art.x + (art.w - dw) / 2, y: art.y + (art.h - dh) / 2, w: dw, h: dh } };
}

export const V_ANGLES = [30, 60, 90, 120];

export interface Derived {
  surfTotal: number; // worst case: removed above the first inlay after the last round
  needDepth: number; // depth an edge must reach to survive all surfacing
  minFeatureFine: number; // narrowest region the bit can hold at needDepth
  minFeature: number; // what cleanup actually uses: max(user's thinnest line, bit limit)
  plugDepth: number;
  warnings: string[];
}

export function derive(s: MachineSettings, base: Wood, tones: Wood[]): Derived {
  const tan = Math.tan(((s.vAngle / 2) * Math.PI) / 180);
  const rounds = Math.max(1, tones.length); // upper bound until round planning runs
  const surfTotal = rounds * s.surfacePerRound;
  const needDepth = s.minRetained + surfTotal;
  const minFeatureFine = 2 * tan * needDepth;
  const minFeature = Math.max(s.minLineMm, minFeatureFine);
  const plugDepth = s.pocketDepth + s.glueGap;
  const warnings: string[] = [];

  if (s.pocketDepth < needDepth) {
    warnings.push(
      `Pocket depth ${fmt(s.pocketDepth)} mm is shallower than the ${fmt(needDepth)} mm needed to survive ${rounds} surfacing passes.`,
    );
  }
  for (const t of tones) {
    if (t.thickness < plugDepth + 0.5) {
      warnings.push(`${t.name} is ${fmt(t.thickness)} mm thick; plugs need at least ${fmt(plugDepth + 0.5)} mm (plug depth + 0.5 mm backing).`);
    }
  }
  const left = base.thickness - surfTotal - s.pocketDepth;
  if (left < 4) {
    warnings.push(`Only ${fmt(left)} mm of ${base.name} would remain under the pockets. Use a thicker base or shallower pockets.`);
  }
  return { surfTotal, needDepth, minFeatureFine, minFeature, plugDepth, warnings };
}

export function fmt(n: number, d = 2): string {
  return (Math.round(n * 10 ** d) / 10 ** d).toString();
}

/** Working resolution: fine enough for the smallest feature, bounded for speed. */
export function pxPerMm(widthMm: number, heightMm: number): number {
  return Math.min(8, 1600 / Math.max(widthMm, heightMm));
}
