import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";

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

export function TitleBar({ tool }: { tool: string }) {
  const win = useAppWindow();
  const [maximized, setMaximized] = useState(false);

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
      <div className="tb-brand">
        <span className="tb-name">officev2</span>
        <span className="tb-sep" aria-hidden>
          /
        </span>
        <span className="tb-tool">{tool}</span>
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
