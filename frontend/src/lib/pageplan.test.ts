import { describe, expect, it } from "vitest";
import { cutEvery, moveTiles, selectTile, splitParts, summary, type Tile } from "./pageplan";

const mk = (n: number): Tile[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, source: 0, page: i + 1, rotate: 0 }));

describe("page plan", () => {
  it("is one file without cuts", () => {
    expect(splitParts(mk(3))).toHaveLength(1);
    expect(summary(mk(3))).toBe("1 file with 3 pages");
  });
  it("cuts after marked tiles and never makes an empty file", () => {
    const t = mk(5);
    t[1].cut = true;
    t[4].cut = true; // the last tile: nothing follows, so no empty file
    expect(splitParts(t).map((p) => p.length)).toEqual([2, 3]);
  });
  it("cuts every n pages", () => {
    expect(splitParts(cutEvery(mk(7), 3)).map((p) => p.length)).toEqual([3, 3, 1]);
    expect(splitParts(cutEvery(cutEvery(mk(7), 3), 0))).toHaveLength(1);
  });
  it("blank pages carry no source page", () => {
    const t: Tile[] = [{ id: 1, source: 2, page: 9, rotate: 90 }, { id: 2, source: 0, page: 1, rotate: 0, blank: true }];
    const [part] = splitParts(t);
    expect(part[0]).toMatchObject({ source: 2, page: 9, rotate: 90 });
    expect(part[1].blank).toBe(true);
  });
  it("moves a group together and keeps its order", () => {
    const moved = moveTiles(mk(6), new Set([2, 4]), 5);
    expect(moved.map((t) => t.id)).toEqual([1, 3, 5, 2, 4, 6]);
    expect(moveTiles(mk(4), new Set([3, 4]), 0).map((t) => t.id)).toEqual([3, 4, 1, 2]);
  });
  it("selects with click, ctrl and shift", () => {
    const t = mk(6);
    const one = selectTile(t, new Set(), null, 2, "one");
    expect([...one]).toEqual([2]);
    expect([...selectTile(t, one, 2, 4, "toggle")].sort()).toEqual([2, 4]);
    expect([...selectTile(t, one, 2, 5, "range")].sort()).toEqual([2, 3, 4, 5]);
  });
});
