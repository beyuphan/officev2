import { failed } from "../lib/notify";
import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { CheckField, FolderField, InputsField, ProgressBar, RunBar, Segmented, SelectField, SourceField, TextField, Title, baseName, pdfFilter, useTask } from "../shared";
import { PdfSource } from "../pdfview";
import { get, post, put as putSetting } from "../api";

const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "");

/* ------------------------------------------------------------------------------------------ */
/* Compare two PDFs                                                                            */
/* ------------------------------------------------------------------------------------------ */

type PageDiff = { page: number; status: "same" | "changed" | "only_in_a" | "only_in_b"; removed: string[]; added: string[]; image: string | null };
type CompareResult = { pages: PageDiff[]; changed: number; pages_a: number; pages_b: number; truncated: boolean };

export function Compare({ onDone }: { onDone: () => void }) {
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const [res, setRes] = useState<CompareResult | null>(null);
  const [open_, setOpen] = useState<number | null>(null);
  const task = useTask(onDone);

  async function go() {
    if (!a || !b) return;
    setRes(null);
    const job = await task.run("/pdf/compare", { a, b });
    if (job?.state === "done") {
      const r = job.result as unknown as CompareResult;
      setRes(r);
      setOpen(r.pages.find((p) => p.status !== "same")?.page ?? null);
    }
  }

  const shown = res?.pages.find((p) => p.page === open_) ?? null;
  return (
    <>
      <Title title="Compare two PDFs" hint="See what changed between two versions of a document: lines that were removed or added, and the differences drawn in red on the new page." />
      <div className="row3">
        <SourceField label="Old version" file={a} onPick={setA} />
        <SourceField label="New version" file={b} onPick={setB} />
      </div>
      <RunBar label="Compare" busyLabel="Comparing…" disabled={!a || !b} onRun={go} task={task} />
      {res && (
        <div className="split">
          <div>
            <p className="hint">
              {res.changed === 0 ? "No differences found." : `${res.changed} of ${res.pages.length} page${res.pages.length === 1 ? "" : "s"} differ.`}
              {res.truncated && " Only the first pages were compared."}
            </p>
            <ul className="pagelist">
              {res.pages.map((p) => (
                <li key={p.page}>
                  <button className={p.page === open_ ? "on" : ""} onClick={() => setOpen(p.page)}>
                    Page {p.page}
                    <small>{p.status === "same" ? "same" : p.status === "only_in_a" ? "only in the old version" : p.status === "only_in_b" ? "only in the new version" : "changed"}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <aside className="side">
            {shown && (
              <>
                {shown.image && <img className="diffimg" src={`data:image/png;base64,${shown.image}`} alt={`Differences on page ${shown.page}`} />}
                {shown.removed.length > 0 && (
                  <>
                    <h2>Removed</h2>
                    <ul className="difflines removed">
                      {shown.removed.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </>
                )}
                {shown.added.length > 0 && (
                  <>
                    <h2>Added</h2>
                    <ul className="difflines added">
                      {shown.added.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </>
                )}
                {shown.status === "same" && <p className="muted">This page is the same in both files.</p>}
              </>
            )}
          </aside>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Pictures inside a PDF                                                                       */
/* ------------------------------------------------------------------------------------------ */


/* ------------------------------------------------------------------------------------------ */
/* Clean up a scan                                                                             */
/* ------------------------------------------------------------------------------------------ */

export function ScanClean({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [deskew, setDeskew] = useState(true);
  const [crop, setCrop] = useState(true);
  const [mode, setMode] = useState<"contrast" | "gray" | "bw">("contrast");
  const task = useTask(onDone);
  return (
    <>
      <Title title="Clean up a scan" hint="Straighten crooked pages, cut away the dark edges and make the paper white. The result is a new PDF made of pictures; run Read scanned pages afterwards to make it searchable." />
      <PdfSource file={file} onPick={setFile} />
      <CheckField label="Straighten crooked pages" checked={deskew} onChange={setDeskew} />
      <CheckField label="Cut away the edges around the paper" checked={crop} onChange={setCrop} />
      <Segmented
        label="Look"
        value={mode}
        onChange={setMode}
        options={[
          { id: "contrast", label: "Keep colours, whiten the paper" },
          { id: "gray", label: "Grey" },
          { id: "bw", label: "Black and white (smallest)" },
        ]}
      />
      <RunBar
        label="Clean up to…"
        busyLabel="Cleaning…"
        disabled={!file}
        task={task}
        onRun={async () => {
          if (!file) return;
          const output = await save({ filters: pdfFilter, defaultPath: `${stem(file)}-clean.pdf` });
          if (output) await task.run("/pdf/clean-scan", { input: file, output, deskew, crop, mode });
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Print layouts: several pages per sheet, booklet                                             */
/* ------------------------------------------------------------------------------------------ */

export function PrintLayout({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [mode, setMode] = useState<"nup" | "booklet">("nup");
  const [per, setPer] = useState("2");
  const [paper, setPaper] = useState("A4");
  const [landscape, setLandscape] = useState(true);
  const [border, setBorder] = useState(false);
  const task = useTask(onDone);
  return (
    <>
      <Title
        title="Print layout"
        hint={mode === "nup" ? "Put several pages on one sheet to save paper." : "Reorder the pages so that sheets printed on both sides and folded in half read like a book."}
      />
      <PdfSource file={file} onPick={setFile} />
      <Segmented label="Layout" value={mode} onChange={setMode} options={[{ id: "nup", label: "Several pages per sheet" }, { id: "booklet", label: "Booklet" }]} />
      {mode === "nup" && (
        <SelectField id="pl-per" label="Pages per sheet" value={per} onChange={setPer} options={["2", "4", "6", "8", "9", "16"].map((n) => ({ id: n, label: n }))} />
      )}
      <SelectField id="pl-paper" label="Paper" value={paper} onChange={setPaper} options={[{ id: "A4", label: "A4" }, { id: "A3", label: "A3" }, { id: "Letter", label: "Letter" }]} />
      {mode === "nup" && <CheckField label="Sheet lying down (landscape)" checked={landscape} onChange={setLandscape} />}
      <CheckField label="Thin line around every page" checked={border} onChange={setBorder} />
      {mode === "booklet" && <p className="hint">Print double-sided, flip on the short edge, then fold the stack in half.</p>}
      <RunBar
        label="Save to…"
        busyLabel="Working…"
        disabled={!file}
        task={task}
        onRun={async () => {
          if (!file) return;
          const output = await save({ filters: pdfFilter, defaultPath: `${stem(file)}-${mode === "nup" ? `${per}-up` : "booklet"}.pdf` });
          if (output) await task.run("/pdf/impose", { input: file, output, mode, per_sheet: Number(per), paper, landscape: mode === "nup" ? landscape : true, border });
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Many PDFs at once                                                                           */
/* ------------------------------------------------------------------------------------------ */

type Steps = { compress: boolean; dpi: string; watermark: boolean; wtext: string; numbers: boolean; ntext: string; metadata: boolean; gray: boolean; encrypt: boolean; password: string };
const NO_STEPS: Steps = { compress: false, dpi: "120", watermark: false, wtext: "DRAFT", numbers: false, ntext: "{n} / {total}", metadata: false, gray: false, encrypt: false, password: "" };

export function PdfBatch({ onDone }: { onDone: () => void }) {
  const [inputs, setInputs] = useState<string[]>([]);
  const [outDir, setOutDir] = useState<string | null>(null);
  const [s, setS] = useState<Steps>(NO_STEPS);
  const [templates, setTemplates] = useState<Record<string, Steps>>({});
  const [name, setName] = useState("");
  const task = useTask(onDone);
  const set = (c: Partial<Steps>) => setS((cur) => ({ ...cur, ...c }));

  useEffect(() => {
    get<Record<string, unknown>>("/settings").then((st) => setTemplates((st.pdf_batch_templates as Record<string, Steps>) ?? {})).catch(failed("Could not load your saved batch steps"));
  }, []);

  const steps = useMemo(
    () => [
      ...(s.compress ? [{ type: "compress", dpi: Number(s.dpi) || 120 }] : []),
      ...(s.watermark && s.wtext.trim() ? [{ type: "watermark", text: s.wtext }] : []),
      ...(s.numbers && s.ntext.trim() ? [{ type: "numbers", text: s.ntext }] : []),
      ...(s.metadata ? [{ type: "clean_metadata" }] : []),
      ...(s.gray ? [{ type: "grayscale" }] : []),
      ...(s.encrypt && s.password ? [{ type: "encrypt", password: s.password }] : []),
    ],
    [s],
  );
  const savable = (t: Steps) => ({ ...t, password: "" }); // a password is never stored

  async function saveTemplate() {
    const n = name.trim();
    if (!n) return;
    const next = { ...templates, [n]: savable(s) };
    await putSetting("/settings/pdf_batch_templates", { value: next });
    setTemplates(next);
    setName("");
  }
  async function dropTemplate(n: string) {
    const { [n]: _gone, ...rest } = templates;
    void _gone;
    await putSetting("/settings/pdf_batch_templates", { value: rest });
    setTemplates(rest);
  }

  return (
    <>
      <Title title="Many PDFs at once" hint="Do the same things to a whole folder of PDFs. The originals stay as they are; the results go to another folder." />
      <InputsField label="PDF files or folders" items={inputs} onChange={setInputs} filters={pdfFilter} />
      <FolderField label="Save the results in" value={outDir} onPick={setOutDir} />
      <span className="label">What to do (in this order)</span>
      <CheckField label="Make smaller" checked={s.compress} onChange={(v) => set({ compress: v })} />
      {s.compress && <TextField id="pb-dpi" label="Picture quality (DPI)" type="number" mono value={s.dpi} onChange={(v) => set({ dpi: v })} hint="72 is small, 150 is good for reading" />}
      <CheckField label="Add a watermark" checked={s.watermark} onChange={(v) => set({ watermark: v })} />
      {s.watermark && <TextField id="pb-w" label="Watermark text" value={s.wtext} onChange={(v) => set({ wtext: v })} />}
      <CheckField label="Add page numbers" checked={s.numbers} onChange={(v) => set({ numbers: v })} />
      {s.numbers && <TextField id="pb-n" label="Page number text" mono value={s.ntext} onChange={(v) => set({ ntext: v })} hint="{n} is the page, {total} the number of pages" />}
      <CheckField label="Remove hidden information (author, title…)" checked={s.metadata} onChange={(v) => set({ metadata: v })} />
      <CheckField label="Make grey" checked={s.gray} onChange={(v) => set({ gray: v })} />
      <CheckField label="Lock with a password" checked={s.encrypt} onChange={(v) => set({ encrypt: v })} />
      {s.encrypt && <TextField id="pb-pw" label="Password" type="password" value={s.password} onChange={(v) => set({ password: v })} />}
      <div className="changes">
        <h2>Saved sets of steps</h2>
        <div className="inline">
          <input aria-label="Name of this set" placeholder="Name, e.g. Send to client" value={name} onChange={(e) => setName(e.target.value)} />
          <button disabled={!name.trim() || steps.length === 0} onClick={saveTemplate}>
            Save these steps
          </button>
        </div>
        <ul className="presetlist">
          {Object.entries(templates).map(([n, t]) => (
            <li key={n}>
              <span>{n}</span>
              <button className="icon text" onClick={() => setS({ ...NO_STEPS, ...t })}>
                Use
              </button>
              <button className="icon text" onClick={() => dropTemplate(n)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      </div>
      <RunBar
        label="Start"
        busyLabel="Working…"
        disabled={inputs.length === 0 || !outDir || steps.length === 0}
        task={task}
        onRun={() => task.run("/pdf/batch", { inputs, out_dir: outDir, steps })}
      />
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Attachments and page labels                                                                 */
/* ------------------------------------------------------------------------------------------ */

type Label = { startpage: number; prefix: string; style: string };

export function Attachments({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [have, setHave] = useState<{ name: string; size: number }[]>([]);
  const [drop, setDrop] = useState<string[]>([]);
  const [add, setAdd] = useState<string[]>([]);
  const [labels, setLabels] = useState<Label[] | null>(null);
  const task = useTask(onDone);

  useEffect(() => {
    setDrop([]);
    setAdd([]);
    setLabels(null);
    if (!file) return setHave([]);
    post<{ attachments: { name: string; size: number }[] }>("/pdf/attachments/list", { input: file })
      .then((r) => setHave(r.attachments))
      .catch(() => setHave([]));
  }, [file]);

  const setLabel = (i: number, c: Partial<Label>) => setLabels((cur) => (cur ?? []).map((l, k) => (k === i ? { ...l, ...c } : l)));
  return (
    <>
      <Title title="Attachments and page labels" hint="Hide files inside a PDF, and choose how pages are numbered in a PDF reader (for example i, ii, iii for the preface and 1, 2, 3 for the rest)." />
      <PdfSource file={file} onPick={setFile} peek={false} />
      {file && (
        <>
          <h2>Files inside this PDF</h2>
          {have.length === 0 && <p className="muted">None.</p>}
          <ul className="presetlist">
            {have.map((a) => (
              <li key={a.name}>
                <span>{a.name}</span>
                <button className={`icon text ${drop.includes(a.name) ? "on" : ""}`} onClick={() => setDrop((d) => (d.includes(a.name) ? d.filter((x) => x !== a.name) : [...d, a.name]))}>
                  {drop.includes(a.name) ? "Will be removed (undo)" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
          <InputsField label="Add files" items={add} onChange={setAdd} filters={[{ name: "Any file", extensions: ["*"] }]} />
          <h2>Page labels</h2>
          {labels === null ? (
            <div className="actions tight">
              <button onClick={() => setLabels([{ startpage: 1, prefix: "", style: "D" }])}>Change page numbering…</button>
            </div>
          ) : (
            <>
              {labels.map((l, i) => (
                <div key={i} className="stamprow">
                  <input aria-label="From page" type="number" min={1} value={l.startpage} onChange={(e) => setLabel(i, { startpage: Number(e.target.value) })} />
                  <select aria-label="Style" value={l.style} onChange={(e) => setLabel(i, { style: e.target.value })}>
                    <option value="D">1, 2, 3</option>
                    <option value="r">i, ii, iii</option>
                    <option value="R">I, II, III</option>
                    <option value="a">a, b, c</option>
                    <option value="A">A, B, C</option>
                    <option value="">No number</option>
                  </select>
                  <input aria-label="Prefix" placeholder="Prefix, e.g. A-" value={l.prefix} onChange={(e) => setLabel(i, { prefix: e.target.value })} />
                  <button className="icon text" onClick={() => setLabels((cur) => (cur ?? []).filter((_, k) => k !== i))}>
                    Remove
                  </button>
                </div>
              ))}
              <div className="actions tight">
                <button onClick={() => setLabels((cur) => [...(cur ?? []), { startpage: 1, prefix: "", style: "D" }])}>Add a rule</button>
              </div>
              <p className="hint">Each rule starts at a page and goes on until the next rule.</p>
            </>
          )}
          <RunBar
            label="Save a copy…"
            busyLabel="Saving…"
            disabled={drop.length === 0 && add.length === 0 && labels === null}
            task={task}
            onRun={async () => {
              const output = await save({ filters: pdfFilter, defaultPath: `${stem(file)}-edited.pdf` });
              if (output) await task.run("/pdf/attachments/save", { input: file, output, add, remove: drop, labels });
            }}
          />
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Add-ons                                                                                     */
/* ------------------------------------------------------------------------------------------ */

type Extra = { id: string; name: string; text: string; size_mb: number; installed: boolean };

export function Addons({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<Extra[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const task = useTask(onDone);
  const load = () => get<{ extras: Extra[] }>("/extras").then((r) => setRows(r.extras)).catch(failed("Could not load the add-ons list"));
  useEffect(() => {
    void load();
  }, []);

  async function install(id: string) {
    setBusy(id);
    await task.run(`/extras/${id}/install`, {});
    setBusy(null);
    void load();
  }

  return (
    <>
      <Title title="Add-ons" hint="The app starts small and fast. Heavier features are installed here, only if you want them. They need an internet connection once, then work offline." />
      <ul className="addons">
        {rows.map((r) => (
          <li key={r.id}>
            <div>
              <b>{r.name}</b>
              <small>{r.text}</small>
            </div>
            <span className="mono note">{r.size_mb} MB</span>
            {r.installed ? (
              <span className="state done">Installed</span>
            ) : (
              <button className="primary" disabled={busy !== null} onClick={() => install(r.id)}>
                {busy === r.id ? "Installing…" : "Install"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {busy && <ProgressBar progress={task.progress} onCancel={task.cancel} />}
      {task.message && <p className={task.message.ok ? "msg ok" : "msg bad"}>{task.message.text}</p>}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Digital signatures                                                                          */
/* ------------------------------------------------------------------------------------------ */

type SigInfo = { field: string; signer: string; intact: boolean; valid: boolean; signed_at: string; error?: string };

export function Sign({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"sign" | "check">("sign");
  const [file, setFile] = useState<string | null>(null);
  const [cert, setCert] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [visible, setVisible] = useState(false);
  const [found, setFound] = useState<SigInfo[] | null>(null);
  const [error, setError] = useState("");
  const task = useTask(onDone);

  useEffect(() => {
    setFound(null);
    setError("");
    if (mode !== "check" || !file) return;
    post<{ signatures: SigInfo[] }>("/pdf/signatures", { input: file })
      .then((r) => setFound(r.signatures))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [mode, file]);

  return (
    <>
      <Title
        title="Digital signature"
        hint={mode === "sign" ? "Sign a PDF with your own certificate (.pfx or .p12) so anyone can see who signed it and that it was not changed afterwards. Needs the Digital signatures add-on." : "Check who signed a PDF and whether it was changed after signing."}
      />
      <Segmented label="What do you want to do?" value={mode} onChange={setMode} options={[{ id: "sign", label: "Sign a PDF" }, { id: "check", label: "Check signatures" }]} />
      <PdfSource file={file} onPick={setFile} peek={mode === "sign"} />
      {mode === "sign" ? (
        <>
          <SourceField label="Certificate (.pfx or .p12)" file={cert} onPick={setCert} filters={[{ name: "Certificate", extensions: ["pfx", "p12"] }]} />
          <TextField id="sg-pw" label="Certificate password" type="password" value={password} onChange={setPassword} />
          <TextField id="sg-reason" label="Reason (optional)" value={reason} onChange={setReason} hint="For example: I approve this contract" />
          <CheckField label="Show a signature box on the first page" checked={visible} onChange={setVisible} />
          <RunBar
            label="Sign and save a copy…"
            busyLabel="Signing…"
            disabled={!file || !cert}
            task={task}
            onRun={async () => {
              if (!file || !cert) return;
              const output = await save({ filters: pdfFilter, defaultPath: `${stem(file)}-signed.pdf` });
              if (output) await task.run("/pdf/sign", { input: file, output, certificate: cert, password, reason, visible });
              setPassword("");
            }}
          />
        </>
      ) : (
        <>
          {error && <p className="msg bad">{error}</p>}
          {found && found.length === 0 && <p className="muted">This PDF has no digital signatures.</p>}
          {found && found.length > 0 && (
            <ul className="addons">
              {found.map((s) => (
                <li key={s.field}>
                  <div>
                    <b>{s.signer || s.field}</b>
                    <small>{s.signed_at ? `Signed ${s.signed_at}` : "Signing time unknown"}</small>
                    {s.error && <small>{s.error}</small>}
                  </div>
                  <span />
                  <span className={`state ${s.intact && s.valid ? "done" : "failed"}`}>{s.intact && s.valid ? "Not changed since signing" : "Changed or not trusted"}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">The signer's certificate is not checked against a trusted authority: this tells you who signed and whether the file was changed afterwards.</p>
        </>
      )}
    </>
  );
}
