import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Copy, FilePlus, Plus, RotateCw, Scissors, Square, Trash2 } from "lucide-react";
import { Message, ProgressBar, Title, baseName, pdfFilter, useTask } from "../shared";
import { thumbSrc, useThumbs, type Thumb } from "../pdfview";
import { takePendingMany } from "../lib/handoff";
import { cutEvery, moveTiles, selectTile, splitParts, summary, type Tile } from "../lib/pageplan";

const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "");
const STRIPES = ["#2563eb", "#c2410c", "#15803d", "#7e22ce", "#b45309", "#0e7490"];

/** Loads one source's thumbnails and tells the screen about them; renders nothing. */
function SourceLoader({ file, index, onData }: { file: string; index: number; onData: (index: number, thumbs: Map<number, Thumb>, total: number, error: string) => void }) {
  const { thumbs, total, error } = useThumbs(file, 150);
  useEffect(() => onData(index, thumbs, total, error), [thumbs, total, error]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Merge, split, reorder, rotate and remove pages: every page of every PDF is a tile. */
export function Pages({ onDone }: { onDone: () => void }) {
  const [sources, setSources] = useState<string[]>([]);
  const [thumbs, setThumbs] = useState<Map<number, Map<number, Thumb>>>(new Map());
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [every, setEvery] = useState("");
  const task = useTask(onDone);
  const nextId = useRef(1);
  const added = useRef(new Set<number>()); // sources whose pages are already tiles

  function addSources(paths: string[]) {
    setSources((cur) => [...cur, ...paths.filter((p) => !cur.includes(p))]);
  }

  useEffect(() => {
    const dropped = takePendingMany(); // PDFs dropped on the window together
    if (dropped.length) addSources(dropped);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onData(index: number, t: Map<number, Thumb>, total: number, error: string) {
    setThumbs((m) => new Map(m).set(index, t));
    setErrors((e) => (e[index] === error ? e : { ...e, [index]: error }));
    if (total > 0 && !added.current.has(index)) {
      added.current.add(index);
      setTiles((cur) => [...cur, ...Array.from({ length: total }, (_, i): Tile => ({ id: nextId.current++, source: index, page: i + 1, rotate: 0 }))]);
    }
  }

  async function choose() {
    const picked = await open({ multiple: true, filters: pdfFilter });
    if (Array.isArray(picked)) addSources(picked);
    else if (typeof picked === "string") addSources([picked]);
  }

  const rotate = () => setTiles((cur) => cur.map((t) => (sel.has(t.id) ? { ...t, rotate: (t.rotate + 90) % 360 } : t)));
  const remove = () => {
    setTiles((cur) => cur.filter((t) => !sel.has(t.id)));
    setSel(new Set());
  };
  const duplicate = () => setTiles((cur) => cur.flatMap((t) => (sel.has(t.id) ? [t, { ...t, id: nextId.current++, cut: false }] : [t])));
  const blankAfter = () => {
    const last = [...tiles].reverse().find((t) => sel.has(t.id));
    const at = last ? tiles.indexOf(last) + 1 : tiles.length;
    setTiles((cur) => [...cur.slice(0, at), { id: nextId.current++, source: 0, page: 1, rotate: 0, blank: true }, ...cur.slice(at)]);
  };
  const toggleCut = (id: number) => setTiles((cur) => cur.map((t) => (t.id === id ? { ...t, cut: !t.cut } : t)));
  const dropOn = (to: number) => setTiles((cur) => moveTiles(cur, sel, to));

  const parts = useMemo(() => splitParts(tiles), [tiles]);
  const locked = Object.values(errors).find(Boolean);

  async function run() {
    if (!tiles.length) return;
    const base = sources.length === 1 ? stem(sources[0]) : "pages";
    let outs: string[];
    if (parts.length === 1) {
      const output = await save({ filters: pdfFilter, defaultPath: `${base}-${sources.length > 1 ? "merged" : "edited"}.pdf` });
      if (!output) return;
      outs = [output];
    } else {
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir !== "string") return;
      const sep = dir.includes("\\") ? "\\" : "/";
      const pad = String(parts.length).length;
      outs = parts.map((_, i) => `${dir.replace(/[\\/]+$/, "")}${sep}${base}-${String(i + 1).padStart(pad, "0")}.pdf`);
    }
    await task.run("/pdf/assemble", { sources, parts: parts.map((plan, i) => ({ output: outs[i], plan })) });
  }

  return (
    <>
      <Title title="Pages" hint="Merge, split and reorder in one place. Add one or more PDFs, then drag pages, rotate or remove them. Click the scissors to start a new file after a page. Your originals are never changed." />
      {sources.map((s, i) => (
        <SourceLoader key={s} file={s} index={i} onData={onData} />
      ))}

      <div className="pg-bar">
        <button onClick={choose}>
          <Plus size={14} strokeWidth={1.5} /> {sources.length ? "Add another PDF…" : "Add PDFs…"}
        </button>
        {sources.length > 0 && (
          <>
            <span className="pg-sep" />
            <button disabled={!sel.size} onClick={rotate}>
              <RotateCw size={14} strokeWidth={1.5} /> Rotate
            </button>
            <button disabled={!sel.size} onClick={duplicate}>
              <Copy size={14} strokeWidth={1.5} /> Duplicate
            </button>
            <button disabled={!sel.size} onClick={remove}>
              <Trash2 size={14} strokeWidth={1.5} /> Remove
            </button>
            <button onClick={blankAfter}>
              <FilePlus size={14} strokeWidth={1.5} /> Blank page
            </button>
            <button onClick={() => setSel(new Set(tiles.map((t) => t.id)))}>Select all</button>
            <span className="pg-sep" />
            <label className="pg-every">
              Split every
              <input
                type="number"
                min={1}
                value={every}
                placeholder="–"
                aria-label="Split every this many pages"
                onChange={(e) => {
                  setEvery(e.target.value);
                  setTiles((cur) => cutEvery(cur, Math.max(0, Math.floor(Number(e.target.value)) || 0)));
                }}
              />
              pages
            </label>
          </>
        )}
      </div>

      <ul className="pg-sources" aria-label="Files in this list">
        {sources.map((s, i) => (
          <li key={s}>
            <i style={{ background: STRIPES[i % STRIPES.length] }} />
            {baseName(s)}
            {errors[i] && <span className="bad-note"> · {/password/i.test(errors[i]) ? "password protected: unlock it first (Protect)" : errors[i]}</span>}
          </li>
        ))}
      </ul>

      {!sources.length && (
        <div className="pg-empty">
          <p>Add the PDFs you want to merge, split or reorder.</p>
          <button className="primary" onClick={choose}>
            Add PDFs…
          </button>
        </div>
      )}

      {tiles.length > 0 && (
        <div className="pg-grid" onClick={() => setSel(new Set())}>
          {tiles.map((t, idx) => {
            const th = t.blank ? undefined : thumbs.get(t.source)?.get(t.page);
            const on = sel.has(t.id);
            return (
              <div
                key={t.id}
                className={`pg-tile${on ? " on" : ""}${t.cut ? " cut" : ""}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  if (!on) {
                    setSel(new Set([t.id]));
                    setAnchor(t.id);
                  }
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => dropOn(idx)}
                onClick={(e) => {
                  e.stopPropagation();
                  setSel((cur) => selectTile(tiles, cur, anchor, t.id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "one"));
                  if (!e.shiftKey) setAnchor(t.id);
                }}
                role="group"
                aria-label={`Position ${idx + 1}${t.blank ? ", blank page" : `, ${baseName(sources[t.source] ?? "")} page ${t.page}`}`}
                aria-selected={on}
              >
                <i className="pg-stripe" style={{ background: t.blank ? "transparent" : STRIPES[t.source % STRIPES.length] }} />
                <div className="pg-thumb">
                  {t.blank ? <Square size={28} strokeWidth={1} /> : th ? <img src={thumbSrc(th)} alt="" draggable={false} style={{ transform: `rotate(${t.rotate}deg)` }} /> : <span className="ph" />}
                </div>
                <div className="pg-meta">
                  <b className="mono">{idx + 1}</b>
                  <small className="note">{t.blank ? "blank" : `p. ${t.page}${t.rotate ? ` · ${t.rotate}°` : ""}`}</small>
                  <button
                    className={`icon pg-cut${t.cut ? " on" : ""}`}
                    aria-label={t.cut ? `Remove the split after position ${idx + 1}` : `Start a new file after position ${idx + 1}`}
                    aria-pressed={!!t.cut}
                    title={t.cut ? "A new file starts after this page" : "Start a new file after this page"}
                    disabled={idx === tiles.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCut(t.id);
                    }}
                  >
                    <Scissors size={13} strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tiles.length > 0 && (
        <div className="pg-save">
          <span className="mono" aria-live="polite">
            {summary(tiles)}
          </span>
          <button className="primary" disabled={task.busy || !!locked} onClick={() => void run()}>
            {task.busy ? "Saving…" : parts.length > 1 ? `Save ${parts.length} files…` : "Save PDF…"}
          </button>
        </div>
      )}
      {task.busy && <ProgressBar progress={task.progress} onCancel={task.cancel} />}
      <Message m={task.message} />
    </>
  );
}
