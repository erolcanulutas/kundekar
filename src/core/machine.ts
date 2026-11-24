// Machine / bit settings and the V-carve geometry derived from them.

import type { Wood } from "./woods";

export interface MachineSettings {
  widthMm: number; // finished piece width; height follows the image aspect
  vAngle: number; // included angle of the V-bit, degrees
  pocketDepth: number; // mm
  glueGap: number; // extra plug depth so the plug bottoms out on the walls, mm
  surfacePerRound: number; // material removed by each surfacing pass, mm
  minRetained: number; // thinnest inlay edge still worth keeping, mm
  simplify: number; // multiplier on the minimum feature size (1 = finest possible)
  colorWeight: number; // 0 = match by lightness only, 1+ = match hue strongly
  smoothing: number; // 0 = raw pixel edges, 1 = strongly rounded region borders
}

export const DEFAULT_SETTINGS: MachineSettings = {
  widthMm: 297,
  vAngle: 90,
  pocketDepth: 2,
  glueGap: 0.5,
  surfacePerRound: 0.1,
  minRetained: 0.5,
  simplify: 1.5,
  colorWeight: 0.35,
  smoothing: 0.7,
};

export const SIZE_PRESETS: { label: string; widthMm: number }[] = [
  { label: "Coaster", widthMm: 100 },
  { label: "A5", widthMm: 210 },
  { label: "A4", widthMm: 297 },
  { label: "A3", widthMm: 420 },
  { label: "Poster", widthMm: 600 },
];

export const V_ANGLES = [30, 60, 90, 120];

export interface Derived {
  surfTotal: number; // worst case: removed above the first inlay after the last round
  needDepth: number; // depth an edge must reach to survive all surfacing
  minFeatureFine: number; // narrowest region the bit can hold at needDepth
  minFeature: number; // after the simplification multiplier
  plugDepth: number;
  warnings: string[];
}

export function derive(s: MachineSettings, base: Wood, tones: Wood[]): Derived {
  const tan = Math.tan(((s.vAngle / 2) * Math.PI) / 180);
  const rounds = Math.max(1, tones.length); // upper bound until round planning runs
  const surfTotal = rounds * s.surfacePerRound;
  const needDepth = s.minRetained + surfTotal;
  const minFeatureFine = 2 * tan * needDepth;
  const minFeature = minFeatureFine * s.simplify;
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
