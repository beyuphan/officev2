import { describe, expect, it } from "vitest";
import { describePlan, parseRanges, toRanges } from "./ranges";

describe("parseRanges", () => {
  it("parses singles, ranges and open ends", () => {
    expect(parseRanges("1-3,5,8-", 10)).toEqual([1, 2, 3, 5, 8, 9, 10]);
    expect(parseRanges(" 2 , 4 - 5 ", 6)).toEqual([2, 4, 5]);
    expect(parseRanges("-3", 9)).toEqual([1, 2, 3]);
    expect(parseRanges("", 5)).toEqual([]);
  });
  it("dedupes and sorts", () => {
    expect(parseRanges("5,1-2,2-3", 6)).toEqual([1, 2, 3, 5]);
  });
  it("rejects what the engine would reject", () => {
    for (const bad of ["0", "7", "3-2", "1-9", "a", "1,,x", "1--2"]) expect(parseRanges(bad, 6), bad).toBeNull();
  });
});

describe("toRanges", () => {
  it("compresses runs", () => {
    expect(toRanges([1, 2, 3, 5, 8, 9])).toBe("1-3,5,8-9");
    expect(toRanges(new Set([4]))).toBe("4");
    expect(toRanges([])).toBe("");
    expect(toRanges([3, 1, 2, 2])).toBe("1-3");
  });
  it("round-trips with parseRanges", () => {
    const pages = [1, 2, 4, 7, 8, 9, 12];
    expect(parseRanges(toRanges(pages), 12)).toEqual(pages);
  });
});

describe("describePlan", () => {
  const same = [1, 2, 3, 4].map((page) => ({ page, rotate: 0 }));
  it("says nothing changed for the untouched document", () => {
    expect(describePlan(same, 4)).toEqual(["No changes yet."]);
  });
  it("lists removed, duplicated, rotated and reordered pages in plain words", () => {
    const plan = [
      { page: 3, rotate: 0 },
      { page: 1, rotate: 90 },
      { page: 1, rotate: 0 },
      { page: 4, rotate: 180 },
    ];
    expect(describePlan(plan, 4)).toEqual([
      "Removed: page 2",
      "Duplicated: page 1 ×2",
      "Rotated: page 1 by 90°, page 4 by 180°",
      "New order: 3, 1, 1, 4",
    ]);
  });
  it("uses the plural for several removed pages", () => {
    expect(describePlan([{ page: 1, rotate: 0 }], 4)).toEqual(["Removed: pages 2-4"]);
  });
});
