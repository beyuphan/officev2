import { useCallback, useEffect, useState } from "react";
import { del, get, post, runJob, type Job } from "../api";
import {
  FolderField,
  Message,
  ProgressBar,
  RunBar,
  Segmented,
  SelectField,
  SourceField,
  Table,
  TextField,
  Title,
  audioFilter,
  baseName,
  formatBytes,
  useTask,
} from "../shared";

export function Transcribe({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [outDir, setOutDir] = useState<string | null>(null);
  const [model, setModel] = useState("small");
  const [language, setLanguage] = useState("");
  const [formats, setFormats] = useState<string[]>(["txt", "srt"]);
  const task = useTask(onDone);

  const toggle = (f: string) => setFormats((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  return (
    <>
      <Title
        title="Transcribe"
        hint="Turn recordings into text and subtitles on this computer. The speech model downloads once on first use. Audio never leaves your machine."
      />
      <SourceField label="Recording" file={file} onPick={setFile} filters={audioFilter} />
      <FolderField label="Save to folder" value={outDir} onPick={setOutDir} />
      <div className="row3">
        <SelectField
          id="t-model"
          label="Model"
          value={model}
          onChange={setModel}
          options={[
            { id: "tiny", label: "Tiny (75 MB, fastest)" },
            { id: "base", label: "Base (145 MB)" },
            { id: "small", label: "Small (480 MB, recommended)" },
          ]}
        />
        <TextField id="t-lang" label="Language" mono value={language} onChange={setLanguage} hint="Code like tr or en. Empty detects it" />
      </div>
      <div className="field">
        <span className="label">Output</span>
        <div className="seg" role="group" aria-label="Output formats">
          {["txt", "srt", "vtt"].map((f) => (
            <button key={f} aria-pressed={formats.includes(f)} className={formats.includes(f) ? "on" : ""} onClick={() => toggle(f)}>
              .{f}
            </button>
          ))}
        </div>
      </div>
      <RunBar
        label="Transcribe"
        busyLabel="Transcribing…"
        disabled={!file || !outDir || formats.length === 0}
        task={task}
        onRun={() => task.run("/ai/transcribe", { input: file, out_dir: outDir, model, language: language.trim() || null, formats })}
      />
    </>
  );
}

type Source = { path: string; page: number; text: string; distance: number };
type Stats = { documents: number; chunks: number; sources: string[] };
type Llm = { available: boolean; models: string[] };

export function Documents({ onDone }: { onDone: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [llm, setLlm] = useState<Llm | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [mode, setMode] = useState<"ask" | "find">("ask");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Source[] | null>(null);
  const [answer, setAnswer] = useState<{ text: string | null; note?: string; model?: string } | null>(null);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const task = useTask(onDone);

  const refresh = useCallback(() => {
    get<Stats>("/ai/index").then(setStats).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    get<Llm>("/ai/llm").then(setLlm).catch(() => undefined);
  }, [refresh]);

  async function index() {
    if (!folder) return;
    await task.run("/ai/index", { paths: [folder] });
    refresh();
  }

  async function forget(path: string) {
    await post("/ai/index/forget", { path });
    refresh();
  }

  async function search() {
    setSearching(true);
    setError("");
    setResults(null);
    setAnswer(null);
    try {
      if (mode === "ask") {
        const r = await post<{ answer: string | null; note?: string; model?: string; sources: Source[] }>("/ai/ask", { question: query });
        setAnswer({ text: r.answer, note: r.note, model: r.model });
        setResults(r.sources);
      } else {
        setResults(await post<Source[]>("/ai/search", { query, per_document: true, k: 10 }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  return (
    <>
      <Title
        title="Documents"
        hint="Index folders on this computer, then ask questions or search by meaning instead of file name. PDF, Word and text files. Nothing is uploaded."
      />

      <div className="field">
        <span className="label">Indexed folders</span>
        {stats && stats.sources.length > 0 ? (
          <ul className="chips">
            {stats.sources.map((s) => (
              <li key={s}>
                <span className="mono trunc" title={s}>
                  {s}
                </span>
                <button className="icon text" onClick={() => forget(s)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No folders yet.</p>
        )}
        {stats && (
          <p className="hint">
            {stats.documents} documents, {stats.chunks} passages indexed.
          </p>
        )}
      </div>
      <FolderField label="Add a folder" value={folder} onPick={setFolder} />
      <RunBar label="Index folder" busyLabel="Indexing…" disabled={!folder} onRun={index} task={task} />

      <hr />

      <Segmented
        label="Mode"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setResults(null);
          setAnswer(null);
        }}
        options={[
          { id: "ask", label: "Ask a question" },
          { id: "find", label: "Find files by meaning" },
        ]}
      />
      {mode === "ask" && llm && !llm.available && (
        <p className="hint">No local language model found (Ollama). Questions will show the matching passages without a written answer.</p>
      )}
      <div className="field">
        <label className="label" htmlFor="d-q">
          {mode === "ask" ? "Question" : "What are you looking for?"}
        </label>
        <div className="inline">
          <input id="d-q" className="wide" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && query.trim() && search()} />
          <button className="primary" disabled={!query.trim() || searching} onClick={search}>
            {searching ? "Searching…" : mode === "ask" ? "Ask" : "Search"}
          </button>
        </div>
      </div>
      {error && <p className="msg bad">{error}</p>}
      {answer?.text && (
        <div className="answer">
          <p>{answer.text}</p>
          {answer.model && <span className="muted mono">{answer.model}</span>}
        </div>
      )}
      {answer && !answer.text && answer.note && <p className="hint">{answer.note}</p>}
      {results && results.length === 0 && <p className="muted">Nothing relevant found.</p>}
      {results && results.length > 0 && (
        <ol className="sources">
          {results.map((r, i) => (
            <li key={r.path + i}>
              <b>
                {mode === "ask" ? `[${i + 1}] ` : ""}
                {baseName(r.path)}
                {r.page ? ` · page ${r.page}` : ""}
              </b>
              <small className="mono" title={r.path}>
                {r.path}
              </small>
              <p>{r.text.length > 320 ? r.text.slice(0, 320) + "…" : r.text}</p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

type ModelRow = { id: string; name: string; kind: string; size_mb: number; installed: boolean; disk_bytes: number; executable?: boolean; platform?: string };

export function Models() {
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<Job["progress"]>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    get<ModelRow[]>("/models").then(setRows);
  }, []);
  useEffect(load, [load]);

  async function install(m: ModelRow) {
    setBusy(m.id);
    setMessage(null);
    try {
      const job = await runJob(`/models/${m.id}/install`, undefined, (j) => setProgress(j.progress));
      setMessage(job.state === "done" ? { ok: true, text: `${m.name} installed.` } : { ok: false, text: job.error ?? job.state });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      setProgress(null);
      load();
    }
  }
  async function remove(m: ModelRow) {
    await del(`/models/${m.id}`);
    load();
  }

  const total = rows.reduce((a, r) => a + r.disk_bytes, 0);

  return (
    <>
      <Title
        title="Models"
        hint="Optional components that make the local AI tools work. They download only when you need them and can be removed any time."
      />
      <Table
        head={
          <tr>
            <th>Component</th>
            <th className="op">Size</th>
            <th className="status">Status</th>
            <th className="act">
              <span className="sr">Actions</span>
            </th>
          </tr>
        }
      >
        {rows.map((m) => (
          <tr key={m.id}>
            <td>
              {m.name}
              {m.executable && <small className="note"> third-party program</small>}
            </td>
            <td className="mono nowrap">{m.installed ? formatBytes(m.disk_bytes) : `${m.size_mb} MB`}</td>
            <td className={`state ${m.installed ? "done" : ""}`}>{m.installed ? "installed" : "not installed"}</td>
            <td className="act">
              {m.installed ? (
                <button className="icon text" disabled={busy !== null} onClick={() => remove(m)}>
                  Remove
                </button>
              ) : (
                <button className="icon text" disabled={busy !== null || (m.platform !== undefined && m.platform !== "win32")} onClick={() => install(m)}>
                  {busy === m.id ? "Installing…" : "Install"}
                </button>
              )}
            </td>
          </tr>
        ))}
      </Table>
      {busy && <ProgressBar progress={progress} />}
      <p className="hint">Total on disk: {formatBytes(total)}</p>
      <Message m={message} />
    </>
  );
}
