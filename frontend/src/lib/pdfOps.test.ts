import { describe, expect, it } from "vitest";
import { describe as describeOp, groupByPage, hitTest, normalizeRect, pagesWithEdits, simplify, translate, type PdfOp } from "./pdfOps";

describe("describe", () => {
  it("names each edit in plain words", () => {
    expect(describeOp({ type: "text", page: 1, text: "Hello" })).toBe("Text “Hello”");
    expect(describeOp({ type: "text", page: 1, text: "A line that is far too long to show" })).toBe("Text “A line that is far too…”");
    expect(describeOp({ type: "link", page: 1, uri: "https://example.com/path" })).toBe("Link to example.com/path");
    expect(describeOp({ type: "link", page: 1, target_page: 4 })).toBe("Link to page 4");
    expect(describeOp({ type: "redact", page: 2 })).toBe("Black out");
    expect(describeOp({ type: "ink", page: 2 })).toBe("Pen drawing");
  });
});

describe("translate", () => {
  it("moves every kind of edit by the same amount", () => {
    expect(translate({ type: "text", page: 1, x: 10, y: 20, text: "t" }, 5, -3)).toMatchObject({ x: 15, y: 17 });
    expect(translate({ type: "note", page: 1, x: 1, y: 2, text: "n" }, 1, 1)).toMatchObject({ x: 2, y: 3 });
    expect(translate({ type: "image", page: 1, x0: 10, y0: 10, w: 50 }, 4, 6)).toMatchObject({ x0: 14, y0: 16, w: 50 });
    expect(translate({ type: "rect", page: 1, x0: 0, y0: 0, x1: 10, y1: 20 }, 3, 4)).toMatchObject({ x0: 3, y0: 4, x1: 13, y1: 24 });
    expect(translate({ type: "arrow", page: 1, x0: 0, y0: 0, x1: 10, y1: 0 }, -1, 2)).toMatchObject({ x0: -1, y0: 2, x1: 9, y1: 2 });
    expect(translate({ type: "ink", page: 1, strokes: [[[0, 0], [5, 5]], [[10, 10], [11, 11]]] }, 2, 3)).toMatchObject({ strokes: [[[2, 3], [7, 8]], [[12, 13], [13, 14]]] });
  });
  it("does not change the original", () => {
    const op: PdfOp = { type: "rect", page: 1, x0: 0, y0: 0, x1: 1, y1: 1 };
    translate(op, 9, 9);
    expect(op.x0).toBe(0);
  });
});

describe("pages", () => {
  const ops: PdfOp[] = [
    { type: "text", page: 3 }, { type: "rect", page: 1 }, { type: "note", page: 3 },
  ];
  it("lists pages with edits and groups the edits", () => {
    expect([...pagesWithEdits(ops)].sort()).toEqual([1, 3]);
    expect(groupByPage(ops).map(([p, o]) => [p, o.length])).toEqual([[1, 1], [3, 2]]);
  });
});

describe("drawing helpers", () => {
  it("simplifies a stroke but keeps its ends", () => {
    const path = Array.from({ length: 100 }, (_, i) => ({ x: i * 0.2, y: 0 }));
    const s = simplify(path, 1.5);
    expect(s[0]).toEqual(path[0]);
    expect(s[s.length - 1]).toEqual(path[99]);
    expect(s.length).toBeLessThan(20);
    expect(simplify([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toHaveLength(2);
  });
  it("normalizes a dragged rectangle", () => {
    expect(normalizeRect({ x: 50, y: 40 }, { x: 10, y: 90 })).toEqual({ x0: 10, y0: 40, x1: 50, y1: 90 });
  });
  it("finds the topmost box under the pointer", () => {
    const boxes = [
      { index: 4, rect: [0, 0, 100, 100] },
      { index: 7, rect: [20, 20, 60, 60] },
    ];
    expect(hitTest(boxes, { x: 30, y: 30 })).toBe(7); // the later box is on top
    expect(hitTest(boxes, { x: 90, y: 90 })).toBe(4);
    expect(hitTest(boxes, { x: 102, y: 50 })).toBe(4); // a few points of slack to grab thin lines
    expect(hitTest(boxes, { x: 150, y: 150 })).toBe(-1);
  });
});
