import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { FileUp, Info } from "lucide-react";
import { RunBar, SelectField, TextField, Title, baseName, useTask } from "../shared";
import { takeHint, takePending } from "../lib/handoff";
import { ALL_EXTS, KIND_NAME, OPTIONS, defaultParams, kindOf, optionsFor, outputExt, overview } from "../lib/convertoptions";

const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, "");

/** One screen: choose a file, and it lists what that file can become. */
export function Convert({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(() => {
    const h = takeHint(); // a start-screen card can name what the person wants to do
    return h && OPTIONS.some((o) => o.id === h) ? h : null;
  });
  const [params, setParams] = useState<Record<string, string>>({});
  const [help, setHelp] = useState(false);
  const task = useTask(onDone);

  useEffect(() => {
    const given = takePending(); // right-clicked "Convert with officev2"
    if (given) setFile(given);
  }, []);

  const kind = file ? kindOf(file) : null;
  const options = kind ? optionsFor(kind) : [];
  const option = options.find((o) => o.id === chosen) ?? null;

  useEffect(() => setParams(option ? defaultParams(option) : {}), [option?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function choose() {
    const picked = await open({ multiple: false, filters: [{ name: "Files I can convert", extensions: ALL_EXTS }] });
    if (typeof picked !== "string") return;
    setFile(picked);
    const k = kindOf(picked);
    if (!k || !optionsFor(k).some((o) => o.id === chosen)) setChosen(optionsFor(k ?? "pdf").length === 1 && k ? optionsFor(k)[0].id : null);
  }

  async function run() {
    if (!file || !option) return;
    let target: string | null;
    if (option.output.type === "file") {
      const ext = outputExt(option, params) ?? "pdf";
      target = (await save({ filters: [{ name: ext.toUpperCase(), extensions: [ext] }], defaultPath: `${stem(file)}${option.output.suffix ?? ""}.${ext}` })) ?? null;
    } else {
      const dir = await open({ directory: true, multiple: false });
      target = typeof dir === "string" ? dir : null;
    }
    if (target) await task.run(option.path, option.body(file, target, params));
  }

  return (
    <>
      <Title title="Convert" hint="Choose a file. This screen shows what it can be turned into." />

      <div className="cv-pick">
        <button className="primary cv-choose" onClick={() => void choose()}>
          <FileUp size={18} strokeWidth={1.5} aria-hidden /> {file ? "Choose another file…" : "Choose a file…"}
        </button>
        <button className={`icon cv-info${help ? " on" : ""}`} aria-label="What can I convert?" aria-expanded={help} title="What can I convert?" onClick={() => setHelp((h) => !h)}>
          <Info size={18} strokeWidth={1.5} />
        </button>
      </div>

      {help && (
        <div className="cv-help" role="region" aria-label="What can I convert?">
          <h2>What can I convert?</h2>
          <ul>
            {overview().map((r) => (
              <li key={r.from}>
                <b>{r.from}</b>
                <span className="cv-to">
                  <span>can become:</span>
                  {r.to.map((t) => (
                    <em key={t}>{t}</em>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!file && !help && <p className="hint">Pick a PDF, a photo, a Word / Excel / PowerPoint file or a web page, and the choices appear here.</p>}

      {file && !kind && <p className="msg bad">This kind of file cannot be converted here. Press the information button to see what can.</p>}

      {file && kind && (
        <>
          <p className="cv-file" title={file}>
            <b className="mono">{baseName(file)}</b> <span className="muted">Type:</span> <b>{KIND_NAME[kind]}</b> <span className="muted">It can become:</span>
          </p>
          <div className="cv-cards" role="radiogroup" aria-label="Convert to">
            {options.map((o) => (
              <button key={o.id} role="radio" aria-checked={o.id === chosen} className={`cv-card${o.id === chosen ? " on" : ""}`} onClick={() => setChosen(o.id)}>
                <b>{o.title}</b>
                <small>{o.text}</small>
              </button>
            ))}
          </div>

          {option && (
            <div className="cv-run">
              {(option.params ?? []).map((p) =>
                p.type === "select" ? (
                  <SelectField key={p.id} id={`cv-${p.id}`} label={p.label} value={params[p.id] ?? p.value} onChange={(v) => setParams((c) => ({ ...c, [p.id]: v }))} options={p.options} />
                ) : (
                  <TextField key={p.id} id={`cv-${p.id}`} label={p.label} type="number" mono value={params[p.id] ?? p.value} onChange={(v) => setParams((c) => ({ ...c, [p.id]: v }))} hint={p.hint} />
                ),
              )}
              <RunBar label={option.output.type === "folder" ? "Convert and choose a folder…" : "Convert and save as…"} busyLabel="Working…" task={task} onRun={() => void run()} />
            </div>
          )}
        </>
      )}
    </>
  );
}
