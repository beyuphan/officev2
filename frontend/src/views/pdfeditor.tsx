import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Circle,
  Eraser,
  EyeOff,
  Highlighter,
  ImagePlus,
  Link2,
  Minus,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Redo2,
  Square,
  StickyNote,
  Strikethrough,
  Type as TypeIcon,
  Underline,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { CheckField, RunBar, SelectField, SourceField, baseName, imageFilter, pdfFilter, useTask } from "../shared";
import { PageNav, thumbSrc, useRendered, useThumbs, type PageData } from "../pdfview";
import { ColorInput, Slider } from "../photoui";
import { describe, groupByPage, hitTest, normalizeRect, pagesWithEdits, simplify, translate, type PdfItem, type PdfOp, type Pt } from "../lib/pdfOps";
import { get } from "../api";

type Tool = "select" | "text" | "image" | "highlight" | "underline" | "strike" | "rect" | "ellipse" | "line" | "arrow" | "pen" | "note" | "link" | "erase" | "redact";

const TOOLS: { id: Tool; label: string; Icon: LucideIcon; hint: string }[] = [
  { id: "select", label: "Select", Icon: MousePointer2, hint: "Click an edit to select it, drag to move it, press Delete to remove it." },
  { id: "text", label: "Text", Icon: TypeIcon, hint: "Click where the text should start, or drag a box to wrap it." },
  { id: "image", label: "Image", Icon: ImagePlus, hint: "Choose a picture (a logo or a signature), then click or drag on the page." },
  { id: "highlight", label: "Highlight", Icon: Highlighter, hint: "Drag over the words to highlight." },
  { id: "underline", label: "Underline", Icon: Underline, hint: "Drag over the words to underline." },
  { id: "strike", label: "Strike", Icon: Strikethrough, hint: "Drag over the words to strike through." },
  { id: "rect", label: "Box", Icon: Square, hint: "Drag to draw a rectangle." },
  { id: "ellipse", label: "Oval", Icon: Circle, hint: "Drag to draw an oval." },
  { id: "line", label: "Line", Icon: Minus, hint: "Drag to draw a line." },
  { id: "arrow", label: "Arrow", Icon: MoveUpRight, hint: "Drag to draw an arrow." },
  { id: "pen", label: "Pen", Icon: PenLine, hint: "Draw freehand, for example a signature." },
  { id: "note", label: "Note", Icon: StickyNote, hint: "Click to leave a comment note." },
  { id: "link", label: "Link", Icon: Link2, hint: "Drag over an area, then enter a web address or a page number." },
  { id: "erase", label: "Erase", Icon: Eraser, hint: "Drag over content to remove it and leave white." },
  { id: "redact", label: "Redact", Icon: EyeOff, hint: "Drag over content to remove it permanently under a black box." },
];

const DEFAULT_COLOR: Partial<Record<Tool, string>> = { highlight: "#ffe600", underline: "#1a7f37", strike: "#d4472b", text: "#111111", note: "#ffcc00", rect: "#d4472b", ellipse: "#d4472b", line: "#d4472b", arrow: "#d4472b", pen: "#1b1f24" };

const STAMPS = [
  { text: "APPROVED", color: "#1a7f37" },
  { text: "DRAFT", color: "#8a6d00" },
  { text: "CONFIDENTIAL", color: "#c42b1c" },
  { text: "PAID", color: "#1a7f37" },
  { text: "REVIEWED", color: "#1d4ed8" },
];

type Prompt = { kind: "text" | "note" | "link"; at: Pt; box?: { x0: number; y0: number; x1: number; y1: number } };
type Drag =
  | { kind: "draw"; a: Pt; b: Pt; path: Pt[]; moved: boolean }
  | { kind: "move"; id: number; last: Pt; moved: boolean };

export function PdfEditor({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [ops, setOps] = useState<PdfItem[]>([]);
  const [past, setPast] = useState<PdfItem[][]>([]);
  const [future, setFuture] = useState<PdfItem[][]>([]);
  const [page, setPage] = useState(1);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [ghost, setGhost] = useState<Drag | null>(null);
  const [flatten, setFlatten] = useState(false);
  const [message, setMessage] = useState("");
  const idc = useRef(1);
  const gesture = useRef(false);

  // tool options
  const [color, setColor] = useState("#d4472b");
  const [width, setWidth] = useState(2);
  const [fill, setFill] = useState(false);
  const [fillColor, setFillColor] = useState("#fff3a3");
  const [opacity, setOpacity] = useState(1);
  const [font, setFont] = useState("Arial");
  const [size, setSize] = useState(14);
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [stamp, setStamp] = useState<(typeof STAMPS)[number] | null>(null);
  const [fonts, setFonts] = useState<string[]>(["Arial"]);

  const task = useTask(onDone);
  const { thumbs, total } = useThumbs(file, 96);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    get<{ fonts: string[] }>("/photo/fonts").then((r) => setFonts(r.fonts)).catch(() => undefined);
  }, []);

  const body = useMemo(
    () => (file ? { input: file, page, width: 1000, ops: ops.map(({ id: _id, ...o }) => (void _id, o)) } : null),
    [file, page, ops],
  );
  const { data: fresh, loading, error } = useRendered("/pdf/edit/preview", body, 150);
  const lastData = useRef<PageData | null>(null);
  if (fresh) lastData.current = fresh;
  const data = fresh ?? lastData.current;
  const boxes = data?.boxes ?? [];

  const changedPages = useMemo(() => pagesWithEdits(ops), [ops]);
  const sel = ops.find((o) => o.id === selected) ?? null;

  /* ---- history ---- */
  const record = () => {
    setPast((p) => [...p.slice(-49), ops]);
    setFuture([]);
  };
  const add = (op: PdfOp) => {
    record();
    const item: PdfItem = { ...op, id: idc.current++ };
    setOps((cur) => [...cur, item]);
    setSelected(item.id);
  };
  const remove = (id: number) => {
    record();
    setOps((cur) => cur.filter((o) => o.id !== id));
    setSelected((s) => (s === id ? null : s));
  };
  const begin = () => {
    if (!gesture.current) {
      gesture.current = true;
      record();
    }
  };
  const end = () => {
    gesture.current = false;
  };
  const patch = (id: number, change: Partial<PdfOp>) => setOps((cur) => cur.map((o) => (o.id === id ? { ...o, ...change } : o)));
  const undo = useCallback(() => {
    if (!past.length) return;
    setFuture((f) => [...f, ops]);
    setOps(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
  }, [past, ops]);
  const redo = useCallback(() => {
    if (!future.length) return;
    setPast((p) => [...p, ops]);
    setOps(future[future.length - 1]);
    setFuture((f) => f.slice(0, -1));
  }, [future, ops]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected !== null) {
        e.preventDefault();
        remove(selected);
      } else if (e.key === "Escape") {
        setSelected(null);
        setPrompt(null);
        setStamp(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo, selected, ops]);

  async function choose() {
    const picked = await open({ multiple: false, filters: pdfFilter });
    if (typeof picked !== "string") return;
    setFile(picked);
    setOps([]);
    setPast([]);
    setFuture([]);
    setPage(1);
    setSelected(null);
    setMessage("");
  }

  function pickTool(t: Tool) {
    setTool(t);
    setPrompt(null);
    setStamp(null);
    if (DEFAULT_COLOR[t]) setColor(DEFAULT_COLOR[t]!);
    if (t === "highlight") setOpacity(0.5);
    else if (["underline", "strike"].includes(t)) setOpacity(1);
  }

  /* ---- pointer handling on the page ---- */
  const toPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * data!.page_width, y: ((e.clientY - r.top) / r.height) * data!.page_height };
  };

  function finish(d: Drag & { kind: "draw" }) {
    const { a, b, path, moved } = d;
    const r = normalizeRect(a, b);
    const big = r.x1 - r.x0 > 4 && r.y1 - r.y0 > 4;
    const base = { page };
    switch (tool) {
      case "text":
        if (stamp && !moved) {
          add({ ...base, type: "text", x: a.x - 40, y: a.y - 10, text: stamp.text, size: 28, bold: true, color: stamp.color, border: stamp.color, background: "#ffffff", opacity: 0.9, rotate: -12, font });
          return;
        }
        setPrompt({ kind: "text", at: a, box: moved && big ? r : undefined });
        return;
      case "note":
        setPrompt({ kind: "note", at: a });
        return;
      case "link":
        if (big) setPrompt({ kind: "link", at: { x: r.x0, y: r.y0 }, box: r });
        return;
      case "image":
        if (!image) return setMessage("Choose an image first (options on the right).");
        add({ ...base, type: "image", path: image, x0: moved && big ? r.x0 : a.x, y0: moved && big ? r.y0 : a.y, ...(moved && big ? { w: r.x1 - r.x0 } : { w: 160 }), opacity });
        return;
      case "highlight":
      case "underline":
      case "strike":
        if (big) add({ ...base, type: tool, ...r, color, opacity });
        return;
      case "rect":
      case "ellipse":
        if (big) add({ ...base, type: tool, ...r, color, width, opacity, ...(fill ? { fill: fillColor } : {}) });
        return;
      case "erase":
      case "redact":
        if (big) add({ ...base, type: tool, ...r });
        return;
      case "line":
      case "arrow":
        if (moved) add({ ...base, type: tool, x0: a.x, y0: a.y, x1: b.x, y1: b.y, color, width, opacity });
        return;
      case "pen":
        if (moved) add({ ...base, type: "ink", strokes: [simplify(path).map((p) => [p.x, p.y])], color, width, opacity });
        return;
    }
  }

  function onDown(e: React.PointerEvent) {
    if (e.button !== 0 || !data || prompt) return;
    const p = toPt(e);
    if (tool === "select") {
      const hit = hitTest(boxes, p);
      if (hit >= 0) {
        const item = ops[hit];
        setSelected(item.id);
        e.currentTarget.setPointerCapture(e.pointerId);
        setGhost({ kind: "move", id: item.id, last: p, moved: false });
        return;
      }
      setSelected(null);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setGhost({ kind: "draw", a: p, b: p, path: [p], moved: false });
  }
  function onMove(e: React.PointerEvent) {
    if (!ghost || !data) return;
    const p = toPt(e);
    if (ghost.kind === "move") {
      const dx = p.x - ghost.last.x, dy = p.y - ghost.last.y;
      if (!ghost.moved && Math.hypot(dx, dy) < 2) return;
      if (!ghost.moved) record();
      patch(ghost.id, translate(ops.find((o) => o.id === ghost.id)!, dx, dy));
      setGhost({ ...ghost, last: p, moved: true });
      return;
    }
    const moved = ghost.moved || Math.hypot(p.x - ghost.a.x, p.y - ghost.a.y) > 3;
    setGhost({ ...ghost, b: p, moved, path: tool === "pen" ? [...ghost.path, p] : ghost.path });
  }
  function onUp() {
    const g = ghost;
    setGhost(null);
    if (g?.kind === "draw") finish(g);
  }

  function submitPrompt(text: string) {
    const pr = prompt;
    setPrompt(null);
    if (!pr || !text.trim()) return;
    if (pr.kind === "text") {
      add({ page, type: "text", x: pr.box ? pr.box.x0 : pr.at.x, y: pr.box ? pr.box.y0 : pr.at.y, text, size, font, bold, italic, color, opacity, ...(pr.box ? { width: pr.box.x1 - pr.box.x0 } : {}) });
    } else if (pr.kind === "note") {
      add({ page, type: "note", x: pr.at.x, y: pr.at.y, text, color });
    } else if (pr.box) {
      const t = text.trim();
      add({ page, type: "link", ...pr.box, ...(/^\d+$/.test(t) ? { target_page: Number(t) } : { uri: /^(https?:\/\/|mailto:)/.test(t) ? t : `https://${t}` }) });
    }
  }

  async function saveCopy() {
    if (!file) return;
    const output = await save({ filters: pdfFilter, defaultPath: baseName(file).replace(/\.pdf$/i, "") + "-edited.pdf" });
    if (output) await task.run("/pdf/edit", { input: file, output, ops: ops.map(({ id: _id, ...o }) => (void _id, o)), flatten });
  }

  if (!file) {
    return (
      <div className="photo empty">
        <h1>PDF editor</h1>
        <p className="muted">Add text, signatures and images, highlight, draw, leave notes, add links, erase or black out content. Every change is a step you can undo or remove. The original is never changed.</p>
        <div className="actions">
          <button className="primary" onClick={choose}>
            Open a PDF…
          </button>
        </div>
      </div>
    );
  }

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const active = TOOLS.find((t) => t.id === tool)!;
  const grouped = groupByPage(ops);
  const needsStroke = ["rect", "ellipse", "line", "arrow", "pen"].includes(tool);

  return (
    <div className="pdfedit">
      <div className="toolbar" role="toolbar" aria-label="Editing tools">
        {TOOLS.map(({ id, label, Icon }) => (
          <button key={id} className={tool === id ? "on" : ""} aria-pressed={tool === id} aria-label={label} title={label} onClick={() => pickTool(id)}>
            <Icon size={16} strokeWidth={1.5} aria-hidden />
            <span>{label}</span>
          </button>
        ))}
        <span className="spacer" />
        <button className="icon" aria-label="Undo" disabled={!past.length} onClick={undo}>
          <Undo2 size={16} strokeWidth={1.5} />
        </button>
        <button className="icon" aria-label="Redo" disabled={!future.length} onClick={redo}>
          <Redo2 size={16} strokeWidth={1.5} />
        </button>
        <button onClick={choose}>Open another…</button>
      </div>

      <div className="pdfmain">
        <div className="strip" aria-label="Pages">
          {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
            <button key={n} className={`${n === page ? "on" : ""}`} aria-label={`Page ${n}${changedPages.has(n) ? " (edited)" : ""}`} onClick={() => setPage(n)}>
              {thumbs.get(n) ? <img src={thumbSrc(thumbs.get(n)!)} alt="" draggable={false} /> : <span className="ph" />}
              <span className="mono">
                {n}
                {changedPages.has(n) && <i className="dot" />}
              </span>
            </button>
          ))}
        </div>

        <div className="pagecol">
          {data ? <PageNav page={page} total={data.total} onChange={setPage} /> : null}
          <p className="hint tool-hint">{active.hint}</p>
          {error && <p className="msg bad">{error}</p>}
          {data && (
            <div className={loading ? "preview loading" : "preview"}>
              <div
                ref={wrap}
                className={`page editable tool-${tool}`}
                style={{ aspectRatio: `${data.page_width} / ${data.page_height}`, ["--ar" as string]: data.page_width / data.page_height } as React.CSSProperties}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
              >
                <img src={`data:image/png;base64,${data.image}`} alt={`Page ${data.page}`} draggable={false} />
                <svg className="overlay" viewBox={`0 0 ${data.page_width} ${data.page_height}`} preserveAspectRatio="none" aria-hidden>
                  {boxes.map((b) => {
                    const isSel = ops[b.index]?.id === selected;
                    if (!isSel && tool !== "select") return null;
                    return <rect key={b.index} className={isSel ? "selbox" : "hoverbox"} x={b.rect[0]} y={b.rect[1]} width={b.rect[2] - b.rect[0]} height={b.rect[3] - b.rect[1]} />;
                  })}
                  {ghost?.kind === "draw" && ghost.moved && <Ghost tool={tool} g={ghost} color={color} />}
                </svg>
                {prompt && (
                  <PromptBox
                    key={`${prompt.kind}${prompt.at.x}${prompt.at.y}`}
                    prompt={prompt}
                    style={{ left: pct(Math.min(prompt.at.x, data.page_width - 230), data.page_width), top: pct(Math.min(prompt.at.y, data.page_height - 120), data.page_height) }}
                    onSubmit={submitPrompt}
                    onCancel={() => setPrompt(null)}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        <aside className="side pdfside">
          <section>
            <h2>{active.label}</h2>
            {(tool === "text" || tool === "note") && (
              <>
                {tool === "text" && (
                  <>
                    <SelectField id="pe-font" label="Font" value={font} onChange={setFont} options={fonts.map((f) => ({ id: f, label: f }))} />
                    <Slider label="Size" value={size} min={6} max={96} unit=" pt" reset={14} onChange={setSize} />
                    <div className="checks">
                      <CheckField label="Bold" checked={bold} onChange={setBold} />
                      <CheckField label="Italic" checked={italic} onChange={setItalic} />
                    </div>
                    <span className="label">Stamps</span>
                    <div className="stamps">
                      {STAMPS.map((s) => (
                        <button key={s.text} className={stamp?.text === s.text ? "on" : ""} aria-pressed={stamp?.text === s.text} style={stamp?.text === s.text ? { color: "#fff", background: s.color, borderColor: s.color } : { color: s.color, borderColor: s.color }} onClick={() => setStamp(stamp?.text === s.text ? null : s)}>
                          {s.text}
                        </button>
                      ))}
                    </div>
                    {stamp && <p className="hint">Click on the page to place the {stamp.text} stamp. Esc cancels.</p>}
                  </>
                )}
              </>
            )}
            {tool === "image" && (
              <>
                <SourceField label="Image or signature" file={image} onPick={setImage} filters={imageFilter} />
                <p className="hint">A PNG with a transparent background works best for signatures.</p>
              </>
            )}
            {tool !== "select" && !["erase", "redact", "link", "image"].includes(tool) && !stamp && <ColorInput label="Color" value={color} onChange={setColor} />}
            {needsStroke && <Slider label="Line width" value={width} min={1} max={20} unit=" pt" reset={2} onChange={setWidth} />}
            {(tool === "rect" || tool === "ellipse") && (
              <>
                <CheckField label="Fill" checked={fill} onChange={setFill} />
                {fill && <ColorInput label="Fill color" value={fillColor} onChange={setFillColor} />}
              </>
            )}
            {["text", "image", "highlight", "rect", "ellipse", "line", "arrow", "pen"].includes(tool) && <Slider label="Opacity" value={opacity} min={0.1} max={1} step={0.05} reset={1} onChange={setOpacity} />}
            {tool === "redact" && <p className="hint">Redaction removes the text and images underneath for good when you save.</p>}
          </section>

          {sel && sel.type === "text" && (
            <section>
              <h2>Selected text</h2>
              <div className="field">
                <textarea aria-label="Selected text" rows={2} value={String(sel.text ?? "")} onFocus={begin} onBlur={end} onChange={(e) => patch(sel.id, { text: e.target.value })} />
              </div>
              <Slider label="Size" value={Number(sel.size ?? 14)} min={6} max={96} unit=" pt" onStart={begin} onEnd={end} onChange={(v) => patch(sel.id, { size: v })} />
              <ColorInput label="Color" value={String(sel.color ?? "#111111")} onChange={(c) => patch(sel.id, { color: c })} />
              <Slider label="Rotate" value={Number(sel.rotate ?? 0)} min={-180} max={180} unit="°" onStart={begin} onEnd={end} onChange={(v) => patch(sel.id, { rotate: v })} />
            </section>
          )}
          {sel && sel.type !== "text" && ["rect", "ellipse", "line", "arrow", "ink", "highlight", "underline", "strike"].includes(sel.type) && (
            <section>
              <h2>Selected {describe(sel).toLowerCase()}</h2>
              <ColorInput label="Color" value={String(sel.color ?? "#d4472b")} onChange={(c) => patch(sel.id, { color: c })} />
              {["rect", "ellipse", "line", "arrow", "ink"].includes(sel.type) && (
                <Slider label="Line width" value={Number(sel.width ?? 2)} min={1} max={20} onStart={begin} onEnd={end} onChange={(v) => patch(sel.id, { width: v })} />
              )}
            </section>
          )}

          <section className="changes">
            <h2>Changes ({ops.length})</h2>
            {ops.length === 0 ? (
              <p className="muted">Nothing changed yet.</p>
            ) : (
              grouped.map(([pg, list]) => (
                <div key={pg} className="pagegroup">
                  <button className={`pagehead ${pg === page ? "on" : ""}`} onClick={() => setPage(pg)}>
                    Page {pg} <small>{list.length}</small>
                  </button>
                  <ul className="editlist">
                    {list.map((o) => (
                      <li key={o.id} className={o.id === selected ? "sel" : ""}>
                        <button className="rowbtn" onClick={() => { setSelected(o.id); setPage(o.page); }}>
                          {describe(o)}
                        </button>
                        <button className="icon text" aria-label={`Remove: ${describe(o)}`} onClick={() => remove(o.id)}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
            <div className="actions tight">
              <button disabled={!ops.length} onClick={() => { record(); setOps([]); setSelected(null); }}>
                Clear all
              </button>
            </div>
          </section>

          <section>
            <CheckField label="Flatten annotations" checked={flatten} onChange={setFlatten} hint="Makes highlights, shapes and notes part of the page so they cannot be edited later." />
            <RunBar label="Save a copy…" busyLabel="Saving…" disabled={!ops.length} onRun={saveCopy} task={task} />
            {message && <p className="msg bad">{message}</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}

/** Outline of what the user is currently dragging, in page points. */
function Ghost({ tool, g, color }: { tool: Tool; g: Extract<Drag, { kind: "draw" }>; color: string }) {
  const r = normalizeRect(g.a, g.b);
  const common = { fill: "none", stroke: color, strokeWidth: 1.5, strokeDasharray: "4 3", vectorEffect: "non-scaling-stroke" as const };
  if (tool === "pen") return <polyline points={g.path.map((p) => `${p.x},${p.y}`).join(" ")} {...common} strokeDasharray="none" strokeWidth={2} />;
  if (tool === "line" || tool === "arrow") return <line x1={g.a.x} y1={g.a.y} x2={g.b.x} y2={g.b.y} {...common} />;
  if (tool === "ellipse") return <ellipse cx={(r.x0 + r.x1) / 2} cy={(r.y0 + r.y1) / 2} rx={(r.x1 - r.x0) / 2} ry={(r.y1 - r.y0) / 2} {...common} />;
  const fillTool = tool === "highlight" ? "rgba(255,230,0,0.35)" : tool === "redact" ? "rgba(0,0,0,0.75)" : tool === "erase" ? "rgba(255,255,255,0.85)" : "none";
  return <rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} {...common} fill={fillTool} />;
}

function PromptBox({ prompt, style, onSubmit, onCancel }: { prompt: Prompt; style: React.CSSProperties; onSubmit: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const label = prompt.kind === "link" ? "Web address or page number" : prompt.kind === "note" ? "Note" : "Text";
  return (
    <div className="promptbox" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <label className="label" htmlFor="pe-prompt">
        {label}
      </label>
      <textarea
        id="pe-prompt"
        ref={ref}
        rows={prompt.kind === "link" ? 1 : 3}
        value={text}
        placeholder={prompt.kind === "link" ? "https://… or 3" : ""}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit(text);
          } else if (e.key === "Escape") onCancel();
        }}
      />
      <div className="actions tight">
        <button className="primary" disabled={!text.trim()} onClick={() => onSubmit(text)}>
          Add
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
