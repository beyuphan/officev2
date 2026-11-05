import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Circle,
  Copy,
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
  Stamp,
  StickyNote,
  Strikethrough,
  Trash2,
  Type as TypeIcon,
  Underline,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { Message, baseName, imageFilter, pdfFilter, useTask, ProgressBar } from "../shared";
import { thumbSrc, useThumbs, type PageData } from "../pdfview";
import { describe, normalizeRect, pagesWithEdits, simplify, translate, type PdfItem, type PdfOp, type Pt } from "../lib/pdfOps";
import { get, post } from "../api";
import { HtmlItem, SVG_TYPES, VectorFrame, VectorItem, num, type HandleId } from "./pdfitems";

type Tool = "select" | "text" | "stamp" | "image" | "note" | "link" | "highlight" | "underline" | "strike" | "rect" | "ellipse" | "line" | "arrow" | "pen" | "erase" | "redact";

const GROUPS: { title: string; tools: { id: Tool; label: string; Icon: LucideIcon; key: string; hint: string }[] }[] = [
  { title: "", tools: [{ id: "select", label: "Select", Icon: MousePointer2, key: "V", hint: "Click anything on the page to edit it. Drag to move, double-click text to retype." }] },
  {
    title: "Add",
    tools: [
      { id: "text", label: "Text", Icon: TypeIcon, key: "T", hint: "Click on the page and type. Drag a box first to make the text wrap." },
      { id: "stamp", label: "Stamp", Icon: Stamp, key: "", hint: "Pick a stamp, then click where it goes." },
      { id: "image", label: "Image", Icon: ImagePlus, key: "I", hint: "Click where the picture goes, or drag a box. Works for logos and signatures." },
      { id: "note", label: "Note", Icon: StickyNote, key: "N", hint: "Click to leave a comment, then type it above." },
      { id: "link", label: "Link", Icon: Link2, key: "L", hint: "Drag over an area, then type a web address or a page number above." },
    ],
  },
  {
    title: "Mark up",
    tools: [
      { id: "highlight", label: "Highlight", Icon: Highlighter, key: "H", hint: "Drag over the words to highlight them." },
      { id: "underline", label: "Underline", Icon: Underline, key: "U", hint: "Drag over the words to underline them." },
      { id: "strike", label: "Strike", Icon: Strikethrough, key: "S", hint: "Drag over the words to strike them through." },
    ],
  },
  {
    title: "Draw",
    tools: [
      { id: "rect", label: "Box", Icon: Square, key: "R", hint: "Drag to draw a rectangle." },
      { id: "ellipse", label: "Oval", Icon: Circle, key: "O", hint: "Drag to draw an oval." },
      { id: "line", label: "Line", Icon: Minus, key: "", hint: "Drag to draw a line." },
      { id: "arrow", label: "Arrow", Icon: MoveUpRight, key: "A", hint: "Drag to draw an arrow." },
      { id: "pen", label: "Pen", Icon: PenLine, key: "P", hint: "Draw freehand, for example a signature." },
    ],
  },
  {
    title: "Remove",
    tools: [
      { id: "erase", label: "Erase", Icon: Eraser, key: "E", hint: "Drag over content to take it out and leave white." },
      { id: "redact", label: "Redact", Icon: EyeOff, key: "X", hint: "Drag over content to remove it for good under a black box." },
    ],
  },
];
const ALL_TOOLS = GROUPS.flatMap((g) => g.tools);
const STICKY: Tool[] = ["highlight", "underline", "strike", "pen", "erase", "redact"]; // stay active so several can be made in a row

const STAMPS = [
  { text: "APPROVED", color: "#1a7f37" },
  { text: "DRAFT", color: "#8a6d00" },
  { text: "CONFIDENTIAL", color: "#c42b1c" },
  { text: "PAID", color: "#1a7f37" },
  { text: "REVIEWED", color: "#1d4ed8" },
];

const TOOL_COLOR: Partial<Record<Tool, string>> = { highlight: "#ffe600", underline: "#1a7f37", strike: "#d4472b", text: "#111111", note: "#ffcc00", rect: "#d4472b", ellipse: "#d4472b", line: "#d4472b", arrow: "#d4472b", pen: "#1b1f24" };

type Defaults = { color: string; width: number; fill: boolean; fillColor: string; opacity: number; font: string; size: number; bold: boolean; italic: boolean };
const DEFAULTS: Defaults = { color: "#d4472b", width: 2, fill: false, fillColor: "#fff3a3", opacity: 1, font: "Arial", size: 14, bold: false, italic: false };

type Ghost = { page: number; tool: Tool; a: Pt; b: Pt; path: Pt[]; moved: boolean };
type Size = { pw: number; ph: number };
const FIRST_SIZE: Size = { pw: 595, ph: 842 };

const strip = (ops: PdfItem[]): PdfOp[] => ops.map(({ id: _id, ...o }) => (void _id, o));
const isEmptyItem = (o: PdfItem) => (o.type === "text" || o.type === "note") && !String(o.text ?? "").trim() || (o.type === "link" && !o.uri && !o.target_page);

export function PdfEditor({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [ops, setOps] = useState<PdfItem[]>([]);
  const [past, setPast] = useState<PdfItem[][]>([]);
  const [future, setFuture] = useState<PdfItem[][]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [defs, setDefs] = useState<Defaults>(DEFAULTS);
  const [image, setImage] = useState<string | null>(null);
  const [stamp, setStamp] = useState(STAMPS[0]);
  const [fonts, setFonts] = useState<string[]>(["Arial"]);
  const [flatten, setFlatten] = useState(false);
  const [message, setMessage] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  const [total, setTotal] = useState(0);
  const [first, setFirst] = useState<Size>(FIRST_SIZE);
  const [pages, setPages] = useState<Map<number, PageData>>(new Map());
  const [fitW, setFitW] = useState(760);

  const idc = useRef(1);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const col = useRef<HTMLDivElement>(null);
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const clip = useRef<PdfItem | null>(null);
  const gestureOpen = useRef(false);
  const gestureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingBase = useRef<PdfItem[] | null>(null);
  const loading = useRef(new Set<number>());

  const task = useTask(onDone);
  const { thumbs } = useThumbs(file, 96);

  useEffect(() => {
    get<{ fonts: string[] }>("/photo/fonts").then((r) => setFonts(r.fonts)).catch(() => undefined);
  }, []);

  /* ---- document and pages ---- */
  useEffect(() => {
    if (!file) return;
    let alive = true;
    post<{ pages: number; width: number; height: number }>("/pdf/info", { input: file })
      .then((r) => {
        if (!alive) return;
        setTotal(r.pages);
        if (r.width) setFirst({ pw: r.width, ph: r.height });
      })
      .catch((e) => alive && setMessage(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [file]);

  const loadPage = useCallback(
    (n: number) => {
      if (!file || loading.current.has(n)) return;
      loading.current.add(n);
      post<PageData>("/pdf/render", { input: file, page: n, width: 1400 })
        .then((d) => setPages((m) => new Map(m).set(n, d)))
        .catch((e) => setMessage(e instanceof Error ? e.message : String(e)));
    },
    [file],
  );

  useEffect(() => {
    const el = col.current;
    if (!el) return;
    const fit = () => setFitW(Math.max(360, Math.min(900, el.clientWidth - 56)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [file]);

  const sizeOf = useCallback((n: number): Size => {
    const d = pages.get(n);
    return d ? { pw: d.page_width, ph: d.page_height } : first;
  }, [pages, first]);

  function scrollToPage(n: number) {
    setCurrent(n);
    pageEls.current.get(n)?.scrollIntoView({ block: "start" });
  }
  function onScroll() {
    const c = col.current;
    if (!c) return;
    const mid = c.getBoundingClientRect().top + c.clientHeight * 0.35;
    let best = 1;
    pageEls.current.forEach((el, n) => {
      if (el.getBoundingClientRect().top <= mid) best = Math.max(best, n);
    });
    setCurrent(best);
  }

  /* ---- history ---- */
  const record = () => {
    setPast((p) => [...p.slice(-59), opsRef.current]);
    setFuture([]);
  };
  /** One undo step for a burst of changes (a drag, typing in a field). */
  const touch = () => {
    if (!gestureOpen.current) {
      gestureOpen.current = true;
      record();
    }
    clearTimeout(gestureTimer.current);
    gestureTimer.current = setTimeout(() => (gestureOpen.current = false), 700);
  };
  const undo = useCallback(() => {
    const p = past;
    if (!p.length) return;
    setFuture((f) => [...f, ops]);
    setOps(p[p.length - 1]);
    setPast(p.slice(0, -1));
    setEditing(null);
  }, [past, ops]);
  const redo = useCallback(() => {
    if (!future.length) return;
    setPast((p) => [...p, ops]);
    setOps(future[future.length - 1]);
    setFuture((f) => f.slice(0, -1));
    setEditing(null);
  }, [future, ops]);

  const patch = (id: number, change: Partial<PdfOp>) => setOps((cur) => cur.map((o) => (o.id === id ? { ...o, ...change } : o)));
  function add(op: PdfOp, opts: { quiet?: boolean } = {}): PdfItem {
    const item: PdfItem = { ...op, id: idc.current++ };
    if (opts.quiet) pendingBase.current = opsRef.current;
    else record();
    setOps((cur) => [...cur, item]);
    return item;
  }
  function remove(id: number) {
    record();
    setOps((cur) => cur.filter((o) => o.id !== id));
    setSelected((s) => (s === id ? null : s));
    setEditing((s) => (s === id ? null : s));
  }
  function duplicate(op: PdfItem, offset = 14) {
    const { id: _id, ...rest } = op;
    void _id;
    const moved = translate(rest as PdfOp, offset, offset);
    const item = add(moved);
    setSelected(item.id);
    setTool("select");
  }

  /* ---- editing text in place ---- */
  const commitText = (id: number) => {
    setEditing((e) => (e === id ? null : e));
    const o = opsRef.current.find((x) => x.id === id);
    if (!o) return;
    if (o.type === "text" && !String(o.text ?? "").trim()) {
      setOps((cur) => cur.filter((x) => x.id !== id));
      setSelected((s) => (s === id ? null : s));
      pendingBase.current = null;
    } else if (pendingBase.current) {
      const base = pendingBase.current;
      pendingBase.current = null;
      setPast((p) => [...p.slice(-59), base]);
      setFuture([]);
    }
  };
  const startEdit = (id: number) => {
    setSelected(id);
    setEditing(id);
    touch();
  };

  /* ---- tools ---- */
  function pickTool(t: Tool) {
    commitIfEmpty();
    setTool(t);
    setSelected(null);
    setEditing(null);
    setMessage("");
    if (TOOL_COLOR[t]) setDefs((d) => ({ ...d, color: TOOL_COLOR[t]!, opacity: t === "highlight" ? 0.5 : ["underline", "strike"].includes(t) ? 1 : d.opacity }));
    if (t === "image") void chooseImage(true);
  }
  function commitIfEmpty() {
    const open = opsRef.current.find((o) => o.id === editing);
    if (open) commitText(open.id);
  }
  async function chooseImage(thenPlace: boolean) {
    const picked = await open({ multiple: false, filters: imageFilter });
    if (typeof picked !== "string") {
      if (thenPlace && !image) setTool("select");
      return;
    }
    setImage(picked);
    if (!thenPlace && selected !== null) {
      touch();
      patch(selected, { path: picked });
    }
  }

  /* ---- pointer work ---- */
  const ptFrom = (n: number, e: { clientX: number; clientY: number }): Pt => {
    const el = pageEls.current.get(n)!;
    const r = el.getBoundingClientRect();
    const s = sizeOf(n);
    return { x: ((e.clientX - r.left) / r.width) * s.pw, y: ((e.clientY - r.top) / r.height) * s.ph };
  };
  const track = (move: (e: PointerEvent) => void, up: (e: PointerEvent) => void) => {
    const m = (e: PointerEvent) => move(e);
    const u = (e: PointerEvent) => {
      window.removeEventListener("pointermove", m);
      window.removeEventListener("pointerup", u);
      window.removeEventListener("pointercancel", u);
      up(e);
    };
    window.addEventListener("pointermove", m);
    window.addEventListener("pointerup", u);
    window.addEventListener("pointercancel", u);
  };

  const dropFocus = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a && a.closest("input, select, textarea")) a.blur();
  };

  function onItemDown(e: RPointerEvent, op: PdfItem) {
    if (e.button !== 0) return;
    if (!(tool === "text" && op.type === "text")) dropFocus();
    if (tool === "text" && op.type === "text") {
      e.stopPropagation();
      startEdit(op.id);
      return;
    }
    if (tool !== "select") return; // let the page start drawing
    e.stopPropagation();
    e.preventDefault();
    commitIfEmpty();
    setSelected(op.id);
    if (editing === op.id) return;
    const start = ptFrom(op.page, e);
    let last = start;
    let moved = false;
    track(
      (ev) => {
        const p = ptFrom(op.page, ev);
        if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 3) return;
        moved = true;
        touch();
        const dx = p.x - last.x, dy = p.y - last.y;
        last = p;
        setOps((cur) => cur.map((o) => (o.id === op.id ? ({ ...o, ...translate(o, dx, dy) } as PdfItem) : o)));
      },
      () => undefined,
    );
  }

  function onHandle(op: PdfItem, id: HandleId, e: RPointerEvent) {
    const n = op.page;
    const el = pageEls.current.get(n)!;
    const size = sizeOf(n);
    const k = size.pw / el.clientWidth; // points per screen pixel
    const dom = el.querySelector<HTMLElement>(`[data-oid="${op.id}"]`);
    const wPt = (dom?.offsetWidth ?? 100) * k;
    const hPt = (dom?.offsetHeight ?? 20) * k;
    const o = { ...op };
    void e;
    track(
      (ev) => {
        const p = ptFrom(n, ev);
        touch();
        if (op.type === "text") {
          const th = (num(o.rotate) * Math.PI) / 180;
          const dir = { x: Math.cos(th), y: Math.sin(th) };
          const ox = num(o.x), oy = num(o.y);
          const proj = (p.x - ox) * dir.x + (p.y - oy) * dir.y;
          if (id === "e") patch(op.id, { width: Math.max(24, Math.round(proj)) });
          else if (id === "se") {
            const ratio = Math.max(0.2, proj / Math.max(1, wPt));
            patch(op.id, { size: Math.min(200, Math.max(4, Math.round(num(o.size, 14) * ratio * 10) / 10)), ...(num(o.width) ? { width: Math.max(24, num(o.width) * ratio) } : {}) });
          } else if (id === "rot") {
            const base = (Math.atan2(-26 * k, wPt / 2) * 180) / Math.PI;
            let deg = (Math.atan2(p.y - oy, p.x - ox) * 180) / Math.PI - base;
            deg = ((deg + 540) % 360) - 180;
            if (Math.abs(deg % 15) < 3 || ev.shiftKey) deg = Math.round(deg / 15) * 15;
            patch(op.id, { rotate: Math.round(deg) });
          }
          return;
        }
        if (op.type === "line" || op.type === "arrow") {
          patch(op.id, id === "p0" ? { x0: p.x, y0: p.y } : { x1: p.x, y1: p.y });
          return;
        }
        if (op.type === "image") {
          const x0 = num(o.x0), y0 = num(o.y0), w = num(o.w, 150);
          const h = num(o.h, hPt);
          if (id === "rot") {
            const c = { x: x0 + w / 2, y: y0 + h / 2 };
            let deg = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90;
            deg = ((deg + 540) % 360) - 180;
            if (Math.abs(deg % 15) < 3 || ev.shiftKey) deg = Math.round(deg / 15) * 15;
            patch(op.id, { rotate: Math.round(deg) });
            return;
          }
          let r = { x0, y0, x1: x0 + w, y1: y0 + h };
          r = sideResize(r, id, p);
          let nw = Math.max(10, r.x1 - r.x0), nh = Math.max(10, r.y1 - r.y0);
          if (id.length === 2 && !ev.shiftKey) {
            nh = (nw * h) / w;
            if (id.includes("n")) r.y0 = r.y1 - nh;
          }
          patch(op.id, { x0: r.x0, y0: r.y0, w: nw, h: nh });
          return;
        }
        // rectangles and markup
        const r = sideResize({ x0: num(o.x0), y0: num(o.y0), x1: num(o.x1), y1: num(o.y1) }, id, p);
        patch(op.id, { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0 + 4, r.x1), y1: Math.max(r.y0 + 4, r.y1) });
      },
      () => undefined,
    );
  }

  function onPageDown(n: number, e: RPointerEvent) {
    if (e.button !== 0) return;
    const p = ptFrom(n, e);
    e.preventDefault();
    dropFocus();
    commitIfEmpty();
    setCurrent(n);
    if (tool === "select") {
      setSelected(null);
      setEditing(null);
      return;
    }
    if (tool === "image" && !image) return;
    setSelected(null);
    const t = tool;
    let g: Ghost = { page: n, tool: t, a: p, b: p, path: [p], moved: false };
    setGhost(g);
    track(
      (ev) => {
        const q = ptFrom(n, ev);
        g = { ...g, b: q, moved: g.moved || Math.hypot(q.x - g.a.x, q.y - g.a.y) > 3, path: t === "pen" ? [...g.path, q] : g.path };
        setGhost(g);
      },
      () => {
        setGhost(null);
        place(g);
      },
    );
  }

  function place(g: Ghost) {
    const { a, b, path, moved, tool: t, page } = g;
    const r = normalizeRect(a, b);
    const big = r.x1 - r.x0 > 5 && r.y1 - r.y0 > 5;
    const base = { page };
    const keep = STICKY.includes(t);
    const done = (item: PdfItem | null, edit = false) => {
      if (!item) return;
      if (!keep) {
        setTool("select");
        setSelected(item.id);
      }
      if (edit) {
        setSelected(item.id);
        setEditing(item.id);
      }
    };
    switch (t) {
      case "text": {
        const item = add({ ...base, type: "text", x: moved && big ? r.x0 : a.x, y: moved && big ? r.y0 : a.y - defs.size * 0.5, text: "", size: defs.size, font: defs.font, bold: defs.bold, italic: defs.italic, color: defs.color, opacity: defs.opacity, ...(moved && big ? { width: r.x1 - r.x0 } : {}) }, { quiet: true });
        done(item, true);
        return;
      }
      case "stamp":
        done(add({ ...base, type: "text", x: a.x - 60, y: a.y - 14, text: stamp.text, size: 28, bold: true, color: stamp.color, border: stamp.color, background: "#ffffff", opacity: 0.9, rotate: -12, font: defs.font }));
        return;
      case "note": {
        const item = add({ ...base, type: "note", x: a.x, y: a.y, text: "", color: defs.color });
        done(item);
        setFocusTick((n) => n + 1);
        return;
      }
      case "link": {
        if (!big) return;
        const item = add({ ...base, type: "link", ...r });
        done(item);
        setFocusTick((n) => n + 1);
        return;
      }
      case "image":
        if (!image) return;
        done(add({ ...base, type: "image", path: image, x0: moved && big ? r.x0 : a.x, y0: moved && big ? r.y0 : a.y, w: moved && big ? r.x1 - r.x0 : 160, opacity: defs.opacity }));
        return;
      case "highlight":
      case "underline":
      case "strike":
        if (big) done(add({ ...base, type: t, ...r, color: defs.color, opacity: defs.opacity }));
        return;
      case "rect":
      case "ellipse":
        if (big) done(add({ ...base, type: t, ...r, color: defs.color, width: defs.width, opacity: defs.opacity, ...(defs.fill ? { fill: defs.fillColor } : {}) }));
        return;
      case "erase":
      case "redact":
        if (big) done(add({ ...base, type: t, ...r }));
        return;
      case "line":
      case "arrow":
        if (moved) done(add({ ...base, type: t, x0: a.x, y0: a.y, x1: b.x, y1: b.y, color: defs.color, width: defs.width, opacity: defs.opacity }));
        return;
      case "pen":
        if (moved) done(add({ ...base, type: "ink", strokes: [simplify(path).map((p) => [p.x, p.y])], color: defs.color, width: defs.width, opacity: defs.opacity }));
        return;
    }
  }

  /* ---- keyboard ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const sel = opsRef.current.find((o) => o.id === selected);
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
        const { id: _id, ...rest } = clip.current;
        void _id;
        const item = add({ ...translate(rest as PdfOp, 14, 14), page: current });
        setSelected(item.id);
      } else if ((k === "delete" || k === "backspace") && sel) {
        e.preventDefault();
        remove(sel.id);
      } else if (k === "enter" && sel?.type === "text") {
        e.preventDefault();
        startEdit(sel.id);
      } else if (k === "escape") {
        setSelected(null);
        setTool("select");
      } else if (sel && k.startsWith("arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k]!;
        touch();
        setOps((cur) => cur.map((o) => (o.id === sel.id ? ({ ...o, ...translate(o, d[0], d[1]) } as PdfItem) : o)));
      } else if (!mod && !e.altKey) {
        const t = ALL_TOOLS.find((x) => x.key && x.key.toLowerCase() === k);
        if (t) pickTool(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo, selected, editing, current, image]);

  async function choose() {
    const picked = await open({ multiple: false, filters: pdfFilter });
    if (typeof picked !== "string") return;
    setFile(picked);
    setOps([]);
    setPast([]);
    setFuture([]);
    setPages(new Map());
    loading.current = new Set();
    pageEls.current = new Map();
    setCurrent(1);
    setSelected(null);
    setEditing(null);
    setTool("select");
    setMessage("");
  }

  async function saveCopy() {
    if (!file) return;
    const keep = ops.filter((o) => !isEmptyItem(o)).map((o) => (o.type === "link" && o.uri && !/^(https?:\/\/|mailto:)/.test(String(o.uri)) ? { ...o, uri: `https://${String(o.uri)}` } : o));
    const output = await save({ filters: pdfFilter, defaultPath: baseName(file).replace(/\.pdf$/i, "") + "-edited.pdf" });
    if (output) await task.run("/pdf/edit", { input: file, output, ops: strip(keep), flatten });
  }

  const changedPages = useMemo(() => pagesWithEdits(ops), [ops]);
  const sel = ops.find((o) => o.id === selected) ?? null;
  const active = ALL_TOOLS.find((t) => t.id === tool)!;

  if (!file) {
    return (
      <div className="photo empty">
        <h1>PDF editor</h1>
        <p className="muted">Add text, signatures and images, highlight, draw, leave notes, add links, erase or black out content. Click anything you placed to change it. The original is never changed.</p>
        <div className="actions">
          <button className="primary" onClick={choose}>
            Open a PDF…
          </button>
        </div>
      </div>
    );
  }

  const pageWidth = fitW * zoom;
  const pageNumbers = Array.from({ length: total }, (_, i) => i + 1);

  return (
    <div className="pdfedit">
      <div className="pdftop">
        <span className="chip" title={file}>
          <b>{baseName(file)}</b>
          <span className="muted">
            Page {current} of {total || "…"}
          </span>
        </span>
        <span className="spacer" />
        <button className="icon" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}>
          <ZoomOut size={16} strokeWidth={1.5} />
        </button>
        <button className="zoomval" aria-label="Fit page width" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="icon" aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom((z) => Math.min(2, +(z + 0.25).toFixed(2)))}>
          <ZoomIn size={16} strokeWidth={1.5} />
        </button>
        <button className="icon" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}>
          <Undo2 size={16} strokeWidth={1.5} />
        </button>
        <button className="icon" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!future.length} onClick={redo}>
          <Redo2 size={16} strokeWidth={1.5} />
        </button>
        <button onClick={choose}>Open another…</button>
        <label className="flatten" title="Makes highlights, shapes and notes part of the page so they cannot be edited later.">
          <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} /> Flatten
        </label>
        <button className="primary" disabled={!ops.some((o) => !isEmptyItem(o)) || task.busy} onClick={saveCopy}>
          {task.busy ? "Saving…" : "Save a copy…"}
        </button>
      </div>

      <ContextBar
        tool={tool}
        hint={active.hint}
        sel={sel}
        defs={defs}
        setDefs={setDefs}
        fonts={fonts}
        stamp={stamp}
        setStamp={setStamp}
        image={image}
        touch={touch}
        patch={patch}
        onDelete={() => sel && remove(sel.id)}
        onDuplicate={() => sel && duplicate(sel)}
        onReplaceImage={() => chooseImage(false)}
        onPickImage={() => chooseImage(false)}
        focusTick={focusTick}
      />
      {(task.busy || task.message || message) && (
        <div className="pdfstatus">
          {task.busy && <ProgressBar progress={task.progress} onCancel={task.cancel} />}
          <Message m={task.message ?? (message ? { ok: false, text: message } : null)} />
        </div>
      )}

      <div className="pdfmain">
        <nav className="toolrail" aria-label="Editing tools">
          {GROUPS.map((g) => (
            <div key={g.title || "select"} className="toolgroup" role="group" aria-label={g.title || "Select"}>
              {g.title && <span className="grouptitle">{g.title}</span>}
              {g.tools.map(({ id, label, Icon, key }) => (
                <button key={id} className={tool === id ? "on" : ""} aria-pressed={tool === id} aria-label={label} title={key ? `${label} (${key})` : label} onClick={() => pickTool(id)}>
                  <Icon size={17} strokeWidth={1.5} aria-hidden />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="strip" aria-label="Pages">
          {pageNumbers.map((n) => (
            <button key={n} className={n === current ? "on" : ""} aria-label={`Page ${n}${changedPages.has(n) ? " (edited)" : ""}`} onClick={() => scrollToPage(n)}>
              {thumbs.get(n) ? <img src={thumbSrc(thumbs.get(n)!)} alt="" draggable={false} /> : <span className="ph" />}
              <span className="mono">
                {n}
                {changedPages.has(n) && <i className="dot" />}
              </span>
            </button>
          ))}
        </div>

        <div className="pagecol" ref={col} onScroll={onScroll}>
          {pageNumbers.map((n) => (
            <PageView
              key={n}
              n={n}
              width={pageWidth}
              size={sizeOf(n)}
              data={pages.get(n)}
              need={loadPage}
              register={(el) => (el ? pageEls.current.set(n, el) : pageEls.current.delete(n))}
              items={ops.filter((o) => o.page === n)}
              selected={selected}
              editing={editing}
              tool={tool}
              ghost={ghost?.page === n ? ghost : null}
              ghostColor={defs.color}
              onPageDown={onPageDown}
              onItemDown={onItemDown}
              onDouble={(o) => {
                if (o.type === "text") startEdit(o.id);
                else {
                  setSelected(o.id);
                  setFocusTick((t) => t + 1);
                }
              }}
              onHandle={onHandle}
              onText={(id, text) => {
                touch();
                patch(id, { text });
              }}
              onCommit={commitText}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Moves the sides named by a handle id to the pointer. */
function sideResize(r: { x0: number; y0: number; x1: number; y1: number }, id: HandleId, p: Pt) {
  const out = { ...r };
  if (id.includes("w")) out.x0 = Math.min(p.x, r.x1 - 6);
  if (id.includes("e")) out.x1 = Math.max(p.x, r.x0 + 6);
  if (id.includes("n")) out.y0 = Math.min(p.y, r.y1 - 6);
  if (id.includes("s")) out.y1 = Math.max(p.y, r.y0 + 6);
  return out;
}

/* ------------------------------------------------------------------------------------------ */

type PageViewProps = {
  n: number;
  width: number;
  size: Size;
  data?: PageData;
  need: (n: number) => void;
  register: (el: HTMLDivElement | null) => void;
  items: PdfItem[];
  selected: number | null;
  editing: number | null;
  tool: Tool;
  ghost: Ghost | null;
  ghostColor: string;
  onPageDown: (n: number, e: RPointerEvent) => void;
  onItemDown: (e: RPointerEvent, op: PdfItem) => void;
  onDouble: (op: PdfItem) => void;
  onHandle: (op: PdfItem, id: HandleId, e: RPointerEvent) => void;
  onText: (id: number, text: string) => void;
  onCommit: (id: number) => void;
};

function PageView(p: PageViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const { n, size, data, need } = p;

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") return need(n);
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && need(n), { rootMargin: "900px 0px" });
    io.observe(node);
    return () => io.disconnect();
  }, [n, need]);

  const vectors = p.items.filter((o) => SVG_TYPES.includes(o.type));
  const html = p.items.filter((o) => !SVG_TYPES.includes(o.type));
  const sel = p.items.find((o) => o.id === p.selected);
  const common = { pw: size.pw, ph: size.ph, onDown: p.onItemDown, onDouble: p.onDouble };

  return (
    <div className="pagewrap" data-page={n}>
      <div
        ref={(node) => {
          el.current = node;
          p.register(node);
        }}
        className={`page editable tool-${p.tool}`}
        style={{ width: p.width, aspectRatio: `${size.pw} / ${size.ph}` }}
        onPointerDown={(e) => p.onPageDown(n, e)}
      >
        {data ? <img src={`data:image/png;base64,${data.image}`} alt={`Page ${n}`} draggable={false} /> : <span className="pagewait mono">Page {n}</span>}
        <svg className="vec" viewBox={`0 0 ${size.pw} ${size.ph}`} preserveAspectRatio="none">
          {vectors.map((o) => (
            <VectorItem key={o.id} op={o} selected={o.id === p.selected} {...common} />
          ))}
          {p.ghost?.moved && <GhostShape g={p.ghost} color={p.ghostColor} />}
        </svg>
        <div className="htmlobjs">
          {html.map((o) => (
            <HtmlItem key={o.id} op={o} selected={o.id === p.selected} editing={o.id === p.editing} onHandle={(id, e) => p.onHandle(o, id, e)} onText={p.onText} onCommit={p.onCommit} {...common} />
          ))}
        </div>
        <div className="selayer">{sel && SVG_TYPES.includes(sel.type) && <VectorFrame op={sel} pw={size.pw} ph={size.ph} onHandle={(id, e) => p.onHandle(sel, id, e)} />}</div>
      </div>
    </div>
  );
}

function GhostShape({ g, color }: { g: Ghost; color: string }) {
  const r = normalizeRect(g.a, g.b);
  const common = { fill: "none", stroke: color, strokeWidth: 1.5, strokeDasharray: "4 3", vectorEffect: "non-scaling-stroke" as const };
  if (g.tool === "pen") return <polyline points={g.path.map((p) => `${p.x},${p.y}`).join(" ")} {...common} strokeDasharray="none" strokeWidth={2} />;
  if (g.tool === "line" || g.tool === "arrow") return <line x1={g.a.x} y1={g.a.y} x2={g.b.x} y2={g.b.y} {...common} />;
  if (g.tool === "ellipse") return <ellipse cx={(r.x0 + r.x1) / 2} cy={(r.y0 + r.y1) / 2} rx={(r.x1 - r.x0) / 2} ry={(r.y1 - r.y0) / 2} {...common} />;
  const fill = g.tool === "highlight" ? "rgba(255,230,0,0.35)" : g.tool === "redact" ? "rgba(0,0,0,0.75)" : g.tool === "erase" ? "rgba(255,255,255,0.85)" : "none";
  return <rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} {...common} fill={fill} />;
}

/* ------------------------------------------------------------------------------------------ */

type BarProps = {
  tool: Tool;
  hint: string;
  sel: PdfItem | null;
  defs: Defaults;
  setDefs: (f: (d: Defaults) => Defaults) => void;
  fonts: string[];
  stamp: (typeof STAMPS)[number];
  setStamp: (s: (typeof STAMPS)[number]) => void;
  image: string | null;
  touch: () => void;
  patch: (id: number, c: Partial<PdfOp>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onReplaceImage: () => void;
  onPickImage: () => void;
  focusTick: number;
};

/** The one place where options live: it shows the settings of whatever is selected, or of the tool in use. */
function ContextBar({ tool, hint, sel, defs, setDefs, fonts, stamp, setStamp, image, touch, patch, onDelete, onDuplicate, onReplaceImage, onPickImage, focusTick }: BarProps) {
  const text = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusTick) setTimeout(() => text.current?.focus(), 60);
  }, [focusTick]);

  const type = sel ? (sel.type === "ink" ? "pen" : sel.type) : tool;
  const val = <K extends keyof Defaults>(k: K): Defaults[K] => (sel && sel[k] !== undefined ? (sel[k] as Defaults[K]) : defs[k]);
  const set = (k: keyof Defaults, v: string | number | boolean) => {
    if (sel) {
      touch();
      const key = k === "fill" ? "fill" : k;
      patch(sel.id, k === "fill" ? { fill: v ? defs.fillColor : undefined } : { [key]: v });
    }
    setDefs((d) => ({ ...d, [k]: v }));
  };

  const hasFont = type === "text";
  const hasColor = !["select", "erase", "redact", "link", "image", "stamp"].includes(type);
  const hasWidth = ["rect", "ellipse", "line", "arrow", "pen"].includes(type);
  const hasFill = type === "rect" || type === "ellipse";
  const hasOpacity = ["text", "image", "highlight", "rect", "ellipse", "line", "arrow", "pen", "underline", "strike"].includes(type);
  const label = sel ? describe(sel).split(" “")[0] : ALLLABEL[tool];

  const fillOn = sel ? Boolean(sel.fill) : defs.fill;

  return (
    <div className="ctxbar" role="toolbar" aria-label="Options">
      <span className="ctxlabel">{label}</span>
      {!sel && <span className="ctxhint">{hint}</span>}
      {hasFont && (
        <>
          <select aria-label="Font" value={String(val("font"))} onChange={(e) => set("font", e.target.value)}>
            {(fonts.includes(String(val("font"))) ? fonts : [String(val("font")), ...fonts]).map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <span className="stepper">
            <button className="icon" aria-label="Smaller" onClick={() => set("size", Math.max(4, num(val("size"), 14) - 1))}>−</button>
            <input aria-label="Size" type="number" min={4} max={200} value={Math.round(num(val("size"), 14) * 10) / 10} onChange={(e) => e.target.value && set("size", Math.min(200, Math.max(4, Number(e.target.value))))} />
            <button className="icon" aria-label="Larger" onClick={() => set("size", Math.min(200, num(val("size"), 14) + 1))}>+</button>
          </span>
          <button className={`icon fmt ${val("bold") ? "on" : ""}`} aria-label="Bold" aria-pressed={Boolean(val("bold"))} onClick={() => set("bold", !val("bold"))}>
            <b>B</b>
          </button>
          <button className={`icon fmt ${val("italic") ? "on" : ""}`} aria-label="Italic" aria-pressed={Boolean(val("italic"))} onClick={() => set("italic", !val("italic"))}>
            <i>I</i>
          </button>
        </>
      )}
      {type === "stamp" && (
        <span className="stamps">
          {STAMPS.map((s) => (
            <button key={s.text} className={stamp.text === s.text ? "on" : ""} aria-pressed={stamp.text === s.text} style={stamp.text === s.text ? { color: "#fff", background: s.color, borderColor: s.color } : { color: s.color, borderColor: s.color }} onClick={() => setStamp(s)}>
              {s.text}
            </button>
          ))}
        </span>
      )}
      {hasColor && (
        <label className="ctl">
          <span>Color</span>
          <input type="color" aria-label="Color" value={String(val("color")).slice(0, 7)} onChange={(e) => set("color", e.target.value)} />
        </label>
      )}
      {hasWidth && (
        <label className="ctl">
          <span>Width</span>
          <input type="range" aria-label="Line width" min={1} max={20} value={num(val("width"), 2)} onChange={(e) => set("width", Number(e.target.value))} />
          <output>{num(val("width"), 2)}</output>
        </label>
      )}
      {hasFill && (
        <label className="ctl">
          <input type="checkbox" checked={fillOn} onChange={(e) => set("fill", e.target.checked)} />
          <span>Fill</span>
          {fillOn && (
            <input
              type="color"
              aria-label="Fill color"
              value={String(sel?.fill ?? defs.fillColor)}
              onChange={(e) => {
                setDefs((d) => ({ ...d, fillColor: e.target.value }));
                if (sel) {
                  touch();
                  patch(sel.id, { fill: e.target.value });
                }
              }}
            />
          )}
        </label>
      )}
      {hasOpacity && (
        <label className="ctl">
          <span>Opacity</span>
          <input type="range" aria-label="Opacity" min={0.1} max={1} step={0.05} value={num(val("opacity"), 1)} onChange={(e) => set("opacity", Number(e.target.value))} />
        </label>
      )}
      {type === "image" && (
        <button onClick={sel ? onReplaceImage : onPickImage}>{sel ? "Replace picture…" : image ? "Change picture…" : "Choose picture…"}</button>
      )}
      {sel?.type === "note" && (
        <input ref={text} className="ctltext" aria-label="Note text" placeholder="Type the note…" value={String(sel.text ?? "")} onChange={(e) => { touch(); patch(sel.id, { text: e.target.value }); }} />
      )}
      {sel?.type === "link" && (
        <input
          ref={text}
          className="ctltext"
          aria-label="Link target"
          placeholder="https://… or a page number"
          value={sel.uri ? String(sel.uri) : sel.target_page ? String(sel.target_page) : ""}
          onChange={(e) => {
            touch();
            const t = e.target.value.trim();
            patch(sel.id, /^\d+$/.test(t) ? { target_page: Number(t), uri: undefined } : { uri: t, target_page: undefined });
          }}
        />
      )}
      {sel?.type === "redact" && <span className="ctxhint">The content underneath is deleted from the file when you save.</span>}
      {sel?.type === "erase" && <span className="ctxhint">The content underneath is removed when you save.</span>}
      <span className="spacer" />
      {sel && (
        <>
          <button onClick={onDuplicate} title="Duplicate (Ctrl+D)">
            <Copy size={15} strokeWidth={1.5} aria-hidden /> Duplicate
          </button>
          <button className="danger" onClick={onDelete} title="Delete (Del)">
            <Trash2 size={15} strokeWidth={1.5} aria-hidden /> Delete
          </button>
        </>
      )}
    </div>
  );
}

const ALLLABEL: Record<Tool, string> = {
  select: "Select", text: "Text", stamp: "Stamp", image: "Image", note: "Note", link: "Link", highlight: "Highlight", underline: "Underline", strike: "Strike",
  rect: "Box", ellipse: "Oval", line: "Line", arrow: "Arrow", pen: "Pen", erase: "Erase", redact: "Redact",
};

