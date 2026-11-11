import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { post } from "../api";
import {
  CheckField,
  FolderField,
  RunBar,
  Segmented,
  SelectField,
  SourceField,
  TextField,
  Title,
  baseName,
  pdfFilter,
  useTask,
} from "../shared";
import { PagePreview, PdfSource, type Box, type PageData } from "../pdfview";

const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "");
const num = (v: string, d: number) => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

/* ------------------------------------------------------------------------------------------ */
/* Page numbers, headers and footers                                                           */
/* ------------------------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------------------------ */
/* Crop and paper size                                                                         */
/* ------------------------------------------------------------------------------------------ */

export function PageSize({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"crop" | "paper">("crop");
  const [file, setFile] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [m, setM] = useState({ left: "0", top: "0", right: "0", bottom: "0" });
  const [padding, setPadding] = useState("12");
  const [pages, setPages] = useState("");
  const [paper, setPaper] = useState("A4");
  const [margin, setMargin] = useState("0");
  const [orient, setOrient] = useState("auto");
  const [page, setPage] = useState(1);
  const task = useTask(onDone);

  const margins = { left: num(m.left, 0), top: num(m.top, 0), right: num(m.right, 0), bottom: num(m.bottom, 0) };
  const keep = (d: PageData): Box[] =>
    mode === "crop" && !auto
      ? [{ id: "keep", tone: "info", label: "Kept area", rect: [margins.left, margins.top, Math.max(margins.left + 5, d.page_width - margins.right), Math.max(margins.top + 5, d.page_height - margins.bottom)] }]
      : [];

  async function go() {
    if (!file) return;
    const output = await save({ filters: pdfFilter, defaultPath: `${stem(file)}-${mode === "crop" ? "cropped" : paper}.pdf` });
    if (!output) return;
    if (mode === "crop") await task.run("/pdf/crop-pages", { input: file, output, pages: pages.trim() || null, ...margins, auto, padding: num(padding, 12) });
    else await task.run("/pdf/resize-pages", { input: file, output, size: paper, margin: num(margin, 0), landscape: orient === "auto" ? null : orient === "landscape" });
  }

  return (
    <>
      <Title
        title="Page size"
        hint={mode === "crop" ? "Trim white margins or cut away parts of every page. The text stays; only the visible area changes." : "Fit every page onto a standard paper size without stretching it."}
      />
      <Segmented
        label="Action"
        value={mode}
        onChange={setMode}
        options={[
          { id: "crop", label: "Crop margins" },
          { id: "paper", label: "Change paper size" },
        ]}
      />
      <div className="split">
        <div>
          <PdfSource file={file} onPick={(f) => { setFile(f); setPage(1); }} peek={false} />
          {mode === "crop" ? (
            <>
              <CheckField label="Crop automatically to the content" checked={auto} onChange={setAuto} />
              {auto ? (
                <TextField id="pz-pad" label="Space around the content (pt)" type="number" mono value={padding} onChange={setPadding} />
              ) : (
                <div className="row3">
                  {(["left", "top", "right", "bottom"] as const).map((k) => (
                    <TextField key={k} id={`pz-${k}`} label={`${k[0].toUpperCase()}${k.slice(1)} (pt)`} type="number" mono value={m[k]} onChange={(v) => setM({ ...m, [k]: v })} />
                  ))}
                </div>
              )}
              <TextField id="pz-pages" label="Only pages (optional)" mono value={pages} onChange={setPages} hint="Empty means all pages. 72 points are one inch." />
            </>
          ) : (
            <>
              <div className="row3">
                <SelectField id="pz-paper" label="Paper" value={paper} onChange={setPaper} options={["A3", "A4", "A5", "Letter", "Legal"].map((x) => ({ id: x, label: x }))} />
                <SelectField id="pz-or" label="Orientation" value={orient} onChange={setOrient} options={[{ id: "auto", label: "Follow each page" }, { id: "portrait", label: "Portrait" }, { id: "landscape", label: "Landscape" }]} />
                <TextField id="pz-mg" label="Margin (pt)" type="number" mono value={margin} onChange={setMargin} />
              </div>
            </>
          )}
        </div>
        <aside className="side">
          <PagePreview file={file} page={page} onPage={setPage} boxesFor={keep} note={() => (mode === "crop" ? (auto ? "The page is cut to its content." : "Only the outlined area stays.") : "")} />
        </aside>
      </div>
      <RunBar label="Save to…" busyLabel="Working…" disabled={!file} onRun={go} task={task} />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Add pages / split                                                                           */
/* ------------------------------------------------------------------------------------------ */

export function AddSplit({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"blank" | "pdf" | "split">("blank");
  const [file, setFile] = useState<string | null>(null);
  const [after, setAfter] = useState("0");
  const [count, setCount] = useState("1");
  const [other, setOther] = useState<string | null>(null);
  const [otherPages, setOtherPages] = useState("");
  const [size, setSize] = useState("same");
  const [how, setHow] = useState<"every" | "at" | "bookmarks">("every");
  const [every, setEvery] = useState("2");
  const [at, setAt] = useState("");
  const [outDir, setOutDir] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const task = useTask(onDone);

  useEffect(() => {
    if (!file) return setTotal(0);
    post<{ pages: number }>("/pdf/info", { input: file }).then((i) => setTotal(i.pages)).catch(() => setTotal(0));
  }, [file]);
  const afterN = Math.round(num(after, 0));
  const afterOk = afterN >= 0 && afterN <= total;
  const atPages = at.split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 1);

  async function go() {
    if (!file) return;
    if (mode === "split") {
      await task.run("/pdf/split-parts", { input: file, out_dir: outDir, every: how === "every" ? Math.round(num(every, 0)) : 0, at: how === "at" ? atPages : [], by_bookmarks: how === "bookmarks" });
      return;
    }
    const output = await save({ filters: pdfFilter, defaultPath: `${stem(file)}-pages.pdf` });
    if (!output) return;
    await task.run("/pdf/insert", {
      input: file, output, after: afterN,
      source: mode === "pdf" ? other : null, source_pages: mode === "pdf" ? otherPages.trim() || null : null,
      blank: mode === "blank" ? Math.round(num(count, 1)) : 0, size,
    });
  }
  const ready = file && (mode === "split" ? !!outDir && (how !== "every" || num(every, 0) >= 1) && (how !== "at" || atPages.length > 0) : afterOk && (mode === "blank" ? num(count, 0) >= 1 : !!other));

  return (
    <>
      <Title title="Add and split pages" hint="Insert blank pages or pages from another PDF, or cut one PDF into several files." />
      <Segmented
        label="Action"
        value={mode}
        onChange={setMode}
        options={[
          { id: "blank", label: "Insert blank pages" },
          { id: "pdf", label: "Insert pages from a PDF" },
          { id: "split", label: "Split into files" },
        ]}
      />
      <PdfSource file={file} onPick={setFile} />
      {mode !== "split" && (
        <>
          <TextField id="as-after" label={`Insert after page (0 = at the start${total ? `, up to ${total}` : ""})`} type="number" mono value={after} onChange={setAfter} hint={afterOk ? undefined : `Choose a number from 0 to ${total}.`} />
          {mode === "blank" ? (
            <div className="row3">
              <TextField id="as-count" label="How many" type="number" mono value={count} onChange={setCount} />
              <SelectField id="as-size" label="Page size" value={size} onChange={setSize} options={[{ id: "same", label: "Same as the neighbor" }, ...["A4", "A3", "A5", "Letter", "Legal"].map((x) => ({ id: x, label: x }))]} />
            </div>
          ) : (
            <>
              <SourceField label="PDF to take pages from" file={other} onPick={setOther} />
              <TextField id="as-op" label="Pages to take (optional)" mono value={otherPages} onChange={setOtherPages} hint="Empty means all of its pages. Example: 2-4" />
            </>
          )}
        </>
      )}
      {mode === "split" && (
        <>
          <Segmented
            label="Split"
            value={how}
            onChange={setHow}
            options={[
              { id: "every", label: "Every N pages" },
              { id: "at", label: "Before certain pages" },
              { id: "bookmarks", label: "At bookmarks" },
            ]}
          />
          {how === "every" && <TextField id="as-every" label="Pages per file" type="number" mono value={every} onChange={setEvery} />}
          {how === "at" && <TextField id="as-at" label="Start a new file at pages" mono value={at} onChange={setAt} hint="Example: 4, 9, 15" />}
          {how === "bookmarks" && <p className="hint">A new file starts at every top-level bookmark.</p>}
          <FolderField label="Save the files in" value={outDir} onPick={setOutDir} />
        </>
      )}
      <RunBar label={mode === "split" ? "Split" : "Save to…"} busyLabel="Working…" disabled={!ready} onRun={go} task={task} />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Export content                                                                              */
/* ------------------------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------------------------ */
/* Forms                                                                                       */
/* ------------------------------------------------------------------------------------------ */

type Field = { page: number; name: string; type: string; value: string | boolean; choices: string[]; readonly: boolean; rect: number[] };

export function Forms({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [fields, setFields] = useState<Field[] | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [flatten, setFlatten] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const task = useTask(onDone);

  useEffect(() => {
    setFields(null);
    setValues({});
    setError("");
    if (!file) return;
    post<{ fields: Field[] }>("/pdf/forms/list", { input: file })
      .then((r) => {
        setFields(r.fields);
        const v: Record<string, string | boolean> = {};
        r.fields.forEach((f) => (v[f.name] = f.value));
        setValues(v);
        if (r.fields[0]) setPage(r.fields[0].page);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [file]);

  const changed = fields ? fields.filter((f) => !f.readonly && values[f.name] !== f.value) : [];
  const boxes = (d: PageData): Box[] => (fields ?? []).filter((f) => f.page === d.page).map((f) => ({ id: f.name, tone: "info", rect: f.rect as [number, number, number, number], label: f.name }));

  async function go() {
    if (!file) return;
    const output = await save({ filters: pdfFilter, defaultPath: `${stem(file)}-filled.pdf` });
    if (!output) return;
    const send: Record<string, string | boolean> = {};
    changed.forEach((f) => (send[f.name] = values[f.name]));
    await task.run("/pdf/forms/fill", { input: file, output, values: send, flatten });
  }

  return (
    <>
      <Title title="Forms" hint="Fill in the fields of a PDF form. Fields are outlined on the page. Nothing is changed in your original." />
      <div className="split">
        <div>
          <PdfSource file={file} onPick={setFile} peek={false} />
          {error && <p className="msg bad">{error}</p>}
          {fields && fields.length === 0 && <p className="muted">This PDF has no form fields.</p>}
          {fields?.map((f) => (
            <div key={f.name} className="field" onFocus={() => setPage(f.page)}>
              {f.type === "CheckBox" || f.type === "RadioButton" ? (
                <CheckField label={`${f.name} (page ${f.page})`} checked={Boolean(values[f.name])} onChange={(v) => setValues({ ...values, [f.name]: v })} />
              ) : f.choices.length ? (
                <SelectField id={`fm-${f.name}`} label={`${f.name} (page ${f.page})`} value={String(values[f.name] ?? "")} onChange={(v) => setValues({ ...values, [f.name]: v })} options={["", ...f.choices].map((c) => ({ id: c, label: c || "—" }))} />
              ) : (
                <TextField id={`fm-${f.name}`} label={`${f.name} (page ${f.page})${f.readonly ? " · read-only" : ""}`} value={String(values[f.name] ?? "")} onChange={(v) => setValues({ ...values, [f.name]: v })} />
              )}
            </div>
          ))}
          {fields && fields.length > 0 && <CheckField label="Flatten the form" checked={flatten} onChange={setFlatten} hint="Turns the answers into plain page content so they can no longer be edited." />}
        </div>
        <aside className="side">
          <PagePreview file={file} page={page} onPage={setPage} boxesFor={boxes} />
        </aside>
      </div>
      <RunBar label="Save to…" busyLabel="Working…" disabled={!file || changed.length === 0} onRun={go} task={task} />
      {fields && fields.length > 0 && <p className="hint">{changed.length} field{changed.length === 1 ? "" : "s"} changed.</p>}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Properties and bookmarks                                                                    */
/* ------------------------------------------------------------------------------------------ */

type Mark = { level: number; title: string; page: number };

export function Properties({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [meta, setMeta] = useState<Record<string, string>>({ title: "", author: "", subject: "", keywords: "" });
  const [toc, setToc] = useState<Mark[]>([]);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState("");
  const task = useTask(onDone);

  useEffect(() => {
    setError("");
    if (!file) return;
    post<{ metadata: Record<string, string>; toc: [number, string, number][]; pages: number }>("/pdf/props/get", { input: file })
      .then((r) => {
        setMeta({ title: r.metadata.title ?? "", author: r.metadata.author ?? "", subject: r.metadata.subject ?? "", keywords: r.metadata.keywords ?? "" });
        setToc(r.toc.map(([level, title, page]) => ({ level, title, page })));
        setPages(r.pages);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [file]);

  const setMark = (i: number, p: Partial<Mark>) => setToc((cur) => cur.map((m, k) => (k === i ? { ...m, ...p } : m)));
  const valid = toc.every((m) => m.title.trim() && m.page >= 1 && m.page <= pages);

  async function go() {
    if (!file) return;
    const output = await save({ filters: pdfFilter, defaultPath: `${stem(file)}-properties.pdf` });
    if (output) await task.run("/pdf/props/set", { input: file, output, metadata: meta, toc: toc.map((m) => [m.level, m.title.trim(), m.page]) });
  }

  return (
    <>
      <Title title="Properties and bookmarks" hint="Edit the title, author and keywords, and the bookmarks that appear in a PDF reader's sidebar." />
      <PdfSource file={file} onPick={setFile} />
      {error && <p className="msg bad">{error}</p>}
      {file && !error && (
        <>
          <div className="row3">
            {(["title", "author", "subject", "keywords"] as const).map((k) => (
              <TextField key={k} id={`pr-${k}`} label={k[0].toUpperCase() + k.slice(1)} wide value={meta[k] ?? ""} onChange={(v) => setMeta({ ...meta, [k]: v })} />
            ))}
          </div>
          <hr />
          <h2>Bookmarks</h2>
          {toc.length === 0 && <p className="muted">No bookmarks.</p>}
          {toc.map((m, i) => (
            <div key={i} className="stamprow">
              <select aria-label="Level" value={m.level} onChange={(e) => setMark(i, { level: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((l) => (
                  <option key={l} value={l}>
                    Level {l}
                  </option>
                ))}
              </select>
              <input aria-label="Title" value={m.title} onChange={(e) => setMark(i, { title: e.target.value })} />
              <input aria-label="Page" className="mono narrow" type="number" min={1} max={pages} value={m.page} onChange={(e) => setMark(i, { page: Number(e.target.value) })} />
              <button className="icon text" onClick={() => setToc((cur) => cur.filter((_, k) => k !== i))}>
                Remove
              </button>
            </div>
          ))}
          <div className="actions tight">
            <button onClick={() => setToc((cur) => [...cur, { level: cur.length ? cur[cur.length - 1].level : 1, title: "", page: 1 }])}>Add bookmark</button>
          </div>
          {!valid && <p className="hint">Every bookmark needs a title and a page between 1 and {pages}.</p>}
        </>
      )}
      <RunBar label="Save to…" busyLabel="Saving…" disabled={!file || !!error || !valid} onRun={go} task={task} />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Flatten and grayscale                                                                       */
/* ------------------------------------------------------------------------------------------ */

