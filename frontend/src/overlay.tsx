import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { post } from "./api";
import "./overlay.css";

/** Always-on-top window showing one reference image. Drag anywhere to move; double-click or Esc closes. */
export function Pin() {
  const [src, setSrc] = useState<string | null>(null);
  const close = () => void getCurrentWindow().close();

  useEffect(() => {
    invoke<string | null>("overlay_payload").then((p) => p && setSrc(convertFileSrc(p)));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="pin" data-tauri-drag-region onDoubleClick={close}>
      {src && <img src={src} alt="Pinned reference" draggable={false} data-tauri-drag-region />}
      <span className="pin-hint">Drag to move · double-click or Esc to close</span>
    </div>
  );
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/** Fullscreen screenshot where the user drags a rectangle; the text inside is read locally and copied. */
export function Snip() {
  const [src, setSrc] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [state, setState] = useState<"select" | "reading" | "done" | "error">("select");
  const [text, setText] = useState("");
  const img = useRef<HTMLImageElement>(null);
  const dragging = useRef(false);

  const finish = () => void invoke("finish_snip");

  useEffect(() => {
    (async () => {
      const path = await invoke<string | null>("overlay_payload");
      if (!path) return;
      // fetch -> blob keeps the canvas untainted when we crop later
      const blob = await (await fetch(convertFileSrc(path))).blob();
      setSrc(URL.createObjectURL(blob));
    })();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const norm = (b: Box) => ({
    x: Math.min(b.x0, b.x1),
    y: Math.min(b.y0, b.y1),
    w: Math.abs(b.x1 - b.x0),
    h: Math.abs(b.y1 - b.y0),
  });

  async function read(b: Box) {
    const el = img.current;
    if (!el) return;
    const r = norm(b);
    const sx = el.naturalWidth / el.clientWidth;
    const sy = el.naturalHeight / el.clientHeight;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(r.w * sx));
    canvas.height = Math.max(1, Math.round(r.h * sy));
    canvas.getContext("2d")!.drawImage(el, r.x * sx, r.y * sy, r.w * sx, r.h * sy, 0, 0, canvas.width, canvas.height);
    setState("reading");
    try {
      const res = await post<{ text: string }>("/ai/ocr-image", { image_base64: canvas.toDataURL("image/png").split(",")[1] });
      if (!res.text.trim()) {
        setText("No text found in that area.");
        setState("error");
        return;
      }
      await invoke("set_clipboard", { text: res.text });
      setText(res.text);
      setState("done");
    } catch (e) {
      setText(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  const r = box ? norm(box) : null;

  return (
    <div
      className="snip"
      onMouseDown={(e) => {
        if (state !== "select") return;
        dragging.current = true;
        setBox({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      }}
      onMouseMove={(e) => dragging.current && setBox((b) => b && { ...b, x1: e.clientX, y1: e.clientY })}
      onMouseUp={(e) => {
        if (!dragging.current || !box) return;
        dragging.current = false;
        const done = { ...box, x1: e.clientX, y1: e.clientY };
        setBox(done);
        const n = norm(done);
        if (n.w > 8 && n.h > 8) void read(done);
        else setBox(null);
      }}
    >
      {src && <img ref={img} src={src} alt="" draggable={false} />}
      {r && <div className="sel" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />}
      {state === "select" && !box && <div className="snip-hint">Drag to select the text you want. Esc cancels.</div>}
      {state !== "select" && (
        <div className="snip-result" onMouseDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()}>
          {state === "reading" && <p>Reading text on this computer…</p>}
          {state === "done" && (
            <>
              <p className="copied">Copied to the clipboard</p>
              <pre>{text}</pre>
            </>
          )}
          {state === "error" && <p className="bad">{text}</p>}
          {state !== "reading" && (
            <div className="row">
              {state === "error" && <button onClick={() => { setBox(null); setState("select"); }}>Try again</button>}
              <button className="primary" onClick={finish}>
                Close
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
