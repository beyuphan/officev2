import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Monitor, Moon, PanelLeft, Square, Sun, X } from "lucide-react";
import { applyTheme, getTheme, nextTheme, setTheme, type Theme } from "./lib/theme";

/** The native window frame is turned off, so the app draws its own title bar and window buttons. */
function useAppWindow() {
  return useMemo(() => {
    try {
      return "__TAURI_INTERNALS__" in window ? getCurrentWindow() : null;
    } catch {
      return null; // plain browser (development): no window to control
    }
  }, []);
}

export function TitleBar({ tool, railOpen, onToggleRail, lang, onLang }: { tool: string; railOpen: boolean; onToggleRail: () => void; lang: string; onLang: (l: "tr" | "en") => void }) {
  const win = useAppWindow();
  const [maximized, setMaximized] = useState(false);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  useEffect(() => applyTheme(theme), []); // eslint-disable-line react-hooks/exhaustive-deps
  const cycleTheme = () => {
    const next = nextTheme(theme);
    setTheme(next);
    setThemeState(next);
  };
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const themeName = theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Same as the computer";

  useEffect(() => {
    if (!win) return;
    let off: (() => void) | undefined;
    const sync = () => win.isMaximized().then(setMaximized).catch(() => undefined);
    void sync();
    win.onResized(sync).then((u) => (off = u)).catch(() => undefined);
    return () => off?.();
  }, [win]);

  return (
    <header className="titlebar" data-tauri-drag-region onDoubleClick={() => void win?.toggleMaximize()}>
      <button className="tb-rail" aria-label={railOpen ? "Hide the tool list" : "Show the tool list"} aria-pressed={railOpen} onClick={onToggleRail} onDoubleClick={(e) => e.stopPropagation()}>
        <PanelLeft size={16} strokeWidth={1.5} />
      </button>
      <div className="tb-brand">
        <span className="tb-name">officev2</span>
        <span className="tb-sep" aria-hidden>
          /
        </span>
        <span className="tb-tool">{tool}</span>
      </div>
      <button className="tb-theme" aria-label={`Theme: ${themeName}`} title={`Theme: ${themeName} (click to change)`} onClick={cycleTheme} onDoubleClick={(e) => e.stopPropagation()}>
        <ThemeIcon size={15} strokeWidth={1.5} />
      </button>
      <div className="tb-lang" role="group" aria-label="Language" data-notranslate onDoubleClick={(e) => e.stopPropagation()}>
        {(["tr", "en"] as const).map((l) => (
          <button key={l} className={lang === l ? "on" : ""} aria-pressed={lang === l} title={l === "tr" ? "Türkçe" : "English"} onClick={() => onLang(l)}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      {win && (
        <div className="tb-controls" onDoubleClick={(e) => e.stopPropagation()}>
          <button aria-label="Minimize" onClick={() => void win.minimize()}>
            <Minus size={15} strokeWidth={1.5} />
          </button>
          <button aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void win.toggleMaximize()}>
            {maximized ? <Copy size={13} strokeWidth={1.5} /> : <Square size={12} strokeWidth={1.5} />}
          </button>
          <button className="close" aria-label="Close" onClick={() => void win.close()}>
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      )}
    </header>
  );
}
