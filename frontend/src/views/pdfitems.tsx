import { useEffect, useRef, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { describe, type PdfItem } from "../lib/pdfOps";

/** How each kind of edit is drawn on the page (in page points) and where its selection handles sit. */

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rot" | "p0" | "p1";

export const RECTLIKE = ["rect", "ellipse", "highlight", "underline", "strike", "erase", "redact", "link"];
export const SVG_TYPES = [...RECTLIKE, "line", "arrow", "ink"];

export const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const pctX = (v: number, pw: number) => `${(v / pw) * 100}%`;
const pctY = (v: number, ph: number) => `${(v / ph) * 100}%`;
const cq = (v: number, pw: number) => `${(v / pw) * 100}cqw`;

export function fileUrl(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return "";
  }
}

/** Bounding box [x0, y0, x1, y1] of the edits drawn as vectors. */
export function bounds(op: PdfItem): [number, number, number, number] {
  if (op.type === "line" || op.type === "arrow") {
    const xs = [num(op.x0), num(op.x1)], ys = [num(op.y0), num(op.y1)];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (op.type === "ink") {
    const pts = (op.strokes as number[][][]).flat();
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return [num(op.x0), num(op.y0), num(op.x1), num(op.y1)];
}

type Common = { pw: number; ph: number; onDown: (e: RPointerEvent, op: PdfItem) => void; onDouble: (op: PdfItem) => void };

/* ---------- vectors ---------- */

export function VectorItem({ op, pw, onDown, onDouble, selected }: Common & { op: PdfItem; selected: boolean }) {
  void pw;
  const color = String(op.color ?? "#d4472b");
  const width = num(op.width, 2);
  const opacity = num(op.opacity, 1);
  const [x0, y0, x1, y1] = bounds(op);
  const w = x1 - x0, h = y1 - y0;
  const events = { onPointerDown: (e: RPointerEvent) => onDown(e, op), onDoubleClick: () => onDouble(op), "data-oid": op.id, "data-type": op.type, "aria-label": describe(op), "data-selected": selected || undefined } as const;
  const hit = Math.max(width, 10);

  switch (op.type) {
    case "rect":
    case "ellipse": {
      const Shape = op.type === "rect" ? "rect" : "ellipse";
      const geo = op.type === "rect" ? { x: x0, y: y0, width: w, height: h } : { cx: x0 + w / 2, cy: y0 + h / 2, rx: w / 2, ry: h / 2 };
      return (
        <g {...events} opacity={opacity}>
          <Shape {...geo} fill={op.fill ? String(op.fill) : "none"} stroke={color} strokeWidth={width} pointerEvents={op.fill ? "all" : "none"} />
          {!op.fill && <Shape {...geo} fill="none" stroke="transparent" strokeWidth={hit} pointerEvents="stroke" />}
        </g>
      );
    }
    case "highlight":
      return <rect {...events} x={x0} y={y0} width={w} height={h} fill={color} opacity={opacity} style={{ mixBlendMode: "multiply" }} />;
    case "underline":
      return (
        <g {...events}>
          <rect x={x0} y={y0} width={w} height={h} fill="transparent" />
          <line x1={x0} x2={x1} y1={y1 - 0.8} y2={y1 - 0.8} stroke={color} strokeWidth={1.2} opacity={opacity} />
        </g>
      );
    case "strike":
      return (
        <g {...events}>
          <rect x={x0} y={y0} width={w} height={h} fill="transparent" />
          <line x1={x0} x2={x1} y1={(y0 + y1) / 2} y2={(y0 + y1) / 2} stroke={color} strokeWidth={1.2} opacity={opacity} />
        </g>
      );
    case "erase":
      return <rect {...events} x={x0} y={y0} width={w} height={h} fill="#ffffff" stroke={selected ? "none" : "rgb(27 31 36 / 0.25)"} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />;
    case "redact":
      return <rect {...events} x={x0} y={y0} width={w} height={h} fill="#000000" />;
    case "link":
      return <rect {...events} x={x0} y={y0} width={w} height={h} fill="rgb(29 78 216 / 0.08)" stroke="#1d4ed8" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />;
    case "line":
    case "arrow": {
      const a = { x: num(op.x0), y: num(op.y0) }, b = { x: num(op.x1), y: num(op.y1) };
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(8, width * 4);
      const hp = [0, 1].map((s) => `${b.x - head * Math.cos(ang + (s ? 0.45 : -0.45))},${b.y - head * Math.sin(ang + (s ? 0.45 : -0.45))}`).join(" ");
      return (
        <g {...events} opacity={opacity}>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={width} strokeLinecap="round" />
          {op.type === "arrow" && <polygon points={`${b.x},${b.y} ${hp}`} fill={color} stroke={color} strokeWidth={width * 0.4} strokeLinejoin="round" />}
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={hit} pointerEvents="stroke" />
        </g>
      );
    }
    case "ink":
      return (
        <g {...events} opacity={opacity} fill="none" strokeLinecap="round" strokeLinejoin="round">
          {(op.strokes as number[][][]).map((s, i) => (
            <g key={i}>
              <polyline points={s.map((p) => p.join(",")).join(" ")} stroke={color} strokeWidth={width} />
              <polyline points={s.map((p) => p.join(",")).join(" ")} stroke="transparent" strokeWidth={hit} pointerEvents="stroke" />
            </g>
          ))}
        </g>
      );
  }
  return null;
}

/* ---------- selection ---------- */

const HANDLE_LABEL: Record<HandleId, string> = { nw: "top left", n: "top", ne: "top right", e: "right", se: "bottom right", s: "bottom", sw: "bottom left", w: "left", rot: "rotate", p0: "start", p1: "end" };

export function Handles({ ids, onStart }: { ids: HandleId[]; onStart: (id: HandleId, e: RPointerEvent) => void }) {
  return (
    <>
      {ids.map((id) => (
        <span key={id} className={`hdl hdl-${id}`} role="slider" aria-label={`Resize ${HANDLE_LABEL[id]}`} data-handle={id} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onStart(id, e); }} />
      ))}
    </>
  );
}

const ALL8: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Frame and handles for a selected vector edit, drawn above the page. */
export function VectorFrame({ op, pw, ph, onHandle }: { op: PdfItem; pw: number; ph: number; onHandle: (id: HandleId, e: RPointerEvent) => void }) {
  const [x0, y0, x1, y1] = bounds(op);
  if (op.type === "line" || op.type === "arrow") {
    return (
      <>
        {(["p0", "p1"] as const).map((id) => {
          const [x, y] = id === "p0" ? [num(op.x0), num(op.y0)] : [num(op.x1), num(op.y1)];
          return (
            <div key={id} className="ptwrap" style={{ left: pctX(x, pw), top: pctY(y, ph) }}>
              <Handles ids={[id]} onStart={onHandle} />
            </div>
          );
        })}
      </>
    );
  }
  const pad = op.type === "ink" ? 4 : 0;
  const style: CSSProperties = { left: pctX(x0 - pad, pw), top: pctY(y0 - pad, ph), width: pctX(x1 - x0 + pad * 2, pw), height: pctY(y1 - y0 + pad * 2, ph) };
  return (
    <div className="selframe" style={style}>
      {op.type !== "ink" && <Handles ids={ALL8} onStart={onHandle} />}
    </div>
  );
}

/* ---------- text, notes, pictures ---------- */

type HtmlProps = Common & {
  op: PdfItem;
  selected: boolean;
  editing: boolean;
  onHandle: (id: HandleId, e: RPointerEvent) => void;
  onText: (id: number, text: string) => void;
  onCommit: (id: number) => void;
};

export function textStyle(op: PdfItem, pw: number, ph: number): CSSProperties {
  const size = num(op.size, 14);
  const framed = Boolean(op.background || op.border);
  const pad = framed ? 4 : 0;
  const width = num(op.width, 0);
  return {
    left: pctX(num(op.x) - pad, pw),
    top: pctY(num(op.y) - pad, ph),
    fontFamily: `"${String(op.font ?? "Arial")}", Arial, sans-serif`,
    fontSize: cq(size, pw),
    fontWeight: op.bold ? 700 : 400,
    fontStyle: op.italic ? "italic" : "normal",
    color: String(op.color ?? "#111111"),
    opacity: num(op.opacity, 1),
    lineHeight: 1.15,
    whiteSpace: width ? "pre-wrap" : "pre",
    width: width ? cq(width, pw) : undefined,
    padding: cq(pad, pw),
    background: op.background ? String(op.background) : undefined,
    border: op.border ? `${cq(1.5, pw)} solid ${String(op.border)}` : undefined,
    transform: num(op.rotate) ? `rotate(${num(op.rotate)}deg)` : undefined,
    transformOrigin: `${cq(pad, pw)} ${cq(pad, pw)}`,
  };
}

function Editor({ op, pw, ph, onText, onCommit }: Pick<HtmlProps, "op" | "pw" | "ph" | "onText" | "onCommit">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const born = useRef(Date.now());
  const leaving = useRef(false);
  useEffect(() => {
    // focus at once so fast typing is not lost; the click that made this box may still steal focus, see onBlur
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <textarea
      ref={ref}
      className="obj text editing"
      data-oid={op.id}
      aria-label="Text"
      spellCheck={false}
      rows={Math.max(1, String(op.text ?? "").split("\n").length)}
      value={String(op.text ?? "")}
      style={{ ...textStyle(op, pw, ph), fieldSizing: "content" } as CSSProperties}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => onText(op.id, e.target.value)}
      onBlur={(e) => {
        if (!leaving.current && Date.now() - born.current < 250) {
          const t = e.currentTarget;
          setTimeout(() => t.focus(), 0); // the creating click's own focus change, not the user leaving
          return;
        }
        onCommit(op.id);
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

export function HtmlItem({ op, pw, ph, selected, editing, onDown, onDouble, onHandle, onText, onCommit }: HtmlProps) {
  const events = { onPointerDown: (e: RPointerEvent) => onDown(e, op), onDoubleClick: () => onDouble(op), "data-oid": op.id, "data-type": op.type, "aria-label": describe(op) } as const;

  if (op.type === "text") {
    if (editing) return <Editor op={op} pw={pw} ph={ph} onText={onText} onCommit={onCommit} />;
    return (
      <div {...events} className={`obj text${selected ? " selected" : ""}`} style={textStyle(op, pw, ph)}>
        {String(op.text ?? "") || " "}
        {selected && <Handles ids={["e", "se", "rot"]} onStart={onHandle} />}
      </div>
    );
  }
  if (op.type === "note") {
    return (
      <div {...events} className={`obj note${selected ? " selected" : ""}`} title={String(op.text ?? "")} style={{ left: pctX(num(op.x), pw), top: pctY(num(op.y), ph), width: pctX(20, pw), aspectRatio: "1", background: String(op.color ?? "#ffcc00") }} />
    );
  }
  // image
  const w = num(op.w, 150);
  const h = num(op.h, 0);
  return (
    <div
      {...events}
      className={`obj image${selected ? " selected" : ""}`}
      style={{ left: pctX(num(op.x0), pw), top: pctY(num(op.y0), ph), width: pctX(w, pw), height: h ? pctY(h, ph) : undefined, opacity: num(op.opacity, 1), transform: num(op.rotate) ? `rotate(${num(op.rotate)}deg)` : undefined }}
    >
      <img src={fileUrl(String(op.path ?? ""))} alt="" draggable={false} />
      {selected && <Handles ids={[...ALL8, "rot"]} onStart={onHandle} />}
    </div>
  );
}
