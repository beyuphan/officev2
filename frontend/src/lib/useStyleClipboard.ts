import { useState } from "react";

type Style = { kind: string; style: Record<string, unknown> };

/**
 * "Copy style" and "paste style" for an editor. `styleOf` says which look an item has
 * (its kind, so a highlight's look is never pasted onto a text) and returns null for items without one.
 */
export function useStyleClipboard<I>(styleOf: (item: I) => Style | null) {
  const [clip, setClip] = useState<Style | null>(null);
  return {
    /** something is waiting to be pasted */
    has: clip !== null,
    copy: (item: I | undefined) => {
      const st = item === undefined ? null : styleOf(item);
      if (st) setClip(st);
    },
    /** the look to apply to `item`, or null when nothing was copied or it is another kind of thing */
    styleFor: (item: I | undefined): Record<string, unknown> | null => {
      const st = item === undefined ? null : styleOf(item);
      return clip && st && st.kind === clip.kind ? clip.style : null;
    },
  };
}
