import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  ClipboardList,
  Combine,
  Cpu,
  Eraser,
  EyeOff,
  FileOutput,
  Film,
  HardDrive,
  History,
  Image as ImageIcon,
  ImageMinus,
  KeyRound,
  Library,
  ListOrdered,
  Lock,
  Maximize2,
  Mic,
  PencilLine,
  Pipette,
  ScanText,
  Scissors,
  Stamp,
  Type,
  Undo2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cancelJob, listHistory, listJobs, undoEntry, waitForEngine, type HistoryEntry, type JobRecord } from "./api";
import { Table, Title, baseName } from "./shared";
import { Ocr, Protect, Watermark } from "./tools";
import { Merge, Split } from "./views/pdf";
import { Convert, Organize, Redact } from "./views/docs";
import { Background, Images, Upscale, Video } from "./views/media";
import { Documents, Models, Transcribe } from "./views/ai";
import { Autopilot, Cleanup, DiskMap, Rename } from "./views/files";
import { Vault } from "./views/vault";
import { DevLab, TextTools } from "./views/utils";
import { Clipboard, ScreenTools } from "./views/desk";
import { TitleBar } from "./titlebar";
import "./App.css";
import "./forms.css";

type ViewDef = { id: string; label: string; group: string; Icon: LucideIcon; keywords?: string };

const VIEWS: ViewDef[] = [
  { id: "merge", label: "Merge", group: "Documents", Icon: Combine, keywords: "pdf combine join" },
  { id: "split", label: "Extract pages", group: "Documents", Icon: Scissors, keywords: "pdf split pages" },
  { id: "organize", label: "Organize pages", group: "Documents", Icon: ListOrdered, keywords: "pdf reorder rotate" },
  { id: "convert", label: "Convert", group: "Documents", Icon: FileOutput, keywords: "word docx office compress metadata" },
  { id: "protect", label: "Protect", group: "Documents", Icon: Lock, keywords: "pdf password encrypt unlock" },
  { id: "watermark", label: "Watermark", group: "Documents", Icon: Stamp, keywords: "pdf stamp logo signature" },
  { id: "redact", label: "Redact", group: "Documents", Icon: EyeOff, keywords: "pdf black out remove text" },
  { id: "ocr", label: "Recognize text", group: "Documents", Icon: ScanText, keywords: "ocr scan searchable" },
  { id: "images", label: "Images", group: "Media", Icon: ImageIcon, keywords: "compress webp jpeg convert exif" },
  { id: "video", label: "Video", group: "Media", Icon: Film, keywords: "compress mp4 ffmpeg" },
  { id: "background", label: "Remove background", group: "Media", Icon: ImageMinus, keywords: "transparent png cutout" },
  { id: "upscale", label: "Upscale", group: "Media", Icon: Maximize2, keywords: "enlarge resolution esrgan" },
  { id: "transcribe", label: "Transcribe", group: "Intelligence", Icon: Mic, keywords: "whisper speech audio subtitles srt" },
  { id: "documents", label: "Documents", group: "Intelligence", Icon: Library, keywords: "ask chat rag search index semantic" },
  { id: "models", label: "Models", group: "Intelligence", Icon: Cpu, keywords: "download ai install" },
  { id: "rename", label: "Rename", group: "Files", Icon: PencilLine, keywords: "bulk regex batch" },
  { id: "cleanup", label: "Clean up", group: "Files", Icon: Eraser, keywords: "temp junk node_modules duplicates quarantine space" },
  { id: "diskmap", label: "Disk map", group: "Files", Icon: HardDrive, keywords: "treemap storage usage" },
  { id: "autopilot", label: "Autopilot", group: "Files", Icon: Workflow, keywords: "rules downloads sort automate" },
  { id: "clipboard", label: "Clipboard", group: "Desk", Icon: ClipboardList, keywords: "history copy paste" },
  { id: "screen", label: "Screen tools", group: "Desk", Icon: Pipette, keywords: "color picker eyedropper pin image live text capture ocr screenshot" },
  { id: "vault", label: "Vault", group: "Private", Icon: KeyRound, keywords: "encrypted secure files" },
  { id: "text", label: "Text", group: "Tools", Icon: Type, keywords: "clean paste scratchpad" },
  { id: "devlab", label: "Dev lab", group: "Tools", Icon: Braces, keywords: "jwt json sql base64 timestamp" },
  { id: "activity", label: "Activity", group: "System", Icon: History, keywords: "history undo jobs" },
];
const GROUPS = [...new Set(VIEWS.map((v) => v.group))];

/** 1 -> A, 26 -> Z, 27 -> AA */
function revLetter(n: number): string {
  let s = "";
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

type Engine = "starting" | "ready" | "error";

export default function App() {
  const [engine, setEngine] = useState<Engine>("starting");
  const [engineError, setEngineError] = useState("");
  const [view, setView] = useState<string>(() => {
    const h = window.location.hash.slice(1);
    return VIEWS.some((v) => v.id === h) ? h : "merge";
  });
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loadError, setLoadError] = useState("");
  const [palette, setPalette] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [j, h] = await Promise.all([listJobs(), listHistory()]);
      setJobs(j);
      setHistory(h);
      setLoadError("");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    waitForEngine()
      .then(() => {
        setEngine("ready");
        refresh();
      })
      .catch((e) => {
        setEngine("error");
        setEngineError(String(e));
      });
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];
  const go = (id: string) => {
    setView(id);
    setPalette(false);
  };
  const revCount = useMemo(() => buildRows(jobs, history).length, [jobs, history]);
  const lastRev = revCount ? revLetter(revCount) : "—";

  return (
    <div className="app">
    <TitleBar tool={current.label} />
    <div className="shell">
      <nav className="rail" aria-label="Tools">
        <button className="palette-hint" onClick={() => setPalette(true)} aria-label="Open command palette">
          <span>Search tools</span>
          <kbd>Ctrl K</kbd>
        </button>
        {GROUPS.map((g) => (
          <div key={g} className="group">
            <div className="group-label">{g}</div>
            {VIEWS.filter((v) => v.group === g).map(({ id, label, Icon }) => (
              <button key={id} className={view === id ? "nav on" : "nav"} aria-current={view === id ? "page" : undefined} onClick={() => go(id)}>
                <Icon size={16} strokeWidth={1.5} aria-hidden />
                {label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <main>
        <div className="sheet">
          {engine === "error" && <p className="msg bad">{engineError}</p>}
          {engine === "starting" && <p className="muted">Starting the local engine…</p>}
          {engine === "ready" && loadError && <p className="msg bad">{loadError}</p>}
          {engine === "ready" && <ViewSwitch id={view} refresh={refresh} go={go} jobs={jobs} history={history} />}
        </div>

        <footer className="titleblock" aria-label="Status">
          <div className="cell wide">
            <span>Tool</span>
            <b>{current.label}</b>
          </div>
          <div className="cell">
            <span>Engine</span>
            <b className={`eng ${engine}`}>{engine === "ready" ? "running" : engine === "starting" ? "starting" : "failed"}</b>
          </div>
          <div className="cell">
            <span>Last rev</span>
            <b className="mono">{lastRev}</b>
          </div>
          <div className="cell">
            <span>Sheet</span>
            <b className="mono">
              {VIEWS.indexOf(current) + 1}/{VIEWS.length}
            </b>
          </div>
        </footer>
      </main>

      {palette && <Palette onPick={go} onClose={() => setPalette(false)} />}
    </div>
    </div>
  );
}

function ViewSwitch({
  id,
  refresh,
  go,
  jobs,
  history,
}: {
  id: string;
  refresh: () => void;
  go: (id: string) => void;
  jobs: JobRecord[];
  history: HistoryEntry[];
}) {
  switch (id) {
    case "merge":
      return <Merge onDone={refresh} />;
    case "split":
      return <Split onDone={refresh} />;
    case "organize":
      return <Organize onDone={refresh} />;
    case "convert":
      return <Convert onDone={refresh} />;
    case "protect":
      return <Protect onDone={refresh} />;
    case "watermark":
      return <Watermark onDone={refresh} />;
    case "redact":
      return <Redact onDone={refresh} />;
    case "ocr":
      return <Ocr onDone={refresh} />;
    case "images":
      return <Images onDone={refresh} />;
    case "video":
      return <Video onDone={refresh} />;
    case "background":
      return <Background onDone={refresh} />;
    case "upscale":
      return <Upscale onDone={refresh} goToModels={() => go("models")} />;
    case "transcribe":
      return <Transcribe onDone={refresh} />;
    case "documents":
      return <Documents onDone={refresh} />;
    case "models":
      return <Models />;
    case "rename":
      return <Rename onDone={refresh} />;
    case "cleanup":
      return <Cleanup onDone={refresh} />;
    case "diskmap":
      return <DiskMap />;
    case "autopilot":
      return <Autopilot onDone={refresh} />;
    case "clipboard":
      return <Clipboard />;
    case "screen":
      return <ScreenTools />;
    case "vault":
      return <Vault />;
    case "text":
      return <TextTools />;
    case "devlab":
      return <DevLab />;
    default:
      return <Activity jobs={jobs} history={history} onChange={refresh} />;
  }
}

/* ---------- command palette ---------- */

function Palette({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const results = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return VIEWS.filter((v) => {
      const hay = `${v.label} ${v.group} ${v.keywords ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [q]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter" && results[sel]) onPick(results[sel].id);
  }

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          ref={input}
          value={q}
          placeholder="Go to a tool…"
          aria-label="Search tools"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
        />
        <ul role="listbox">
          {results.map((v, i) => (
            <li key={v.id} role="option" aria-selected={i === sel}>
              <button className={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onClick={() => onPick(v.id)}>
                <v.Icon size={16} strokeWidth={1.5} aria-hidden />
                {v.label}
                <small>{v.group}</small>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="empty-row">No tool matches.</li>}
        </ul>
      </div>
    </div>
  );
}

/* ---------- activity ---------- */

const TYPE_LABEL: Record<string, string> = {
  "pdf.merge": "Merge PDFs",
  "pdf.split": "Extract pages",
  "pdf.encrypt": "Encrypt",
  "pdf.unlock": "Unlock",
  "pdf.watermark": "Watermark",
  "pdf.ocr": "Recognize text",
  "pdf.compress": "Compress PDF",
  "pdf.organize": "Organize pages",
  "pdf.redact": "Redact",
  "pdf.clean_metadata": "Clean metadata",
  "pdf.to_docx": "PDF to Word",
  "pdf.from_office": "Office to PDF",
  "media.images": "Convert images",
  "media.video": "Convert video",
  "media.remove_background": "Remove background",
  "media.upscale": "Upscale",
  "ai.transcribe": "Transcribe",
  "ai.index": "Index documents",
  "models.install": "Install model",
  "files.clean_scan": "Scan temp files",
  "files.junk_scan": "Scan developer junk",
  "files.usage": "Disk map",
  "files.duplicates": "Find duplicates",
};
const OP_LABEL: Record<string, string> = { move: "Move / rename", quarantine: "Quarantine", create: "Create file" };

type Row = {
  key: string;
  time: number;
  label: string;
  result: string;
  state: string;
  entryIds: number[];
  job?: JobRecord;
};

function summarize(j: JobRecord): string {
  if (j.error) return j.error;
  const r = j.result;
  if (!r) return "";
  if (r.output) return baseName(r.output);
  if (r.outputs) return `${r.count ?? r.outputs.length} file(s)`;
  if (r.items) return `${r.items.length} item(s)`;
  if (r.groups) return `${r.groups.length} group(s)`;
  if (r.indexed != null) return `${r.indexed} indexed, ${r.unchanged} unchanged`;
  return "";
}

function buildRows(jobs: JobRecord[], history: HistoryEntry[]): Row[] {
  const rows: Row[] = [];
  const byJob = new Map<string, HistoryEntry[]>();
  const loose: HistoryEntry[] = [];
  for (const h of history) {
    if (h.job_id) byJob.set(h.job_id, [...(byJob.get(h.job_id) ?? []), h]);
    else loose.push(h);
  }
  for (const j of jobs) {
    const entries = byJob.get(j.id) ?? [];
    const withdrawn = entries.length > 0 && entries.every((e) => e.reverted_at);
    rows.push({
      key: j.id,
      time: j.created_at,
      label: TYPE_LABEL[j.type] ?? j.type,
      result: summarize(j),
      state: withdrawn ? "withdrawn" : j.state,
      entryIds: entries.filter((e) => !e.reverted_at).map((e) => e.id),
      job: j,
    });
  }
  // moves/renames/quarantines that happened outside a job: one row per burst of the same operation
  const sorted = [...loose].sort((a, b) => a.id - b.id);
  let group: HistoryEntry[] = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0];
    rows.push({
      key: `batch-${first.id}`,
      time: first.created_at,
      label: `${OP_LABEL[first.op] ?? first.op}${group.length > 1 ? ` (${group.length})` : ""}`,
      // quarantine shows what left; moves show the new name
      result: (() => {
        const shown = first.op === "quarantine" ? first.source : first.destination;
        return shown ? baseName(shown) + (group.length > 1 ? ", …" : "") : "";
      })(),
      state: group.every((e) => e.reverted_at) ? "withdrawn" : "done",
      entryIds: group.filter((e) => !e.reverted_at).map((e) => e.id),
    });
    group = [];
  };
  for (const h of sorted) {
    const last = group[group.length - 1];
    if (last && (last.op !== h.op || h.created_at - last.created_at > 3)) flush();
    group.push(h);
  }
  flush();
  return rows.sort((a, b) => a.time - b.time);
}

function Activity({ jobs, history, onChange }: { jobs: JobRecord[]; history: HistoryEntry[]; onChange: () => void }) {
  const [error, setError] = useState("");
  const rows = useMemo(() => buildRows(jobs, history), [jobs, history]);
  const running = jobs.some((j) => j.state === "queued" || j.state === "running");

  useEffect(() => {
    if (!running) return;
    const t = setInterval(onChange, 1500);
    return () => clearInterval(t);
  }, [running, onChange]);

  async function undo(row: Row) {
    let failed = 0;
    let lastError = "";
    for (const id of row.entryIds) {
      try {
        await undoEntry(id);
      } catch (e) {
        failed++;
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    setError(failed ? `${failed} item(s) could not be restored: ${lastError}` : "");
    onChange();
  }

  const total = rows.length;
  const display = [...rows].reverse();

  return (
    <>
      <Title
        title="Activity"
        hint="Every operation is a revision. Undo withdraws a revision: created files move to officev2's trash folder and moved files go back where they were. Nothing is deleted."
      />
      {error && <p className="msg bad">{error}</p>}
      <Table
        head={
          <tr>
            <th className="num">Rev</th>
            <th className="op">Operation</th>
            <th>Result</th>
            <th className="date">Date</th>
            <th className="status">Status</th>
            <th className="act">
              <span className="sr">Actions</span>
            </th>
          </tr>
        }
        empty={total === 0 ? "No revisions yet. Run a tool and it will be listed here." : undefined}
      >
        {display.map((r, i) => {
          const live = r.job && (r.job.state === "queued" || r.job.state === "running");
          const pct = r.job?.progress && r.job.progress.total > 0 ? Math.round((r.job.progress.done / r.job.progress.total) * 100) : null;
          return (
            <tr key={r.key} className={r.state === "withdrawn" ? "withdrawn" : ""}>
              <td className="num mono">{revLetter(total - i)}</td>
              <td>{r.label}</td>
              <td className="mono trunc" title={r.result}>
                {live ? `${pct !== null ? pct + "% · " : ""}${r.job?.progress?.message ?? "working"}` : r.result}
              </td>
              <td className="mono nowrap">{new Date(r.time * 1000).toLocaleString()}</td>
              <td className={`state ${r.state}`}>{r.state}</td>
              <td className="act">
                {live && r.job && (
                  <button className="icon text" onClick={() => cancelJob(r.job!.id).then(onChange)}>
                    Cancel
                  </button>
                )}
                {!live && r.entryIds.length > 0 && (
                  <button className="icon text" onClick={() => undo(r)} aria-label={`Withdraw revision ${revLetter(total - i)}`}>
                    <Undo2 size={14} strokeWidth={1.5} />
                    Undo
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </Table>
    </>
  );
}
