// Wood species presets. Colors are approximate finished (oiled) tones;
// the user can always override the color for their actual boards.

export interface WoodPreset {
  id: string;
  name: string;
  local: string; // Turkish name
  color: string;
  figure: number; // 0 = plain, 1 = strong stripes/rings
  note?: string;
}

export const WOOD_PRESETS: WoodPreset[] = [
  { id: "maple", name: "Hard maple", local: "Akçaağaç", color: "#e6d2a8", figure: 0.22 },
  { id: "basswood", name: "Basswood", local: "Ihlamur", color: "#e9dbbb", figure: 0.12 },
  { id: "hornbeam", name: "Hornbeam", local: "Gürgen", color: "#ddd0b4", figure: 0.15 },
  { id: "ash", name: "White ash", local: "Dişbudak", color: "#d8c196", figure: 0.55 },
  { id: "yellowheart", name: "Yellowheart", local: "Sarıkalp", color: "#dfb43f", figure: 0.3 },
  { id: "oak", name: "White oak", local: "Meşe", color: "#c4a067", figure: 0.6 },
  { id: "zebrano", name: "Zebrano", local: "Zebrano", color: "#cbae78", figure: 0.95 },
  { id: "teak", name: "Teak", local: "Tik", color: "#a8794a", figure: 0.45 },
  { id: "alder", name: "Red alder", local: "Kızılağaç", color: "#c48d60", figure: 0.25 },
  { id: "chestnut", name: "Chestnut", local: "Kestane", color: "#a7794d", figure: 0.6 },
  { id: "cherry", name: "Cherry", local: "Kiraz", color: "#b27048", figure: 0.35 },
  { id: "sapele", name: "Sapele", local: "Sapelli", color: "#8e5232", figure: 0.55 },
  { id: "mahogany", name: "Mahogany", local: "Maun", color: "#86492f", figure: 0.35 },
  { id: "padauk", name: "Padauk", local: "Padauk", color: "#b4442a", figure: 0.4 },
  { id: "bubinga", name: "Bubinga", local: "Bubinga", color: "#8b3b2c", figure: 0.45 },
  { id: "purpleheart", name: "Purpleheart", local: "Mor ağaç", color: "#6d3a52", figure: 0.3 },
  { id: "walnut", name: "Walnut", local: "Ceviz", color: "#5b3e2a", figure: 0.45 },
  { id: "wenge", name: "Wenge", local: "Wenge", color: "#3a2a20", figure: 0.75 },
  { id: "ebony", name: "Ebony", local: "Abanoz", color: "#1f1a16", figure: 0.12 },
];

export function presetById(id: string | null | undefined): WoodPreset | undefined {
  return WOOD_PRESETS.find((p) => p.id === id);
}

export interface Wood {
  uid: string;
  presetId: string | null; // null = custom
  name: string;
  color: string;
  figure: number;
  thickness: number; // mm
}

let uidCounter = 0;
export function newUid(): string {
  return Date.now().toString(36) + (uidCounter++).toString(36) + Math.random().toString(36).slice(2, 6);
}

export function woodFromPreset(id: string, thickness: number): Wood {
  const p = presetById(id) ?? WOOD_PRESETS[0];
  return { uid: newUid(), presetId: p.id, name: p.name, color: p.color, figure: p.figure, thickness };
}

/** Ready-made wood sets: a base board plus tone woods. */
export interface WoodKit {
  id: string;
  name: string;
  description: string;
  base: string;
  tones: string[];
}

export const WOOD_KITS: WoodKit[] = [
  {
    id: "classic",
    name: "Classic contrast",
    description: "Light maple ground, walnut and wenge for shadows, cherry and yellowheart for warmth.",
    base: "maple",
    tones: ["yellowheart", "cherry", "walnut", "wenge"],
  },
  {
    id: "anatolian",
    name: "Anatolian",
    description: "Native woods only: hornbeam ground with oak, chestnut, cherry and walnut.",
    base: "hornbeam",
    tones: ["oak", "chestnut", "cherry", "walnut"],
  },
  {
    id: "miniature",
    name: "Miniature painting",
    description: "Saturated reds and purples for figures, ebony for outlines.",
    base: "basswood",
    tones: ["yellowheart", "padauk", "purpleheart", "walnut", "ebony"],
  },
  {
    id: "dark",
    name: "Dark ground",
    description: "Walnut ground with pale woods that glow against it.",
    base: "walnut",
    tones: ["maple", "yellowheart", "padauk"],
  },
];

export const BASE_THICKNESS = 10;
export const TONE_THICKNESS = 4;
export const MIN_TONES = 1;
export const MAX_TONES = 5;

export function woodsFromKit(kit: WoodKit): { base: Wood; tones: Wood[] } {
  return {
    base: woodFromPreset(kit.base, BASE_THICKNESS),
    tones: kit.tones.map((t) => woodFromPreset(t, TONE_THICKNESS)),
  };
}
