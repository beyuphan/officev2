import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckField, Message, SourceField, Title, formatBytes, imageFilter } from "../shared";
import { hexToRgb, parseColor, rgbToHsl, urlHost } from "../lib/color";

const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return /__TAURI|invoke|not a function|undefined/i.test(m) ? "This works in the officev2 desktop app." : m;
};

/* ---------------------------------- clipboard history ---------------------------------- */

type Clip = { id: number; kind: "text" | "image"; text: string; width: number; height: number; thumb: string | null; created_at: number; pinned: boolean };

/** The clipboard history only records while the app runs, so it can start with Windows (hidden in the tray). */
function StartWithWindows() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    import("@tauri-apps/plugin-autostart").then((m) => m.isEnabled()).then(setOn).catch(() => setOn(null));
  }, []);
  if (on === null) return null; // plain browser: nothing to switch
  return (
    <CheckField
      label="Start with Windows"
      checked={on}
      onChange={(v) => {
        import("@tauri-apps/plugin-autostart").then((m) => (v ? m.enable() : m.disable())).then(() => setOn(v)).catch(() => undefined);
      }}
    />
  );
}

export function Clipboard() {
  const [items, setItems] = useState<Clip[]>([]);
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await invoke<Clip[]>("clip_list", { query: query || null }));
      setPaused(await invoke<boolean>("clip_paused"));
    } catch (e) {
      setMessage({ ok: false, text: errText(e) });
    }
  }, [query]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  const run = (p: Promise<unknown>) => p.then(load).catch((e) => setMessage({ ok: false, text: errText(e) }));

  return (
    <>
      <Title
        title="Clipboard"
        hint="The last 100 things you copied, text and images, kept on this computer. Press Ctrl+Shift+V in any program to open this list next to your cursor and paste from it. Anything a password manager marks as private is never recorded."
      />
      <div className="inline" style={{ marginBottom: 14 }}>
        <input
          aria-label="Search clipboard history"
          className="wide"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={() => run(invoke("clip_set_paused", { paused: !paused }))}>{paused ? "Resume capture" : "Pause capture"}</button>
        <StartWithWindows />
        <button onClick={() => run(invoke("clip_clear"))} disabled={items.every((i) => i.pinned)}>
          Clear unpinned
        </button>
      </div>
      {paused && <p className="hint">Capture is paused. Nothing you copy is recorded until you resume.</p>}
      <Message m={message} />
      {items.length === 0 ? (
        <p className="muted">{query ? "Nothing matches." : "Nothing recorded yet. Copy some text and it will appear here."}</p>
      ) : (
        <ul className="clips">
          {items.map((c) => {
            const isImage = c.kind === "image";
            const color = isImage ? null : parseColor(c.text);
            const host = isImage ? null : urlHost(c.text);
            return (
              <li key={c.id} className={c.pinned ? "pinned" : ""}>
                {color && <i className="swatch" style={{ background: color }} aria-label={`Color ${c.text}`} />}
                <span className="clip-text">
                  {isImage ? (
                    <>
                      {c.thumb && <img className="clip-thumb" src={`data:image/png;base64,${c.thumb}`} alt={`Copied image, ${c.width} by ${c.height}`} />}
                      <small className="note">
                        Image · {c.width}×{c.height} · {new Date(c.created_at).toLocaleString()}
                      </small>
                    </>
                  ) : (
                    <>
                      {host && <small className="note">link to {host}</small>}
                      <span className="mono">{c.text.length > 240 ? c.text.slice(0, 240) + "…" : c.text}</span>
                      <small className="note">
                        {new Date(c.created_at).toLocaleString()} · {formatBytes(new TextEncoder().encode(c.text).length)}
                      </small>
                    </>
                  )}
                </span>
                <span className="clip-actions">
                  <button
                    className="icon text"
                    onClick={() =>
                      run(invoke("clip_copy", { id: c.id }).then(() => {
                        setCopied(c.id);
                        setTimeout(() => setCopied((x) => (x === c.id ? null : x)), 1200);
                      }))
                    }
                  >
                    {copied === c.id ? "Copied" : "Copy"}
                  </button>
                  <button className="icon text" onClick={() => run(invoke("clip_pin", { id: c.id, pinned: !c.pinned }))}>
                    {c.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button className="icon text" onClick={() => run(invoke("clip_delete", { id: c.id }))}>
                    Delete
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/* ------------------------------ color picker, pin, text capture ------------------------------ */

type Picked = { hex: string };

export function ScreenTools() {
  const [countdown, setCountdown] = useState<number | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [recent, setRecent] = useState<string[]>(() => JSON.parse(localStorage.getItem("lf.colors") ?? "[]"));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [alsoCopy, setAlsoCopy] = useState(true);

  useEffect(() => localStorage.setItem("lf.colors", JSON.stringify(recent)), [recent]);

  function pickColor() {
    setMessage(null);
    let n = 3;
    setCountdown(n);
    const t = setInterval(async () => {
      n -= 1;
      if (n > 0) return setCountdown(n);
      clearInterval(t);
      setCountdown(null);
      try {
        const hex = await invoke<string>("pick_color");
        setPicked({ hex });
        setRecent((r) => [hex, ...r.filter((x) => x !== hex)].slice(0, 12));
        if (alsoCopy) await invoke("set_clipboard", { text: hex });
      } catch (e) {
        setMessage({ ok: false, text: errText(e) });
      }
    }, 1000);
  }

  const rgb = picked ? hexToRgb(picked.hex) : null;
  const hsl = rgb ? rgbToHsl(rgb) : null;
  const copy = (text: string) => invoke("set_clipboard", { text }).catch((e) => setMessage({ ok: false, text: errText(e) }));

  return (
    <>
      <Title title="Screen tools" hint="Pick a color from anywhere on screen, keep a reference image above your other windows, or copy text out of anything you can see." />

      <h2>Color picker</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Press the button, then move the pointer over any pixel before the countdown ends.
      </p>
      <div className="actions tight">
        <button disabled={countdown !== null} onClick={pickColor}>
          {countdown !== null ? `Picking in ${countdown}…` : "Pick a color"}
        </button>
      </div>
      <CheckField label="Copy the HEX code to the clipboard" checked={alsoCopy} onChange={setAlsoCopy} />
      {picked && rgb && hsl && (
        <div className="picked">
          <i className="swatch big" style={{ background: picked.hex }} />
          <div>
            <b className="mono">{picked.hex}</b>
            <div className="mono note">rgb({rgb.r}, {rgb.g}, {rgb.b})</div>
            <div className="mono note">hsl({hsl.h}, {hsl.s}%, {hsl.l}%)</div>
            <div className="actions tight">
              <button className="icon text" onClick={() => copy(picked.hex)}>Copy HEX</button>
              <button className="icon text" onClick={() => copy(`rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`)}>Copy RGB</button>
            </div>
          </div>
        </div>
      )}
      {recent.length > 0 && (
        <div className="swatches" aria-label="Recent colors">
          {recent.map((c) => (
            <button key={c} className="swatch" style={{ background: c }} title={`${c} — click to copy`} aria-label={`Copy ${c}`} onClick={() => copy(c)} />
          ))}
        </div>
      )}

      <hr />
      <h2>Pin an image</h2>
      <SourceField label="Image" file={image} onPick={setImage} filters={imageFilter} />
      <div className="actions tight">
        <button
          disabled={!image}
          onClick={() => invoke("pin_image", { path: image }).catch((e) => setMessage({ ok: false, text: errText(e) }))}
        >
          Pin to screen
        </button>
      </div>
      <p className="hint">The image floats above other windows. Drag it anywhere; double-click or press Esc to close it. You can pin several.</p>

      <hr />
      <h2>Copy text from the screen</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        officev2 hides itself, you drag a rectangle over any text (videos, images, locked pages), and the text is read on this computer and copied.
        The screenshot is deleted right away.
      </p>
      <div className="actions tight">
        <button onClick={() => invoke("start_snip").catch((e) => setMessage({ ok: false, text: errText(e) }))}>Select an area…</button>
      </div>
      <Message m={message} />
    </>
  );
}
