import { failed } from "../lib/notify";
import { useAnnounceEditorFile } from "../lib/editorfile";
import { useHistory } from "../lib/useHistory";
import { useStyleClipboard } from "../lib/useStyleClipboard";
import { takePending } from "../lib/handoff";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Circle,
  Copy,
  FilePlus,
  Files,
  Scissors,
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
  TextCursorInput,
  Strikethrough,
  Trash2,
  Type as TypeIcon,
  Underline,
  Undo2,
  ZoomIn,
  ZoomOut,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { ConfirmDialog, SaveState, FontPicker, Message, baseName, imageFilter, pdfFilter, useTask, ProgressBar } from "../shared";
import { FileMenu, PagesMenu, type PageOp } from "./pdfpages";
import { NUMBERS_OFF, NumbersButton, NumbersOverlay, numbersRequest, type Numbers } from "./pdfnumbers";
import { thumbSrc, useThumbs, type PageData } from "../pdfview";
import { describe, normalizeRect, pagesWithEdits, simplify, translate, type PdfItem, type PdfOp, type Pt } from "../lib/pdfOps";
import { get, post, put as putSetting } from "../api";
import { HtmlItem, SVG_TYPES, VectorFrame, VectorItem, num, type HandleId } from "./pdfitems";

type Tool = "select" | "text" | "stamp" | "image" | "note" | "link" | "highlight" | "underline" | "strike" | "rect" | "ellipse" | "line" | "arrow" | "pen" | "eraser" | "erase" | "redact" | "retext" | "field";

const GROUPS: { title: string; tools: { id: Tool; label: string; Icon: LucideIcon; key: string; hint: string }[] }[] = [
  { title: "", tools: [{ id: "select", label: "Select", Icon: MousePointer2, key: "V", hint: "Click any text on the page to edit it. Drag text or pictures to move them." }] },
  {
    title: "Add",
    tools: [
      { id: "text", label: "Text", Icon: TypeIcon, key: "T", hint: "Click on the page and type. Drag a box first to make the text wrap." },
      { id: "stamp", label: "Stamp", Icon: Stamp, key: "", hint: "Pick a stamp, then click where it goes." },
      { id: "field", label: "Form field", Icon: TextCursorInput, key: "", hint: "Drag a box where people should type, tick or choose. Set its kind above." },
      { id: "image", label: "Image", Icon: ImagePlus, key: "I", hint: "Click where the picture goes, or drag a box. Works for logos and signatures." },
      { id: "note", label: "Note", Icon: StickyNote, key: "N", hint: "Click to leave a comment, then type it above." },
      { id: "link", label: "Link", Icon: Link2, key: "L", hint: "Drag over an area, then type a web address or a page number above." },
    ],
  },
  {
    title: "Mark up",
    tools: [
      { id: "highlight", label: "Highlight", Icon: Highlighter, key: "H", hint: "Drag over the words to highlight them, or click one word." },
      { id: "underline", label: "Underline", Icon: Underline, key: "U", hint: "Drag over the words to underline them, or click one word." },
      { id: "strike", label: "Strike", Icon: Strikethrough, key: "S", hint: "Drag over the words to strike them through, or click one word." },
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
      { id: "eraser", label: "Eraser", Icon: Eraser, key: "E", hint: "Click or drag over things you added to take them away again." },
      { id: "erase", label: "White-out", Icon: Square, key: "", hint: "Drag over the original page content to cover it with white. Use it for small fixes." },
      { id: "redact", label: "Black out", Icon: EyeOff, key: "X", hint: "Drag over private information. The text underneath is deleted from the file, so nobody can copy it back." },
    ],
  },
];
const ALL_TOOLS = GROUPS.flatMap((g) => g.tools);
/** The groups that start unfolded; the others open with one click, or by themselves when one of their tools is in use. */
const RAIL_OPEN_AT_START = ["Add", "Mark up"];
const STICKY: Tool[] = ["text", "highlight", "underline", "strike", "pen", "eraser", "erase", "redact"]; // stay active so several can be made in a row

type StampDef = { text: string; color: string };
const STAMPS: StampDef[] = [
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

type OrigText = { id: number; rect: [number, number, number, number]; text: string; size: number; color: string; font: string; bold: boolean; italic: boolean };
type OrigPicture = { xref: number; rect: [number, number, number, number]; width: number; height: number; background?: boolean };
type PageObjects = { width: number; height: number; texts: OrigText[]; images: OrigPicture[] };
type OrigSel = { key: string; page: number; kind: "t" | "i"; obj: OrigText | OrigPicture };

/** A page that was removed while its picture or text was still loading is not an error. */
const gone = (e: unknown) => /does not exist/.test(e instanceof Error ? e.message : String(e));

const origStyle = (r: number[], s: Size): React.CSSProperties => ({ left: `${(r[0] / s.pw) * 100}%`, top: `${(r[1] / s.ph) * 100}%`, width: `${((r[2] - r[0]) / s.pw) * 100}%`, height: `${((r[3] - r[1]) / s.ph) * 100}%` });

/** The installed font that best matches a font name taken from the PDF (ArialMT, ABCDEF+Calibri-Bold…). */
function matchFont(pdfName: string, fonts: string[], fallback: string): string {
  const clean = pdfName.replace(/^[A-Z]{6}\+/, "").replace(/[-,](Bold|Italic|Oblique|Regular|BoldItalic).*$/i, "").replace(/(MT|PS)$/i, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!clean) return fallback;
  return fonts.find((f) => f.toLowerCase().replace(/[^a-z0-9]/g, "") === clean) ?? fonts.find((f) => f.toLowerCase().replace(/[^a-z0-9]/g, "").startsWith(clean)) ?? fonts.find((f) => clean.startsWith(f.toLowerCase().replace(/[^a-z0-9]/g, ""))) ?? fallback;
}

const strip = (ops: PdfItem[]): PdfOp[] =>
  ops.map(({ id: _id, choicesText, previewData, ...o }) => {
    void _id;
    void previewData;
    return typeof choicesText === "string" ? { ...o, choices: choicesText.split(",").map((c) => c.trim()).filter(Boolean) } : o;
  });
const isEmptyItem = (o: PdfItem) => (o.type === "text" || o.type === "note") && !String(o.text ?? "").trim() || (o.type === "link" && !o.uri && !o.target_page);

export function PdfEditor({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  useAnnounceEditorFile(file !== null);
  const [ops, setOps] = useState<PdfItem[]>([]);
  const [origFile, setOrigFile] = useState<string | null>(null); // the file you opened; "file" below may be a working copy with page changes
  const [objs, setObjs] = useState<Map<number, PageObjects>>(new Map());
  const [origSel, setOrigSel] = useState<OrigSel | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const stripEl = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const layers = true; // the page's own text and pictures are always clickable
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [railOpen, setRailOpen] = useState<Record<string, boolean>>({});
  const [sideTab, setSideTab] = useState<"options" | "pages">("pages");
  const busyWithSomething = selected !== null || origSel !== null || tool !== "select";
  useEffect(() => setSideTab(busyWithSomething ? "options" : "pages"), [busyWithSomething, selected, origSel?.key, tool]); // a new selection or tool brings Options back
  const [editing, setEditing] = useState<number | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [defs, setDefs] = useState<Defaults>(DEFAULTS);
  const [image, setImage] = useState<string | null>(null);
  const [stamp, setStamp] = useState<StampDef>(STAMPS[0]);
  const [mine, setMine] = useState<StampDef[]>([]);
  const [numbers, setNumbers] = useState<Numbers>(NUMBERS_OFF);
  const [savedKey, setSavedKey] = useState("");
  const [ask, setAsk] = useState<null | "close" | "open">(null);
  const [fonts, setFonts] = useState<string[]>(["Arial"]);
  const [flatten, setFlatten] = useState(false);
  const [message, setMessage] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  const [total, setTotal] = useState(0);
  const totalRef = useRef(0);
  totalRef.current = total;
  const [first, setFirst] = useState<Size>(FIRST_SIZE);
  const [pages, setPages] = useState<Map<number, PageData>>(new Map());
  const [fitW, setFitW] = useState(760);

  const idc = useRef(1);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const col = useRef<HTMLDivElement>(null);
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const layersRef = useRef(false);
  layersRef.current = layers;
  const fileRef = useRef<string | null>(null);
  fileRef.current = file;
  const fileOf = useRef(new WeakMap<PdfItem[], string>()); // which working copy a snapshot of the items belongs to
  const clip = useRef<PdfItem | null>(null);
  const pendingBase = useRef<PdfItem[] | null>(null);
  const loading = useRef(new Set<number>());

  const task = useTask(onDone);
  const { thumbs } = useThumbs(file, 96);
  const stateKey = () => JSON.stringify([strip(opsRef.current.filter((o) => !isEmptyItem(o))), numbersRequest(numbersRef.current), fileRef.current]);
  const numbersRef = useRef(numbers);
  numbersRef.current = numbers;

  useEffect(() => {
    get<{ fonts: string[] }>("/photo/fonts").then((r) => setFonts(r.fonts)).catch(failed("Could not load the font list"));
    get<Record<string, unknown>>("/settings").then((st) => setMine((st.pdf_stamps as StampDef[]) ?? [])).catch(failed("Could not load your saved stamps"));
  }, []);

  async function saveStamps(next: StampDef[]) {
    setMine(next);
    await putSetting("/settings/pdf_stamps", { value: next }).catch(failed("Could not save your stamps"));
  }

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
      if (!file || loading.current.has(n) || (totalRef.current > 0 && n > totalRef.current)) return;
      loading.current.add(n);
      post<PageData>("/pdf/render", { input: file, page: n, width: 1400 })
        .then((d) => setPages((m) => new Map(m).set(n, d)))
        .catch((e) => !gone(e) && setMessage(e instanceof Error ? e.message : String(e)));
      if (layersRef.current)
        post<PageObjects>("/pdf/page-objects", { input: file, page: n })
          .then((o) => setObjs((m) => new Map(m).set(n, o)))
          .catch((e) => !gone(e) && setMessage(`Could not read the text of page ${n}: ${e instanceof Error ? e.message : String(e)}`));
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
  const history = useHistory<PdfItem[]>({
    value: ops,
    valueRef: opsRef,
    setValue: setOps,
    onRecord: (snap) => fileOf.current.set(snap, fileRef.current ?? ""),
    onLeave: (cur) => fileOf.current.set(cur, fileRef.current ?? ""),
    onRestore: (snap) => {
      setEditing(null);
      const f = fileOf.current.get(snap);
      if (f && f !== fileRef.current) swapFile(f);
    },
  });
  const { past, future, record, touch, undo, redo } = history;

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
    const partner = opsRef.current.find((o) => o.id === id)?.partner;
    setOps((cur) => cur.filter((o) => o.id !== id && o.id !== partner));
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

  const styleOf = (o: PdfItem) => {
    const pick = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
    if (o.type === "text") return { kind: "text", style: pick(["font", "size", "bold", "italic", "color", "opacity", "border", "background"]) };
    if (["rect", "ellipse", "line", "arrow", "ink"].includes(o.type)) return { kind: "shape", style: pick(["color", "width", "opacity", "fill"]) };
    if (["highlight", "underline", "strike"].includes(o.type)) return { kind: "markup:" + o.type, style: pick(["color", "opacity"]) };
    return null;
  };
  const styles = useStyleClipboard<PdfItem>(styleOf);
  const copyStyle = () => styles.copy(opsRef.current.find((x) => x.id === selected));
  const pasteStyle = () => {
    const o = opsRef.current.find((x) => x.id === selected);
    const style = styles.styleFor(o);
    if (!o || !style) return;
    record();
    setOps((cur) => cur.map((x) => (x.id === o.id ? ({ ...x, ...style } as PdfItem) : x)));
    Object.entries(style).forEach(([k, v]) => v === undefined && setOps((cur) => cur.map((x) => { if (x.id !== o.id) return x; const { [k]: _gone, ...rest } = x; void _gone; return rest as PdfItem; })));
  };

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
      history.push(base);
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

  /** Eraser: everything the pointer touches that you added is removed, in one undo step. */
  function sweep(e: RPointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    dropFocus();
    record();
    const gone = new Set<number>();
    const hit = (x: number, y: number) => {
      document.elementsFromPoint(x, y).forEach((el) => {
        const id = Number((el as HTMLElement).closest?.("[data-oid]")?.getAttribute("data-oid"));
        if (id && !gone.has(id)) {
          gone.add(id);
          setOps((cur) => cur.filter((o) => o.id !== id));
        }
      });
    };
    hit(e.clientX, e.clientY);
    track(
      (ev) => hit(ev.clientX, ev.clientY),
      () => {
        if (!gone.size) history.dropLast(); // nothing touched: no undo step
        setSelected(null);
      },
    );
  }

  function onItemDown(e: RPointerEvent, op: PdfItem) {
    if (e.button !== 0) return;
    if (tool === "eraser") return sweep(e);
    if (!(tool === "text" && op.type === "text")) dropFocus();
    const textClick = tool === "text" && op.type === "text"; // in the text tool a click retypes, a drag moves
    if (tool !== "select" && !textClick) return; // let the page start drawing
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
      () => {
        if (textClick && !moved) startEdit(op.id);
      },
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
        if (op.type === "origimg" && id.length === 2 && !ev.shiftKey) {
          const w0 = Math.max(1, num(o.x1) - num(o.x0)), h0 = Math.max(1, num(o.y1) - num(o.y0));
          const q = sideResize({ x0: num(o.x0), y0: num(o.y0), x1: num(o.x1), y1: num(o.y1) }, id, p);
          const nw = Math.max(10, q.x1 - q.x0), nh = (nw * h0) / w0;
          patch(op.id, { x0: q.x0, x1: q.x0 + nw, y0: id.includes("n") ? q.y1 - nh : q.y0, y1: id.includes("n") ? q.y1 : q.y0 + nh });
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
    if (tool === "eraser") return sweep(e);
    if (tool === "retext") {
      void retype(n, p);
      return;
    }
    if (tool === "select") {
      setSelected(null);
      setEditing(null);
      setOrigSel(null);
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

  /** Highlight, underline and strike follow the real words: drag from one word to another, or click one word. */
  async function markText(g: Ghost, big: boolean) {
    const t = g.tool as "highlight" | "underline" | "strike";
    if (file) {
      try {
        const r = await post<{ found: boolean; lines: number[][] }>("/pdf/text-between", { input: file, page: g.page, ax: g.a.x, ay: g.a.y, bx: g.b.x, by: g.b.y });
        if (r.found && r.lines.length) {
          record();
          const items = r.lines.map(([x0, y0, x1, y1]): PdfItem => ({ id: idc.current++, page: g.page, type: t, x0, y0, x1, y1, color: defs.color, opacity: defs.opacity }));
          setOps((cur) => [...cur, ...items]);
          return;
        }
      } catch {
        /* fall back to the dragged box */
      }
    }
    if (big) {
      const r = normalizeRect(g.a, g.b);
      add({ page: g.page, type: t, ...r, color: defs.color, opacity: defs.opacity });
    } else setMessage("There is no text here to mark. Drag over words, or use a box on a scanned page.");
  }

  /** Click on the page's own text: cover that line and put the same words, editable, on top. */
  async function retype(n: number, p: Pt) {
    if (!file) return;
    setSelected(null);
    try {
      const r = await post<{ found: boolean; text: string; rect: number[]; size: number; color: string; font: string; bold: boolean; italic: boolean }>("/pdf/text-at", { input: file, page: n, x: p.x, y: p.y });
      if (!r.found) {
        setMessage("There is no text of the page here. To add new text, use the Text tool.");
        return;
      }
      setMessage("");
      record();
      const coverId = idc.current++;
      const textId = idc.current++;
      const [x0, y0, x1, y1] = r.rect;
      const cover: PdfItem = { id: coverId, partner: textId, type: "cover", bg: sampleBg(n, r.rect), page: n, x0, y0, x1, y1 };
      const text: PdfItem = { id: textId, partner: coverId, type: "text", page: n, x: x0, y: y0, text: r.text, size: r.size, font: matchFont(r.font, fonts, defs.font), bold: r.bold, italic: r.italic, color: r.color, opacity: 1 };
      pendingBase.current = null;
      setOps((cur) => [...cur, cover, text]);
      setSelected(textId);
      setEditing(textId);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
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
        done(add({ ...base, type: "text", x: a.x - 60, y: a.y - 14, text: stamp.text.replace("{date}", new Date().toLocaleDateString()), size: 28, bold: true, color: stamp.color, border: stamp.color, background: "#ffffff", opacity: 0.9, rotate: -12, font: defs.font }));
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
        void markText(g, big);
        return;
      case "rect":
      case "ellipse":
        if (big) done(add({ ...base, type: t, ...r, color: defs.color, width: defs.width, opacity: defs.opacity, ...(defs.fill ? { fill: defs.fillColor } : {}) }));
        return;
      case "erase":
      case "redact":
        if (big) done(add({ ...base, type: t, ...r }));
        return;
      case "field":
        if (big) done(add({ ...base, type: "field", kind: "text", name: "", ...r }));
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
      } else if (mod && e.shiftKey && k === "c" && sel) {
        copyStyle();
      } else if (mod && e.shiftKey && k === "v") {
        e.preventDefault();
        pasteStyle();
      } else if (mod && k === "c" && sel) {
        clip.current = sel;
      } else if (mod && k === "v" && clip.current) {
        e.preventDefault();
        const { id: _id, ...rest } = clip.current;
        void _id;
        const item = add({ ...translate(rest as PdfOp, 14, 14), page: current });
        setSelected(item.id);
      } else if ((k === "delete" || k === "backspace") && !sel && origSel) {
        e.preventDefault();
        deleteOrig();
      } else if ((k === "delete" || k === "backspace") && sel) {
        e.preventDefault();
        remove(sel.id);
      } else if (k === "enter" && sel?.type === "text") {
        e.preventDefault();
        startEdit(sel.id);
      } else if (k === "escape") {
        setOrigSel(null);
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
  }, [undo, redo, selected, editing, current, image, origSel]);

  useEffect(() => {
    if (!layers || !file) return;
    pages.forEach((_d, n) => {
      if (objs.has(n) || (total > 0 && n > total)) return;
      post<PageObjects>("/pdf/page-objects", { input: file, page: n })
        .then((o) => setObjs((m) => new Map(m).set(n, o)))
        .catch((e) => !gone(e) && setMessage(`Could not read the text of page ${n}: ${e instanceof Error ? e.message : String(e)}`));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, pages, file]);

  /** Switch to another working copy of the document (page changes, undo of page changes). */
  function swapFile(next: string) {
    fileRef.current = next;
    setFile(next);
    setTotal(0); // no page is asked for until the new document says how many it has
    setPages(new Map());
    setObjs(new Map());
    setOrigSel(null);
    loading.current = new Set();
    pageEls.current = new Map();
  }

  /** The document with your edits written in, so that splitting or extracting includes them. */
  async function bake(): Promise<string> {
    if (!file) throw new Error("no file");
    const keep = ops.filter((o) => !isEmptyItem(o));
    if (!keep.length && !numbersRequest(numbers)) return file;
    const r = await post<{ path: string }>("/pdf/work/edit", { input: file, ops: strip(keep), flatten, numbers: numbersRequest(numbers) });
    return r.path;
  }

  async function extractPages(range: string) {
    if (!file) return;
    const output = await save({ filters: pdfFilter, defaultPath: baseName(origFile ?? file).replace(/\.pdf$/i, "") + "-pages.pdf" });
    if (!output) return;
    try {
      const src = await bake();
      await task.run("/pdf/split", { input: src, pages: range, output });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function splitBefore(at: number = current) {
    if (!file || at <= 1) return;
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    try {
      const src = await bake();
      await task.run("/pdf/split-parts", { input: src, out_dir: dir, at: [at], name: baseName(origFile ?? file).replace(/\.pdf$/i, "") });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  /** Dragging a thumbnail reorders the pages. Pointer events are used on purpose: the desktop shell takes over HTML5 drag and drop. */
  function onThumbDown(e: RPointerEvent, from: number) {
    if (e.button !== 0 || pageBusy) return;
    const y0 = e.clientY;
    let started = false;
    const slotAt = (clientY: number): number => {
      const items = Array.from(stripEl.current?.querySelectorAll<HTMLElement>("[data-thumb]") ?? []);
      for (const el of items) {
        const r = el.getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return Number(el.dataset.thumb);
      }
      return items.length + 1;
    };
    track(
      (ev) => {
        if (!started && Math.abs(ev.clientY - y0) < 6) return;
        started = true;
        setDrag({ from, over: slotAt(ev.clientY) });
      },
      (ev) => {
        if (!started) return;
        suppressClick.current = true;
        setTimeout(() => (suppressClick.current = false), 0);
        const slot = slotAt(ev.clientY);
        setDrag(null);
        const to = slot > from ? slot - 1 : slot;
        if (to !== from) void pageOp("move", from, to);
      },
    );
  }

  /** Delete, move, rotate, duplicate, add pages. Your items follow their pages. */
  async function pageOp(kind: PageOp | "move", at: number = current, to?: number) {
    if (!file) return;
    if (kind === "split") return void splitBefore(at);
    const n = at;
    const N = total;
    const all = Array.from({ length: N }, (_, i) => i + 1);
    type Entry = { source: number; page: number; rotate?: number; blank?: boolean; width?: number; height?: number };
    let plan: Entry[] = all.map((p) => ({ source: 0, page: p }));
    let sources = [file];
    let remap: (p: number) => number | null = (p) => p;
    let landOn = n;
    if (kind === "delete") {
      if (N <= 1) return;
      plan = plan.filter((e) => e.page !== n);
      remap = (p) => (p === n ? null : p > n ? p - 1 : p);
      landOn = Math.min(n, N - 1);
    } else if (kind === "move") {
      if (to === undefined || to === n || to < 1 || to > N) return;
      const [moved] = plan.splice(n - 1, 1);
      plan.splice(to - 1, 0, moved);
      remap = (p) => (p === n ? to : n < to && p > n && p <= to ? p - 1 : n > to && p >= to && p < n ? p + 1 : p);
      landOn = to;
    } else if (kind === "up" || kind === "down") {
      const m = kind === "up" ? n - 1 : n + 1;
      if (m < 1 || m > N) return;
      [plan[n - 1], plan[m - 1]] = [plan[m - 1], plan[n - 1]];
      remap = (p) => (p === n ? m : p === m ? n : p);
      landOn = m;
    } else if (kind === "rotate-left" || kind === "rotate-right") {
      if (opsRef.current.some((o) => o.page === n)) return;
      plan[n - 1] = { source: 0, page: n, rotate: kind === "rotate-right" ? 90 : 270 };
    } else if (kind === "duplicate") {
      plan.splice(n, 0, { source: 0, page: n });
      remap = (p) => (p > n ? p + 1 : p);
      landOn = n + 1;
    } else if (kind === "blank") {
      const sz = sizeOf(n);
      plan.splice(n, 0, { source: 0, page: 1, blank: true, width: sz.pw, height: sz.ph });
      remap = (p) => (p > n ? p + 1 : p);
      landOn = n + 1;
    } else if (kind === "merge") {
      const other = await open({ multiple: false, filters: pdfFilter });
      if (typeof other !== "string") return;
      try {
        const info = await post<{ pages: number }>("/pdf/info", { input: other });
        sources = [file, other];
        plan.splice(n, 0, ...Array.from({ length: info.pages }, (_, i): Entry => ({ source: 1, page: i + 1 })));
        remap = (p) => (p > n ? p + info.pages : p);
        landOn = n + 1;
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setPageBusy(true);
    try {
      const r = await post<{ path: string; pages: number }>("/pdf/work/build", { sources, plan });
      record();
      const moved = opsRef.current.flatMap((o): PdfItem[] => {
        const to = remap(o.page);
        return to === null ? [] : [{ ...o, page: to }];
      });
      setOps(moved);
      swapFile(r.path);
      setSelected(null);
      setEditing(null);
      setMessage("");
      setCurrent(landOn);
      setTimeout(() => pageEls.current.get(landOn)?.scrollIntoView({ block: "start" }), 400);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setPageBusy(false);
    }
  }

  /* ---- the page's own text and pictures ---- */
  const origKey = (kind: "t" | "i", page: number, id: number | string) => `${kind}:${page}:${id}`;

  /** The colour around a box on the rendered page, so a cover looks like the page in the preview (the saved file keeps the real background). */
  function sampleBg(page: number, rect: number[]): string {
    try {
      const img = pageEls.current.get(page)?.querySelector("img");
      const pw = objs.get(page)?.width;
      if (!img || !pw || !img.naturalWidth) return "#ffffff";
      const k = img.naturalWidth / pw;
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d", { willReadFrequently: true });
      if (!g) return "#ffffff";
      g.drawImage(img, 0, 0);
      const [x0, y0, x1, y1] = rect.map((v) => v * k);
      const pts: [number, number][] = [];
      for (let i = 0; i <= 4; i++) {
        const fx = x0 + ((x1 - x0) * i) / 4, fy = y0 + ((y1 - y0) * i) / 4;
        pts.push([fx, y0 - 3], [fx, y1 + 3], [x0 - 3, fy], [x1 + 3, fy]);
      }
      const px = pts.filter(([x, y]) => x >= 0 && y >= 0 && x < c.width && y < c.height).map(([x, y]) => g.getImageData(Math.round(x), Math.round(y), 1, 1).data);
      if (!px.length) return "#ffffff";
      const med = (i: number) => px.map((d) => d[i]).sort((a, b) => a - b)[Math.floor(px.length / 2)];
      return `rgb(${med(0)} ${med(1)} ${med(2)})`;
    } catch {
      return "#ffffff";
    }
  }

  /** Turns a block of the page's own text into things you added: a white cover plus the same words, ready to move or retype. */
  function convertText(page: number, t: OrigText): number {
    record();
    const coverId = idc.current++;
    const textId = idc.current++;
    const key = origKey("t", page, t.id);
    const [x0, y0, x1, y1] = t.rect;
    const cover: PdfItem = { id: coverId, partner: textId, orig: key, type: "cover", bg: sampleBg(page, t.rect), page, x0, y0, x1, y1 };
    const text: PdfItem = { id: textId, partner: coverId, orig: key, type: "text", page, x: x0, y: y0, text: t.text, size: t.size, font: matchFont(t.font, fonts, defs.font), bold: t.bold, italic: t.italic, color: t.color, opacity: 1 };
    pendingBase.current = null;
    setOps((cur) => [...cur, cover, text]);
    setOrigSel(null);
    setSelected(textId);
    return textId;
  }

  async function convertImage(page: number, im: OrigPicture): Promise<number> {
    record();
    const id = idc.current++;
    const [x0, y0, x1, y1] = im.rect;
    const item: PdfItem = { id, orig: origKey("i", page, `${im.xref}@${Math.round(x0)}:${Math.round(y0)}`), type: "origimg", bg: sampleBg(page, im.rect), page, xref: im.xref, x0, y0, x1, y1, ox0: x0, oy0: y0, ox1: x1, oy1: y1 };
    setOps((cur) => [...cur, item]);
    setOrigSel(null);
    setSelected(id);
    try {
      if (file) {
        const r = await post<{ image: string }>("/pdf/original-image", { input: file, xref: im.xref });
        setOps((cur) => cur.map((o) => (o.id === id ? { ...o, previewData: `data:image/png;base64,${r.image}` } : o)));
      }
    } catch {
      /* the picture is still moved on save; it just is not previewed */
    }
    return id;
  }

  function deleteOrig() {
    const o = origSel;
    if (!o) return;
    if (o.kind === "t") {
      record();
      const [x0, y0, x1, y1] = (o.obj as OrigText).rect;
      const item: PdfItem = { id: idc.current++, orig: o.key, type: "cover", bg: sampleBg(o.page, (o.obj as OrigText).rect), page: o.page, x0, y0, x1, y1 };
      setOps((cur) => [...cur, item]);
      setOrigSel(null);
    } else {
      void convertImage(o.page, o.obj as OrigPicture).then((id) => {
        setOps((cur) => cur.map((x) => (x.id === id ? { ...x, deleted: true } : x)));
        setSelected(null);
      });
    }
  }

  /** Press on the page's own text or picture: a click selects it, dragging moves it, double-click retypes text. */
  function onOrigDown(e: RPointerEvent | null, page: number, kind: "t" | "i", obj: OrigText | OrigPicture) {
    if (e && e.button !== 0) return;
    e?.stopPropagation();
    e?.preventDefault();
    dropFocus();
    commitIfEmpty();
    setSelected(null);
    setEditing(null);
    const key = kind === "t" ? origKey("t", page, (obj as OrigText).id) : origKey("i", page, `${(obj as OrigPicture).xref}@${Math.round(obj.rect[0])}:${Math.round(obj.rect[1])}`);
    setOrigSel({ key, page, kind, obj });
    if (!e) return; // chosen without a press (a background picture: double-click)
    const start = ptFrom(page, e);
    let last = start;
    let moved = false;
    let target: number | null = null;
    track(
      (ev) => {
        const p = ptFrom(page, ev);
        if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
        const dx = p.x - last.x, dy = p.y - last.y;
        if (!moved) {
          moved = true;
          if (kind === "t") target = convertText(page, obj as OrigText);
          else void convertImage(page, obj as OrigPicture).then((id) => (target = id));
        }
        last = p;
        const id = target;
        if (id === null) return;
        setOps((cur) => cur.map((o) => (o.id === id ? ({ ...o, ...translate(o, dx, dy) } as PdfItem) : o)));
      },
      () => {
        if (!moved && kind === "t") {
          const id = convertText(page, obj as OrigText);
          setEditing(id);
        }
      },
    );
  }

  function onOrigDouble(page: number, kind: "t" | "i", obj: OrigText | OrigPicture) {
    if (kind !== "t") return;
    const id = convertText(page, obj as OrigText);
    setEditing(id);
  }

  async function choose() {
    const picked = await open({ multiple: false, filters: pdfFilter });
    if (typeof picked === "string") openFile(picked);
  }

  const dirty = file !== null && stateKey() !== savedKey;
  /** Close the PDF or open another one, asking first when there are edits that were not saved. */
  function leave(what: "close" | "open") {
    if (dirty) setAsk(what);
    else void doLeave(what);
  }
  async function doLeave(what: "close" | "open") {
    setAsk(null);
    if (what === "open") await choose();
    else {
      setFile(null);
      setOrigFile(null);
      fileRef.current = null;
      setOps([]);
      history.clear();
      setSavedKey("");
    }
  }

  // a file dropped on the window (or chosen on the start screen) opens as soon as the editor appears
  useEffect(() => {
    const dropped = takePending();
    if (dropped) openFile(dropped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openFile(picked: string) {
    reallyOpen(picked);
  }

  function reallyOpen(picked: string) {
    setFile(picked);
    setOrigFile(picked);
    fileRef.current = picked;
    setObjs(new Map());
    setOrigSel(null);
    setSavedKey(JSON.stringify([[], null, picked]));
    setNumbers(NUMBERS_OFF);
    setOps([]);
    history.clear();
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
    const output = await save({ filters: pdfFilter, defaultPath: baseName(origFile ?? file).replace(/\.pdf$/i, "") + "-edited.pdf" });
    if (!output) return;
    const job = await task.run("/pdf/edit", { input: file, output, ops: strip(keep), flatten, numbers: numbersRequest(numbers) });
    if (job?.state === "done") setSavedKey(stateKey());
  }

  const changedPages = useMemo(() => pagesWithEdits(ops), [ops]);
  const sel = ops.find((o) => o.id === selected) ?? null;
  const converted = useMemo(() => new Set(ops.map((o) => (typeof o.orig === "string" ? o.orig : "")).filter(Boolean)), [ops]);
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
          <b>{baseName(origFile ?? file)}</b>
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
        
        <PagesMenu current={current} total={total} hasEdits={ops.some((o) => o.page === current)} busy={pageBusy} onOp={(op) => void pageOp(op, current)} onExtract={(r) => void extractPages(r)} />
        <NumbersButton n={numbers} onChange={setNumbers} fonts={fonts} onFonts={setFonts} />
        <SaveState dirty={dirty} hasEdits={ops.some((o) => !isEmptyItem(o)) || file !== origFile} />
        <FileMenu flatten={flatten} onFlatten={setFlatten} onOpen={() => leave("open")} onClose={() => leave("close")} />
        <button className="primary" disabled={(!ops.some((o) => !isEmptyItem(o)) && !numbersRequest(numbers) && file === origFile) || task.busy} onClick={saveCopy}>
          {task.busy ? "Saving…" : "Save a copy…"}
        </button>
      </div>

      {(task.busy || task.message || message) && (
        <div className="pdfstatus">
          {task.busy && <ProgressBar progress={task.progress} onCancel={task.cancel} />}
          <Message m={task.message ?? (message ? { ok: false, text: message } : null)} />
        </div>
      )}

      <div className="pdfmain">
        <nav className="toolrail" aria-label="Editing tools">
          {GROUPS.map((g) => {
            const holdsActive = g.tools.some((t) => t.id === tool);
            const open = !g.title || holdsActive || (railOpen[g.title] ?? RAIL_OPEN_AT_START.includes(g.title));
            return (
              <div key={g.title || "select"} className="toolgroup" role="group" aria-label={g.title || "Select"}>
                {g.title && (
                  <button className="grouptitle" aria-expanded={open} onClick={() => !holdsActive && setRailOpen((c) => ({ ...c, [g.title]: !open }))} title={holdsActive ? "The tool you are using is in this group" : undefined}>
                    <ChevronRight size={11} strokeWidth={2} aria-hidden className={open ? "turned" : ""} />
                    {g.title}
                  </button>
                )}
                {open &&
                  g.tools.map(({ id, label, Icon, key }) => (
                    <button key={id} className={tool === id ? "on" : ""} aria-pressed={tool === id} aria-label={label} title={key ? `${label} (${key})` : label} onClick={() => pickTool(id)}>
                      <Icon size={17} strokeWidth={1.5} aria-hidden />
                      <span>{label}</span>
                    </button>
                  ))}
              </div>
            );
          })}
        </nav>

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
              orig={tool === "select" ? objs.get(n) : undefined}
              origSel={origSel?.page === n ? origSel.key : null}
              converted={converted}
              onOrigDown={onOrigDown}
              onOrigDouble={onOrigDouble}
              numbers={numbers}
              total={total}
              file={baseName(file).replace(/\.[^.]+$/, "")}
            />
          ))}
        </div>

        <aside className="sidepanel" aria-label="Side panel">
          <div className="sidetabs" role="tablist">
            <button role="tab" aria-selected={sideTab === "options"} className={sideTab === "options" ? "on" : ""} onClick={() => setSideTab("options")}>
              Options
            </button>
            <button role="tab" aria-selected={sideTab === "pages"} className={sideTab === "pages" ? "on" : ""} onClick={() => setSideTab("pages")}>
              Pages{total ? ` (${total})` : ""}
            </button>
          </div>
          <div className="sidebody" hidden={sideTab !== "options"}>
          <ContextBar
            tool={tool}
            hint={active.hint}
            sel={sel}
            defs={defs}
            setDefs={setDefs}
            fonts={fonts}
            onFonts={setFonts}
            stamp={stamp}
            setStamp={setStamp}
            mine={mine}
            saveStamps={saveStamps}
            hasStyle={styles.has}
            onCopyStyle={copyStyle}
            onPasteStyle={pasteStyle}
            image={image}
            touch={touch}
            patch={patch}
            onDelete={() => sel && remove(sel.id)}
            onDuplicate={() => sel && duplicate(sel)}
            onReplaceImage={() => chooseImage(false)}
            onPickImage={() => chooseImage(false)}
            focusTick={focusTick}
          />
          </div>
          <div className="sidebody pagestab" hidden={sideTab !== "pages"}>
            <div className="strip" aria-label="Pages" ref={stripEl}>
              <div className="stripadd">
                <button disabled={pageBusy} onClick={() => void pageOp("merge", total)} title="Add the pages of another PDF at the end">
                  <Files size={14} strokeWidth={1.5} aria-hidden /> Add PDF
                </button>
                <button disabled={pageBusy} onClick={() => void pageOp("blank", total)} title="Add a blank page at the end">
                  <FilePlus size={14} strokeWidth={1.5} aria-hidden /> Blank
                </button>
              </div>
              {pageNumbers.map((n) => (
                <div key={n} data-thumb={n} className={`thumb${n === current ? " on" : ""}${drag?.over === n ? " drop-before" : ""}${drag && drag.over === total + 1 && n === total ? " drop-after" : ""}${drag?.from === n ? " lifted" : ""}`}>
                  <button
                    aria-label={`Page ${n}${changedPages.has(n) ? " (edited)" : ""}`}
                    onPointerDown={(e) => onThumbDown(e, n)}
                    onClick={() => {
                      if (suppressClick.current) return void (suppressClick.current = false);
                      scrollToPage(n);
                    }}
                  >
                    {thumbs.get(n) ? <img src={thumbSrc(thumbs.get(n)!)} alt="" draggable={false} /> : <span className="ph" />}
                    <span className="mono">
                      {n}
                      {changedPages.has(n) && <i className="dot" />}
                    </span>
                  </button>
                  <span className="thumbtools">
                    <button className="icon" aria-label={`Duplicate page ${n}`} title="Duplicate this page" onClick={() => void pageOp("duplicate", n)}>
                      <Copy size={12} strokeWidth={1.6} aria-hidden />
                    </button>
                    {n > 1 && (
                      <button className="icon" aria-label={`Split before page ${n}`} title="Split the PDF into two files before this page" onClick={() => void pageOp("split", n)}>
                        <Scissors size={12} strokeWidth={1.6} aria-hidden />
                      </button>
                    )}
                    {total > 1 && (
                      <button className="icon danger" aria-label={`Delete page ${n}`} title="Delete this page" onClick={() => void pageOp("delete", n)}>
                        <Trash2 size={12} strokeWidth={1.6} aria-hidden />
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
      
      {ask && (
        <ConfirmDialog
          title="This PDF has changes you did not save"
          text="Saving makes a copy of the PDF with your edits. Your original is never changed. If you continue without saving, the edits are lost."
          choices={[
            { label: "Save a copy first", kind: "primary", onClick: () => { setAsk(null); void saveCopy(); } },
            { label: ask === "close" ? "Close without saving" : "Open another without saving", kind: "danger", onClick: () => void doLeave(ask) },
          ]}
          onCancel={() => setAsk(null)}
        />
      )}
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
  orig?: PageObjects;
  origSel: string | null;
  converted: Set<string>;
  onOrigDown: (e: RPointerEvent | null, page: number, kind: "t" | "i", obj: OrigText | OrigPicture) => void;
  onOrigDouble: (page: number, kind: "t" | "i", obj: OrigText | OrigPicture) => void;
  numbers: Numbers;
  total: number;
  file: string;
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
        {p.orig && (
          <div className="origlayer" aria-label="Content of the page">
            {p.orig.images.map((im) => {
              const key = `i:${n}:${im.xref}@${Math.round(im.rect[0])}:${Math.round(im.rect[1])}`;
              if (p.converted.has(key)) return null;
              return <div key={key} className={`origbox pic${im.background ? " bg" : ""}${p.origSel === key ? " on" : ""}`} data-orig="image" style={origStyle(im.rect, size)} title={im.background ? "Background picture: double-click to select" : "Click to select, drag to move"} onPointerDown={im.background ? undefined : (e) => p.onOrigDown(e, n, "i", im)} onDoubleClick={im.background ? () => p.onOrigDown(null, n, "i", im) : undefined} />;
            })}
            {p.orig.texts.map((t) => {
              const key = `t:${n}:${t.id}`;
              if (p.converted.has(key)) return null;
              return <div key={key} className={`origbox${p.origSel === key ? " on" : ""}`} data-orig="text" style={origStyle(t.rect, size)} title="Click to edit, drag to move" onPointerDown={(e) => p.onOrigDown(e, n, "t", t)} onDoubleClick={() => p.onOrigDouble(n, "t", t)} />;
            })}
          </div>
        )}
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
        <NumbersOverlay n={p.numbers} page={n} total={p.total} file={p.file} scale={p.width / size.pw} pw={size.pw} ph={size.ph} />
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
  onFonts: (all: string[]) => void;
  stamp: StampDef;
  setStamp: (s: StampDef) => void;
  mine: StampDef[];
  saveStamps: (s: StampDef[]) => void;
  hasStyle: boolean;
  onCopyStyle: () => void;
  onPasteStyle: () => void;
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
function ContextBar({ tool, hint, sel, defs, setDefs, fonts, onFonts, stamp, setStamp, mine, saveStamps, hasStyle, onCopyStyle, onPasteStyle, image, touch, patch, onDelete, onDuplicate, onReplaceImage, onPickImage, focusTick }: BarProps) {
  const text = useRef<HTMLInputElement>(null);
  const [making, setMaking] = useState(false);
  const [newText, setNewText] = useState("");
  const [newColor, setNewColor] = useState("#c42b1c");
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
          <FontPicker value={String(val("font"))} fonts={fonts} onChange={(f) => set("font", f)} onFonts={onFonts} />
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
          {[...STAMPS, ...mine].map((s) => (
            <span key={s.text + s.color} className="stampchip">
              <button className={stamp.text === s.text ? "on" : ""} aria-pressed={stamp.text === s.text} style={stamp.text === s.text ? { color: "#fff", background: s.color, borderColor: s.color } : { color: s.color, borderColor: s.color }} onClick={() => setStamp(s)}>
                {s.text}
              </button>
              {mine.includes(s) && (
                <button className="icon x" aria-label={`Delete stamp ${s.text}`} title="Delete this stamp" onClick={() => saveStamps(mine.filter((m) => m !== s))}>
                  ×
                </button>
              )}
            </span>
          ))}
          {making ? (
            <span className="newstamp">
              <input autoFocus aria-label="Stamp text" placeholder="Your text, e.g. SIGNED {date}" value={newText} onChange={(e) => setNewText(e.target.value)} />
              <input type="color" aria-label="Stamp color" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
              <button
                className="primary"
                disabled={!newText.trim()}
                onClick={() => {
                  const made = { text: newText.trim(), color: newColor };
                  saveStamps([...mine, made]);
                  setStamp(made);
                  setNewText("");
                  setMaking(false);
                }}
              >
                Save stamp
              </button>
              <button onClick={() => setMaking(false)}>Cancel</button>
            </span>
          ) : (
            <button onClick={() => setMaking(true)}>+ Make your own</button>
          )}
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
      {sel?.type === "field" && (
        <>
          <select aria-label="Kind of field" value={String(sel.kind ?? "text")} onChange={(e) => { touch(); patch(sel.id, { kind: e.target.value }); }}>
            <option value="text">Text box</option>
            <option value="checkbox">Tick box</option>
            <option value="combobox">Choose from a list</option>
          </select>
          <input className="ctltext" aria-label="Field name" placeholder="Name of the field, e.g. surname" value={String(sel.name ?? "")} onChange={(e) => { touch(); patch(sel.id, { name: e.target.value }); }} />
          {sel.kind === "combobox" && (
            <input className="ctltext" aria-label="Choices" placeholder="Choices, separated by commas" value={String(sel.choicesText ?? ((sel.choices as string[] | undefined) ?? []).join(", "))} onChange={(e) => { touch(); patch(sel.id, { choicesText: e.target.value }); }} />
          )}
        </>
      )}
      {sel?.type === "redact" && <span className="ctxhint">The text underneath is deleted from the file when you save, so it cannot be copied back.</span>}
      {sel?.type === "erase" && <span className="ctxhint">The original content underneath is covered with white when you save.</span>}
      <span className="spacer" />
      {sel && (
        <>
          {["text", "rect", "ellipse", "line", "arrow", "ink", "highlight", "underline", "strike"].includes(sel.type) && (
            <>
              <button onClick={onCopyStyle} title="Copy how this looks (Ctrl+Shift+C)">Copy style</button>
              <button onClick={onPasteStyle} disabled={!hasStyle} title="Give the copied look to this one (Ctrl+Shift+V)">Paste style</button>
            </>
          )}
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
  rect: "Box", ellipse: "Oval", line: "Line", arrow: "Arrow", pen: "Pen", eraser: "Eraser", erase: "White-out", redact: "Black out", retext: "Change text", field: "Form field",
};

