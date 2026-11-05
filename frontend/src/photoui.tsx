import { useEffect, useRef, useState, type ReactNode } from "react";
import { post } from "./api";
import { resizeRect, type Handle, type Point, type Rect } from "./lib/crop";

/* ---------------------------------------------------------------------------------------- */
/* Live preview                                                                              */
/* ---------------------------------------------------------------------------------------- */

export type Preview = {
  image: string;
  mime: string;
  width: number;
  height: number;
  original_width: number;
  original_height: number;
  result_size: [number, number];
};

/** Renders `edits` on the photo; the previous picture stays on screen while the next one is computed. */
export function usePhotoPreview(file: string | null, edits: object[], delay = 120) {
  const [state, setState] = useState<{ data: Preview | null; loading: boolean; error: string }>({ data: null, loading: false, error: "" });
  const seq = useRef(0);
  const key = file ? JSON.stringify([file, edits]) : "";

  useEffect(() => {
    if (!file) {
      setState({ data: null, loading: false, error: "" });
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(async () => {
      try {
        const data = await post<Preview>("/photo/preview", { input: file, edits });
        if (mine === seq.current) setState({ data, loading: false, error: "" });
      } catch (e) {
        if (mine === seq.current) setState((s) => ({ data: s.data, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delay]);

  return state;
}

/* ---------------------------------------------------------------------------------------- */
/* Controls                                                                                  */
/* ---------------------------------------------------------------------------------------- */

/** A labelled range input. Double-click resets. onStart/onEnd bracket one drag so the editor can record one undo step. */
export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onStart,
  onEnd,
  reset = 0,
  unit = "",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  reset?: number;
  unit?: string;
}) {
  const id = `sl-${label.replace(/\W+/g, "-")}`;
  return (
    <div className="slider">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onStart}
        onKeyDown={onStart}
        onPointerUp={onEnd}
        onKeyUp={onEnd}
        onBlur={onEnd}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => {
          onStart?.();
          onChange(reset);
          onEnd?.();
        }}
      />
      <output className="mono" htmlFor={id}>
        {step < 1 ? value.toFixed(2) : value}
        {unit}
      </output>
    </div>
  );
}

export function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="colorfield">
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="mono">{value}</span>
    </label>
  );
}

/* ---------------------------------------------------------------------------------------- */
/* Pointer layers on top of the photo                                                        */
/* ---------------------------------------------------------------------------------------- */

const norm = (el: HTMLElement, e: { clientX: number; clientY: number }): Point => {
  const r = el.getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
};

/** Transparent layer over the photo. Reports a click, or a drag as the start, current point and every point on the way. */
export function DragLayer({
  onDrag,
  onEnd,
  onClick,
  cursor = "crosshair",
  children,
}: {
  onDrag?: (a: Point, b: Point, path: Point[]) => void;
  onEnd?: (a: Point, b: Point, path: Point[]) => void;
  onClick?: (p: Point) => void;
  cursor?: string;
  children?: ReactNode;
}) {
  const drag = useRef<{ a: Point; path: Point[]; moved: boolean } | null>(null);
  return (
    <div
      className="draglayer"
      style={{ cursor }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const a = norm(e.currentTarget, e);
        drag.current = { a, path: [a], moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const p = norm(e.currentTarget, e);
        if (Math.hypot(p.x - d.a.x, p.y - d.a.y) > 0.004) d.moved = true;
        const last = d.path[d.path.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 0.002) d.path.push(p);
        if (d.moved) onDrag?.(d.a, p, d.path);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const p = norm(e.currentTarget, e);
        if (d.moved) onEnd?.(d.a, p, d.path);
        else onClick?.(d.a);
      }}
    >
      {children}
    </div>
  );
}

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Draggable crop frame with eight handles. `aspect` is the locked normalized width/height ratio, or null. */
export function CropBox({ rect, onChange, aspect }: { rect: Rect; onChange: (r: Rect) => void; aspect: number | null }) {
  const drag = useRef<{ handle: Handle; r0: Rect; start: Point } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const down = (handle: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { handle, r0: rect, start: norm(root.current!, e) };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    onChange(resizeRect(d.r0, d.handle, norm(root.current!, e), d.start, aspect));
  };
  const up = () => (drag.current = null);

  return (
    <div className="cropwrap" ref={root}>
      <div
        className="cropbox"
        style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
        onPointerDown={down("move")}
        onPointerMove={move}
        onPointerUp={up}
      >
        <i className="third v1" />
        <i className="third v2" />
        <i className="third h1" />
        <i className="third h2" />
        {HANDLES.map((h) => (
          <b key={h} className={`handle ${h}`} data-handle={h} onPointerDown={down(h)} onPointerMove={move} onPointerUp={up} />
        ))}
      </div>
    </div>
  );
}

/** Outline of a region the user is choosing (rectangle or ellipse). */
export function AreaOutline({ rect, shape }: { rect: Rect; shape: "rect" | "ellipse" }) {
  return (
    <div
      className={`areabox ${shape}`}
      style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
    />
  );
}
