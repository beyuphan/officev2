import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  Crop,
  Download,
  Droplet,
  Eye,
  FlipHorizontal2,
  FlipVertical2,
  Frame,
  ListChecks,
  Redo2,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { get, post, put as putSetting } from "../api";
import { CheckField, FolderField, InputsField, RunBar, SelectField, TextField, baseName, formatBytes, imageFilter, useTask } from "../shared";
import { ColorInput, CropBox, Slider, usePhotoPreview } from "../photoui";
import { ALL_PTOOLS, ObjectLayer, PHOTO_GROUPS, PhotoBar, makeDefs, type Defs, type PTool } from "./photoobjects";
import { ADJUST_KEYS, aspectRect, current, describe, isObject, ordered, pipeline, put, type Item, type Op } from "../lib/photoOps";
import { normAspect, type Rect } from "../lib/crop";

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
/* Blur the whole photo, or tilt-shift. (Blur over one area is a placed object, see the Blur tool.) */
/* ------------------------------------------------------------------------------------------ */

function BlurPanel(p: Panel) {
  const [kind, setKind] = useState("tiltshift");
  const [radius, setRadius] = useState(Math.max(8, Math.round(p.info.width / 120)));
  const [angle, setAngle] = useState(0);
  const [band, setBand] = useState(0.18);
  const [center, setCenter] = useState(0.5);
  const tilt = kind === "tiltshift";
  const maxR = Math.max(60, Math.round(p.info.width / 20));

  const op = useMemo<Op>(() => {
    const base: Op = { type: "blur", kind, radius };
    if (tilt) return { ...base, band, center };
    if (kind === "motion") base.angle = angle;
    return base;
  }, [kind, radius, band, center, angle, tilt]);

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
          { id: "tiltshift", label: "Tilt-shift (miniature)" },
          { id: "gaussian", label: "Blur the whole photo" },
          { id: "box", label: "Soft box blur" },
          { id: "motion", label: "Motion blur" },
          { id: "pixelate", label: "Pixelate the whole photo" },
        ]}
      />
      <Slider label={kind === "pixelate" ? "Block size" : "Strength"} value={radius} min={1} max={maxR} onChange={setRadius} reset={12} />
      {kind === "motion" && <Slider label="Direction" value={angle} min={-90} max={90} unit="°" onChange={setAngle} />}
      {tilt && (
        <>
          <Slider label="Sharp band" value={band} min={0.03} max={0.6} step={0.01} onChange={setBand} reset={0.18} />
          <Slider label="Band position" value={center} min={0} max={1} step={0.01} onChange={setCenter} reset={0.5} />
        </>
      )}
      <div className="actions tight">
        <button className="primary" onClick={() => p.commit(op)}>
          Apply
        </button>
      </div>
      <p className="hint">To hide a face or a number plate, use the Blur area tool on the left and drag over it.</p>
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Frame: border, rounded corners, background                                                  */
/* ------------------------------------------------------------------------------------------ */

function FramePanel(p: Panel) {
  const border = current<Op & { width: number; color: string }>(p.items, "border");
  const rounded = current<Op & { radius: number }>(p.items, "rounded");
  const [borderColor, setBorderColor] = useState("#ffffff");
  const bg = current<Op>(p.items, "remove_background");

  return (
    <>
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
type SectionId = "crop" | "adjust" | "filters" | "blur" | "frame" | "save" | "edits";

const SECTIONS: { id: SectionId; label: string; sub: string; Icon: LucideIcon }[] = [
  { id: "crop", label: "Crop and rotate", sub: "Crop, straighten, rotate, flip", Icon: Crop },
  { id: "adjust", label: "Light and color", sub: "Brightness, contrast, warmth…", Icon: SlidersHorizontal },
  { id: "filters", label: "Filters and looks", sub: "Filters, vignette, film grain", Icon: Sparkles },
  { id: "blur", label: "Blur the whole photo", sub: "Tilt-shift, motion blur", Icon: Droplet },
  { id: "frame", label: "Border and background", sub: "Border, round corners, cut-out", Icon: Frame },
  { id: "save", label: "Size and save", sub: "Resize, format, batch", Icon: Download },
  { id: "edits", label: "All edits and presets", sub: "Remove a step, reuse a look", Icon: ListChecks },
];

export function PhotoEditor({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [past, setPast] = useState<Item[][]>([]);
  const [future, setFuture] = useState<Item[][]>([]);
  const [section, setSection] = useState<SectionId | null>("adjust");
  const [tool, setTool] = useState<PTool>("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [compare, setCompare] = useState(false);
  const [draft, setDraft] = useState<Op | null>(null);
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [fonts, setFonts] = useState<{ fonts: string[]; filters: string[] }>({ fonts: ["Arial"], filters: [] });
  const [presets, setPresets] = useState<Presets>({});
  const [presetName, setPresetName] = useState("");
  const [loadError, setLoadError] = useState("");
  const [logo, setLogo] = useState<string | null>(null);
  const [defs, setDefs] = useState<Defs>(() => makeDefs(3000));
  const idc = useRef(1);
  const gestureOpen = useRef(false);
  const gestureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingBase = useRef<Item[] | null>(null);
  const clip = useRef<Item | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
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
      setDefs((d) => ({ ...makeDefs(i.width), font: d.font }));
      setFile(picked);
      setItems([]);
      setPast([]);
      setFuture([]);
      setSelected(null);
      setEditing(null);
      setTool("select");
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  /* ---- history ---- */
  const record = () => {
    setPast((p) => [...p.slice(-59), itemsRef.current]);
    setFuture([]);
  };
  /** One undo step for a burst of changes (a drag, a slider). */
  const touch = () => {
    if (!gestureOpen.current) {
      gestureOpen.current = true;
      record();
    }
    clearTimeout(gestureTimer.current);
    gestureTimer.current = setTimeout(() => (gestureOpen.current = false), 700);
  };
  const apply = useCallback((cur: Item[], op: Op) => (op._off ? cur.filter((i) => i.type !== op.type) : put(cur, op, nextId)), [nextId]);
  const commit = (op: Op) => {
    record();
    setItems((cur) => apply(cur, op));
  };
  const live = (op: Op) => setItems((cur) => apply(cur, op));
  const begin = () => {
    gestureOpen.current = false;
    touch();
    clearTimeout(gestureTimer.current); // stays open until end()
  };
  const end = () => {
    gestureOpen.current = false;
  };
  const undo = useCallback(() => {
    if (!past.length) return;
    setFuture((f) => [...f, items]);
    setItems(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    setEditing(null);
  }, [past, items]);
  const redo = useCallback(() => {
    if (!future.length) return;
    setPast((p) => [...p, items]);
    setItems(future[future.length - 1]);
    setFuture((f) => f.slice(0, -1));
    setEditing(null);
  }, [future, items]);

  /* ---- placed objects ---- */
  const patchItem = (id: number, change: Partial<Op>) =>
    setItems((cur) =>
      cur.map((i) => {
        if (i.id !== id) return i;
        const next = { ...i, ...change } as Item;
        Object.keys(change).forEach((k) => change[k] === undefined && delete next[k]);
        return next;
      }),
    );

  function place(op: Op, opts: { edit?: boolean; keepTool?: boolean } = {}) {
    let o = op;
    if (o.type === "overlay" && !o.path) {
      if (!logo) return;
      o = { ...o, path: logo };
    }
    const item = { ...o, id: nextId() } as Item;
    if (opts.edit) pendingBase.current = itemsRef.current;
    else record();
    setItems((cur) => [...cur, item]);
    setSelected(item.id);
    if (opts.edit) setEditing(item.id);
    if (!opts.keepTool) {
      setTool("select");
    }
    if (opts.keepTool) setSelected(null);
  }

  const commitText = (id: number) => {
    setEditing((e) => (e === id ? null : e));
    const it = itemsRef.current.find((x) => x.id === id);
    if (!it) return;
    if (it.type === "text" && !String(it.text ?? "").trim()) {
      setItems((cur) => cur.filter((x) => x.id !== id));
      setSelected((s) => (s === id ? null : s));
      pendingBase.current = null;
    } else if (pendingBase.current) {
      const base = pendingBase.current;
      pendingBase.current = null;
      setPast((p) => [...p.slice(-59), base]);
      setFuture([]);
    }
  };
  const removeItem = (id: number) => {
    record();
    setItems((cur) => cur.filter((i) => i.id !== id));
    setSelected((s) => (s === id ? null : s));
    setEditing((s) => (s === id ? null : s));
  };
  const duplicate = (it: Item) => {
    const { id: _id, ...rest } = it;
    void _id;
    const moved = { ...rest, ...nudge(it, 0.03, 0.03) } as Op;
    record();
    const item = { ...moved, id: nextId() } as Item;
    setItems((cur) => [...cur, item]);
    setSelected(item.id);
    setTool("select");
  };

  async function pickLogo(replaceSelected: boolean): Promise<void> {
    const picked = await open({ multiple: false, filters: imageFilter });
    if (typeof picked !== "string") {
      if (!logo) setTool("select");
      return;
    }
    setLogo(picked);
    if (replaceSelected && selected !== null) {
      touch();
      patchItem(selected, { path: picked });
    }
  }

  function pickTool(t: PTool) {
    if (editing !== null) commitText(editing);
    setTool(t);
    setSelected(null);
    setEditing(null);
    if (section === "crop") setSection(null);
    if (t === "image") void pickLogo(false);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const sel = itemsRef.current.find((i) => i.id === selected);
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        redo();
      } else if (mod && k === "d" && sel) {
        e.preventDefault();
        duplicate(sel);
      } else if (mod && k === "c" && sel) {
        clip.current = sel;
      } else if (mod && k === "v" && clip.current) {
        e.preventDefault();
        duplicate(clip.current);
      } else if ((k === "delete" || k === "backspace") && sel) {
        e.preventDefault();
        removeItem(sel.id);
      } else if (k === "enter" && sel?.type === "text") {
        e.preventDefault();
        setEditing(sel.id);
      } else if (k === "escape") {
        setSelected(null);
        setTool("select");
      } else if (sel && k.startsWith("arrow")) {
        e.preventDefault();
        const s = e.shiftKey ? 0.02 : 0.002;
        const d = { arrowleft: [-s, 0], arrowright: [s, 0], arrowup: [0, -s], arrowdown: [0, s] }[k]!;
        touch();
        patchItem(sel.id, nudge(sel, d[0], d[1]));
      } else if (!mod && !e.altKey && section !== "crop") {
        const t = ALL_PTOOLS.find((x) => x.key && x.key.toLowerCase() === k);
        if (t) pickTool(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo, selected, editing, section, logo]);

  /* ---- what the engine draws ---- */
  const shownItems = useMemo(() => ordered(editing !== null ? items.filter((i) => i.id !== editing) : items), [items, editing]);
  const sent = useMemo(() => (draft ? [...shownItems, { ...draft, id: -1 } as Item] : shownItems), [shownItems, draft]);
  const edits = useMemo(() => sent.map(({ id: _id, ...op }) => (void _id, op as Op)), [sent]);
  const saved = useMemo(() => pipeline(items), [items]);
  const ids = useMemo(() => sent.map((i) => i.id), [sent]);
  const pv = usePhotoPreview(file, compare ? [] : edits, 80, ids);
  const shown = pv.data;
  const size = shown ? { w: shown.width, h: shown.height } : null;
  const sizes = useMemo(() => {
    const m = new Map<number, { w: number; h: number }>();
    if (!shown?.boxes || compare) return m;
    shown.boxes.forEach((b) => {
      const id = pv.tag?.[b.index];
      if (id !== undefined && id >= 0) m.set(id, { w: b.rect[2] - b.rect[0], h: b.rect[3] - b.rect[1] });
    });
    return m;
  }, [shown, pv.tag, compare]);
  const basis = { w: shown?.result_size[0] ?? info?.width ?? 1000, h: shown?.result_size[1] ?? info?.height ?? 1000 };

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
        <p className="muted">Crop, straighten, adjust light and color, add filters, blur faces or number plates, add text and drawings, then save a copy. Click anything you placed to change it. Your original is never changed.</p>
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
  const sel = items.find((i) => i.id === selected) ?? null;
  const objectsOn = section !== "crop" && !compare;
  const active = ALL_PTOOLS.find((t) => t.id === tool)!;
  const toggle = (id: SectionId) => {
    setSection((s) => (s === id ? null : id));
    if (id === "crop") {
      setSelected(null);
      setEditing(null);
      setTool("select");
    }
  };

  return (
    <div className="photo">
      <div className="phototop">
        <span className="chip" title={file}>
          <b>{baseName(file)}</b>
          <span className="mono note">
            {info.width}×{info.height} · {info.megapixels} MP · {formatBytes(info.size_bytes)}
            {info.camera ? ` · ${info.camera}` : ""}
            {info.has_location ? " · has location" : ""}
          </span>
        </span>
        <span className="spacer" />
        <button className="icon" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}>
          <Undo2 size={16} strokeWidth={1.5} />
        </button>
        <button className="icon" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!future.length} onClick={redo}>
          <Redo2 size={16} strokeWidth={1.5} />
        </button>
        <button className={compare ? "on" : ""} aria-pressed={compare} onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerLeave={() => setCompare(false)}>
          <Eye size={15} strokeWidth={1.5} /> Hold to compare
        </button>
        <button onClick={choose}>Open another…</button>
        <button className="primary" onClick={() => setSection("save")}>
          Save…
        </button>
      </div>

      <PhotoBar
        tool={tool}
        hint={section === "crop" ? "Drag the frame on the photo, then press Apply crop." : active.hint}
        sel={objectsOn ? sel : null}
        defs={defs}
        setDefs={setDefs}
        fonts={fonts.fonts}
        maxSide={Math.max(info.width, info.height)}
        hasImage={Boolean(logo)}
        patch={patchItem}
        touch={touch}
        onDelete={() => sel && removeItem(sel.id)}
        onDuplicate={() => sel && duplicate(sel)}
        onPickImage={() => pickLogo(true)}
      />

      <div className="photomain">
        <nav className="toolrail" aria-label="Photo tools">
          {PHOTO_GROUPS.map((g) => (
            <div key={g.title || "select"} className="toolgroup" role="group" aria-label={g.title || "Select"}>
              {g.title && <span className="grouptitle">{g.title}</span>}
              {g.tools.map(({ id, label, Icon, key }) => (
                <button key={id} className={tool === id && section !== "crop" ? "on" : ""} aria-pressed={tool === id} aria-label={label} title={key ? `${label} (${key})` : label} onClick={() => pickTool(id)}>
                  <Icon size={17} strokeWidth={1.5} aria-hidden />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="photostage">
          <div className="photocanvas" ref={setCanvas} style={shown ? ({ aspectRatio: `${shown.width} / ${shown.height}`, ["--ar" as string]: shown.width / shown.height } as React.CSSProperties) : undefined}>
            {shown ? <img src={`data:${shown.mime};base64,${shown.image}`} alt="Photo preview" draggable={false} className={pv.loading ? "loading" : ""} /> : <p className="muted pad">Loading…</p>}
            {objectsOn && shown && (
              <ObjectLayer
                items={items}
                itemsRef={itemsRef}
                selected={selected}
                editing={editing}
                tool={tool}
                sizes={sizes}
                basis={basis}
                defs={defs}
                hasImage={Boolean(logo)}
                onSelect={setSelected}
                onEdit={setEditing}
                patch={patchItem}
                touch={touch}
                place={place}
                onText={(id, text) => {
                  touch();
                  patchItem(id, { text });
                }}
                onCommit={commitText}
              />
            )}
          </div>
          {pv.error && <p className="msg bad stage-error">{pv.error}</p>}
        </div>

        <aside className="photoside" aria-label="Whole-photo tools">
          {SECTIONS.map(({ id, label, sub, Icon }) => (
            <section key={id} className={`acc${section === id ? " open" : ""}`}>
              <button className="acchead" aria-expanded={section === id} onClick={() => toggle(id)}>
                <Icon size={16} strokeWidth={1.5} aria-hidden />
                <span className="acctext">
                  <b>{label}</b>
                  <small>{sub}</small>
                </span>
                <ChevronDown size={15} strokeWidth={1.5} aria-hidden className="accchev" />
              </button>
              {section === id && (
                <div className="accbody">
                  {id === "crop" && <CropPanel {...panel} />}
                  {id === "adjust" && <AdjustPanel {...panel} />}
                  {id === "filters" && <FiltersPanel {...panel} />}
                  {id === "blur" && <BlurPanel {...panel} />}
                  {id === "frame" && <FramePanel {...panel} />}
                  {id === "save" && <SavePanel {...panel} edits={saved} resultSize={shown?.result_size ?? null} onDone={onDone} />}
                  {id === "edits" && (
                    <>
                      <h2>Edits ({items.length})</h2>
                      {items.length === 0 ? (
                        <p className="muted">Nothing changed yet.</p>
                      ) : (
                        <ol className="editlist">
                          {items.map((it) => (
                            <li key={it.id} className={it.id === selected ? "sel" : ""}>
                              <button className="rowbtn" onClick={() => isObject(it) && (setSelected(it.id), setTool("select"))}>
                                {describe(it)}
                              </button>
                              <button className="icon text" aria-label={`Remove: ${describe(it)}`} onClick={() => removeItem(it.id)}>
                                Remove
                              </button>
                            </li>
                          ))}
                        </ol>
                      )}
                      <div className="actions tight">
                        <button disabled={!items.length} onClick={() => { record(); setItems([]); setSelected(null); }}>
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
                    </>
                  )}
                </div>
              )}
            </section>
          ))}
        </aside>
      </div>
    </div>
  );
}

/** The same object moved by a fraction of the picture. */
function nudge(it: Item, dx: number, dy: number): Partial<Op> {
  if (it.type === "blur" && it.area) {
    const a = it.area as { x: number; y: number };
    return { area: { ...(it.area as object), x: a.x + dx, y: a.y + dy } };
  }
  if (it.type === "shape" && Array.isArray(it.points)) return { points: (it.points as number[][]).map(([x, y]) => [x + dx, y + dy]) };
  return { x: Number(it.x ?? 0) + dx, y: Number(it.y ?? 0) + dy };
}
