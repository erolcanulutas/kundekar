// Projects live for days (glue has to cure between rounds), so everything
// is autosaved to IndexedDB and can be exported to / imported from a file.

import { DEFAULT_SETTINGS, type MachineSettings } from "./core/machine";
import { newUid, WOOD_KITS, woodsFromKit, type Wood } from "./core/woods";

export const FILE_VERSION = 1;

export interface Project {
  id: string;
  name: string;
  created: number;
  updated: number;
  base: Wood;
  tones: Wood[];
  settings: MachineSettings;
  image: Blob | null;
  imageName: string | null;
  step: string; // id of the step the user is on
  done: Record<string, number>; // step id -> time it was marked done
  log: { t: number; text: string }[];
}

export function newProject(name = "Untitled inlay"): Project {
  const { base, tones } = woodsFromKit(WOOD_KITS[0]);
  const now = Date.now();
  return {
    id: newUid(), name, created: now, updated: now, base, tones,
    settings: { ...DEFAULT_SETTINGS }, image: null, imageName: null,
    step: "image", done: {}, log: [{ t: now, text: "Project created" }],
  };
}

const DB = "kundekar", STORE = "projects";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const store = {
  list: () => tx<Project[]>("readonly", (s) => s.getAll()).then((ps) => ps.sort((a, b) => b.updated - a.updated)),
  get: (id: string) => tx<Project | undefined>("readonly", (s) => s.get(id)),
  put: (p: Project) => tx("readwrite", (s) => s.put(p)),
  remove: (id: string) => tx("readwrite", (s) => s.delete(id)),
};

const LAST = "kundekar.lastProject";
export const lastProjectId = {
  get: () => localStorage.getItem(LAST),
  set: (id: string) => localStorage.setItem(LAST, id),
  clear: () => localStorage.removeItem(LAST),
};

// ---- File export / import -------------------------------------------------

interface ProjectFile extends Omit<Project, "image"> {
  kundekar: number;
  image: string | null; // data URL
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

export async function exportProject(p: Project): Promise<Blob> {
  const file: ProjectFile = { ...p, kundekar: FILE_VERSION, image: p.image ? await blobToDataUrl(p.image) : null };
  return new Blob([JSON.stringify(file)], { type: "application/json" });
}

export async function importProject(f: File): Promise<Project> {
  const data = JSON.parse(await f.text()) as ProjectFile;
  if (typeof data.kundekar !== "number" || !data.base || !Array.isArray(data.tones)) {
    throw new Error("This is not a Kundekar project file.");
  }
  if (data.kundekar > FILE_VERSION) throw new Error("This project was saved by a newer version of Kundekar.");
  const image = data.image ? await (await fetch(data.image)).blob() : null;
  const { kundekar: _v, ...rest } = data;
  return {
    ...rest,
    settings: { ...DEFAULT_SETTINGS, ...rest.settings },
    image,
    id: newUid(), // never overwrite an existing project silently
    updated: Date.now(),
  };
}

export function fileName(p: Project): string {
  const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  return `${slug}.kundekar.json`;
}
