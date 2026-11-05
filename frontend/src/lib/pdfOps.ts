/** PDF editor edits: plain-language descriptions, moving, and which edits sit on which page. */

export type PdfOp = { type: string; page: number; [key: string]: unknown };
export type PdfItem = PdfOp & { id: number };

const n = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

const LABEL: Record<string, string> = {
  text: "Text", image: "Image", note: "Note", link: "Link", highlight: "Highlight", underline: "Underline",
  strike: "Strikethrough", squiggly: "Squiggly underline", rect: "Box", ellipse: "Oval", line: "Line", arrow: "Arrow",
  ink: "Pen drawing", erase: "Erase", redact: "Redact (black out)",
};

export function describe(op: PdfOp): string {
  const what = LABEL[op.type] ?? op.type;
  const extra =
    op.type === "text" || op.type === "note"
      ? ` “${String(op.text ?? "").slice(0, 22)}${String(op.text ?? "").length > 22 ? "…" : ""}”`
      : op.type === "link"
        ? op.uri
          ? ` to ${String(op.uri).replace(/^https?:\/\//, "").slice(0, 26)}`
          : ` to page ${n(op.target_page)}`
        : "";
  return `${what}${extra}`;
}

/** The same edit moved by (dx, dy) points on its page. */
export function translate(op: PdfOp, dx: number, dy: number): PdfOp {
  switch (op.type) {
    case "text":
    case "note":
      return { ...op, x: n(op.x) + dx, y: n(op.y) + dy };
    case "image":
      return { ...op, x0: n(op.x0) + dx, y0: n(op.y0) + dy };
    case "ink":
      return { ...op, strokes: (op.strokes as number[][][]).map((s) => s.map(([x, y]) => [x + dx, y + dy])) };
    default:
      if ("x0" in op) return { ...op, x0: n(op.x0) + dx, y0: n(op.y0) + dy, x1: n(op.x1) + dx, y1: n(op.y1) + dy };
      return op;
  }
}

/** Page numbers (1-based) that carry at least one edit. */
export function pagesWithEdits(ops: PdfOp[]): Set<number> {
  return new Set(ops.map((o) => o.page));
}

export function groupByPage<T extends PdfOp>(ops: T[]): [number, T[]][] {
  const map = new Map<number, T[]>();
  ops.forEach((o) => map.set(o.page, [...(map.get(o.page) ?? []), o]));
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

export type Pt = { x: number; y: number };

/** Keep every Nth point of a freehand stroke (always the first and last) so strokes stay small. */
export function simplify(path: Pt[], minDist = 1.5): Pt[] {
  if (path.length <= 2) return path;
  const out = [path[0]];
  for (const p of path.slice(1, -1)) {
    const l = out[out.length - 1];
    if (Math.hypot(p.x - l.x, p.y - l.y) >= minDist) out.push(p);
  }
  out.push(path[path.length - 1]);
  return out;
}

export function normalizeRect(a: Pt, b: Pt): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** Index of the topmost box containing the point, or -1. Boxes are [x0, y0, x1, y1]. */
export function hitTest(boxes: { index: number; rect: number[] }[], p: Pt, slop = 3): number {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const [x0, y0, x1, y1] = boxes[i].rect;
    if (p.x >= x0 - slop && p.x <= x1 + slop && p.y >= y0 - slop && p.y <= y1 + slop) return boxes[i].index;
  }
  return -1;
}
