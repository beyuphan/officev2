import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ArrowRight, Copy, RotateCw, X } from "lucide-react";
import { RunBar, Segmented, SourceField, TextField, Title, baseName, pdfFilter, useTask } from "../shared";
import { PagePreview, PdfSource, thumbSrc, useRendered, useThumbs, type Box } from "../pdfview";
import { describePlan } from "../lib/ranges";
import { post } from "../api";

const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "");

/* ------------------------------------------------------------------------------------------ */
/* Convert, compress, clean metadata                                                          */
/* ------------------------------------------------------------------------------------------ */

type Mode = "word" | "office" | "compress" | "metadata";

const officeFilter = [
  { name: "Office documents", extensions: ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt"] },
];

const MODES: Record<Mode, { label: string; hint: string; path: string; filter: typeof pdfFilter; ext: string; suffix: string }> = {
  word: {
    label: "PDF to Word",
    hint: "Create an editable .docx. Simple documents convert well; complex layouts and scans will not be perfect.",
    path: "/pdf/to-docx",
    filter: pdfFilter,
    ext: "docx",
    suffix: "",
  },
  office: {
    label: "Office to PDF",
    hint: "Convert Word, Excel, PowerPoint and OpenDocument files with LibreOffice. LibreOffice must be installed.",
    path: "/pdf/from-office",
    filter: officeFilter,
    ext: "pdf",
    suffix: "",
  },
  compress: {
    label: "Compress",
    hint: "Shrink image-heavy PDFs by lowering image resolution and quality. Text stays sharp.",
    path: "/pdf/compress",
    filter: pdfFilter,
    ext: "pdf",
    suffix: "-small",
  },
  metadata: {
    label: "Clean metadata",
    hint: "Remove title, author, creator and other hidden fields from a PDF copy.",
    path: "/pdf/clean-metadata",
    filter: pdfFilter,
    ext: "pdf",
    suffix: "-clean",
  },
};

export function Convert({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>("word");
  const [file, setFile] = useState<string | null>(null);
  const [dpi, setDpi] = useState("120");
  const [quality, setQuality] = useState("70");
  const task = useTask(onDone);
  const m = MODES[mode];

  async function go() {
    if (!file) return;
    const output = await save({
      filters: [{ name: m.ext.toUpperCase(), extensions: [m.ext] }],
      defaultPath: `${stem(file)}${m.suffix}.${m.ext}`,
    });
    if (!output) return;
    await task.run(m.path, {
      input: file,
      output,
      ...(mode === "compress" ? { dpi: Number(dpi), quality: Number(quality) } : {}),
    });
  }

  return (
    <>
      <Title title="Convert" hint={m.hint} />
      <Segmented
        label="Action"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setFile(null);
        }}
        options={(Object.keys(MODES) as Mode[]).map((k) => ({ id: k, label: MODES[k].label }))}
      />
      {mode === "office" ? (
        <SourceField label="Source" file={file} onPick={setFile} filters={m.filter} />
      ) : (
        <PdfSource file={file} onPick={setFile} />
      )}
      {mode === "compress" && (
        <div className="row3">
          <TextField id="c-dpi" label="Image DPI" type="number" mono value={dpi} onChange={setDpi} hint="72 screen, 150 office" />
          <TextField id="c-q" label="JPEG quality" type="number" mono value={quality} onChange={setQuality} hint="1 to 100" />
        </div>
      )}
      <RunBar label="Convert to…" busyLabel="Working…" disabled={!file} onRun={go} task={task} />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Organize pages: a page manager                                                              */
/* ------------------------------------------------------------------------------------------ */

type Item = { id: number; page: number; rotate: number };

export function Organize({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const { thumbs, total, loading, error } = useThumbs(file, 150);
  const [items, setItems] = useState<Item[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const nextId = useRef(1);
  const dragFrom = useRef<number | null>(null);
  const task = useTask(onDone);

  useEffect(() => {
    nextId.current = 1;
    setItems(Array.from({ length: total }, (_, i) => ({ id: nextId.current++, page: i + 1, rotate: 0 })));
    setSelId(null);
  }, [file, total]);

  const sel = items.find((i) => i.id === selId) ?? null;
  const big = useRendered("/pdf/render", file && sel ? { input: file, page: sel.page, width: 800 } : null);

  const move = (idx: number, d: number) =>
    setItems((cur) => {
      const j = idx + d;
      if (j < 0 || j >= cur.length) return cur;
      const c = [...cur];
      [c[idx], c[j]] = [c[j], c[idx]];
      return c;
    });
  const drop = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to) return;
    setItems((cur) => {
      const c = [...cur];
      const [it] = c.splice(from, 1);
      c.splice(to, 0, it);
      return c;
    });
  };
  const rotate = (id: number) => setItems((cur) => cur.map((i) => (i.id === id ? { ...i, rotate: (i.rotate + 90) % 360 } : i)));
  const duplicate = (idx: number) =>
    setItems((cur) => {
      const c = [...cur];
      c.splice(idx + 1, 0, { ...cur[idx], id: nextId.current++ });
      return c;
    });
  const remove = (id: number) => {
    setItems((cur) => cur.filter((i) => i.id !== id));
    setSelId((s) => (s === id ? null : s));
  };
  const reset = () => {
    nextId.current = 1;
    setItems(Array.from({ length: total }, (_, i) => ({ id: nextId.current++, page: i + 1, rotate: 0 })));
  };

  const changes = useMemo(() => describePlan(items, total), [items, total]);
  const changed = changes[0] !== "No changes yet.";

  async function go() {
    if (!file) return;
    const output = await save({ filters: pdfFilter, defaultPath: `${stem(file)}-organized.pdf` });
    if (output) await task.run("/pdf/organize", { input: file, output, plan: items.map(({ page, rotate }) => ({ page, rotate })) });
  }

  return (
    <>
      <Title
        title="Organize pages"
        hint="Every page is a tile. Drag tiles or use the arrows to reorder, rotate or duplicate a page, remove the ones you do not need. Your original is not modified."
      />
      <PdfSource file={file} onPick={setFile} peek={false} />
      {error && <p className="msg bad">{error}</p>}
      {file && total > 0 && (
        <div className="split">
          <div>
            <div className="ptiles">
              {items.map((it, idx) => {
                const t = thumbs.get(it.page);
                return (
                  <div
                    key={it.id}
                    className={`ptile ${selId === it.id ? "sel" : ""}`}
                    draggable
                    onDragStart={() => (dragFrom.current = idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => drop(idx)}
                    onClick={() => setSelId(it.id)}
                    role="group"
                    aria-label={`Position ${idx + 1}: page ${it.page}`}
                  >
                    <div className="thumbbox">
                      {t ? <img src={thumbSrc(t)} alt="" draggable={false} style={{ transform: `rotate(${it.rotate}deg)` }} /> : <span className="ph" />}
                    </div>
                    <div className="meta">
                      <b className="mono">{idx + 1}</b>
                      <small className="note">
                        page {it.page}
                        {it.rotate ? ` · ${it.rotate}°` : ""}
                      </small>
                    </div>
                    <div className="tools" onClick={(e) => e.stopPropagation()}>
                      <button className="icon" aria-label={`Move page ${it.page} earlier`} disabled={idx === 0} onClick={() => move(idx, -1)}>
                        <ArrowLeft size={14} strokeWidth={1.5} />
                      </button>
                      <button className="icon" aria-label={`Move page ${it.page} later`} disabled={idx === items.length - 1} onClick={() => move(idx, 1)}>
                        <ArrowRight size={14} strokeWidth={1.5} />
                      </button>
                      <button className="icon" aria-label={`Rotate page ${it.page}`} onClick={() => rotate(it.id)}>
                        <RotateCw size={14} strokeWidth={1.5} />
                      </button>
                      <button className="icon" aria-label={`Duplicate page ${it.page}`} onClick={() => duplicate(idx)}>
                        <Copy size={14} strokeWidth={1.5} />
                      </button>
                      <button className="icon" aria-label={`Remove page ${it.page}`} onClick={() => remove(it.id)}>
                        <X size={14} strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {loading && <p className="hint">Loading pages…</p>}
            <div className="changes" aria-label="What will change">
              <h2>What will change</h2>
              <ul>
                {changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p className="hint">The result has {items.length} page{items.length === 1 ? "" : "s"}.</p>
            </div>
          </div>
          <aside className="side">
            {sel && big.data ? (
              <>
                <p className="note">
                  Position {items.findIndex((i) => i.id === sel.id) + 1} · page {sel.page}
                  {sel.rotate ? ` · rotated ${sel.rotate}°` : ""}
                </p>
                <div className="rotbox">
                  <img src={`data:image/png;base64,${big.data.image}`} alt={`Page ${sel.page}`} style={{ transform: `rotate(${sel.rotate}deg)` }} />
                </div>
              </>
            ) : (
              <p className="muted">Click a tile to see that page larger.</p>
            )}
          </aside>
        </div>
      )}
      <div className="actions">
        <button onClick={reset} disabled={!changed}>
          Reset
        </button>
      </div>
      <RunBar label="Save to…" busyLabel="Working…" disabled={!file || items.length === 0 || !changed} onRun={go} task={task} />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Redact: find, review on the page, remove                                                    */
/* ------------------------------------------------------------------------------------------ */

type Found = { pages: { page: number; width: number; height: number; hits: { term: string; rect: [number, number, number, number] }[] }[]; total: number; page_count: number };
type Manual = { id: string; page: number; rect: [number, number, number, number] };

export function Redact({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [terms, setTerms] = useState("");
  const [pages, setPages] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState<Manual[]>([]);
  const [page, setPage] = useState(1);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const task = useTask(onDone);
  const list = terms.split("\n").map((t) => t.trim()).filter(Boolean);

  useEffect(() => {
    setFound(null);
    setOff(new Set());
    setManual([]);
    setPage(1);
    setError("");
  }, [file]);

  async function search() {
    if (!file) return;
    setSearching(true);
    setError("");
    try {
      const res = await post<Found>("/pdf/search", { input: file, terms: list, pages: pages.trim() || null });
      setFound(res);
      setOff(new Set());
      if (res.pages.length) setPage(res.pages[0].page);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  const hitId = (p: number, i: number) => `h${p}:${i}`;
  const selectedHits = (found?.pages ?? []).flatMap((pg) => pg.hits.map((h, i) => ({ id: hitId(pg.page, i), page: pg.page, rect: h.rect }))).filter((h) => !off.has(h.id));
  const perPage = new Map<number, { hits: number; areas: number }>();
  selectedHits.forEach((h) => perPage.set(h.page, { hits: (perPage.get(h.page)?.hits ?? 0) + 1, areas: perPage.get(h.page)?.areas ?? 0 }));
  manual.forEach((m) => perPage.set(m.page, { hits: perPage.get(m.page)?.hits ?? 0, areas: (perPage.get(m.page)?.areas ?? 0) + 1 }));
  const pageList = [...perPage.entries()].sort((a, b) => a[0] - b[0]);
  const totalAreas = selectedHits.length + manual.length;

  const current = found?.pages.find((p) => p.page === page);
  const boxes: Box[] = [
    ...(current?.hits ?? []).map((h, i): Box => ({ id: hitId(page, i), rect: h.rect, tone: off.has(hitId(page, i)) ? "off" : "hit", label: off.has(hitId(page, i)) ? `Keep “${h.term}” (click to redact again)` : `Redact “${h.term}” (click to keep)` })),
    ...manual.filter((m) => m.page === page).map((m): Box => ({ id: m.id, rect: m.rect, tone: "manual", label: "Marked area (click to remove)" })),
  ];

  async function go() {
    if (!file) return;
    const output = await save({ filters: pdfFilter, defaultPath: `${stem(file)}-redacted.pdf` });
    if (!output) return;
    const rects = [...selectedHits.map((h) => ({ page: h.page, rect: h.rect })), ...manual.map((m) => ({ page: m.page, rect: m.rect }))].map(({ page: p, rect }) => ({
      page: p,
      x0: rect[0] - 1,
      y0: rect[1] - 1,
      x1: rect[2] + 1,
      y1: rect[3] + 1,
    }));
    await task.run("/pdf/redact", { input: file, output, rects });
  }

  return (
    <>
      <Title
        title="Redact"
        hint="Find words, check every match on its page, add your own boxes, then remove them. The text under a black box is deleted from the file. Always saves a copy."
      />
      <PdfSource file={file} onPick={setFile} peek={false} />
      {file && (
        <div className="split">
          <div>
            <div className="field">
              <label className="label" htmlFor="r-terms">
                Text to find (one per line)
              </label>
              <textarea id="r-terms" rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} />
            </div>
            <TextField id="r-pages" label="Look only on pages (optional)" mono value={pages} onChange={setPages} hint="Empty means all pages" />
            <div className="actions tight">
              <button disabled={list.length === 0 || searching} onClick={search}>
                {searching ? "Searching…" : "Find"}
              </button>
            </div>
            {error && <p className="msg bad">{error}</p>}
            {found && found.total === 0 && <p className="muted">No matches. Scanned pages have no text to find: run Recognize text first, or draw boxes on the page.</p>}
            <div className="changes" aria-label="What will be removed">
              <h2>What will be removed</h2>
              {totalAreas === 0 ? (
                <p className="muted">Nothing marked yet. Find words, or drag on the page to draw a box.</p>
              ) : (
                <>
                  <p className="hint" style={{ marginTop: 0 }}>
                    {totalAreas} area{totalAreas === 1 ? "" : "s"} on {pageList.length} page{pageList.length === 1 ? "" : "s"}
                  </p>
                  <ul className="pagelist">
                    {pageList.map(([p, c]) => (
                      <li key={p}>
                        <button className={p === page ? "on" : ""} onClick={() => setPage(p)}>
                          Page {p}
                          <small>
                            {c.hits ? `${c.hits} match${c.hits === 1 ? "" : "es"}` : ""}
                            {c.hits && c.areas ? " · " : ""}
                            {c.areas ? `${c.areas} drawn` : ""}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
          <aside className="side">
            <PagePreview file={file} page={page} onPage={setPage} boxes={boxes} onBoxClick={(id) => (id.startsWith("h") ? setOff((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; }) : setManual((m) => m.filter((x) => x.id !== id)))} onDraw={(rect) => setManual((m) => [...m, { id: `m${Date.now()}${m.length}`, page, rect }])} note={() => "Red boxes are matches: click one to keep it. Drag on the page to add a box of your own."} />
          </aside>
        </div>
      )}
      <RunBar label="Redact to…" busyLabel="Redacting…" disabled={!file || totalAreas === 0} onRun={go} task={task} />
    </>
  );
}
