import { useEffect } from "react";

/** An editor tells the window whether a file is open, so the tool list folds away only once there is something to edit. */
export const EDITOR_FILE = "editor-file";

export function useAnnounceEditorFile(hasFile: boolean) {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(EDITOR_FILE, { detail: hasFile }));
    return () => {
      window.dispatchEvent(new CustomEvent(EDITOR_FILE, { detail: false }));
    };
  }, [hasFile]);
}
