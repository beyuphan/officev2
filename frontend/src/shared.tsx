import { useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { cancelJob, post, runJob, type Job } from "./api";

export const pdfFilter = [{ name: "PDF", extensions: ["pdf"] }];
export const imageFilter = [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "avif", "heic", "heif", "ico"] }];
export const videoFilter = [{ name: "Video", extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v"] }];
export const audioFilter = [
  { name: "Audio / video", extensions: ["wav", "mp3", "m4a", "flac", "ogg", "opus", "aac", "mp4", "mkv", "mov", "webm"] },
];
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const dirName = (p: string) => p.slice(0, Math.max(0, p.length - baseName(p).length)).replace(/[\\/]$/, "");

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

type Msg = { ok: boolean; text: string };

/** Turns a finished job into one readable line. */
export function describeJob(job: Job): Msg {
  if (job.state === "cancelled") return { ok: false, text: "Cancelled." };
  if (job.state !== "done") return { ok: false, text: job.error ?? job.state };
  const r = job.result ?? {};
  const parts: string[] = [];
  if (r.outputs) {
    parts.push(`${r.count ?? r.outputs.length} file(s) written`);
    if (typeof r.saved_bytes === "number") parts.push(`${r.saved_bytes >= 0 ? "saved" : "grew by"} ${formatBytes(Math.abs(r.saved_bytes))}`);
    if (r.skipped?.length) parts.push(`${r.skipped.length} skipped (${r.skipped[0].reason})`);
    if (r.language) parts.push(`language: ${r.language}`);
  } else if (r.output) {
    parts.push(r.width && r.height ? `${r.width} × ${r.height} px written to ${r.output}` : `${r.pages} pages written to ${r.output}`);
    if (r.words != null) parts.push(`${r.words} words recognized${r.engine ? ` (${r.engine})` : ""}`);
    if (r.redactions != null) parts.push(`${r.redactions} redactions`);
    if (r.before_bytes != null) parts.push(`${formatBytes(r.before_bytes)} → ${formatBytes(r.after_bytes)}`);
    if (r.removed_fields) parts.push(r.removed_fields.length ? `removed: ${r.removed_fields.join(", ")}` : "no metadata found");
  } else {
    parts.push("Done.");
  }
  return { ok: true, text: parts.join(" · ") };
}

export function useTask(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Msg | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const current = useRef<string | null>(null);

  async function run(path: string, body: unknown): Promise<Job | null> {
    setBusy(true);
    setMessage(null);
    setJob(null);
    try {
      const finished = await runJob(path, body, (j) => {
        current.current = j.id;
        setJob(j);
      });
      setMessage(describeJob(finished));
      return finished;
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      setBusy(false);
      current.current = null;
      onDone();
    }
  }
  const cancel = () => (current.current ? cancelJob(current.current) : Promise.resolve());
  return { busy, message, run, progress: busy ? job?.progress ?? null : null, cancel };
}

export function Message({ m }: { m: Msg | null }) {
  return m ? (
    <p className={m.ok ? "msg good" : "msg bad"} role="status">
      {m.text}
    </p>
  ) : null;
}

/** "Not saved yet" / "All changes saved" / "No changes": the same words in every editor. */
export function SaveState({ dirty, hasEdits }: { dirty: boolean; hasEdits: boolean }) {
  return (
    <span className={`savestate ${dirty ? "unsaved" : "saved"}`} role="status">
      {dirty ? "Not saved yet" : hasEdits ? "All changes saved" : "No changes"}
    </span>
  );
}

export function Title({ title, hint }: { title: string; hint: string }) {
  return (
    <header className="title">
      <h1>{title}</h1>
      <p>{hint}</p>
    </header>
  );
}

export function ProgressBar({ progress, onCancel }: { progress: Job["progress"]; onCancel?: () => void }) {
  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;
  return (
    <div className="progress" role="status" aria-live="polite">
      <div className="bar" aria-hidden>
        <i style={{ width: pct === null ? "30%" : `${pct}%` }} className={pct === null ? "indeterminate" : ""} />
      </div>
      <span className="muted mono">{pct === null ? "working" : `${pct}%`}{progress?.message ? ` · ${progress.message}` : ""}</span>
      {onCancel && <button className="icon text" onClick={onCancel}>Cancel</button>}
    </div>
  );
}

/** Action row: primary button, progress with cancel while running, then the result line. */
export function RunBar({
  label,
  busyLabel,
  disabled,
  onRun,
  task,
}: {
  label: string;
  busyLabel: string;
  disabled?: boolean;
  onRun: () => void;
  task: ReturnType<typeof useTask>;
}) {
  return (
    <>
      <div className="actions">
        <button className="primary" disabled={disabled || task.busy} onClick={onRun}>
          {task.busy ? busyLabel : label}
        </button>
      </div>
      {task.busy && <ProgressBar progress={task.progress} onCancel={task.cancel} />}
      <Message m={task.message} />
    </>
  );
}

export function SourceField({
  label,
  file,
  onPick,
  filters = pdfFilter,
}: {
  label: string;
  file: string | null;
  onPick: (p: string) => void;
  filters?: { name: string; extensions: string[] }[];
}) {
  async function pick() {
    const picked = await open({ multiple: false, filters });
    if (typeof picked === "string") onPick(picked);
  }
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="inline">
        <span className={file ? "mono trunc" : "muted"} title={file ?? undefined}>
          {file ?? "No file selected"}
        </span>
        <button onClick={pick}>Choose…</button>
      </div>
    </div>
  );
}

export function FolderField({
  label,
  value,
  onPick,
  placeholder = "No folder selected",
}: {
  label: string;
  value: string | null;
  onPick: (p: string) => void;
  placeholder?: string;
}) {
  async function pick() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") onPick(picked);
  }
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="inline">
        <span className={value ? "mono trunc" : "muted"} title={value ?? undefined}>
          {value ?? placeholder}
        </span>
        <button onClick={pick}>Choose…</button>
      </div>
    </div>
  );
}

/** Several files and/or folders as input. A folder is opened and its files are listed, so you can drop the ones you do not want. */
export function InputsField({
  label,
  items,
  onChange,
  filters,
}: {
  label: string;
  items: string[];
  onChange: (v: string[]) => void;
  filters: { name: string; extensions: string[] }[];
}) {
  const [deep, setDeep] = useState(false);
  const [note, setNote] = useState("");
  const add = (p: string | string[] | null) => {
    if (!p) return;
    const list = Array.isArray(p) ? p : [p];
    onChange([...items, ...list.filter((x) => !items.includes(x))]);
  };
  async function addFolder() {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    try {
      const exts = filters.flatMap((f) => f.extensions);
      const r = await post<{ files: string[]; truncated: boolean }>("/files/folder-files", { folder: dir, extensions: exts, recursive: deep });
      add(r.files);
      setNote(r.files.length === 0 ? `No matching files in ${baseName(dir)}${deep ? "" : " (subfolders are not included)"}.` : r.truncated ? "Only the first 1000 files were added." : "");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="field">
      <span className="label">{label}</span>
      {items.length > 0 && (
        <>
          <ul className="chips">
            {items.map((p) => (
              <li key={p}>
                <span className="mono trunc" title={p}>
                  {p}
                </span>
                <button className="icon" aria-label={`Remove ${baseName(p)}`} onClick={() => onChange(items.filter((x) => x !== p))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">
            {`${items.length} file${items.length === 1 ? "" : "s"}`} ·{" "}
            <button className="icon text" onClick={() => onChange([])}>
              Clear all
            </button>
          </p>
        </>
      )}
      <div className="actions tight">
        <button onClick={async () => add((await open({ multiple: true, filters })) as string[] | null)}>Add files…</button>
        <button onClick={addFolder}>Add folder…</button>
        <label className="check inlinecheck">
          <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> Include subfolders
        </label>
      </div>
      {note && <p className="hint">{note}</p>}
    </div>
  );
}

/** A font list that can also take a new font: choose “Add a font…”, pick a .ttf or .otf, and it is ready to use. */
export function FontPicker({ value, fonts, onChange, onFonts, label = "Font" }: { value: string; fonts: string[]; onChange: (f: string) => void; onFonts: (all: string[]) => void; label?: string }) {
  const [error, setError] = useState("");
  async function pick(v: string) {
    if (v !== "__add__") return onChange(v);
    const file = await open({ multiple: false, filters: [{ name: "Fonts", extensions: ["ttf", "otf"] }] });
    if (typeof file !== "string") return;
    try {
      const r = await post<{ family: string; fonts: string[] }>("/photo/fonts/add", { path: file });
      onFonts(r.fonts);
      onChange(r.family);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const list = fonts.includes(value) ? fonts : [value, ...fonts];
  return (
    <>
      <select aria-label={label} value={value} onChange={(e) => void pick(e.target.value)} title={error || undefined}>
        {list.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
        <option value="__add__">＋ Add a font…</option>
      </select>
      {error && <span className="ctxhint" role="alert">{error}</span>}
    </>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="field">
      <span className="label" id={`seg-${label}`}>
        {label}
      </span>
      <div className="seg" role="group" aria-labelledby={`seg-${label}`}>
        {options.map((o) => (
          <button key={o.id} aria-pressed={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  mono,
  hint,
  wide,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  mono?: boolean;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        className={`${mono ? "mono" : ""} ${wide ? "wide" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string }[];
  hint?: string;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function CheckField({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Table({ head, children, empty }: { head: ReactNode; children: ReactNode; empty?: string }) {
  return (
    <table className="grid">
      <thead>{head}</thead>
      <tbody>
        {children}
        {empty && (
          <tr>
            <td colSpan={9} className="empty">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}


/** A small question with a few answers, centred over the window. */
export function ConfirmDialog({
  title,
  text,
  choices,
  onCancel,
  cancelLabel = "Keep editing",
}: {
  title: string;
  text: string;
  cancelLabel?: string;
  choices: { label: string; kind?: "primary" | "danger"; onClick: () => void }[];
  onCancel: () => void;
}) {
  return (
    <div className="scrim" onMouseDown={onCancel}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
        <h2>{title}</h2>
        <p>{text}</p>
        <div className="actions">
          {choices.map((c) => (
            <button key={c.label} className={c.kind ?? ""} onClick={c.onClick} autoFocus={c.kind === "primary"}>
              {c.label}
            </button>
          ))}
          <button onClick={onCancel}>{cancelLabel}</button>
        </div>
      </div>
    </div>
  );
}
