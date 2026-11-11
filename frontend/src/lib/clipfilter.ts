import { parseColor, urlHost } from "./color";

export type Clip = { id: number; kind: "text" | "image"; text: string; width: number; height: number; thumb: string | null; created_at: number; pinned: boolean };

export type ClipTab = "all" | "pinned" | "links" | "images" | "text";

export const CLIP_TABS: { id: ClipTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pinned", label: "Pinned" },
  { id: "links", label: "Links" },
  { id: "images", label: "Images" },
  { id: "text", label: "Text" },
];

/** What a clip is, for the little label and the tabs. */
export function clipType(c: Clip): "image" | "link" | "color" | "text" {
  if (c.kind === "image") return "image";
  if (urlHost(c.text)) return "link";
  if (parseColor(c.text)) return "color";
  return "text";
}

/** The clips of a tab, pinned ones first (the list keeps its newest-first order inside each half). */
export function visibleClips(items: Clip[], tab: ClipTab): Clip[] {
  const keep = items.filter((c) => {
    const t = clipType(c);
    if (tab === "pinned") return c.pinned;
    if (tab === "links") return t === "link";
    if (tab === "images") return t === "image";
    if (tab === "text") return t === "text" || t === "color";
    return true;
  });
  return [...keep.filter((c) => c.pinned), ...keep.filter((c) => !c.pinned)];
}

/** Arrow-key movement inside a list of `n` rows, stopping at the ends. */
export function moveIndex(current: number, delta: number, n: number): number {
  if (n <= 0) return 0;
  return Math.min(n - 1, Math.max(0, current + delta));
}
