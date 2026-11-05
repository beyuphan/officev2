/** Crop rectangle geometry in normalized (0..1) image coordinates. */

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

export const MIN = 0.02;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * New rectangle after dragging `handle` to pointer `p`.
 * `a` is the locked width/height ratio in normalized units (null = free). `start` is where the drag began
 * (only used to move the whole box).
 */
export function resizeRect(r0: Rect, handle: Handle, p: Point, start: Point, a: number | null): Rect {
  if (handle === "move") {
    return {
      ...r0,
      x: clamp(r0.x + (p.x - start.x), 0, 1 - r0.w),
      y: clamp(r0.y + (p.y - start.y), 0, 1 - r0.h),
    };
  }
  const west = handle.includes("w"), east = handle.includes("e"), north = handle.includes("n");

  if (handle.length === 2) {
    // corner: the opposite corner stays where it is
    const ax = west ? r0.x + r0.w : r0.x;
    const ay = north ? r0.y + r0.h : r0.y;
    const maxW = west ? ax : 1 - ax;
    const maxH = north ? ay : 1 - ay;
    let w = Math.abs(p.x - ax), h = Math.abs(p.y - ay);
    if (a) {
      w = Math.min(w, h * a, maxW, maxH * a);
      w = Math.max(w, MIN * a > MIN ? MIN * a : MIN);
      h = w / a;
    } else {
      w = clamp(w, MIN, maxW);
      h = clamp(h, MIN, maxH);
    }
    return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
  }

  if (east || west) {
    const ax = west ? r0.x + r0.w : r0.x;
    const maxW = west ? ax : 1 - ax;
    let w = clamp(Math.abs(p.x - ax), MIN, maxW);
    let h = r0.h;
    let y = r0.y;
    if (a) {
      h = w / a;
      if (h > 1) {
        h = 1;
        w = h * a;
      }
      y = clamp(r0.y + r0.h / 2 - h / 2, 0, 1 - h);
    }
    return { x: west ? ax - w : ax, y, w, h };
  }

  const ay = north ? r0.y + r0.h : r0.y;
  const maxH = north ? ay : 1 - ay;
  let h = clamp(Math.abs(p.y - ay), MIN, maxH);
  let w = r0.w;
  let x = r0.x;
  if (a) {
    w = h * a;
    if (w > 1) {
      w = 1;
      h = w / a;
    }
    x = clamp(r0.x + r0.w / 2 - w / 2, 0, 1 - w);
  }
  return { x, y: north ? ay - h : ay, w, h };
}

/** Rectangle spanned by two points, clamped to the image. */
export function spanRect(a: Point, b: Point): Rect {
  const x0 = clamp(Math.min(a.x, b.x), 0, 1), y0 = clamp(Math.min(a.y, b.y), 0, 1);
  const x1 = clamp(Math.max(a.x, b.x), 0, 1), y1 = clamp(Math.max(a.y, b.y), 0, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Normalized pixel-aspect (w/h of the picture) -> ratio between normalized width and height. */
export const normAspect = (pixelAspect: number, imageW: number, imageH: number) => pixelAspect * (imageH / imageW);
