import { describe, expect, it } from "vitest";
import { aspectRect, describe as describeOp, isNeutral, pipeline, put, type Item } from "./photoOps";

let n = 0;
const id = () => ++n;

describe("pipeline", () => {
  it("orders edits by stage but keeps creation order inside a stage, and strips ids", () => {
    const items: Item[] = [
      { id: 1, type: "text", text: "A" },
      { id: 2, type: "adjust", brightness: 10 },
      { id: 3, type: "crop", x: 0, y: 0, w: 0.5, h: 0.5 },
      { id: 4, type: "text", text: "B" },
      { id: 5, type: "blur", kind: "gaussian" },
      { id: 6, type: "rotate", degrees: 90 },
      { id: 7, type: "border", width: 10 },
      { id: 8, type: "filter", name: "sepia" },
    ];
    expect(pipeline(items).map((o) => o.type + (o.text ? `:${o.text}` : ""))).toEqual([
      "crop", "rotate", "blur", "adjust", "filter", "text:A", "text:B", "border",
    ]);
    expect(pipeline(items).every((o) => !("id" in o))).toBe(true);
  });
});

describe("put / singletons", () => {
  it("replaces a single-instance setting and drops neutral ones", () => {
    let items: Item[] = [];
    items = put(items, { type: "adjust", brightness: 20 }, id);
    items = put(items, { type: "adjust", brightness: 35, contrast: 5 }, id);
    expect(items).toHaveLength(1);
    expect(items[0].brightness).toBe(35);
    items = put(items, { type: "adjust", brightness: 0, contrast: 0 }, id);
    expect(items).toHaveLength(0);
  });
  it("stacks repeatable edits", () => {
    let items: Item[] = [];
    items = put(items, { type: "blur", kind: "gaussian" }, id);
    items = put(items, { type: "blur", kind: "pixelate" }, id);
    items = put(items, { type: "text", text: "x" }, id);
    expect(items.map((i) => i.type)).toEqual(["blur", "blur", "text"]);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
  });
});

describe("isNeutral", () => {
  it("knows when an edit would change nothing", () => {
    expect(isNeutral({ type: "adjust" })).toBe(true);
    expect(isNeutral({ type: "adjust", warmth: 3 })).toBe(false);
    expect(isNeutral({ type: "filter", name: "sepia", intensity: 0 })).toBe(true);
    expect(isNeutral({ type: "straighten", degrees: 0.01 })).toBe(true);
    expect(isNeutral({ type: "resize", mode: "scale", factor: 1 })).toBe(true);
    expect(isNeutral({ type: "resize", mode: "fit", max_side: 800 })).toBe(false);
    expect(isNeutral({ type: "crop", x: 0, y: 0, w: 1, h: 1 })).toBe(false);
  });
});

describe("describe", () => {
  it("explains edits in plain words", () => {
    expect(describeOp({ type: "crop", x: 0.1, y: 0.1, w: 0.62, h: 0.8 })).toBe("Crop to 62% × 80%");
    expect(describeOp({ type: "rotate", degrees: -90 })).toBe("Rotate left 90°");
    expect(describeOp({ type: "blur", kind: "pixelate", area: { shape: "rect" } })).toBe("Pixelate (area)");
    expect(describeOp({ type: "blur", kind: "gaussian", area: {}, invert: true })).toBe("Gaussian blur (everything except the area)");
    expect(describeOp({ type: "blur", kind: "gaussian" })).toBe("Gaussian blur (whole photo)");
    expect(describeOp({ type: "adjust", brightness: 20, hue: -5, contrast: 0 })).toBe("Adjust: brightness +20, hue -5");
    expect(describeOp({ type: "text", text: "A very long caption that keeps going" })).toBe("Text “A very long caption that…”");
    expect(describeOp({ type: "filter", name: "noir", intensity: 0.5 })).toBe("Filter: noir 50%");
  });
});

describe("aspectRect", () => {
  it("fits the biggest centered rectangle of a pixel aspect", () => {
    const r = aspectRect(4000, 3000, 1); // square inside a 4:3 photo
    expect(r.h).toBe(1);
    expect(r.w).toBeCloseTo(0.75, 6);
    expect(r.x).toBeCloseTo(0.125, 6);
    const wide = aspectRect(3000, 4000, 16 / 9); // 16:9 inside a portrait photo
    expect(wide.w).toBe(1);
    expect((wide.w * 3000) / (wide.h * 4000)).toBeCloseTo(16 / 9, 6);
    expect(wide.y).toBeCloseTo((1 - wide.h) / 2, 6);
  });
});
