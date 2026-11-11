import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { Slider } from "../photoui";
import { baseName } from "../shared";
import { current, type Item, type Op } from "../lib/photoOps";

/** What every whole-photo panel gets from the editor. */
export type PanelProps = {
  file: string;
  info: { width: number; height: number };
  items: Item[];
  canvas: HTMLElement | null;
  size: { w: number; h: number } | null;
  commit: (op: Op) => void;
  live: (op: Op) => void;
  begin: () => void;
  end: () => void;
  setDraft: (op: Op | null) => void;
};

/* ------------------------------------------------------------------------------------------ */
/* Curves                                                                                      */
/* ------------------------------------------------------------------------------------------ */

type Pt = [number, number];
const CHANNELS = [
  { id: "rgb", label: "All", color: "#222" },
  { id: "r", label: "Red", color: "#d33" },
  { id: "g", label: "Green", color: "#2a2" },
  { id: "b", label: "Blue", color: "#36d" },
] as const;
const HOME: Pt[] = [[0, 0], [255, 255]];
const SIDE = 240;

export function CurvesPanel(p: PanelProps) {
  const op = current<Op & { channels?: Record<string, Pt[]> }>(p.items, "curves");
  const [chan, setChan] = useState<(typeof CHANNELS)[number]["id"]>("rgb");
  const [drag, setDrag] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const channels = op?.channels ?? {};
  const pts: Pt[] = (channels[chan] as Pt[] | undefined) ?? HOME;
  const color = CHANNELS.find((c) => c.id === chan)!.color;

  const write = (next: Pt[]) => {
    const all = { ...channels, [chan]: next };
    p.live({ type: "curves", channels: all });
  };
  const toPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.round(Math.min(255, Math.max(0, ((e.clientX - r.left) / r.width) * 255))), Math.round(Math.min(255, Math.max(0, (1 - (e.clientY - r.top) / r.height) * 255)))];
  };

  function down(e: RPointerEvent<SVGSVGElement>) {
    const at = toPt(e);
    let idx = pts.findIndex((q) => Math.hypot(q[0] - at[0], q[1] - at[1]) < 14);
    p.begin();
    let cur = pts;
    if (idx < 0) {
      cur = [...pts, at].sort((a, b) => a[0] - b[0]);
      idx = cur.indexOf(cur.find((q) => q[0] === at[0] && q[1] === at[1])!);
      write(cur);
    }
    setDrag(idx);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const n = toPt(ev);
      const first = idx === 0, last = idx === cur.length - 1;
      const lo = first ? 0 : cur[idx - 1][0] + 1;
      const hi = last ? 255 : cur[idx + 1][0] - 1;
      const x = first ? cur[0][0] : last ? cur[cur.length - 1][0] : Math.min(hi, Math.max(lo, n[0]));
      cur = cur.map((q, i) => (i === idx ? ([x, n[1]] as Pt) : q));
      write(cur);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      p.end();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function remove(i: number) {
    if (i === 0 || i === pts.length - 1) return;
    p.begin();
    write(pts.filter((_, k) => k !== i));
    p.end();
  }

  const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${(x / 255) * SIDE},${SIDE - (y / 255) * SIDE}`).join(" ");
  return (
    <>
      <div className="seg" role="group" aria-label="Channel">
        {CHANNELS.map((c) => (
          <button key={c.id} className={chan === c.id ? "on" : ""} aria-pressed={chan === c.id} onClick={() => setChan(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <svg ref={svg} className="curvebox" width={SIDE} height={SIDE} viewBox={`0 0 ${SIDE} ${SIDE}`} onPointerDown={down} role="img" aria-label="Tone curve">
        {[1, 2, 3].map((k) => (
          <g key={k} stroke="#cfd2c6">
            <line x1={(k * SIDE) / 4} y1={0} x2={(k * SIDE) / 4} y2={SIDE} />
            <line x1={0} y1={(k * SIDE) / 4} x2={SIDE} y2={(k * SIDE) / 4} />
          </g>
        ))}
        <line x1={0} y1={SIDE} x2={SIDE} y2={0} stroke="#bbb" strokeDasharray="3 3" />
        <path d={path} fill="none" stroke={color} strokeWidth={2} />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={(x / 255) * SIDE}
            cy={SIDE - (y / 255) * SIDE}
            r={drag === i ? 7 : 5}
            fill="#fff"
            stroke={color}
            strokeWidth={2}
            onDoubleClick={(e) => {
              e.stopPropagation();
              remove(i);
            }}
          />
        ))}
      </svg>
      <p className="hint">Drag the line to brighten or darken. Click to add a point, double-click a point to remove it. Bottom left is shadows, top right is highlights.</p>
      <div className="actions tight">
        <button disabled={!op} onClick={() => p.commit({ type: "curves", _off: true })}>
          Reset curves
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Colour mixer (hue / saturation / brightness per colour)                                     */
/* ------------------------------------------------------------------------------------------ */

const BANDS = [
  { id: "red", label: "Red", css: "#e0312d" },
  { id: "orange", label: "Orange", css: "#f08a24" },
  { id: "yellow", label: "Yellow", css: "#e8d21f" },
  { id: "green", label: "Green", css: "#35b04a" },
  { id: "aqua", label: "Aqua", css: "#25b8c4" },
  { id: "blue", label: "Blue", css: "#2f5fe0" },
  { id: "purple", label: "Purple", css: "#8a45d6" },
  { id: "magenta", label: "Magenta", css: "#d63fa4" },
] as const;

export function HslPanel(p: PanelProps) {
  const op = current<Op & { bands?: Record<string, Record<string, number>> }>(p.items, "hsl");
  const [band, setBand] = useState<string>("red");
  const bands = op?.bands ?? {};
  const cur = bands[band] ?? {};
  const set = (k: string, v: number) => p.live({ type: "hsl", bands: { ...bands, [band]: { ...cur, [k]: v } } });
  return (
    <>
      <div className="swatches" role="group" aria-label="Colour">
        {BANDS.map((b) => (
          <button key={b.id} className={band === b.id ? "on" : ""} aria-pressed={band === b.id} aria-label={b.label} title={b.label} style={{ background: b.css }} onClick={() => setBand(b.id)}>
            {bands[b.id] && Object.values(bands[b.id]).some((v) => v) ? <span className="dot" /> : null}
          </button>
        ))}
      </div>
      <p className="hint">Pick a colour, then change only that colour in the photo: make the sky bluer, the grass less neon, the skin tones calmer.</p>
      <Slider label="Shift the colour" value={cur.hue ?? 0} min={-100} max={100} onStart={p.begin} onEnd={p.end} onChange={(v) => set("hue", v)} />
      <Slider label="Intensity" value={cur.sat ?? 0} min={-100} max={100} onStart={p.begin} onEnd={p.end} onChange={(v) => set("sat", v)} />
      <Slider label="Brightness" value={cur.lum ?? 0} min={-100} max={100} onStart={p.begin} onEnd={p.end} onChange={(v) => set("lum", v)} />
      <div className="actions tight">
        <button disabled={!op} onClick={() => p.commit({ type: "hsl", _off: true })}>
          Reset colours
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Perspective                                                                                 */
/* ------------------------------------------------------------------------------------------ */

const CORNERS: Pt[] = [[0.12, 0.12], [0.88, 0.12], [0.88, 0.88], [0.12, 0.88]];

export function PerspectivePanel(p: PanelProps) {
  const applied = current<Op & { points: number[][] }>(p.items, "perspective");
  const [pts, setPts] = useState<Pt[]>(CORNERS);
  const box = useRef<HTMLDivElement>(null);

  function startDrag(i: number, e: RPointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev: PointerEvent) => {
      const r = box.current!.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      setPts((cur) => cur.map((q, k) => (k === i ? ([x, y] as Pt) : q)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  if (applied) {
    return (
      <>
        <p className="hint">Perspective is corrected. To change it, remove it and mark the corners again.</p>
        <div className="actions tight">
          <button onClick={() => p.commit({ type: "perspective", _off: true })}>Remove correction</button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="hint">Drag the four corners onto the corners of the thing that should be straight (a document, a screen, a building), then press Straighten.</p>
      <div className="actions tight">
        <button className="primary" onClick={() => p.commit({ type: "perspective", points: pts })}>
          Straighten
        </button>
        <button onClick={() => setPts(CORNERS)}>Reset corners</button>
      </div>
      {p.canvas &&
        createPortal(
          <div ref={box} className="perspbox">
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
              <polygon points={pts.map((q) => q.join(",")).join(" ")} fill="rgb(255 255 255 / 0.12)" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </svg>
            {pts.map((q, i) => (
              <button key={i} className="persp-handle" aria-label={`Corner ${i + 1}`} style={{ left: `${q[0] * 100}%`, top: `${q[1] * 100}%` }} onPointerDown={(e) => startDrag(i, e)} />
            ))}
          </div>,
          p.canvas,
        )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Extra corrections: noise, lens, colour grading, colour looks                                */
/* ------------------------------------------------------------------------------------------ */

export function ExtraPanel(p: PanelProps) {
  const denoise = current<Op>(p.items, "denoise");
  const lens = current<Op>(p.items, "lens");
  const vig = current<Op>(p.items, "vignette");
  const grade = current<Op>(p.items, "grade");
  const lut = current<Op>(p.items, "lut");
  const g = (k: string, d: string) => String(grade?.[k] ?? d);
  const setGrade = (k: string, v: string) => p.live({ type: "grade", amount: grade?.amount ?? 0.6, ...grade, [k]: v });

  async function pickLut() {
    const picked = await open({ multiple: false, filters: [{ name: "Colour look (.cube)", extensions: ["cube"] }] });
    if (typeof picked === "string") p.commit({ type: "lut", path: picked, intensity: 1 });
  }

  return (
    <>
      <Slider label="Reduce noise" value={Number(denoise?.strength ?? 0)} min={0} max={30} onStart={p.begin} onEnd={p.end} onChange={(v) => p.live({ type: "denoise", strength: v })} />
      <p className="hint">For grainy night photos. Strong values smooth fine detail.</p>
      <Slider label="Lens distortion" value={Number(lens?.amount ?? 0)} min={-100} max={100} onStart={p.begin} onEnd={p.end} onChange={(v) => p.live({ type: "lens", amount: v })} />
      <Slider label="Dark corners" value={Number(vig?.strength ?? 0)} min={-1} max={1} step={0.05} onStart={p.begin} onEnd={p.end} onChange={(v) => p.live({ type: "vignette", strength: v })} />
      <p className="hint">Move left to lighten dark corners that the lens caused, right to add a vignette.</p>
      <hr />
      <span className="label">Colour tones</span>
      <div className="tonegrid">
        {(["shadows", "midtones", "highlights"] as const).map((k) => (
          <label key={k} className="colorfield">
            <span>{k === "shadows" ? "Shadows" : k === "midtones" ? "Midtones" : "Highlights"}</span>
            <input type="color" value={g(k, "#808080")} onChange={(e) => setGrade(k, e.target.value)} onPointerDown={p.begin} onBlur={p.end} />
          </label>
        ))}
      </div>
      <Slider label="Tone strength" value={Number(grade?.amount ?? 0.6)} min={0} max={1} step={0.05} reset={0.6} onStart={p.begin} onEnd={p.end} onChange={(v) => p.live({ type: "grade", ...grade, amount: v })} />
      <div className="actions tight">
        <button disabled={!grade} onClick={() => p.commit({ type: "grade", _off: true })}>
          Clear tones
        </button>
      </div>
      <hr />
      <span className="label">Colour look from a file</span>
      <div className="inline">
        <span className={lut ? "mono trunc" : "muted"} title={String(lut?.path ?? "")}>
          {lut ? baseName(String(lut.path)) : "None chosen"}
        </span>
        <button onClick={pickLut}>Choose .cube…</button>
      </div>
      {lut && (
        <>
          <Slider label="Look strength" value={Number(lut.intensity ?? 1)} min={0} max={1} step={0.05} reset={1} onStart={p.begin} onEnd={p.end} onChange={(v) => p.live({ ...lut, intensity: v })} />
          <div className="actions tight">
            <button onClick={() => p.commit({ type: "lut", _off: true })}>Remove look</button>
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* QR code                                                                                     */
/* ------------------------------------------------------------------------------------------ */

const CORNERS_QR: { id: string; label: string; x: number; y: number }[] = [
  { id: "tl", label: "Top left", x: 0.14, y: 0.14 },
  { id: "tr", label: "Top right", x: 0.86, y: 0.14 },
  { id: "c", label: "Middle", x: 0.5, y: 0.5 },
  { id: "bl", label: "Bottom left", x: 0.14, y: 0.86 },
  { id: "br", label: "Bottom right", x: 0.86, y: 0.86 },
];

export function QrPanel(p: PanelProps) {
  const qr = current<Op>(p.items, "qr");
  const [text, setText] = useState(String(qr?.text ?? ""));
  const w = Number(qr?.w ?? 0.2);
  const x = Number(qr?.x ?? 0.86);
  const y = Number(qr?.y ?? 0.86);
  const write = (c: Partial<Op>) => p.live({ type: "qr", text, x, y, w, color: "#000000", background: "#ffffff", ...qr, ...c });
  return (
    <>
      <div className="field">
        <label className="label" htmlFor="qr-text">
          What the code holds
        </label>
        <input id="qr-text" placeholder="https://example.com or any text" value={text} onChange={(e) => { setText(e.target.value); if (e.target.value.trim()) write({ text: e.target.value }); else p.commit({ type: "qr", _off: true }); }} />
      </div>
      {qr && (
        <>
          <div className="seg" role="group" aria-label="Position">
            {CORNERS_QR.map((c) => (
              <button key={c.id} className={Math.abs(x - c.x) < 0.01 && Math.abs(y - c.y) < 0.01 ? "on" : ""} onClick={() => p.commit({ ...qr, type: "qr", x: c.x, y: c.y })}>
                {c.label}
              </button>
            ))}
          </div>
          <Slider label="Size" value={w} min={0.06} max={0.6} step={0.01} reset={0.2} onStart={p.begin} onEnd={p.end} onChange={(v) => write({ w: v })} />
          <div className="actions tight">
            <button onClick={() => { setText(""); p.commit({ type: "qr", _off: true }); }}>Remove the code</button>
          </div>
        </>
      )}
      <p className="hint">Scan it with a phone before you send the picture out. A big, quiet corner works best.</p>
    </>
  );
}
