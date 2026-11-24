/// <reference lib="webworker" />
// Generates G-code files off the main thread.
import { writeGcode, type Flavor } from "./core/gcode";
import { plugToolpaths, pocketToolpaths, surfacingToolpaths, type MillParams, type VParams } from "./core/toolpaths";

export interface GcodeFile { name: string; text: string; seconds: number }

export interface GcodeRequest {
  id: number;
  op: "pocket" | "plug" | "surface";
  loops: Float32Array[];
  stockW: number;
  stockH: number;
  v: VParams;
  vFeed: number;
  vPlunge: number;
  mill: (MillParams & { feed: number; plunge: number }) | null;
  surf: MillParams & { feed: number; plunge: number };
  rpm: number;
  safeZ: number;
  flavor: Flavor;
  // pocket
  depth: number;
  zTop: number;
  // plug
  startDepth: number;
  plugDepth: number;
  // surface
  zStart: number;
  zEnd: number;
  // naming and notes
  prefix: string; // e.g. "project-R1-"
  wood: string;
  title: string;
  zeroNote: string;
}

export interface GcodeResponse { id: number; files?: GcodeFile[]; error?: string }

const ext = (f: Flavor) => (f === "mach3" ? "tap" : "nc");
const mm = (v: number) => String(Math.round(v * 10) / 10);

self.onmessage = (e: MessageEvent<GcodeRequest>) => {
  const q = e.data;
  try {
    const files: GcodeFile[] = [];
    const add = (name: string, tool: string, cuts: Parameters<typeof writeGcode>[0]["cuts"], feed: number, plunge: number, approachZ: number) => {
      if (!cuts.length) return;
      const out = writeGcode({
        title: `Kundekar - ${q.title}`,
        notes: [`Tool: ${tool}`, q.zeroNote],
        cuts, stockH: q.stockH, feed, plunge, rpm: q.rpm, safeZ: q.safeZ, approachZ, flavor: q.flavor,
      });
      const lines = out.text.split("\n");
      lines.splice(1, 0, `(Estimated time about ${Math.max(1, Math.round(out.seconds / 60))} min)`);
      files.push({ name: `${q.prefix}${name}.${ext(q.flavor)}`, text: lines.join("\n"), seconds: out.seconds });
    };
    const vName = `V${q.v.angle}`, vTool = `${q.v.angle} deg V-bit`;
    if (q.op === "pocket") {
      const t = pocketToolpaths(q.loops, q.depth, q.v, q.mill, q.zTop);
      if (q.mill) add(`1-pocket-clear-${mm(q.mill.dia)}mm`, `${mm(q.mill.dia)} mm flat end mill`, t.clear, q.mill.feed, q.mill.plunge, q.zTop + 1);
      add(`2-pocket-${vName}`, vTool, t.v, q.vFeed, q.vPlunge, q.zTop + 1);
    } else if (q.op === "plug") {
      const t = plugToolpaths(q.loops, q.stockW, q.stockH, q.startDepth, q.plugDepth, q.v, q.mill);
      if (q.mill) add(`3-plug-${q.wood}-clear-${mm(q.mill.dia)}mm`, `${mm(q.mill.dia)} mm flat end mill`, t.clear, q.mill.feed, q.mill.plunge, 1);
      add(`4-plug-${q.wood}-${vName}`, vTool, t.v, q.vFeed, q.vPlunge, 1);
    } else {
      const cuts = surfacingToolpaths(q.stockW, q.stockH, q.surf, q.zStart, q.zEnd);
      add(`5-surface-${mm(q.surf.dia)}mm`, `${mm(q.surf.dia)} mm surfacing bit`, cuts, q.surf.feed, q.surf.plunge, q.zStart + 1);
    }
    (self as unknown as Worker).postMessage({ id: q.id, files } satisfies GcodeResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: q.id, error: String(err) } satisfies GcodeResponse);
  }
};
