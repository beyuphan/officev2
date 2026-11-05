import { describe, expect, it } from "vitest";
import { MIN, normAspect, resizeRect, spanRect, type Rect } from "./crop";

const r0: Rect = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
const same = (r: Rect, e: Rect) => (["x", "y", "w", "h"] as const).forEach((k) => expect(r[k], k).toBeCloseTo(e[k], 9));
const inside = (r: Rect) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9 && r.w >= MIN - 1e-9 && r.h >= MIN - 1e-9;

describe("resizeRect: free", () => {
  it("moves an edge and keeps the opposite one fixed", () => {
    same(resizeRect(r0, "e", { x: 0.8, y: 0.3 }, { x: 0, y: 0 }, null), { x: 0.2, y: 0.2, w: 0.6, h: 0.4 });
    const w = resizeRect(r0, "w", { x: 0.1, y: 0 }, { x: 0, y: 0 }, null);
    expect(w.x).toBeCloseTo(0.1); expect(w.x + w.w).toBeCloseTo(0.6);
    const n = resizeRect(r0, "n", { x: 0, y: 0.05 }, { x: 0, y: 0 }, null);
    expect(n.y).toBeCloseTo(0.05);
    expect(n.y + n.h).toBeCloseTo(0.6);
  });
  it("drags a corner against the opposite corner", () => {
    const r = resizeRect(r0, "se", { x: 0.9, y: 0.7 }, { x: 0, y: 0 }, null);
    same(r, { x: 0.2, y: 0.2, w: 0.7, h: 0.5 });
    const nw = resizeRect(r0, "nw", { x: 0.1, y: 0.1 }, { x: 0, y: 0 }, null);
    expect(nw.x + nw.w).toBeCloseTo(0.6); expect(nw.y + nw.h).toBeCloseTo(0.6);
    expect(nw.x).toBeCloseTo(0.1);
  });
  it("never leaves the image or collapses", () => {
    for (const h of ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const)
      for (const p of [{ x: -1, y: -1 }, { x: 2, y: 2 }, { x: 0.4, y: 0.4 }, { x: 0.2, y: 0.2 }]) {
        expect(inside(resizeRect(r0, h, p, { x: 0, y: 0 }, null)), `${h} ${JSON.stringify(p)}`).toBe(true);
      }
  });
  it("can flip over the anchor while dragging", () => {
    const r = resizeRect(r0, "se", { x: 0.05, y: 0.05 }, { x: 0, y: 0 }, null); // dragged past the top-left corner
    expect(r.w).toBeCloseTo(0.15); expect(r.h).toBeCloseTo(0.15);
  });
});

describe("resizeRect: locked aspect", () => {
  const a = 1; // square in normalized units
  it("keeps the ratio on every handle and stays inside", () => {
    for (const h of ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const)
      for (const p of [{ x: 0.95, y: 0.95 }, { x: 0.05, y: 0.05 }, { x: 0.5, y: 0.9 }, { x: 2, y: -1 }]) {
        const r = resizeRect(r0, h, p, { x: 0, y: 0 }, a);
        expect(r.w / r.h, `${h} ${JSON.stringify(p)}`).toBeCloseTo(a, 6);
        expect(inside(r), `${h} ${JSON.stringify(p)}`).toBe(true);
      }
  });
  it("a corner keeps its opposite corner", () => {
    const r = resizeRect(r0, "se", { x: 0.7, y: 0.6 }, { x: 0, y: 0 }, a);
    expect(r.x).toBeCloseTo(0.2); expect(r.y).toBeCloseTo(0.2);
    expect(r.w).toBeCloseTo(0.4); // limited by the smaller pointer distance (0.4 high)
  });
  it("a side handle resizes around the center of the other axis", () => {
    const r = resizeRect(r0, "e", { x: 0.8, y: 0 }, { x: 0, y: 0 }, a);
    expect(r.w).toBeCloseTo(0.6);
    expect(r.h).toBeCloseTo(0.6);
    expect(r.y + r.h / 2).toBeCloseTo(0.4); // stays centered on its old middle
  });
  it("supports a wide ratio", () => {
    const wide = 16 / 9;
    const r = resizeRect({ x: 0, y: 0, w: 0.5, h: 0.5 / wide }, "se", { x: 1, y: 1 }, { x: 0, y: 0 }, wide);
    expect(r.w / r.h).toBeCloseTo(wide, 6);
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("move and span", () => {
  it("moves the whole box but keeps it inside", () => {
    same(resizeRect(r0, "move", { x: 0.6, y: 0.5 }, { x: 0.4, y: 0.4 }, null), { x: 0.4, y: 0.3, w: 0.4, h: 0.4 });
    const far = resizeRect(r0, "move", { x: 5, y: 5 }, { x: 0, y: 0 }, null);
    expect(far.x + far.w).toBeCloseTo(1); expect(far.y + far.h).toBeCloseTo(1);
    const neg = resizeRect(r0, "move", { x: -5, y: -5 }, { x: 0, y: 0 }, null);
    expect(neg.x).toBe(0); expect(neg.y).toBe(0);
  });
  it("spans two points in any direction and clamps", () => {
    same(spanRect({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.1 }), { x: 0.2, y: 0.1, w: 0.4, h: 0.6 });
    const c = spanRect({ x: -1, y: 0.5 }, { x: 2, y: 3 });
    same(c, { x: 0, y: 0.5, w: 1, h: 0.5 });
  });
  it("converts a pixel aspect to a normalized one", () => {
    expect(normAspect(1, 4000, 3000)).toBeCloseTo(0.75); // a square is 3/4 as wide as tall in normalized units on a landscape photo
  });
});
