import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as RPointerEvent } from "react";
import { Circle, Copy, Droplet, Highlighter, ImagePlus, Minus, MousePointer2, MoveUpRight, PenLine, Square, Trash2, Type as TypeIcon, type LucideIcon } from "lucide-react";
import { Handles, type HandleId } from "./pdfitems";
import { FontPicker } from "../shared";
import type { Item, Op } from "../lib/photoOps";
import { spanRect } from "../lib/crop";

/** Things placed on a photo (text, shapes, pictures, blur areas) that can be clicked, moved, resized and retyped. */

export type PTool = "select" | "text" | "rect" | "ellipse" | "line" | "arrow" | "path" | "highlighter" | "image" | "blur";

export const PHOTO_GROUPS: { title: string; tools: { id: PTool; label: string; Icon: LucideIcon; key: string; hint: string }[] }[] = [
  { title: "", tools: [{ id: "select", label: "Select", Icon: MousePointer2, key: "V", hint: "Click anything on the photo to change it. Drag to move, double-click text to retype." }] },
  {
    title: "Add",
    tools: [
      { id: "text", label: "Text", Icon: TypeIcon, key: "T", hint: "Click on the photo and type." },
      { id: "image", label: "Image", Icon: ImagePlus, key: "I", hint: "Click where the logo or picture goes." },
      { id: "blur", label: "Blur area", Icon: Droplet, key: "B", hint: "Drag over a face or a number plate to blur or pixelate it." },
    ],
  },
  {
    title: "Draw",
    tools: [
      { id: "rect", label: "Box", Icon: Square, key: "R", hint: "Drag to draw a rectangle." },
      { id: "ellipse", label: "Oval", Icon: Circle, key: "O", hint: "Drag to draw an oval." },
      { id: "line", label: "Line", Icon: Minus, key: "", hint: "Drag to draw a line." },
      { id: "arrow", label: "Arrow", Icon: MoveUpRight, key: "A", hint: "Drag to draw an arrow." },
      { id: "path", label: "Pen", Icon: PenLine, key: "P", hint: "Draw freehand." },
      { id: "highlighter", label: "Marker", Icon: Highlighter, key: "H", hint: "Draw with a see-through marker." },
    ],
  },
];
export const ALL_PTOOLS = PHOTO_GROUPS.flatMap((g) => g.tools);
export const STICKY_P: PTool[] = ["path", "highlighter"];

export type Defs = {
  font: string; size: number; bold: boolean; italic: boolean; color: string; opacity: number;
  outline: number; outlineColor: string; shadow: boolean; box: boolean; boxColor: string;
  shapeColor: string; width: number; fill: boolean; fillColor: string;
  kind: string; radius: number; feather: number; invert: boolean; areaShape: "rect" | "ellipse";
};

export function makeDefs(photoWidth: number): Defs {
  return {
    font: "Arial", size: Math.round(photoWidth * 0.07), bold: true, italic: false, color: "#ffffff", opacity: 1,
    outline: Math.max(0, Math.round(photoWidth * 0.004)), outlineColor: "#000000", shadow: false, box: false, boxColor: "#000000",
    shapeColor: "#ff3b30", width: Math.max(3, Math.round(photoWidth * 0.004)), fill: false, fillColor: "#ff3b30",
    kind: "gaussian", radius: Math.max(8, Math.round(photoWidth / 120)), feather: 0, invert: false, areaShape: "rect",
  };
}

type NR = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
type Basis = { w: number; h: number }; // pixels of the finished picture
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const area = (it: Item) => it.area as { shape: string; x: number; y: number; w: number; h: number };
const points = (it: Item) => (it.points as number[][]) ?? [];

/** Where an object sits, as fractions of the picture. */
export function rectOf(it: Item, size: { w: number; h: number } | undefined, basis: Basis): NR | null {
  if (it.type === "blur" && it.area) {
    const a = area(it);
    return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
  if (it.type === "shape") {
    if (it.kind === "rect" || it.kind === "ellipse") return { x: num(it.x), y: num(it.y), w: num(it.w), h: num(it.h) };
    const pts = points(it);
    if (!pts.length) return null;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const pad = 0.008;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (it.type === "text") {
    const lines = String(it.text ?? "").split("\n");
    const size_ = num(it.size, 48);
    const w = size?.w ?? (Math.max(...lines.map((l) => l.length), 1) * size_ * 0.6) / basis.w;
    const h = size?.h ?? (lines.length * size_ * 1.3) / basis.h;
    return { x: num(it.x, 0.5) - w / 2, y: num(it.y, 0.5) - h / 2, w, h };
  }
  if (it.type === "overlay") {
    const w = size?.w ?? num(it.w, 0.25);
    const h = size?.h ?? (num(it.w, 0.25) * basis.w) / basis.h;
    return { x: num(it.x, 0.85) - w / 2, y: num(it.y, 0.9) - h / 2, w, h };
  }
  return null;
}

function movedBy(it: Item, dx: number, dy: number): Partial<Op> {
  if (it.type === "blur") return { area: { ...area(it), x: area(it).x + dx, y: area(it).y + dy } };
  if (it.type === "shape" && (it.kind === "rect" || it.kind === "ellipse")) return { x: num(it.x) + dx, y: num(it.y) + dy };
  if (it.type === "shape") return { points: points(it).map(([x, y]) => [x + dx, y + dy]) };
  return { x: num(it.x) + dx, y: num(it.y) + dy };
}

const sideResize = (r: NR, id: HandleId, p: Pt): NR => {
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  const min = 0.01;
  if (id.includes("w")) x0 = Math.min(p.x, x1 - min);
  if (id.includes("e")) x1 = Math.max(p.x, x0 + min);
  if (id.includes("n")) y0 = Math.min(p.y, y1 - min);
  if (id.includes("s")) y1 = Math.max(p.y, y0 + min);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

const pctStyle = (r: NR): CSSProperties => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
const RECT8: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export const label = (it: Item): string =>
  it.type === "text" ? "Text" : it.type === "overlay" ? "Image" : it.type === "blur" ? (it.kind === "pixelate" ? "Pixelate area" : "Blur area") :
  ({ rect: "Box", ellipse: "Oval", line: "Line", arrow: "Arrow", path: "Pen drawing", highlighter: "Marker" } as Record<string, string>)[String(it.kind)] ?? "Drawing";

type Ghost = { tool: PTool; a: Pt; b: Pt; path: Pt[]; moved: boolean };

export type LayerProps = {
  items: Item[];
  itemsRef: MutableRefObject<Item[]>;
  selected: number | null;
  editing: number | null;
  tool: PTool;
  sizes: Map<number, { w: number; h: number }>;
  basis: Basis;
  defs: Defs;
  hasImage: boolean;
  onSelect: (id: number | null) => void;
  onEdit: (id: number | null) => void;
  patch: (id: number, change: Partial<Op>) => void;
  touch: () => void;
  place: (op: Op, opts?: { edit?: boolean; keepTool?: boolean; stay?: boolean }) => void;
  /** ids the engine's picture already shows; text not in here yet is drawn by the browser meanwhile */
  drawn: Set<number>;
  onText: (id: number, text: string) => void;
  onCommit: (id: number) => void;
};

export function ObjectLayer(p: LayerProps) {
  const layer = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  const norm = (e: { clientX: number; clientY: number }): Pt => {
    const r = layer.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const track = (move: (e: PointerEvent) => void, up: (e: PointerEvent) => void) => {
    const u = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", u);
      window.removeEventListener("pointercancel", u);
      up(e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", u);
    window.addEventListener("pointercancel", u);
  };
  const dropFocus = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a && a.closest("input, select, textarea") && !a.classList.contains("ptext")) a.blur();
  };

  function onItemDown(e: RPointerEvent, it: Item) {
    if (e.button !== 0) return;
    const textClick = p.tool === "text" && it.type === "text"; // in the text tool a click retypes, a drag moves
    if (p.tool !== "select" && !textClick) return;
    e.stopPropagation();
    e.preventDefault();
    dropFocus();
    p.onSelect(it.id);
    if (p.editing === it.id) return;
    const start = norm(e);
    let last = start, moved = false;
    track(
      (ev) => {
        const n = norm(ev);
        if (!moved && Math.hypot(n.x - start.x, n.y - start.y) < 0.004) return;
        moved = true;
        p.touch();
        const dx = n.x - last.x, dy = n.y - last.y;
        last = n;
        const cur = p.itemsRef.current.find((x) => x.id === it.id);
        if (cur) p.patch(it.id, movedBy(cur, dx, dy));
      },
      () => {
        if (textClick && !moved) p.onEdit(it.id);
      },
    );
  }

  function onHandle(it: Item, id: HandleId, e: RPointerEvent) {
    const box = layer.current!.getBoundingClientRect();
    const r0 = rectOf(it, p.sizes.get(it.id), p.basis)!;
    const c = { x: r0.x + r0.w / 2, y: r0.y + r0.h / 2 };
    const startN = norm(e);
    const dist = (a: Pt, b: Pt) => Math.hypot((a.x - b.x) * box.width, (a.y - b.y) * box.height);
    const d0 = Math.max(4, dist(startN, c));
    const it0 = { ...it } as Item;
    track(
      (ev) => {
        const n = norm(ev);
        p.touch();
        if (it0.type === "shape" && (it0.kind === "line" || it0.kind === "arrow")) {
          const pts = points(it0).map((q) => [...q]);
          pts[id === "p0" ? 0 : 1] = [n.x, n.y];
          p.patch(it0.id, { points: pts });
          return;
        }
        if (id === "rot") {
          let deg = (Math.atan2((n.y - c.y) * box.height, (n.x - c.x) * box.width) * 180) / Math.PI + 90;
          deg = ((deg + 540) % 360) - 180;
          if (Math.abs(deg % 15) < 3 || ev.shiftKey) deg = Math.round(deg / 15) * 15;
          p.patch(it0.id, { rotation: Math.round(deg) });
          return;
        }
        if (it0.type === "text" || it0.type === "overlay") {
          const ratio = Math.max(0.1, dist(n, c) / d0);
          if (it0.type === "text") p.patch(it0.id, { size: Math.max(6, Math.round(num(it0.size, 48) * ratio)) });
          else p.patch(it0.id, { w: Math.min(3, Math.max(0.02, num(it0.w, 0.25) * ratio)) });
          return;
        }
        const r = sideResize(r0, id, n);
        if (it0.type === "blur") p.patch(it0.id, { area: { ...area(it0), x: r.x, y: r.y, w: r.w, h: r.h } });
        else p.patch(it0.id, { x: r.x, y: r.y, w: r.w, h: r.h });
      },
      () => undefined,
    );
  }

  function onLayerDown(e: RPointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    dropFocus();
    if (p.tool === "select") {
      p.onSelect(null);
      p.onEdit(null);
      return;
    }
    if (p.tool === "image" && !p.hasImage) return;
    p.onSelect(null);
    const t = p.tool;
    const a = norm(e);
    let g: Ghost = { tool: t, a, b: a, path: [a], moved: false };
    setGhost(g);
    track(
      (ev) => {
        const n = norm(ev);
        g = { ...g, b: n, moved: g.moved || Math.hypot(n.x - g.a.x, n.y - g.a.y) > 0.006, path: t === "path" || t === "highlighter" ? [...g.path, n] : g.path };
        setGhost(g);
      },
      () => {
        setGhost(null);
        finish(g);
      },
    );
  }

  function finish(g: Ghost) {
    const { tool: t, a, b, path, moved } = g;
    const d = p.defs;
    const r = spanRect(a, b);
    const big = r.w > 0.012 && r.h > 0.012;
    switch (t) {
      case "text":
        p.place({ type: "text", text: "", font: d.font, size: d.size, bold: d.bold, italic: d.italic, color: d.color, opacity: d.opacity, rotation: 0, x: a.x, y: a.y, stroke_width: d.outline, stroke_color: d.outlineColor, shadow: d.shadow, ...(d.box ? { background: d.boxColor } : {}) }, { edit: true, stay: true });
        return;
      case "image":
        p.place({ type: "overlay", path: "", x: a.x, y: a.y, w: moved && big ? r.w : 0.22, opacity: 1, rotation: 0 });
        return;
      case "blur":
        if (!big) return;
        p.place({ type: "blur", kind: d.kind, radius: d.radius, area: { shape: d.areaShape, ...r }, feather: d.areaShape === "ellipse" || d.feather ? d.feather : 0, invert: d.invert, ...(d.kind === "motion" ? { angle: 0 } : {}) });
        return;
      case "rect":
      case "ellipse":
        if (big) p.place({ type: "shape", kind: t, color: d.shapeColor, width: d.width, opacity: 1, x: r.x, y: r.y, w: r.w, h: r.h, ...(d.fill ? { fill: d.fillColor } : {}) });
        return;
      case "line":
      case "arrow":
        if (moved) p.place({ type: "shape", kind: t, color: d.shapeColor, width: d.width, opacity: 1, points: [[a.x, a.y], [b.x, b.y]] });
        return;
      case "path":
      case "highlighter":
        if (moved) p.place({ type: "shape", kind: t, color: t === "highlighter" && d.shapeColor === "#ff3b30" ? "#ffe600" : d.shapeColor, width: t === "highlighter" ? d.width * 4 : d.width, opacity: 1, points: path.map((q) => [q.x, q.y]) }, { keepTool: true });
        return;
    }
  }

  const objects = p.items.filter((it) => (it.type === "text" || it.type === "shape" || it.type === "overlay" || (it.type === "blur" && it.area)) && it.id !== p.editing);
  const sel = objects.find((it) => it.id === p.selected);
  const editingItem = p.items.find((it) => it.id === p.editing && it.type === "text");

  return (
    <div ref={layer} className={`objlayer tool-${p.tool}`} onPointerDown={onLayerDown}>
      {ghost?.moved && <GhostShape g={ghost} color={p.defs.shapeColor} />}
      {objects.map((it) => {
        const r = rectOf(it, p.sizes.get(it.id), p.basis);
        if (!r) return null;
        const isSel = it.id === p.selected;
        const line = it.type === "shape" && (it.kind === "line" || it.kind === "arrow");
        const handles: HandleId[] = line ? [] : it.type === "text" || it.type === "overlay" ? ["nw", "ne", "sw", "se", "rot"] : it.type === "shape" && (it.kind === "path" || it.kind === "highlighter") ? [] : RECT8;
        return (
          <div
            key={it.id}
            className={`pobj${isSel ? " selected" : ""}`}
            data-oid={it.id}
            data-type={it.type}
            aria-label={label(it)}
            style={pctStyle(r)}
            onPointerDown={(e) => onItemDown(e, it)}
            onDoubleClick={() => it.type === "text" && (p.onSelect(it.id), p.onEdit(it.id))}
          >
            {isSel && <Handles ids={handles} onStart={(id, e) => onHandle(it, id, e)} />}
          </div>
        );
      })}
      {sel && sel.type === "shape" && (sel.kind === "line" || sel.kind === "arrow") &&
        points(sel).slice(0, 2).map((q, i) => (
          <div key={i} className="ptwrap" style={{ left: `${q[0] * 100}%`, top: `${q[1] * 100}%` }}>
            <Handles ids={[i === 0 ? "p0" : "p1"]} onStart={(id, e) => onHandle(sel, id, e)} />
          </div>
        ))}
      {p.items
        .filter((it) => it.type === "text" && it.id !== p.editing && !p.drawn.has(it.id) && String(it.text ?? "").trim())
        .map((it) => (
          <TextGhost key={`g${it.id}`} it={it} basis={p.basis} />
        ))}
      {editingItem && <TextEditor it={editingItem} basis={p.basis} onText={p.onText} onCommit={p.onCommit} />}
    </div>
  );
}

function textStyle(it: Item, basis: Basis): CSSProperties {
  const size = num(it.size, 48);
  const stroke = num(it.stroke_width);
  return {
    left: `${num(it.x, 0.5) * 100}%`,
    top: `${num(it.y, 0.5) * 100}%`,
    transform: `translate(-50%, -50%)${num(it.rotation) ? ` rotate(${num(it.rotation)}deg)` : ""}`,
    fontFamily: `"${String(it.font ?? "Arial")}", Arial, sans-serif`,
    fontSize: `${(size / basis.w) * 100}cqw`,
    fontWeight: it.bold ? 700 : 400,
    fontStyle: it.italic ? "italic" : "normal",
    color: String(it.color ?? "#ffffff"),
    opacity: num(it.opacity, 1),
    textAlign: "center",
    lineHeight: 1.2,
    background: it.background ? String(it.background) : undefined,
    WebkitTextStroke: stroke ? `${(stroke / basis.w) * 200}cqw ${String(it.stroke_color ?? "#000")}` : undefined,
    paintOrder: "stroke fill",
    textShadow: it.shadow ? `${(size * 0.06) / basis.w * 100}cqw ${(size * 0.06) / basis.w * 100}cqw 0 rgb(0 0 0 / 0.6)` : undefined,
    fieldSizing: "content",
  } as CSSProperties;
}

/** The text as the page will show it, drawn by the browser until the engine's picture catches up. */
function TextGhost({ it, basis }: { it: Item; basis: Basis }) {
  return (
    <div className="pghost" aria-hidden style={{ ...textStyle(it, basis), whiteSpace: "pre", pointerEvents: "none" }}>
      {String(it.text ?? "")}
    </div>
  );
}

function TextEditor({ it, basis, onText, onCommit }: { it: Item; basis: Basis; onText: (id: number, t: string) => void; onCommit: (id: number) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const born = useRef(Date.now());
  const leaving = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const style = textStyle(it, basis);
  return (
    <textarea
      ref={ref}
      className="ptext"
      aria-label="Text"
      spellCheck={false}
      rows={Math.max(1, String(it.text ?? "").split("\n").length)}
      value={String(it.text ?? "")}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => onText(it.id, e.target.value)}
      onBlur={(e) => {
        if (!leaving.current && Date.now() - born.current < 250) {
          const t = e.currentTarget;
          setTimeout(() => t.focus(), 0);
          return;
        }
        onCommit(it.id);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          leaving.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function GhostShape({ g, color }: { g: Ghost; color: string }) {
  const r = spanRect(g.a, g.b);
  const common = { fill: "none", stroke: color, strokeWidth: 2, strokeDasharray: "5 4", vectorEffect: "non-scaling-stroke" as const };
  let shape;
  if (g.tool === "path" || g.tool === "highlighter") shape = <polyline points={g.path.map((q) => `${q.x},${q.y}`).join(" ")} {...common} strokeDasharray="none" />;
  else if (g.tool === "line" || g.tool === "arrow") shape = <line x1={g.a.x} y1={g.a.y} x2={g.b.x} y2={g.b.y} {...common} />;
  else if (g.tool === "ellipse") shape = <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} {...common} />;
  else shape = <rect x={r.x} y={r.y} width={r.w} height={r.h} {...common} stroke={g.tool === "blur" ? "#ffffff" : color} fill={g.tool === "blur" ? "rgb(255 255 255 / 0.2)" : "none"} />;
  return (
    <svg className="ghost" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
      {shape}
    </svg>
  );
}

/* ------------------------------------------------------------------------------------------ */

const BLUR_KINDS = [
  { id: "gaussian", label: "Blur" },
  { id: "box", label: "Soft box blur" },
  { id: "motion", label: "Motion blur" },
  { id: "pixelate", label: "Pixelate" },
];

/** The look of an object (not where it is), so it can be copied onto another one of the same kind. */
export function styleOf(it: Item): { kind: string; style: Partial<Op> } | null {
  const pick = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, it[k]]));
  if (it.type === "text") return { kind: "text", style: pick(["font", "size", "bold", "italic", "color", "opacity", "stroke_width", "stroke_color", "shadow", "background"]) };
  if (it.type === "shape") return { kind: "shape", style: pick(["color", "width", "opacity", "fill"]) };
  if (it.type === "blur") return { kind: "blur", style: pick(["kind", "radius", "feather", "invert"]) };
  if (it.type === "overlay") return { kind: "overlay", style: pick(["opacity"]) };
  return null;
}

export type BarProps = {
  tool: PTool;
  hint: string;
  sel: Item | null;
  defs: Defs;
  setDefs: (f: (d: Defs) => Defs) => void;
  fonts: string[];
  onFonts: (all: string[]) => void;
  maxSide: number;
  hasImage: boolean;
  patch: (id: number, c: Partial<Op>) => void;
  touch: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onPickImage: () => void;
  hasStyle: boolean;
  onCopyStyle: () => void;
  onPasteStyle: () => void;
};

/** Options of whatever is selected, or of the tool in use. */
export function PhotoBar({ tool, hint, sel, defs, setDefs, fonts, onFonts, maxSide, hasImage, patch, touch, onDelete, onDuplicate, onPickImage, hasStyle, onCopyStyle, onPasteStyle }: BarProps) {
  const kind: PTool | "overlay" = sel ? (sel.type === "text" ? "text" : sel.type === "overlay" ? "image" : sel.type === "blur" ? "blur" : (String(sel.kind) as PTool)) : tool;
  const isText = kind === "text";
  const isShape = ["rect", "ellipse", "line", "arrow", "path", "highlighter"].includes(kind);
  const isBlur = kind === "blur";
  const isImage = kind === "image";

  /** Sets one option on the selection (if any) and remembers it for the next one. */
  const set = (itemKey: string, defKey: keyof Defs, v: string | number | boolean, extra?: Partial<Op>) => {
    if (sel) {
      touch();
      patch(sel.id, { [itemKey]: v, ...extra });
    }
    setDefs((d) => ({ ...d, [defKey]: v }));
  };
  const v = <T,>(itemKey: string, defKey: keyof Defs): T => (sel && sel[itemKey] !== undefined ? (sel[itemKey] as T) : (defs[defKey] as T));
  const fillOn = sel ? Boolean(sel.fill) : defs.fill;
  const areaShape = sel?.area ? (area(sel).shape as "rect" | "ellipse") : defs.areaShape;
  const boxOn = sel ? Boolean(sel.background) : defs.box;
  const size = num(v("size", "size"), 48);
  const font = String(v("font", "font"));

  return (
    <div className="ctxbar" role="toolbar" aria-label="Options">
      <span className="ctxlabel">{sel ? label(sel) : (ALL_PTOOLS.find((t) => t.id === tool)?.label ?? "")}</span>
      {!sel && <span className="ctxhint">{hint}</span>}

      {isText && (
        <>
          <FontPicker value={font} fonts={fonts} onChange={(f) => set("font", "font", f)} onFonts={onFonts} />
          <span className="stepper">
            <button className="icon" aria-label="Smaller" onClick={() => set("size", "size", Math.max(6, Math.round(size * 0.92)))}>−</button>
            <input aria-label="Size" type="number" min={6} max={maxSide} value={size} onChange={(e) => e.target.value && set("size", "size", Math.min(maxSide, Math.max(6, Number(e.target.value))))} />
            <button className="icon" aria-label="Larger" onClick={() => set("size", "size", Math.min(maxSide, Math.round(size * 1.08) + 1))}>+</button>
          </span>
          <button className={`icon fmt ${v("bold", "bold") ? "on" : ""}`} aria-label="Bold" aria-pressed={Boolean(v("bold", "bold"))} onClick={() => set("bold", "bold", !v("bold", "bold"))}><b>B</b></button>
          <button className={`icon fmt ${v("italic", "italic") ? "on" : ""}`} aria-label="Italic" aria-pressed={Boolean(v("italic", "italic"))} onClick={() => set("italic", "italic", !v("italic", "italic"))}><i>I</i></button>
          <label className="ctl"><span>Color</span><input type="color" aria-label="Color" value={String(v("color", "color"))} onChange={(e) => set("color", "color", e.target.value)} /></label>
          <label className="ctl"><span>Outline</span><input type="range" aria-label="Outline" min={0} max={Math.max(6, Math.round(maxSide / 25))} value={num(v("stroke_width", "outline"))} onChange={(e) => set("stroke_width", "outline", Number(e.target.value))} />
            {num(v("stroke_width", "outline")) > 0 && <input type="color" aria-label="Outline color" value={String(v("stroke_color", "outlineColor"))} onChange={(e) => set("stroke_color", "outlineColor", e.target.value)} />}
          </label>
          <label className="ctl"><input type="checkbox" checked={Boolean(v("shadow", "shadow"))} onChange={(e) => set("shadow", "shadow", e.target.checked)} /><span>Shadow</span></label>
          <label className="ctl">
            <input type="checkbox" checked={boxOn} onChange={(e) => { if (sel) { touch(); patch(sel.id, { background: e.target.checked ? defs.boxColor : undefined }); } setDefs((d) => ({ ...d, box: e.target.checked })); }} />
            <span>Label box</span>
            {boxOn && <input type="color" aria-label="Box color" value={String(sel?.background ?? defs.boxColor)} onChange={(e) => { if (sel) { touch(); patch(sel.id, { background: e.target.value }); } setDefs((d) => ({ ...d, boxColor: e.target.value })); }} />}
          </label>
          <label className="ctl"><span>Opacity</span><input type="range" aria-label="Opacity" min={0.1} max={1} step={0.05} value={num(v("opacity", "opacity"), 1)} onChange={(e) => set("opacity", "opacity", Number(e.target.value))} /></label>
        </>
      )}

      {isShape && (
        <>
          <label className="ctl"><span>Color</span><input type="color" aria-label="Color" value={String(v("color", "shapeColor"))} onChange={(e) => set("color", "shapeColor", e.target.value)} /></label>
          <label className="ctl"><span>Width</span><input type="range" aria-label="Line width" min={1} max={Math.max(12, Math.round(maxSide / 40))} value={num(v("width", "width"), 6)} onChange={(e) => set("width", "width", Number(e.target.value))} /></label>
          {(kind === "rect" || kind === "ellipse") && (
            <label className="ctl">
              <input type="checkbox" checked={fillOn} onChange={(e) => { if (sel) { touch(); patch(sel.id, { fill: e.target.checked ? defs.fillColor : undefined }); } setDefs((d) => ({ ...d, fill: e.target.checked })); }} />
              <span>Fill</span>
              {fillOn && <input type="color" aria-label="Fill color" value={String(sel?.fill ?? defs.fillColor)} onChange={(e) => { if (sel) { touch(); patch(sel.id, { fill: e.target.value }); } setDefs((d) => ({ ...d, fillColor: e.target.value })); }} />}
            </label>
          )}
          {kind !== "highlighter" && <label className="ctl"><span>Opacity</span><input type="range" aria-label="Opacity" min={0.1} max={1} step={0.05} value={num(sel?.opacity, 1)} onChange={(e) => sel && (touch(), patch(sel.id, { opacity: Number(e.target.value) }))} disabled={!sel} /></label>}
        </>
      )}

      {isBlur && (
        <>
          <select aria-label="Effect" value={String(v("kind", "kind"))} onChange={(e) => set("kind", "kind", e.target.value)}>
            {BLUR_KINDS.map((k) => (
              <option key={k.id} value={k.id}>{k.label}</option>
            ))}
          </select>
          <label className="ctl"><span>{v("kind", "kind") === "pixelate" ? "Block size" : "Strength"}</span><input type="range" aria-label="Strength" min={1} max={Math.max(60, Math.round(maxSide / 20))} value={num(v("radius", "radius"), 12)} onChange={(e) => set("radius", "radius", Number(e.target.value))} /></label>
          <select aria-label="Shape" value={areaShape} onChange={(e) => { const s = e.target.value as "rect" | "ellipse"; if (sel?.area) { touch(); patch(sel.id, { area: { ...area(sel), shape: s } }); } setDefs((d) => ({ ...d, areaShape: s })); }}>
            <option value="rect">Rectangle</option>
            <option value="ellipse">Oval</option>
          </select>
          <label className="ctl"><span>Soft edge</span><input type="range" aria-label="Soft edge" min={0} max={Math.max(10, Math.round(maxSide / 40))} value={num(v("feather", "feather"))} onChange={(e) => set("feather", "feather", Number(e.target.value))} /></label>
          <label className="ctl" title="Keeps the area sharp and blurs everything around it"><input type="checkbox" checked={Boolean(v("invert", "invert"))} onChange={(e) => set("invert", "invert", e.target.checked)} /><span>Blur everything else</span></label>
        </>
      )}

      {isImage && (
        <>
          <button onClick={onPickImage}>{sel ? "Replace picture…" : hasImage ? "Change picture…" : "Choose picture…"}</button>
          {sel && (
            <>
              <label className="ctl"><span>Size</span><input type="range" aria-label="Picture size" min={0.03} max={1} step={0.01} value={num(sel.w, 0.22)} onChange={(e) => (touch(), patch(sel.id, { w: Number(e.target.value) }))} /></label>
              <label className="ctl"><span>Opacity</span><input type="range" aria-label="Opacity" min={0.1} max={1} step={0.05} value={num(sel.opacity, 1)} onChange={(e) => (touch(), patch(sel.id, { opacity: Number(e.target.value) }))} /></label>
            </>
          )}
        </>
      )}

      <span className="spacer" />
      {sel && (
        <>
          <button onClick={onCopyStyle} title="Copy how this looks (Ctrl+Shift+C)">Copy style</button>
          <button onClick={onPasteStyle} disabled={!hasStyle} title="Give the copied look to this one (Ctrl+Shift+V)">Paste style</button>
          <button onClick={onDuplicate} title="Duplicate (Ctrl+D)"><Copy size={15} strokeWidth={1.5} aria-hidden /> Duplicate</button>
          <button className="danger" onClick={onDelete} title="Delete (Del)"><Trash2 size={15} strokeWidth={1.5} aria-hidden /> Delete</button>
        </>
      )}
    </div>
  );
}

