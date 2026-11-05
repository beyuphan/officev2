import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { post } from "../api";
import { RunBar, Table, TextField, Title, baseName, dirName, pdfFilter, useTask } from "../shared";
import { PdfSource, thumbSrc, useRendered, useThumbs } from "../pdfview";
import { parseRanges, toRanges } from "../lib/ranges";

function FirstPage({ file }: { file: string }) {
  const { data } = useRendered("/pdf/render", { input: file, page: 1, width: 72 });
  return data ? <img className="mini" src={`data:image/png;base64,${data.image}`} alt="" /> : <span className="mini blank" />;
}

export function Merge({ onDone }: { onDone: () => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number | "locked" | "error">>({});
  const task = useTask(onDone);

  useEffect(() => {
    files.filter((f) => !(f in counts)).forEach((f) => {
      post<{ pages: number; needs_password: boolean }>("/pdf/info", { input: f })
        .then((i) => setCounts((c) => ({ ...c, [f]: i.needs_password ? "locked" : i.pages })))
        .catch(() => setCounts((c) => ({ ...c, [f]: "error" })));
    });
  }, [files, counts]);

  async function pick() {
    const picked = await open({ multiple: true, filters: pdfFilter });
    if (picked) setFiles((f) => [...f, ...picked]);
  }
  function move(i: number, d: number) {
    setFiles((f) => {
      const j = i + d;
      if (j < 0 || j >= f.length) return f;
      const c = [...f];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });
  }
  async function merge() {
    const output = await save({ filters: pdfFilter, defaultPath: "merged.pdf" });
    if (output) await task.run("/pdf/merge", { inputs: files, output });
  }

  // which pages of the result come from which file
  let at = 1;
  const parts = files.map((f) => {
    const n = counts[f];
    if (typeof n !== "number") return { f, label: null as string | null };
    const label = n === 1 ? `${at}` : `${at}–${at + n - 1}`;
    at += n;
    return { f, label };
  });
  const allKnown = files.length > 0 && files.every((f) => typeof counts[f] === "number");
  const problem = files.find((f) => counts[f] === "locked" || counts[f] === "error");

  return (
    <>
      <Title title="Merge" hint="Combine PDFs in the order listed. The originals are not modified." />
      <Table
        head={
          <tr>
            <th className="num">No.</th>
            <th style={{ width: 56 }}>
              <span className="sr">Preview</span>
            </th>
            <th>File</th>
            <th className="status">Pages in result</th>
            <th className="act">
              <span className="sr">Actions</span>
            </th>
          </tr>
        }
        empty={files.length === 0 ? "No files. Use Add files to start the list." : undefined}
      >
        {parts.map(({ f, label }, i) => (
          <tr key={f + i} className="tall">
            <td className="num mono">{String(i + 1).padStart(2, "0")}</td>
            <td>
              <FirstPage file={f} />
            </td>
            <td>
              {baseName(f)}
              <small className="note" title={f}>
                {" "}
                {dirName(f)}
              </small>
              {counts[f] === "locked" && <small className="note bad-note"> password protected: unlock it first</small>}
              {counts[f] === "error" && <small className="note bad-note"> cannot be read</small>}
            </td>
            <td className="mono nowrap">{label ? `${label}${typeof counts[f] === "number" ? `  (${counts[f]})` : ""}` : "…"}</td>
            <td className="act">
              <button className="icon" aria-label={`Move ${baseName(f)} up`} onClick={() => move(i, -1)} disabled={i === 0}>
                <ArrowUp size={14} strokeWidth={1.5} />
              </button>
              <button className="icon" aria-label={`Move ${baseName(f)} down`} onClick={() => move(i, 1)} disabled={i === files.length - 1}>
                <ArrowDown size={14} strokeWidth={1.5} />
              </button>
              <button className="icon" aria-label={`Remove ${baseName(f)}`} onClick={() => setFiles(files.filter((_, k) => k !== i))}>
                <X size={14} strokeWidth={1.5} />
              </button>
            </td>
          </tr>
        ))}
      </Table>
      {allKnown && <p className="hint">The merged file will have {at - 1} pages.</p>}
      <div className="actions">
        <button onClick={pick}>Add files…</button>
      </div>
      <RunBar label="Merge to…" busyLabel="Merging…" disabled={files.length < 2 || !!problem} onRun={merge} task={task} />
    </>
  );
}

export function Split({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [invalid, setInvalid] = useState(false);
  const { thumbs, total, loading, error } = useThumbs(file, 130);
  const task = useTask(onDone);

  useEffect(() => {
    setSel(new Set());
    setText("");
    setInvalid(false);
  }, [file]);

  function choose(next: Set<number>) {
    setSel(next);
    setText(toRanges(next));
    setInvalid(false);
  }
  function onText(v: string) {
    setText(v);
    const pages = parseRanges(v, total);
    if (pages) {
      setSel(new Set(pages));
      setInvalid(false);
    } else setInvalid(true);
  }
  const toggle = (p: number) => {
    const n = new Set(sel);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    choose(n);
  };
  const all = Array.from({ length: total }, (_, i) => i + 1);

  async function split() {
    const output = await save({ filters: pdfFilter, defaultPath: "extract.pdf" });
    if (output && file) await task.run("/pdf/split", { input: file, pages: toRanges(sel), output });
  }

  return (
    <>
      <Title title="Extract pages" hint="Click the pages you want to keep, or type a range such as 1-3,5,8-. They are written to a new PDF." />
      <PdfSource file={file} onPick={setFile} peek={false} />
      {error && <p className="msg bad">{error}</p>}
      {file && total > 0 && (
        <>
          <div className="actions tight">
            <button onClick={() => choose(new Set(all))}>All</button>
            <button onClick={() => choose(new Set())}>None</button>
            <button onClick={() => choose(new Set(all.filter((p) => p % 2 === 1)))}>Odd</button>
            <button onClick={() => choose(new Set(all.filter((p) => p % 2 === 0)))}>Even</button>
          </div>
          <div className="tiles" role="group" aria-label="Pages">
            {all.map((p) => {
              const t = thumbs.get(p);
              return (
                <button key={p} className={`tile-page ${sel.has(p) ? "on" : ""}`} aria-pressed={sel.has(p)} aria-label={`Page ${p}`} onClick={() => toggle(p)}>
                  {t ? <img src={thumbSrc(t)} alt="" draggable={false} /> : <span className="ph" />}
                  <span className="mono">{p}</span>
                </button>
              );
            })}
          </div>
          {loading && <p className="hint">Loading pages…</p>}
          <TextField id="pages" label="Pages" mono value={text} onChange={onText} hint={invalid ? `Not a valid range for a ${total}-page document.` : `${sel.size} of ${total} pages selected`} />
        </>
      )}
      <RunBar label="Extract to…" busyLabel="Extracting…" disabled={!file || sel.size === 0 || invalid} onRun={split} task={task} />
    </>
  );
}
