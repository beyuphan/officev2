import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Aperture,
  Braces,
  ChevronRight,
  ClipboardList,
  Combine,
  Cpu,
  Eraser,
  EyeOff,
  Crop,
  FileOutput,
  FilePenLine,
  House,
  HardDrive,
  History,
  GitCompare,
  Paperclip,
  Printer,
  Puzzle,
  Files,
  ScanLine,
  Share2,
  BadgeCheck,
  UserSquare,
  LayoutGrid,
  Info,
  ImageMinus,
  KeyRound,
  Library,
  Lock,
  Mic,
  PencilLine,
  Pipette,
  ScanText,
  Stamp,
  TextCursorInput,
  Type,
  Undo2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { request, cancelJob, listHistory, listJobs, undoEntry, waitForEngine, type HistoryEntry, type JobRecord } from "./api";
import { Table, Title, baseName } from "./shared";
import { Ocr, Protect, Watermark } from "./tools";
import { Redact } from "./views/docs";
import { Convert } from "./views/convert";
import { Background, Video } from "./views/media";
import { Documents, Models, Transcribe } from "./views/ai";
import { Autopilot, Cleanup, DiskMap, Rename } from "./views/files";
import { Vault } from "./views/vault";
import { DevLab, TextTools } from "./views/utils";
import { Clipboard, ScreenTools } from "./views/desk";
import { TitleBar } from "./titlebar";
import { PhotoEditor } from "./views/photo";
import { PdfEditor } from "./views/pdfeditor";
import { Home } from "./views/home";
import { Addons, Attachments, Compare, PdfBatch, PrintLayout, ScanClean, Sign } from "./views/more";
import { Collage, IdPhoto, Social } from "./views/photomake";
import { EDITOR_FILE } from "./lib/editorfile";
import { collectBurst, parseOpenArgs } from "./lib/openargs";
import { NOTICE, type Notice } from "./lib/notify";
import { routeDrop, setPending, setPendingMany } from "./lib/handoff";
import { Pages } from "./views/pages";
import { getLang, setLang, type Lang } from "./lib/i18n";
import { Forms, PageSize, Properties } from "./views/pdftools";
import "./App.css";
import "./forms.css";
import "./editors.css";

type ViewDef = { id: string; label: string; group: string; Icon: LucideIcon; keywords?: string };

const VIEWS: ViewDef[] = [
  { id: "home", label: "Start", group: "Start", Icon: House, keywords: "home start begin what to do" },
  { id: "pdfedit", label: "PDF editor", group: "PDF", Icon: FilePenLine, keywords: "pdf edit add text signature image highlight draw note link erase annotate sign stamp" },
  { id: "pages", label: "Pages", group: "PDF", Icon: Combine, keywords: "pdf merge combine join split extract cut reorder rotate delete duplicate organize pages blank insert" },
  { id: "pdfbatch", label: "Many PDFs at once", group: "PDF", Icon: Files, keywords: "pdf batch bulk folder compress watermark many files template" },
  { id: "compare", label: "Compare two PDFs", group: "PDF", Icon: GitCompare, keywords: "pdf compare difference versions changes diff" },
  { id: "scanclean", label: "Clean up a scan", group: "PDF", Icon: ScanLine, keywords: "scan straighten deskew crop black white clean" },
  { id: "printlayout", label: "Print layout", group: "PDF", Icon: Printer, keywords: "pdf print booklet n-up pages per sheet imposition duplex" },
  { id: "attachments", label: "Attachments and labels", group: "PDF", Icon: Paperclip, keywords: "pdf attach files page labels numbering roman" },
  { id: "sign", label: "Digital signature", group: "PDF", Icon: BadgeCheck, keywords: "pdf sign certificate pfx p12 verify signature" },
  { id: "pagesize", label: "Page size", group: "PDF", Icon: Crop, keywords: "pdf crop margins paper a4 letter resize" },
  { id: "redact", label: "Redact", group: "PDF", Icon: EyeOff, keywords: "pdf black out remove text" },
  { id: "watermark", label: "Watermark", group: "PDF", Icon: Stamp, keywords: "pdf stamp logo signature" },
  { id: "protect", label: "Protect", group: "PDF", Icon: Lock, keywords: "pdf password encrypt unlock" },
  { id: "ocr", label: "Recognize text", group: "PDF", Icon: ScanText, keywords: "ocr scan searchable" },
  { id: "convert", label: "Convert", group: "PDF", Icon: FileOutput, keywords: "convert word docx excel office pdf compress smaller jpg png webp heic photo format html text tables markdown repair metadata" },
  { id: "forms", label: "Forms", group: "PDF", Icon: TextCursorInput, keywords: "pdf fill form fields" },
  { id: "props", label: "Properties", group: "PDF", Icon: Info, keywords: "pdf metadata title author bookmarks outline" },
  { id: "photo", label: "Photo editor", group: "Photo", Icon: Aperture, keywords: "photo edit crop rotate straighten blur filter adjust brightness contrast text draw resize effects" },
  { id: "social", label: "Sizes for social media", group: "Photo", Icon: Share2, keywords: "instagram youtube linkedin facebook story cover resize template" },
  { id: "idphoto", label: "Passport photos", group: "Photo", Icon: UserSquare, keywords: "passport id photo vesikalik biometric print sheet" },
  { id: "collage", label: "Collage and more", group: "Photo", Icon: LayoutGrid, keywords: "collage gif animation panorama hdr merge exposure" },
  { id: "background", label: "Remove background", group: "Photo", Icon: ImageMinus, keywords: "transparent png cutout" },
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
  { id: "addons", label: "Add-ons", group: "System", Icon: Puzzle, keywords: "install extra speech background ocr word optional download" },
  { id: "activity", label: "Activity", group: "System", Icon: History, keywords: "history undo jobs" },
];
/** Tools that were folded into Pages; old links and shortcuts still land somewhere sensible. */
const OLD_VIEWS: Record<string, string> = { merge: "pages", split: "pages", organize: "pages", addsplit: "pages", export: "convert", images: "convert", upscale: "convert", pdfimages: "pdfedit", pagenums: "pdfedit", finish: "pdfedit" };
/** What most people need, always visible. Everything else lives under "More tools". */
const MAIN = ["home", "pdfedit", "pages", "photo", "convert", "clipboard"];
const GROUPS = [...new Set(VIEWS.filter((v) => !MAIN.includes(v.id)).map((v) => v.group))];

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
    const id = OLD_VIEWS[h] ?? h;
    return VIEWS.some((v) => v.id === id) ? id : "home";
  });
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loadError, setLoadError] = useState("");
  const [palette, setPalette] = useState(false);
  const [dropSeq, setDropSeq] = useState(0); // a new drop restarts the tool, so it opens the new file
  const [dragging, setDragging] = useState(false);
  const [dropNote, setDropNote] = useState("");
  const [lang, setLangState] = useState<Lang>(getLang());
  const [openGroups, setOpenGroups] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("officev2.groups") ?? "null");
      if (Array.isArray(saved)) return saved;
    } catch {
      /* storage unavailable */
    }
    return [];
  });
  // the editors want the whole window, but only once a file is open: until then the tool list stays
  const [editorFile, setEditorFile] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setEditorFile(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener(EDITOR_FILE, on);
    return () => window.removeEventListener(EDITOR_FILE, on);
  }, []);
  const immersive = (view === "photo" || view === "pdfedit") && editorFile;
  const [railOpen, setRailOpen] = useState(!immersive);
  // the editors want the whole window: the tool list folds away when one opens and returns when you leave it
  useEffect(() => setRailOpen(!immersive), [immersive]);

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

  // the engine stopped while the app was open: say so, offer a restart, and carry on when it answers again
  const [engineDown, setEngineDown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      setNotice((e as CustomEvent<Notice>).detail.text);
      clearTimeout(timer);
      timer = setTimeout(() => setNotice(null), 8000);
    };
    window.addEventListener(NOTICE, on);
    return () => {
      window.removeEventListener(NOTICE, on);
      clearTimeout(timer);
    };
  }, []);
  const readyRef = useRef(false);
  readyRef.current = engine === "ready";
  useEffect(() => {
    const down = () => readyRef.current && setEngineDown(true);
    window.addEventListener("engine-down", down);
    return () => window.removeEventListener("engine-down", down);
  }, []);
  useEffect(() => {
    if (!engineDown) return;
    const t = setInterval(() => {
      request("/health")
        .then(() => {
          setEngineDown(false);
          void refresh();
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [engineDown, refresh]);

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

  // files Windows hands to the app (double click, right click "Edit/Convert with officev2", command line)
  useEffect(() => {
    if (engine !== "ready") return;
    let off: (() => void) | undefined;
    let dead = false;
    let convert = false;
    const open = (paths: string[]) => {
      if (!paths.length) return;
      if (convert) {
        setPending(paths[0]);
        setDropSeq((n) => n + 1);
        setView("convert");
        convert = false;
        return;
      }
      const route = routeDrop(paths);
      if (!route) return;
      if (route.tool === "pages") setPendingMany(route.paths);
      else setPending(route.paths[0]);
      setDropSeq((n) => n + 1);
      setView(route.tool);
    };
    const burst = collectBurst(open);
    const take = (args: string[]) => {
      const req = parseOpenArgs(args);
      if (req.convert) convert = true;
      if (req.paths.length) burst(req.paths);
    };
    Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")])
      .then(async ([{ invoke }, { listen }]) => {
        take(await invoke<string[]>("take_open_args"));
        const un = await listen<string[]>("open-files", (e) => {
          void invoke("take_open_args"); // the same files are in the queue too: empty it so they are not opened twice
          take(e.payload);
        });
        if (dead) un();
        else off = un;
      })
      .catch(() => undefined); // plain browser: no desktop shell
    return () => {
      dead = true;
      off?.();
    };
  }, [engine]);

  useEffect(() => {
    // files dropped on the window open straight in the right editor (desktop shell only)
    let off: (() => void) | undefined;
    let dead = false;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((e) => {
        const t = e.payload.type;
        if (t === "enter" || t === "over") setDragging(true);
        else if (t === "leave") setDragging(false);
        else if (t === "drop") {
          setDragging(false);
          const route = routeDrop(e.payload.paths);
          if (route) {
            setDropNote("");
            if (route.tool === "pages") setPendingMany(route.paths);
            else setPending(route.paths[0]);
            setDropSeq((n) => n + 1);
            setView(route.tool);
            setPalette(false);
          } else setDropNote("That kind of file can't be opened here. Drop a PDF or a photo.");
        }
      }))
      .then((un) => (dead ? un() : (off = un)))
      .catch(() => undefined); // plain browser: no desktop shell
    return () => {
      dead = true;
      off?.();
    };
  }, []);

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
  // the group of the tool you are in is always open, so you can see where you are
  const isOpen = (g: string) => g === current.group || openGroups.includes(g);
  const [moreOpen, setMoreOpen] = useState(false);
  const showMore = moreOpen || !MAIN.includes(current.id);
  const toggleGroup = (g: string) =>
    setOpenGroups((cur) => {
      const next = cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g];
      try {
        localStorage.setItem("officev2.groups", JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  const go = (id: string) => {
    setView(OLD_VIEWS[id] ?? id);
    setPalette(false);
  };

  return (
    <div className="app">
    <TitleBar tool={current.label} railOpen={railOpen} onToggleRail={() => setRailOpen((o) => !o)} lang={lang} onLang={(l) => { setLang(l); setLangState(l); }} />
    <div className={`shell ${railOpen ? "" : "norail"}`}>
      <nav className="rail" aria-label="Tools">
        <button className="palette-hint" onClick={() => setPalette(true)} aria-label="Open command palette">
          <span>Search tools</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="group main">
          {VIEWS.filter((v) => MAIN.includes(v.id)).map(({ id, label, Icon }) => (
            <button key={id} className={view === id ? "nav on" : "nav"} aria-current={view === id ? "page" : undefined} onClick={() => go(id)}>
              <Icon size={16} strokeWidth={1.5} aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <button className="group-label foldable more" aria-expanded={showMore} onClick={() => MAIN.includes(current.id) && setMoreOpen((o) => !o)}>
          <ChevronRight size={13} strokeWidth={1.8} aria-hidden className={showMore ? "turned" : ""} />
          More tools
        </button>
        {showMore && GROUPS.map((g) => (
          <div key={g} className="group">
            <button className="group-label foldable" aria-expanded={isOpen(g)} onClick={() => g !== current.group && toggleGroup(g)}>
              <ChevronRight size={13} strokeWidth={1.8} aria-hidden className={isOpen(g) ? "turned" : ""} />
              {g}
              <small>{VIEWS.filter((v) => v.group === g && !MAIN.includes(v.id)).length}</small>
            </button>
            {isOpen(g) &&
              VIEWS.filter((v) => v.group === g && !MAIN.includes(v.id)).map(({ id, label, Icon }) => (
                <button key={id} className={view === id ? "nav on" : "nav"} aria-current={view === id ? "page" : undefined} onClick={() => go(id)}>
                  <Icon size={16} strokeWidth={1.5} aria-hidden />
                  {label}
                </button>
              ))}
          </div>
        ))}
      </nav>

      <main>
        <div className={`sheet ${immersive ? "fill" : ""}`}>
          {engine === "error" && <p className="msg bad">{engineError}</p>}
          {notice && (
            <p className="msg bad notice" role="alert">
              {notice} <button onClick={() => setNotice(null)}>Dismiss</button>
            </p>
          )}
          {engineDown && (
            <p className="msg bad" role="alert">
              The engine stopped answering. {" "}
              <button
                onClick={() =>
                  import("@tauri-apps/api/core").then(({ invoke }) => invoke("restart_engine")).catch(() => undefined)
                }
              >
                Restart the engine
              </button>
            </p>
          )}
          {engine === "starting" && <p className="muted">Starting the local engine…</p>}
          {engine === "ready" && loadError && <p className="msg bad">{loadError}</p>}
          {dropNote && <p className="msg bad">{dropNote}</p>}
          {engine === "ready" && <ViewSwitch key={dropSeq} id={view} refresh={refresh} go={go} jobs={jobs} history={history} />}
        </div>

      </main>

      {dragging && <div className="drop-veil" aria-hidden>Drop a PDF or photo to open it</div>}
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
    case "home":
      return <Home go={go} />;
    case "pdfedit":
      return <PdfEditor onDone={refresh} />;
    case "photo":
      return <PhotoEditor onDone={refresh} />;
    case "pdfbatch":
      return <PdfBatch onDone={refresh} />;
    case "sign":
      return <Sign onDone={refresh} />;
    case "compare":
      return <Compare onDone={refresh} />;
    case "scanclean":
      return <ScanClean onDone={refresh} />;
    case "printlayout":
      return <PrintLayout onDone={refresh} />;
    case "attachments":
      return <Attachments onDone={refresh} />;
    case "social":
      return <Social onDone={refresh} />;
    case "idphoto":
      return <IdPhoto onDone={refresh} />;
    case "collage":
      return <Collage onDone={refresh} />;
    case "addons":
      return <Addons onDone={refresh} />;
    case "pagesize":
      return <PageSize onDone={refresh} />;
    case "forms":
      return <Forms onDone={refresh} />;
    case "props":
      return <Properties onDone={refresh} />;
    case "pages":
      return <Pages onDone={refresh} />;
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
    case "video":
      return <Video onDone={refresh} />;
    case "background":
      return <Background onDone={refresh} />;
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
  "photo.export": "Save edited photo",
  "photo.batch": "Edit many photos",
  "pdf.edit": "Edit PDF",
  "pdf.stamp": "Page numbers and headers",
  "pdf.crop": "Crop pages",
  "pdf.resize": "Change paper size",
  "pdf.insert": "Insert pages",
  "pdf.split_parts": "Split PDF",
  "pdf.extract_images": "Extract pictures",
  "pdf.to_images": "Pages to pictures",
  "pdf.from_images": "Pictures to PDF",
  "pdf.extract_text": "Extract text",
  "pdf.flatten": "Flatten PDF",
  "pdf.grayscale": "Grayscale PDF",
  "pdf.fill_form": "Fill form",
  "pdf.set_props": "Edit properties",
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
