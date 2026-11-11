/** A file dropped on the window waits here until the tool it belongs to has opened. */
let pending: string | null = null;

export const setPending = (path: string | null) => {
  pending = path;
};

export function takePending(): string | null {
  const p = pending;
  pending = null;
  return p;
}

/** Which tool a dropped file should open in, or null when no tool fits. */
export function toolForFile(path: string): "pdfedit" | "photo" | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdfedit";
  if (["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "avif", "heic", "heif", "ico"].includes(ext)) return "photo";
  return null;
}

/** Several PDFs dropped together wait here for the Pages screen. */
let pendingMany: string[] = [];

export const setPendingMany = (paths: string[]) => {
  pendingMany = paths;
};

export function takePendingMany(): string[] {
  const p = pendingMany;
  pendingMany = [];
  return p;
}

/** Where a drop goes: two or more PDFs open together in Pages, otherwise the first file in its editor. */
export function routeDrop(paths: string[]): { tool: "pdfedit" | "photo" | "pages"; paths: string[] } | null {
  const pdfs = paths.filter((p) => toolForFile(p) === "pdfedit");
  if (pdfs.length >= 2) return { tool: "pages", paths: pdfs };
  const first = paths.find((p) => toolForFile(p));
  const tool = first ? toolForFile(first) : null;
  return first && tool ? { tool, paths: [first] } : null;
}

/** A start-screen shortcut can ask a tool to open on a particular mode. */
let hint: string | null = null;

export const setHint = (h: string | null) => {
  hint = h;
};

export function takeHint(): string | null {
  const h = hint;
  hint = null;
  return h;
}
