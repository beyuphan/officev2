import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Crop,
  Download,
  Droplet,
  Eye,
  FlipHorizontal2,
  FlipVertical2,
  Frame,
  Pencil,
  Redo2,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  Type as TypeIcon,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { get, post, put as putSetting } from "../api";
import { CheckField, FolderField, InputsField, RunBar, Segmented, SelectField, SourceField, TextField, baseName, formatBytes, imageFilter, useTask } from "../shared";
import { AreaOutline, ColorInput, CropBox, DragLayer, Slider, usePhotoPreview } from "../photoui";
import { ADJUST_KEYS, aspectRect, current, describe, pipeline, put, type Item, type Op } from "../lib/photoOps";
import { normAspect, spanRect, type Rect } from "../lib/crop";

type Tab = "crop" | "adjust" | "filters" | "blur" | "text" | "draw" | "frame" | "export";
const TABS: { id: Tab; label: string; Icon: LucideIcon }[] = [
  { id: "crop", label: "Crop", Icon: Crop },
  { id: "adjust", label: "Adjust", Icon: SlidersHorizontal },
  { id: "filters", label: "Filters", Icon: Sparkles },
  { id: "blur", label: "Blur", Icon: Droplet },
  { id: "text", label: "Text", Icon: TypeIcon },
  { id: "draw", label: "Draw", Icon: Pencil },
  { id: "frame", label: "Frame", Icon: Frame },
  { id: "export", label: "Save", Icon: Download },
];

type Info = { width: number; height: number; format: string; megapixels: number; camera: string; taken: string; has_location: boolean; size_bytes: number };

type Panel = {
  file: string;
  info: Info;
  items: Item[];
  canvas: HTMLElement | null;
  size: { w: number; h: number } | null;
  commit: (op: Op) => void;
  live: (op: Op) => void;
  begin: () => void;
  end: () => void;
  setDraft: (op: Op | null) => void;
  fonts: string[];
  filters: string[];
};

const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "");

/* ------------------------------------------------------------------------------------------ */
/* Crop and rotate                                                                            */
/* ------------------------------------------------------------------------------------------ */

const ASPECTS: { id: string; label: string; ratio: number | "orig" | null }[] = [
  { id: "free", label: "Free", ratio: null },
  { id: "orig", label: "Original", ratio: "orig" },
  { id: "1:1", label: "Square 1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "5:4", label: "5:4", ratio: 5 / 4 },
  { id: "4:5", label: "Portrait 4:5", ratio: 4 / 5 },
  { id: "9:16", label: "Story 9:16", ratio: 9 / 16 },
];

function CropPanel(p: Panel) {
  const full: Rect = { x: 0, y: 0, w: 1, h: 1 };
  const [rect, setRect] = useState<Rect>(full);
  const [aspectId, setAspectId] = useState("free");
  const [flip, setFlip] = useState(false);
  const size = p.size ?? { w: 1, h: 1 };
  const base = ASPECTS.find((a) => a.id === aspectId)!.ratio;
  const pixelAspect = base === null ? null : base === "orig" ? size.w / size.h : flip ? 1 / base : base;
  const a = pixelAspect === null ? null : normAspect(pixelAspect, size.w, size.h);
  const straighten = current<Op & { degrees: number }>(p.items, "straighten")?.degrees ?? 0;

  // whenever the picture or the ratio changes, start from the biggest frame of that ratio
  useEffect(() => {
    setRect(pixelAspect === null ? full : aspectRect(size.w, size.h, pixelAspect));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, aspectId, flip]);

  const isFull = rect.w > 0.999 && rect.h > 0.999;

  return (
    <>
      <SelectField id="cr-asp" label="Shape" value={aspectId} onChange={setAspectId} options={ASPECTS.map((x) => ({ id: x.id, label: x.label }))} />
      {pixelAspect !== null && base !== "orig" && base !== 1 && (
        <CheckField label="Swap landscape and portrait" checked={flip} onChange={setFlip} />
      )}
      <div className="actions tight">
        <button className="primary" disabled={isFull} onClick={() => p.commit({ type: "crop", x: rect.x, y: rect.y, w: rect.w, h: rect.h })}>
          Apply crop
        </button>
        <button disabled={isFull} onClick={() => setRect(pixelAspect === null ? full : aspectRect(size.w, size.h, pixelAspect))}>
          Reset frame
        </button>
      </div>
      <p className="hint">Drag the frame or its handles on the photo. Applying a crop adds a step you can remove later.</p>
      <hr />
      <span className="label">Rotate and flip</span>
      <div className="iconrow">
        <button aria-label="Rotate left" onClick={() => p.commit({ type: "rotate", degrees: -90 })}>
          <RotateCcw size={16} strokeWidth={1.5} />
        </button>
        <button aria-label="Rotate right" onClick={() => p.commit({ type: "rotate", degrees: 90 })}>
          <RotateCw size={16} strokeWidth={1.5} />
        </button>
        <button aria-label="Flip horizontally" onClick={() => p.commit({ type: "flip", direction: "horizontal" })}>
          <FlipHorizontal2 size={16} strokeWidth={1.5} />
        </button>
        <button aria-label="Flip vertically" onClick={() => p.commit({ type: "flip", direction: "vertical" })}>
          <FlipVertical2 size={16} strokeWidth={1.5} />
        </button>
      </div>
      <Slider
        label="Straighten"
        value={straighten}
        min={-15}
        max={15}
        step={0.1}
        unit="°"
        onStart={p.begin}
        onEnd={p.end}
        onChange={(v) => p.live({ type: "straighten", degrees: v })}
      />
      {p.canvas && createPortal(<CropBox rect={rect} onChange={setRect} aspect={a} />, p.canvas)}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Light and color                                                                            */
/* ------------------------------------------------------------------------------------------ */

const ADJUST_LABEL: Record<string, string> = {
  exposure: "Exposure", brightness: "Brightness", contrast: "Contrast", highlights: "Highlights", shadows: "Shadows",
  saturation: "Saturation", vibrance: "Vibrance", warmth: "Warmth", tint: "Tint", hue: "Hue", sharpness: "Sharpness",
};
const ADJUST_ORDER = ["exposure", "brightness", "contrast", "highlights", "shadows", "warmth", "tint", "saturation", "vibrance", "hue", "sharpness"] as const;

function AdjustPanel(p: Panel) {
  const cur = current<Op>(p.items, "adjust") ?? { type: "adjust" };
  const auto = current<Op>(p.items, "auto");
  return (
    <>
      <div className="actions tight">
        {(["contrast", "equalize", "enhance"] as const).map((m) => (
          <button key={m} className={auto?.mode === m ? "on" : ""} aria-pressed={auto?.mode === m} onClick={() => p.commit(auto?.mode === m ? { type: "auto", mode: m, _off: true } : { type: "auto", mode: m })}>
            Auto {m}
          </button>
        ))}
      </div>
      {ADJUST_ORDER.map((k) => (
        <Slider
          key={k}
          label={ADJUST_LABEL[k]}
          value={Number(cur[k] ?? 0)}
          min={-100}
          max={100}
          onStart={p.begin}
          onEnd={p.end}
          onChange={(v) => p.live({ ...cur, type: "adjust", [k]: v })}
        />
      ))}
      <div className="actions tight">
        <button disabled={ADJUST_KEYS.every((k) => Number(cur[k] ?? 0) === 0)} onClick={() => p.commit({ type: "adjust" })}>
          Reset adjustments
        </button>
      </div>
      <p className="hint">Double-click a slider to reset it.</p>
    </>
  );
}

function FiltersPanel(p: Panel) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const filter = current<Op & { name: string; intensity?: number }>(p.items, "filter");
  const vig = current<Op>(p.items, "vignette");
  const grain = current<Op>(p.items, "grain");
  const without = useMemo(() => pipeline(p.items.filter((i) => i.type !== "filter")), [p.items]);
  const key = JSON.stringify(without);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      post<{ filters: Record<string, string> }>("/photo/filter-thumbs", { input: p.file, edits: without })
        .then((r) => live && setThumbs(r.filters))
        .catch(() => undefined);
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.file, key]);

  return (
    <>
      <div className="filtergrid">
        <button className={!filter ? "on" : ""} aria-pressed={!filter} onClick={() => p.commit({ type: "filter", name: "" })}>
          <span className="ph" />
          <small>None</small>
        </button>
        {p.filters.map((f) => (
          <button key={f} className={filter?.name === f ? "on" : ""} aria-pressed={filter?.name === f} onClick={() => p.commit({ type: "filter", name: f, intensity: filter?.intensity ?? 1 })}>
            {thumbs[f] ? <img src={`data:image/jpeg;base64,${thumbs[f]}`} alt="" /> : <span className="ph" />}
            <small>{f}</small>
          </button>
        ))}
      </div>
      {filter && (
        <Slider label="Strength" value={filter.intensity ?? 1} min={0} max={1} step={0.05} reset={1} onStart={p.begin} onEnd={p.end} onChange={(v) => p.live({ ...filter, intensity: v })} />
      )}
      <hr />
      <Slider label="Vignette" value={Number(vig?.strength ?? 0)} min={0} max={1} step={0.05} onStart={p.begin} onEnd={p.end} onChange={(v) => p.live({ type: "vignette", strength: v })} />
      <Slider label="Film grain" value={Number(grain?.amount ?? 0)} min={0} max={1} step={0.05} onStart={p.begin} onEnd={p.end} onChange={(v) => p.live({ type: "grain", amount: v })} />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Blur and privacy                                                                           */
/* ------------------------------------------------------------------------------------------ */

function BlurPanel(p: Panel) {
  const [kind, setKind] = useState("gaussian");
  const [shape, setShape] = useState<"rect" | "ellipse">("rect");
  const [radius, setRadius] = useState(Math.max(8, Math.round(p.info.width / 120)));
  const [feather, setFeather] = useState(0);
  const [invert, setInvert] = useState(false);
  const [angle, setAngle] = useState(0);
  const [band, setBand] = useState(0.18);
  const [center, setCenter] = useState(0.5);
  const [area, setArea] = useState<Rect | null>(null);
  const tilt = kind === "tiltshift";
  const maxR = Math.max(60, Math.round(p.info.width / 20));

  const op = useMemo<Op>(() => {
    const base: Op = { type: "blur", kind, radius };
    if (tilt) return { ...base, band, center };
    if (kind === "motion") base.angle = angle;
    if (area && area.w > 0.01 && area.h > 0.01) return { ...base, area: { shape, ...area }, feather: shape === "ellipse" || feather ? feather : 0, invert };
    return base;
  }, [kind, radius, band, center, angle, area, shape, feather, invert, tilt]);

  // live preview of what "Apply" would do
  const { setDraft } = p;
  useEffect(() => {
    setDraft(op);
    return () => setDraft(null);
  }, [op, setDraft]);

  return (
    <>
      <SelectField
        id="bl-kind"
        label="Effect"
        value={kind}
        onChange={setKind}
        options={[
          { id: "gaussian", label: "Blur (smooth)" },
          { id: "box", label: "Blur (soft box)" },
          { id: "motion", label: "Motion blur" },
          { id: "pixelate", label: "Pixelate / mosaic" },
          { id: "tiltshift", label: "Tilt-shift (miniature)" },
        ]}
      />
      <Slider label={kind === "pixelate" ? "Block size" : "Strength"} value={radius} min={1} max={maxR} onChange={setRadius} reset={12} />
      {kind === "motion" && <Slider label="Direction" value={angle} min={-90} max={90} unit="°" onChange={setAngle} />}
      {tilt ? (
        <>
          <Slider label="Sharp band" value={band} min={0.03} max={0.6} step={0.01} onChange={setBand} reset={0.18} />
          <Slider label="Band position" value={center} min={0} max={1} step={0.01} onChange={setCenter} reset={0.5} />
        </>
      ) : (
        <>
          <Segmented
            label="Area"
            value={shape}
            onChange={setShape}
            options={[
              { id: "rect", label: "Rectangle" },
              { id: "ellipse", label: "Oval" },
            ]}
          />
          <Slider label="Soft edge" value={feather} min={0} max={Math.round(p.info.width / 40)} onChange={setFeather} />
          <CheckField label="Blur everything except the area" checked={invert} onChange={setInvert} hint="Keeps the subject sharp and softens the background." />
          <p className="hint">Drag on the photo to choose an area, for example a face or a number plate. Without an area the whole photo is affected.</p>
        </>
      )}
      <div className="actions tight">
        <button
          className="primary"
          onClick={() => {
            p.commit(op);
            setArea(null);
          }}
        >
          Apply
        </button>
        {area && <button onClick={() => setArea(null)}>Clear area</button>}
      </div>
      {p.canvas &&
        !tilt &&
        createPortal(
          <DragLayer onDrag={(a, b) => setArea(spanRect(a, b))} onEnd={(a, b) => setArea(spanRect(a, b))}>
            {area && <AreaOutline rect={area} shape={shape} />}
          </DragLayer>,
          p.canvas,
        )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Text                                                                                       */
/* ------------------------------------------------------------------------------------------ */

function TextPanel(p: Panel) {
  const [text, setText] = useState("");
  const [font, setFont] = useState("Arial");
  const [size, setSize] = useState(Math.round(p.info.width * 0.07));
  const [bold, setBold] = useState(true);
  const [italic, setItalic] = useState(false);
  const [color, setColor] = useState("#ffffff");
  const [opacity, setOpacity] = useState(1);
  const [outline, setOutline] = useState(Math.max(0, Math.round(p.info.width * 0.004)));
  const [outlineColor, setOutlineColor] = useState("#000000");
  const [shadow, setShadow] = useState(false);
  const [box, setBox] = useState(false);
  const [boxColor, setBoxColor] = useState("#000000");
  const [rotation, setRotation] = useState(0);
  const [pos, setPos] = useState({ x: 0.5, y: 0.5 });

  const op = useMemo<Op>(
    () => ({
      type: "text", text, font, size, bold, italic, color, opacity, rotation, x: pos.x, y: pos.y,
      stroke_width: outline, stroke_color: outlineColor, shadow, ...(box ? { background: boxColor } : {}),
    }),
    [text, font, size, bold, italic, color, opacity, rotation, pos, outline, outlineColor, shadow, box, boxColor],
  );
  const { setDraft } = p;
  useEffect(() => {
    setDraft(text.trim() ? op : null);
    return () => setDraft(null);
  }, [op, text, setDraft]);

  return (
    <>
      <div className="field">
        <label className="label" htmlFor="tx-text">
          Text
        </label>
        <textarea id="tx-text" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type, then click the photo to place it" />
      </div>
      <SelectField id="tx-font" label="Font" value={font} onChange={setFont} options={p.fonts.map((f) => ({ id: f, label: f }))} />
      <Slider label="Size" value={size} min={8} max={Math.round(p.info.width / 2)} onChange={setSize} unit=" px" reset={Math.round(p.info.width * 0.07)} />
      <div className="checks">
        <CheckField label="Bold" checked={bold} onChange={setBold} />
        <CheckField label="Italic" checked={italic} onChange={setItalic} />
        <CheckField label="Shadow" checked={shadow} onChange={setShadow} />
        <CheckField label="Label box" checked={box} onChange={setBox} />
      </div>
      <div className="colorrow">
        <ColorInput label="Color" value={color} onChange={setColor} />
        {box && <ColorInput label="Box" value={boxColor} onChange={setBoxColor} />}
      </div>
      <Slider label="Opacity" value={opacity} min={0.1} max={1} step={0.05} reset={1} onChange={setOpacity} />
      <Slider label="Outline" value={outline} min={0} max={Math.max(6, Math.round(p.info.width / 100))} onChange={setOutline} unit=" px" />
      {outline > 0 && <ColorInput label="Outline color" value={outlineColor} onChange={setOutlineColor} />}
      <Slider label="Rotate" value={rotation} min={-180} max={180} unit="°" onChange={setRotation} />
      <div className="actions tight">
        <button
          className="primary"
          disabled={!text.trim()}
          onClick={() => {
            p.commit(op);
            setText("");
          }}
        >
          Add text
        </button>
      </div>
      {p.canvas && createPortal(<DragLayer onClick={(pt) => setPos(pt)} onEnd={(a, b) => setPos({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })} />, p.canvas)}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Draw                                                                                       */
/* ------------------------------------------------------------------------------------------ */

type ShapeKind = "rect" | "ellipse" | "line" | "arrow" | "path" | "highlighter";

function DrawPanel(p: Panel) {
  const [kind, setKind] = useState<ShapeKind>("rect");
  const [color, setColor] = useState("#ff3b30");
  const [width, setWidth] = useState(Math.max(3, Math.round(p.info.width * 0.004)));
  const [fill, setFill] = useState(false);
  const [fillColor, setFillColor] = useState("#ff3b30");
  const [ghost, setGhost] = useState<{ a: { x: number; y: number }; b: { x: number; y: number }; path: { x: number; y: number }[] } | null>(null);
  const line = kind === "line" || kind === "arrow";
  const freehand = kind === "path" || kind === "highlighter";

  function build(a: { x: number; y: number }, b: { x: number; y: number }, path: { x: number; y: number }[]): Op {
    const base = { type: "shape", kind, color: kind === "highlighter" && color === "#ff3b30" ? "#ffe600" : color, width: kind === "highlighter" ? width * 4 : width };
    if (freehand) return { ...base, points: path.map((q) => [q.x, q.y]) };
    if (line) return { ...base, points: [[a.x, a.y], [b.x, b.y]] };
    const r = spanRect(a, b);
    return { ...base, x: r.x, y: r.y, w: r.w, h: r.h, ...(fill ? { fill: fillColor } : {}) };
  }

  return (
    <>
      <Segmented
        label="Tool"
        value={kind}
        onChange={setKind}
        options={[
          { id: "rect", label: "Box" },
          { id: "ellipse", label: "Oval" },
          { id: "line", label: "Line" },
          { id: "arrow", label: "Arrow" },
          { id: "path", label: "Pen" },
          { id: "highlighter", label: "Marker" },
        ]}
      />
      <div className="colorrow">
        <ColorInput label="Color" value={color} onChange={setColor} />
        {!line && !freehand && fill && <ColorInput label="Fill" value={fillColor} onChange={setFillColor} />}
      </div>
      <Slider label="Line width" value={width} min={1} max={Math.max(12, Math.round(p.info.width / 60))} unit=" px" onChange={setWidth} />
      {!line && !freehand && <CheckField label="Fill the shape" checked={fill} onChange={setFill} />}
      <p className="hint">Drag on the photo to draw. Each drawing is its own step in the list, so you can remove it later.</p>
      {p.canvas &&
        createPortal(
          <DragLayer
            onDrag={(a, b, path) => setGhost({ a, b, path })}
            onEnd={(a, b, path) => {
              setGhost(null);
              p.commit(build(a, b, path));
            }}
          >
            {ghost && (
              <svg className="ghost" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
                {freehand ? (
                  <polyline points={ghost.path.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" />
                ) : line ? (
                  <line x1={ghost.a.x} y1={ghost.a.y} x2={ghost.b.x} y2={ghost.b.y} stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" />
                ) : (
                  (() => {
                    const r = spanRect(ghost.a, ghost.b);
                    return kind === "ellipse" ? (
                      <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} fill="none" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" />
                    ) : (
                      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" />
                    );
                  })()
                )}
              </svg>
            )}
          </DragLayer>,
          p.canvas,
        )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Frame: logo, border, rounded corners, background                                           */
/* ------------------------------------------------------------------------------------------ */

function FramePanel(p: Panel) {
  const [logo, setLogo] = useState<string | null>(null);
  const [pos, setPos] = useState({ x: 0.85, y: 0.88 });
  const [w, setW] = useState(0.22);
  const [opacity, setOpacity] = useState(1);
  const [rotation, setRotation] = useState(0);
  const border = current<Op & { width: number; color: string }>(p.items, "border");
  const rounded = current<Op & { radius: number }>(p.items, "rounded");
  const [borderColor, setBorderColor] = useState("#ffffff");
  const bg = current<Op>(p.items, "remove_background");

  const op = useMemo<Op | null>(() => (logo ? { type: "overlay", path: logo, x: pos.x, y: pos.y, w, opacity, rotation } : null), [logo, pos, w, opacity, rotation]);
  const { setDraft } = p;
  useEffect(() => {
    setDraft(op);
    return () => setDraft(null);
  }, [op, setDraft]);

  return (
    <>
      <span className="label">Logo or image</span>
      <SourceField label="Image (PNG with transparency works best)" file={logo} onPick={setLogo} filters={imageFilter} />
      {logo && (
        <>
          <Slider label="Size" value={w} min={0.03} max={1} step={0.01} reset={0.22} onChange={setW} />
          <Slider label="Opacity" value={opacity} min={0.1} max={1} step={0.05} reset={1} onChange={setOpacity} />
          <Slider label="Rotate" value={rotation} min={-180} max={180} unit="°" onChange={setRotation} />
          <p className="hint">Click the photo to place it.</p>
          <div className="actions tight">
            <button
              className="primary"
              onClick={() => {
                p.commit(op!);
                setLogo(null);
              }}
            >
              Add image
            </button>
          </div>
        </>
      )}
      <hr />
      <Slider
        label="Border"
        value={border?.width ?? 0}
        min={0}
        max={Math.round(p.info.width / 10)}
        unit=" px"
        onStart={p.begin}
        onEnd={p.end}
        onChange={(v) => p.live({ type: "border", width: v, color: border?.color ?? borderColor })}
      />
      <ColorInput
        label="Border color"
        value={border?.color ?? borderColor}
        onChange={(c) => {
          setBorderColor(c);
          if (border) p.live({ ...border, color: c });
        }}
      />
      <Slider label="Rounded corners" value={rounded?.radius ?? 0} min={0} max={Math.round(Math.min(p.info.width, p.info.height) / 2)} unit=" px" onStart={p.begin} onEnd={p.end} onChange={(v) => p.live({ type: "rounded", radius: v })} />
      <p className="hint">Rounded corners are transparent: save as PNG or WebP to keep them.</p>
      <hr />
      <div className="actions tight">
        <button aria-pressed={!!bg} className={bg ? "on" : ""} onClick={() => p.commit(bg ? { type: "remove_background", _off: true } : { type: "remove_background" })}>
          {bg ? "Background removed (click to undo)" : "Remove background"}
        </button>
      </div>
      <p className="hint">Needs the small background model from Models. Save as PNG or WebP to keep transparency.</p>
      {p.canvas && logo && createPortal(<DragLayer onClick={setPos} onEnd={(a, b) => setPos({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })} />, p.canvas)}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Resize, save, batch                                                                        */
/* ------------------------------------------------------------------------------------------ */

const EXT: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp", tiff: "tiff", bmp: "bmp", pdf: "pdf" };

function SavePanel(p: Panel & { edits: Op[]; resultSize: [number, number] | null; onDone: () => void }) {
  const resize = current<Op & { mode: string; factor?: number; max_side?: number; width?: number; height?: number }>(p.items, "resize");
  const [fmt, setFmt] = useState("jpeg");
  const [quality, setQuality] = useState(92);
  const [strip, setStrip] = useState(false);
  const [background, setBackground] = useState("#ffffff");
  const [batchIn, setBatchIn] = useState<string[]>([]);
  const [batchOut, setBatchOut] = useState<string | null>(null);
  const task = useTask(p.onDone);
  const batch = useTask(p.onDone);
  const mode = resize?.mode ?? "none";
  const lossy = fmt === "jpeg" || fmt === "webp";

  async function saveCopy() {
    const ext = EXT[fmt];
    const output = await save({ filters: [{ name: fmt.toUpperCase(), extensions: [ext] }], defaultPath: `${stem(p.file)}-edited.${ext}` });
    if (output) await task.run("/photo/export", { input: p.file, edits: p.edits, output, format: fmt, quality, strip_metadata: strip, background });
  }

  return (
    <>
      <SelectField
        id="rs-mode"
        label="Size"
        value={mode}
        onChange={(m) => {
          if (m === "none") p.commit({ type: "resize", mode: "scale", factor: 1 });
          else if (m === "scale") p.commit({ type: "resize", mode: "scale", factor: 0.5 });
          else if (m === "fit") p.commit({ type: "resize", mode: "fit", max_side: Math.min(2048, Math.max(p.info.width, p.info.height)) });
          else p.commit({ type: "resize", mode: "exact", width: p.info.width, height: p.info.height });
        }}
        options={[
          { id: "none", label: "Keep original size" },
          { id: "scale", label: "Scale by percent" },
          { id: "fit", label: "Longest side (px)" },
          { id: "exact", label: "Exact width and height" },
        ]}
      />
      {mode === "scale" && <Slider label="Scale" value={Math.round((resize?.factor ?? 1) * 100)} min={5} max={200} unit="%" reset={100} onStart={p.begin} onEnd={p.end} onChange={(v) => p.live({ type: "resize", mode: "scale", factor: v / 100 })} />}
      {mode === "fit" && <TextField id="rs-fit" label="Longest side px" type="number" mono value={String(resize?.max_side ?? "")} onChange={(v) => Number(v) >= 16 && p.commit({ type: "resize", mode: "fit", max_side: Number(v) })} />}
      {mode === "exact" && (
        <div className="row3">
          <TextField id="rs-w" label="Width px" type="number" mono value={String(resize?.width ?? "")} onChange={(v) => Number(v) >= 1 && p.commit({ type: "resize", mode: "exact", width: Number(v), height: resize?.height ?? p.info.height })} />
          <TextField id="rs-h" label="Height px" type="number" mono value={String(resize?.height ?? "")} onChange={(v) => Number(v) >= 1 && p.commit({ type: "resize", mode: "exact", width: resize?.width ?? p.info.width, height: Number(v) })} />
        </div>
      )}
      {p.resultSize && (
        <p className="hint">
          Result: {p.resultSize[0]} × {p.resultSize[1]} px
        </p>
      )}
      <hr />
      <SelectField
        id="sv-fmt"
        label="Format"
        value={fmt}
        onChange={setFmt}
        options={[
          { id: "jpeg", label: "JPEG" },
          { id: "png", label: "PNG (keeps transparency)" },
          { id: "webp", label: "WebP" },
          { id: "tiff", label: "TIFF" },
          { id: "bmp", label: "BMP" },
          { id: "pdf", label: "PDF (one page)" },
        ]}
      />
      {lossy && <Slider label="Quality" value={quality} min={40} max={100} onChange={setQuality} reset={92} />}
      {(fmt === "jpeg" || fmt === "bmp" || fmt === "pdf") && <ColorInput label="Background for transparent areas" value={background} onChange={setBackground} />}
      <CheckField label="Remove camera and location data" checked={strip} onChange={setStrip} hint={p.info.has_location ? "This photo contains GPS location data." : "Keeps date and camera details when unchecked."} />
      <RunBar label="Save a copy…" busyLabel="Saving…" onRun={saveCopy} task={task} />
      <hr />
      <h2>Apply to many photos</h2>
      <p className="hint">Uses the edits in the list for every photo you choose. Crops are relative, so they fit photos of any size.</p>
      <InputsField label="Photos or folders" items={batchIn} onChange={setBatchIn} filters={imageFilter} />
      <FolderField label="Save to folder" value={batchOut} onPick={setBatchOut} />
      <RunBar
        label="Apply to all"
        busyLabel="Working…"
        disabled={batchIn.length === 0 || !batchOut || p.edits.length === 0}
        task={batch}
        onRun={() => batch.run("/photo/batch", { inputs: batchIn, out_dir: batchOut, edits: p.edits, format: fmt === "pdf" ? "jpeg" : fmt, quality, strip_metadata: strip, background })}
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The editor                                                                                  */
/* ------------------------------------------------------------------------------------------ */

type Presets = Record<string, Op[]>;

export function PhotoEditor({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [past, setPast] = useState<Item[][]>([]);
  const [future, setFuture] = useState<Item[][]>([]);
  const [tab, setTab] = useState<Tab>("crop");
  const [compare, setCompare] = useState(false);
  const [draft, setDraft] = useState<Op | null>(null);
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [fonts, setFonts] = useState<{ fonts: string[]; filters: string[] }>({ fonts: ["Arial"], filters: [] });
  const [presets, setPresets] = useState<Presets>({});
  const [presetName, setPresetName] = useState("");
  const [loadError, setLoadError] = useState("");
  const idc = useRef(1);
  const gesture = useRef(false);
  const nextId = useCallback(() => idc.current++, []);

  useEffect(() => {
    get<{ fonts: string[]; filters: string[] }>("/photo/fonts").then(setFonts).catch(() => undefined);
    get<Record<string, unknown>>("/settings").then((s) => setPresets((s.photo_presets as Presets) ?? {})).catch(() => undefined);
  }, []);

  async function choose() {
    const picked = await open({ multiple: false, filters: imageFilter });
    if (typeof picked !== "string") return;
    try {
      const i = await post<Info>("/photo/info", { input: picked });
      setInfo(i);
      setFile(picked);
      setItems([]);
      setPast([]);
      setFuture([]);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  const record = () => {
    setPast((p) => [...p.slice(-49), items]);
    setFuture([]);
  };
  const apply = useCallback((cur: Item[], op: Op) => (op._off ? cur.filter((i) => i.type !== op.type) : put(cur, op, nextId)), [nextId]);
  const commit = (op: Op) => {
    record();
    setItems((cur) => apply(cur, op));
  };
  const live = (op: Op) => setItems((cur) => apply(cur, op));
  const begin = () => {
    if (!gesture.current) {
      gesture.current = true;
      record();
    }
  };
  const end = () => {
    gesture.current = false;
  };
  const undo = useCallback(() => {
    if (!past.length) return;
    setFuture((f) => [...f, items]);
    setItems(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  }, [past, items]);
  const redo = useCallback(() => {
    if (!future.length) return;
    setPast((p) => [...p, items]);
    setItems(future[future.length - 1]);
    setFuture((f) => f.slice(0, -1));
  }, [future, items]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const edits = useMemo(() => pipeline(draft ? [...items, { ...draft, id: -1 }] : items), [items, draft]);
  const saved = useMemo(() => pipeline(items), [items]);
  const pv = usePhotoPreview(file, compare ? [] : edits);
  const size = pv.data ? { w: pv.data.width, h: pv.data.height } : null;

  async function savePreset() {
    const name = presetName.trim();
    if (!name || !saved.length) return;
    const next = { ...presets, [name]: saved };
    await putSetting("/settings/photo_presets", { value: next });
    setPresets(next);
    setPresetName("");
  }
  async function removePreset(name: string) {
    const { [name]: _gone, ...rest } = presets;
    void _gone;
    await putSetting("/settings/photo_presets", { value: rest });
    setPresets(rest);
  }
  const usePreset = (ops: Op[]) => {
    record();
    setItems((cur) => ops.reduce((acc, op) => apply(acc, op), cur));
  };

  if (!file || !info) {
    return (
      <div className="photo empty">
        <h1>Photo editor</h1>
        <p className="muted">Crop, straighten, adjust light and color, add filters, blur faces or number plates, add text and drawings, then save a copy. Your original is never changed.</p>
        <div className="actions">
          <button className="primary" onClick={choose}>
            Open a photo…
          </button>
        </div>
        {loadError && <p className="msg bad">{loadError}</p>}
      </div>
    );
  }

  const panel: Panel = { file, info, items, canvas, size, commit, live, begin, end, setDraft, fonts: fonts.fonts, filters: fonts.filters };
  const shown = pv.data;

  return (
    <div className="photo">
      <div className="phototop">
        <button onClick={choose}>Open another…</button>
        <span className="chip" title={file}>
          <b>{baseName(file)}</b>
          <span className="mono note">
            {info.width}×{info.height} · {info.megapixels} MP · {formatBytes(info.size_bytes)}
            {info.camera ? ` · ${info.camera}` : ""}
            {info.has_location ? " · has location" : ""}
          </span>
        </span>
        <span className="spacer" />
        <button className="icon" aria-label="Undo" disabled={!past.length} onClick={undo}>
          <Undo2 size={16} strokeWidth={1.5} />
        </button>
        <button className="icon" aria-label="Redo" disabled={!future.length} onClick={redo}>
          <Redo2 size={16} strokeWidth={1.5} />
        </button>
        <button
          className={compare ? "on" : ""}
          aria-pressed={compare}
          onPointerDown={() => setCompare(true)}
          onPointerUp={() => setCompare(false)}
          onPointerLeave={() => setCompare(false)}
        >
          <Eye size={15} strokeWidth={1.5} /> Hold to compare
        </button>
      </div>

      <div className="photomain">
        <div className="photostage">
          <div className="photocanvas" ref={setCanvas}>
            {shown ? <img src={`data:${shown.mime};base64,${shown.image}`} alt="Photo preview" draggable={false} className={pv.loading ? "loading" : ""} /> : <p className="muted pad">Loading…</p>}
          </div>
          {pv.error && <p className="msg bad stage-error">{pv.error}</p>}
        </div>

        <aside className="photoside">
          <div className="phototabs" role="tablist" aria-label="Photo tools">
            {TABS.map(({ id, label, Icon }) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                <Icon size={15} strokeWidth={1.5} aria-hidden />
                {label}
              </button>
            ))}
          </div>
          <div className="tabpanel" key={tab}>
            {tab === "crop" && <CropPanel {...panel} />}
            {tab === "adjust" && <AdjustPanel {...panel} />}
            {tab === "filters" && <FiltersPanel {...panel} />}
            {tab === "blur" && <BlurPanel {...panel} />}
            {tab === "text" && <TextPanel {...panel} />}
            {tab === "draw" && <DrawPanel {...panel} />}
            {tab === "frame" && <FramePanel {...panel} />}
            {tab === "export" && <SavePanel {...panel} edits={saved} resultSize={shown?.result_size ?? null} onDone={onDone} />}
          </div>

          <div className="changes">
            <h2>Edits ({items.length})</h2>
            {items.length === 0 ? (
              <p className="muted">Nothing changed yet.</p>
            ) : (
              <ol className="editlist">
                {items.map((it) => (
                  <li key={it.id}>
                    <span>{describe(it)}</span>
                    <button className="icon text" aria-label={`Remove: ${describe(it)}`} onClick={() => { record(); setItems((cur) => cur.filter((i) => i.id !== it.id)); }}>
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <div className="actions tight">
              <button disabled={!items.length} onClick={() => { record(); setItems([]); }}>
                Reset all
              </button>
            </div>
            <h2>Presets</h2>
            <p className="hint">Save the current edits to reuse them on other photos.</p>
            <div className="inline">
              <input aria-label="Preset name" placeholder="Name" value={presetName} onChange={(e) => setPresetName(e.target.value)} />
              <button disabled={!presetName.trim() || !saved.length} onClick={savePreset}>
                Save
              </button>
            </div>
            <ul className="presetlist">
              {Object.entries(presets).map(([name, ops]) => (
                <li key={name}>
                  <span>{name}</span>
                  <button className="icon text" onClick={() => usePreset(ops)}>
                    Apply
                  </button>
                  <button className="icon text" onClick={() => removePreset(name)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

