import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { CheckField, Message, RunBar, Segmented, SourceField, TextField, Title, baseName, imageFilter, pdfFilter, useTask } from "./shared";
import { PagePreview, PdfSource } from "./pdfview";

function outName(file: string, suffix: string): string {
  return baseName(file).replace(/\.pdf$/i, "") + suffix + ".pdf";
}

/* ---------- Protect: encrypt / unlock ---------- */

export function Protect({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"encrypt" | "restrict" | "unlock">("encrypt");
  const [allow, setAllow] = useState<string[]>(["print"]);
  const [file, setFile] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { busy, message, run } = useTask(onDone);

  const mismatch = mode === "encrypt" && confirm !== "" && confirm !== password;
  const ready = file && !busy && (mode === "unlock" || (password !== "" && (mode === "restrict" || password === confirm)));

  async function go() {
    if (!file) return;
    const output = await save({
      filters: pdfFilter,
      defaultPath: outName(file, mode === "encrypt" ? "-protected" : "-unlocked"),
    });
    if (!output) return;
    if (mode === "restrict") await run("/pdf/restrict", { input: file, output, owner_password: password, allow });
    else await run(mode === "encrypt" ? "/pdf/encrypt" : "/pdf/unlock", { input: file, output, password });
    setPassword("");
    setConfirm("");
  }

  return (
    <>
      <Title
        title="Protect"
        hint={
          mode === "encrypt"
            ? "Save a copy that needs a password to open (AES-256). The original is not modified."
            : mode === "restrict"
              ? "Anyone can open the copy, but only what you allow below works without your password. Good for contracts and handouts."
              : "Save a copy without password or print/copy restrictions. You must know the password; officev2 does not break passwords."
        }
      />
      <Segmented
        label="Action"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setPassword("");
          setConfirm("");
        }}
        options={[
          { id: "encrypt", label: "Password to open" },
          { id: "restrict", label: "Limit printing and copying" },
          { id: "unlock", label: "Unlock" },
        ]}
      />
      <PdfSource file={file} onPick={setFile} />
      <TextField
        id="pw"
        label={mode === "encrypt" ? "Password" : mode === "restrict" ? "Your owner password (needed to lift the limits later)" : "Password (leave empty if the file only has restrictions)"}
        type="password"
        value={password}
        onChange={setPassword}
      />
      {mode === "restrict" && (
        <div className="field">
          <span className="label">What people may do without the password</span>
          <div className="checks">
            {[
              { id: "print", label: "Print" },
              { id: "copy", label: "Copy text and pictures" },
              { id: "edit", label: "Change the document" },
              { id: "annotate", label: "Add notes and fill forms" },
            ].map((a) => (
              <CheckField key={a.id} label={a.label} checked={allow.includes(a.id)} onChange={(v) => setAllow((cur) => (v ? [...cur, a.id] : cur.filter((x) => x !== a.id)))} />
            ))}
          </div>
        </div>
      )}
      {mode === "encrypt" && (
        <TextField
          id="pw2"
          label="Repeat password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          hint={mismatch ? "Passwords do not match." : "There is no recovery: a lost password means the copy cannot be opened."}
        />
      )}
      <div className="actions">
        <button className="primary" disabled={!ready} onClick={go}>
          {busy ? "Working…" : mode === "encrypt" ? "Encrypt to…" : mode === "restrict" ? "Save limited copy to…" : "Unlock to…"}
        </button>
      </div>
      <Message m={message} />
    </>
  );
}

/* ---------- Watermark with a live preview ---------- */

export function Watermark({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<"text" | "image">("text");
  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState("CONFIDENTIAL");
  const [opacity, setOpacity] = useState("25");
  const [angle, setAngle] = useState("45");
  const [fontSize, setFontSize] = useState("64");
  const [image, setImage] = useState<string | null>(null);
  const [width, setWidth] = useState("120");
  const [margin, setMargin] = useState("36");
  const [pages, setPages] = useState("");
  const [page, setPage] = useState(1);
  const task = useTask(onDone);

  const num = (v: string, fallback: number) => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);
  const params =
    kind === "text"
      ? { text, opacity: Math.min(1, Math.max(0.02, num(opacity, 25) / 100)), angle: Math.min(180, Math.max(-180, num(angle, 45))), font_size: Math.min(400, Math.max(6, num(fontSize, 64))) }
      : { image, width_pt: Math.max(1, num(width, 120)), x: Math.max(0, num(margin, 36)), y: Math.max(0, num(margin, 36)) };

  const valid = file && (kind === "text" ? text.trim() !== "" : image !== null);

  async function go() {
    if (!file) return;
    const output = await save({ filters: pdfFilter, defaultPath: outName(file, "-stamped") });
    if (!output) return;
    const common = { input: file, output, kind, pages: pages.trim() || null };
    await task.run(
      "/pdf/watermark",
      kind === "text"
        ? { ...common, text, opacity: params.opacity, angle: (params as { angle: number }).angle, font_size: (params as { font_size: number }).font_size }
        : { ...common, image, width: (params as { width_pt: number }).width_pt, x: (params as { x: number }).x, y: (params as { y: number }).y },
    );
  }

  const previewBody = valid ? { input: file, page, width: 900, kind, pages: pages.trim() || null, ...params } : null;

  return (
    <>
      <Title
        title="Watermark"
        hint="Stamp text across pages, or place a logo or signature in the bottom-right corner. The preview shows each page as it will look. Your original is not modified."
      />
      <div className="split">
        <div>
          <Segmented
            label="Type"
            value={kind}
            onChange={setKind}
            options={[
              { id: "text", label: "Text" },
              { id: "image", label: "Image" },
            ]}
          />
          <PdfSource file={file} onPick={(f) => { setFile(f); setPage(1); }} peek={false} />
          {kind === "text" ? (
            <>
              <TextField id="wm-text" label="Text" value={text} onChange={setText} />
              <div className="row3">
                <TextField id="wm-op" label="Opacity %" type="number" mono value={opacity} onChange={setOpacity} />
                <TextField id="wm-an" label="Angle °" type="number" mono value={angle} onChange={setAngle} />
                <TextField id="wm-fs" label="Size pt" type="number" mono value={fontSize} onChange={setFontSize} />
              </div>
            </>
          ) : (
            <>
              <SourceField label="Image (PNG or JPG)" file={image} onPick={setImage} filters={imageFilter} />
              <div className="row3">
                <TextField id="wm-w" label="Width pt" type="number" mono value={width} onChange={setWidth} />
                <TextField id="wm-m" label="Margin pt" type="number" mono value={margin} onChange={setMargin} />
              </div>
            </>
          )}
          <TextField id="wm-pages" label="Pages (optional)" mono value={pages} onChange={setPages} hint="Empty means all pages. Example: 1-3,5. Pages you leave out stay as they are." />
        </div>
        <aside className="side">
          <PagePreview
            file={file}
            page={page}
            onPage={setPage}
            extra={previewBody ? { url: "/pdf/preview-watermark", body: previewBody, delay: 300 } : undefined}
            note={(d) => (d.stamped ? "This page will be stamped." : "This page is outside your selection, so it stays as it is.")}
          />
        </aside>
      </div>
      <RunBar label="Stamp to…" busyLabel="Stamping…" disabled={!valid} onRun={go} task={task} />
    </>
  );
}

/* ---------- OCR ---------- */

export function Ocr({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [pages, setPages] = useState("");
  const task = useTask(onDone);

  async function go() {
    if (!file) return;
    const output = await save({ filters: pdfFilter, defaultPath: outName(file, "-searchable") });
    if (output) await task.run("/pdf/ocr", { input: file, output, pages: pages.trim() || null });
  }

  return (
    <>
      <Title
        title="Recognize text"
        hint="Add an invisible, selectable text layer to scanned pages. The pages keep their original look. Runs on this computer; large files take a while."
      />
      <PdfSource file={file} onPick={setFile} />
      <TextField id="ocr-pages" label="Pages (optional)" mono value={pages} onChange={setPages} hint="Empty means all pages. Example: 1-3,5" />
      <RunBar label="Recognize to…" busyLabel="Recognizing…" disabled={!file} onRun={go} task={task} />
    </>
  );
}
