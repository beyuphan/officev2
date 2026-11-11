/** The photo editor's edit list: ordering, single-instance settings and plain-language descriptions. */

export type Op = { type: string; [key: string]: unknown };
export type Item = Op & { id: number };

/** Edits run in this order whatever the order the user made them in, so e.g. a tone change never recolors text. */
const STAGE: Record<string, number> = {
  crop: 0, rotate: 0, straighten: 0, flip: 0, resize: 0, perspective: 0, lens: 0,
  blur: 1, remove_background: 1, denoise: 1,
  adjust: 2, levels: 2, auto: 2, curves: 2, hsl: 2, grade: 2, lut: 2,
  filter: 3,
  vignette: 4, grain: 4,
  text: 5, shape: 5, overlay: 5, qr: 5,
  inner_rounded: 5.5,
  border: 6, rounded: 7,
};

/** Settings that exist once: setting them again replaces the old value. */
export const SINGLETONS = new Set(["adjust", "filter", "vignette", "grain", "straighten", "resize", "border", "rounded", "levels", "remove_background", "auto", "curves", "hsl", "perspective", "denoise", "grade", "lut", "lens", "inner_rounded", "qr"]);

export const ADJUST_KEYS = ["brightness", "contrast", "exposure", "highlights", "shadows", "saturation", "vibrance", "warmth", "tint", "hue", "sharpness"] as const;

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** True when applying the op would change nothing (so it can be dropped from the list). */
export function isNeutral(op: Op): boolean {
  switch (op.type) {
    case "adjust":
      return ADJUST_KEYS.every((k) => num(op[k]) === 0);
    case "filter":
      return !op.name || num(op.intensity, 1) <= 0;
    case "grain":
      return num(op.amount) <= 0;
    case "straighten":
      return Math.abs(num(op.degrees)) < 0.05;
    case "border":
      return num(op.width) <= 0;
    case "rounded":
      return num(op.radius) <= 0;
    case "resize":
      return op.mode === "scale" && num(op.factor, 1) === 1;
    case "curves": {
      const chans = (op.channels ?? {}) as Record<string, number[][]>;
      return Object.values(chans).every((pts) => pts.every(([x, y]) => Math.abs(x - y) < 0.5));
    }
    case "hsl": {
      const bands = (op.bands ?? {}) as Record<string, Record<string, number>>;
      return Object.values(bands).every((b) => Object.values(b).every((v) => v === 0));
    }
    case "perspective": {
      const pts = (op.points ?? []) as number[][];
      const home = [[0, 0], [1, 0], [1, 1], [0, 1]];
      return pts.length === 4 && pts.every((p, i) => Math.abs(p[0] - home[i][0]) < 0.002 && Math.abs(p[1] - home[i][1]) < 0.002);
    }
    case "denoise":
      return num(op.strength) <= 0;
    case "grade":
      return !op.shadows && !op.midtones && !op.highlights;
    case "lut":
      return !op.path || num(op.intensity, 1) <= 0;
    case "lens":
      return num(op.amount) === 0;
    case "qr":
      return !String(op.text ?? "").trim();
    case "inner_rounded":
      return num(op.radius) <= 0;
    case "vignette":
      return num(op.strength) === 0;
    case "levels":
      return num(op.black) === 0 && num(op.white, 255) === 255 && num(op.gamma, 1) === 1;
    default:
      return false;
  }
}

/** Items in the order the engine applies them (by stage, then as made). */
export function ordered(items: Item[]): Item[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (STAGE[a.it.type] ?? 9) - (STAGE[b.it.type] ?? 9) || a.i - b.i)
    .map(({ it }) => it);
}

/** The list to send to the engine: ordered by stage (stable) and without the ids. */
export function pipeline(items: Item[]): Op[] {
  return ordered(items).map((it) => {
    const { id: _id, ...op } = it;
    void _id;
    return op as Op;
  });
}

/** Things placed on the photo that can be clicked, moved and resized. */
export const isObject = (it: Op): boolean => it.type === "text" || it.type === "shape" || it.type === "overlay" || (it.type === "blur" && Boolean(it.area));

/** Add an op, replacing the previous one when it is a single-instance setting; neutral settings remove it. */
export function put(items: Item[], op: Op, nextId: () => number): Item[] {
  if (SINGLETONS.has(op.type)) {
    const rest = items.filter((i) => i.type !== op.type);
    return isNeutral(op) ? rest : [...rest, { ...op, id: nextId() }];
  }
  return [...items, { ...op, id: nextId() }];
}

export function current<T extends Op>(items: Item[], type: string): T | undefined {
  return items.find((i) => i.type === type) as unknown as T | undefined;
}

const pct = (v: unknown) => `${Math.round(num(v) * 100)}%`;

export function describe(op: Op): string {
  switch (op.type) {
    case "crop":
      return `Crop to ${pct(op.w)} × ${pct(op.h)}`;
    case "rotate":
      return `Rotate ${num(op.degrees) > 0 ? "right" : "left"} ${Math.abs(num(op.degrees))}°`;
    case "straighten":
      return `Straighten ${num(op.degrees).toFixed(1)}°`;
    case "flip":
      return `Flip ${op.direction === "vertical" ? "vertically" : "horizontally"}`;
    case "resize":
      return op.mode === "scale" ? `Resize to ${Math.round(num(op.factor, 1) * 100)}%` : op.mode === "fit" ? `Resize, longest side ${num(op.max_side)} px` : `Resize to ${num(op.width)} × ${num(op.height)} px`;
    case "adjust": {
      const set = ADJUST_KEYS.filter((k) => num(op[k]) !== 0).map((k) => `${k} ${num(op[k]) > 0 ? "+" : ""}${num(op[k])}`);
      return `Adjust: ${set.join(", ")}`;
    }
    case "levels":
      return "Levels";
    case "auto":
      return `Auto ${String(op.mode ?? "contrast")}`;
    case "filter":
      return `Filter: ${String(op.name)}${num(op.intensity, 1) < 1 ? ` ${Math.round(num(op.intensity, 1) * 100)}%` : ""}`;
    case "blur": {
      const kind = String(op.kind ?? "gaussian");
      const where = op.area ? (op.invert ? "everything except the area" : "area") : "whole photo";
      return `${kind === "pixelate" ? "Pixelate" : kind === "tiltshift" ? "Tilt-shift" : `${kind[0].toUpperCase()}${kind.slice(1)} blur`} (${where})`;
    }
    case "vignette":
      return `${num(op.strength) < 0 ? "Lighten edges" : "Vignette"} ${pct(Math.abs(num(op.strength)))}`;
    case "grain":
      return `Grain ${pct(op.amount)}`;
    case "text":
      return `Text “${String(op.text).slice(0, 24)}${String(op.text).length > 24 ? "…" : ""}”`;
    case "shape":
      return `Draw ${op.kind === "path" ? "pen line" : String(op.kind)}`;
    case "overlay":
      return "Logo / image";
    case "border":
      return `Border ${num(op.width)} px`;
    case "rounded":
      return `Frame corners ${num(op.radius)} px`;
    case "inner_rounded":
      return `Photo corners ${num(op.radius)} px`;
    case "curves":
      return "Curves";
    case "hsl":
      return `Colour mixer: ${Object.keys((op.bands ?? {}) as object).join(", ")}`;
    case "perspective":
      return "Perspective correction";
    case "denoise":
      return `Reduce noise ${num(op.strength)}`;
    case "grade":
      return "Colour grading";
    case "lut":
      return `Colour look: ${String(op.path ?? "").split(/[\/]/).pop()}`;
    case "qr":
      return "QR code";
    case "lens":
      return `Lens correction ${num(op.amount)}`;
    case "remove_background":
      return "Remove background";
    default:
      return String(op.type);
  }
}

/** Largest rectangle of the wanted pixel aspect (w/h) inside the image, centered, in normalized units. */
export function aspectRect(imageW: number, imageH: number, aspect: number): { x: number; y: number; w: number; h: number } {
  const imgAspect = imageW / imageH;
  if (aspect >= imgAspect) {
    const h = imgAspect / aspect;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  const w = aspect / imgAspect;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}
