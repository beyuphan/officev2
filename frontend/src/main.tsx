import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
  } else {
    const { default: App } = await import("./App");
    root = <App />;
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<React.StrictMode>{root}</React.StrictMode>);
}

void boot();
