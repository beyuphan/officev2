import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { start as startTranslation } from "./lib/i18n";
import { applyTheme, getTheme } from "./lib/theme";

applyTheme(getTheme()); // before anything is drawn, so a dark window does not flash light

/** Which window are we? The main window shows the app; "pin-*" and "snip" are small overlay windows. */
function windowLabel(): string {
  try {
    return "__TAURI_INTERNALS__" in window ? getCurrentWindow().label : "main";
  } catch {
    return "main";
  }
}

async function boot() {
  const label = windowLabel();
  let root: React.ReactNode;
  if (label === "snip" || label.startsWith("pin-")) {
    const { Pin, Snip } = await import("./overlay"); // overlay styles load only in overlay windows
    root = label === "snip" ? <Snip /> : <Pin />;
  } else if (label === "clip-popup") {
    const { ClipPopup } = await import("./clippopup");
    root = <ClipPopup />;
  } else {
    const { default: App } = await import("./App");
    root = <App />;
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode>{root}</React.StrictMode>);
  startTranslation(); // swaps the interface texts into the chosen language as they appear
}

void boot();
