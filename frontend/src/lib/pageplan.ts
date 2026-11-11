/** The page grid behind the Pages screen: tiles from one or more PDFs, in the order they will be written. */

export type Tile = {
  id: number;
  /** index into the list of source files; ignored for a blank page */
  source: number;
  /** 1-based page of that source */
  page: number;
  rotate: number;
  blank?: boolean;
  /** start a new file after this tile */
  cut?: boolean;
};

export type PlanEntry = { source: number; page: number; rotate: number; blank?: boolean; width?: number; height?: number };

const toEntry = (t: Tile): PlanEntry => (t.blank ? { source: 0, page: 1, rotate: 0, blank: true, width: 595, height: 842 } : { source: t.source, page: t.page, rotate: t.rotate });

/** Tiles cut into files at every `cut` (the last tile never starts an empty file). */
export function splitParts(tiles: Tile[]): PlanEntry[][] {
  const parts: PlanEntry[][] = [];
  let cur: PlanEntry[] = [];
  tiles.forEach((t, i) => {
    cur.push(toEntry(t));
    if (t.cut && i < tiles.length - 1) {
      parts.push(cur);
      cur = [];
    }
  });
  if (cur.length) parts.push(cur);
  return parts;
}

/** Put a cut after every n-th tile (0 clears them all). */
export function cutEvery(tiles: Tile[], n: number): Tile[] {
  return tiles.map((t, i) => ({ ...t, cut: n > 0 && (i + 1) % n === 0 && i < tiles.length - 1 }));
}

/** Move the chosen tiles (kept in their own order) so they start at `to`, an index counted before they are lifted out. */
export function moveTiles(tiles: Tile[], ids: Set<number>, to: number): Tile[] {
  const moving = tiles.filter((t) => ids.has(t.id));
  if (!moving.length) return tiles;
  const before = tiles.slice(0, to).filter((t) => !ids.has(t.id));
  const after = tiles.slice(to).filter((t) => !ids.has(t.id));
  return [...before, ...moving, ...after];
}

/** Selection with Shift (range from the anchor) and Ctrl (toggle) like a file list. */
export function selectTile(tiles: Tile[], current: Set<number>, anchor: number | null, id: number, mode: "one" | "toggle" | "range"): Set<number> {
  if (mode === "toggle") {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }
  if (mode === "range" && anchor !== null) {
    const a = tiles.findIndex((t) => t.id === anchor);
    const b = tiles.findIndex((t) => t.id === id);
    if (a >= 0 && b >= 0) return new Set(tiles.slice(Math.min(a, b), Math.max(a, b) + 1).map((t) => t.id));
  }
  return new Set([id]);
}

/** One line for the user about what pressing Save will do. */
export function summary(tiles: Tile[]): string {
  if (!tiles.length) return "Add a PDF to start.";
  const parts = splitParts(tiles);
  const pages = tiles.length;
  return parts.length === 1 ? `1 file with ${pages} page${pages === 1 ? "" : "s"}` : `${parts.length} files, ${pages} pages in all (${parts.map((p) => p.length).join(" + ")})`;
}
