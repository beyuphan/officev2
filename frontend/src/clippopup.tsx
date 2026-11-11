import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pin, PinOff, Trash2 } from "lucide-react";
import { CLIP_TABS, clipType, moveIndex, visibleClips, type Clip, type ClipTab } from "./lib/clipfilter";
import { parseColor, urlHost } from "./lib/color";
import "./clippopup.css";

const close = () => getCurrentWindow().close().catch(() => undefined);

/** The window that opens with Ctrl+Shift+V: pick with the arrow keys and Enter, and it is pasted where you were typing. */
export function ClipPopup() {
  const [items, setItems] = useState<Clip[]>([]);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<ClipTab>("all");
  const [at, setAt] = useState(0);
  const [error, setError] = useState("");
  const list = useRef<HTMLUListElement>(null);

  const load = useCallback(async () => {
    try {
      setItems(await invoke<Clip[]>("clip_list", { query: query || null }));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  // clicking anywhere else closes it
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) void close();
      })
      .then((un) => (dead ? un() : (off = un)))
      .catch(() => undefined);
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  const shown = useMemo(() => visibleClips(items, tab), [items, tab]);
  useEffect(() => setAt(0), [tab, query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>("li.on")?.scrollIntoView({ block: "nearest" });
  }, [at, shown]);

  const paste = (c: Clip | undefined) => {
    if (c) invoke("clip_paste", { id: c.id }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") void close();
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setAt((i) => moveIndex(i, e.key === "ArrowDown" ? 1 : -1, shown.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      paste(shown[at]);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const i = CLIP_TABS.findIndex((t) => t.id === tab);
      setTab(CLIP_TABS[(i + (e.shiftKey ? CLIP_TABS.length - 1 : 1)) % CLIP_TABS.length].id);
    } else if ((e.key === "p" || e.key === "P") && e.ctrlKey && shown[at]) {
      e.preventDefault();
      invoke("clip_pin", { id: shown[at].id, pinned: !shown[at].pinned }).then(load);
    } else if (e.key === "Delete" && e.ctrlKey && shown[at]) {
      e.preventDefault();
      invoke("clip_delete", { id: shown[at].id }).then(load);
    }
  }

  return (
    <div className="cp" onKeyDown={onKey}>
      <input className="cp-search" autoFocus aria-label="Search clipboard history" placeholder="Search what you copied…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="cp-tabs" role="tablist">
        {CLIP_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} tabIndex={-1}>
            {t.label}
          </button>
        ))}
      </div>
      {error && <p className="cp-error">{error}</p>}
      {shown.length === 0 ? (
        <p className="cp-empty">{query || tab !== "all" ? "Nothing here." : "Copy something and it shows up here."}</p>
      ) : (
        <ul ref={list} className="cp-list">
          {shown.map((c, i) => {
            const type = clipType(c);
            const color = type === "color" ? parseColor(c.text) : null;
            return (
              <li key={c.id} className={i === at ? "on" : ""} onMouseMove={() => i !== at && setAt(i)} onClick={() => paste(c)}>
                {color && <i className="cp-swatch" style={{ background: color }} />}
                <span className="cp-body">
                  {type === "image" ? (
                    <>
                      {c.thumb && <img src={`data:image/png;base64,${c.thumb}`} alt="" />}
                      <small>
                        Image · {c.width}×{c.height}
                      </small>
                    </>
                  ) : (
                    <>
                      {type === "link" && <small>{urlHost(c.text)}</small>}
                      <span className="cp-text">{c.text.length > 160 ? `${c.text.slice(0, 160)}…` : c.text}</span>
                    </>
                  )}
                </span>
                <span className="cp-act">
                  <button
                    aria-label={c.pinned ? "Unpin" : "Pin"}
                    title={c.pinned ? "Unpin (Ctrl+P)" : "Pin (Ctrl+P)"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void invoke("clip_pin", { id: c.id, pinned: !c.pinned }).then(load);
                    }}
                  >
                    {c.pinned ? <PinOff size={13} strokeWidth={1.6} /> : <Pin size={13} strokeWidth={1.6} />}
                  </button>
                  <button
                    aria-label="Delete"
                    title="Delete (Ctrl+Delete)"
                    onClick={(e) => {
                      e.stopPropagation();
                      void invoke("clip_delete", { id: c.id }).then(load);
                    }}
                  >
                    <Trash2 size={13} strokeWidth={1.6} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <footer className="cp-foot">↑↓ choose · Enter paste · Tab switch list · Esc close</footer>
    </div>
  );
}
