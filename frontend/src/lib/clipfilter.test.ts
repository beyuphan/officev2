import { describe, expect, it } from "vitest";
import { clipType, moveIndex, visibleClips, type Clip } from "./clipfilter";

const clip = (id: number, text: string, extra: Partial<Clip> = {}): Clip => ({ id, kind: "text", text, width: 0, height: 0, thumb: null, created_at: id, pinned: false, ...extra });

describe("clipboard list", () => {
  it("tells links, colors, images and plain text apart", () => {
    expect(clipType(clip(1, "https://example.com/a"))).toBe("link");
    expect(clipType(clip(2, "#336699"))).toBe("color");
    expect(clipType(clip(3, "hello there"))).toBe("text");
    expect(clipType(clip(4, "", { kind: "image" }))).toBe("image");
  });
  it("filters by tab and keeps pinned items on top", () => {
    const items = [clip(1, "https://a.com"), clip(2, "note"), clip(3, "https://b.com", { pinned: true }), clip(4, "", { kind: "image" })];
    expect(visibleClips(items, "all").map((c) => c.id)).toEqual([3, 1, 2, 4]);
    expect(visibleClips(items, "links").map((c) => c.id)).toEqual([3, 1]);
    expect(visibleClips(items, "images").map((c) => c.id)).toEqual([4]);
    expect(visibleClips(items, "pinned").map((c) => c.id)).toEqual([3]);
    expect(visibleClips(items, "text").map((c) => c.id)).toEqual([2]);
  });
  it("moves the highlight and stops at the ends", () => {
    expect(moveIndex(0, -1, 5)).toBe(0);
    expect(moveIndex(4, 1, 5)).toBe(4);
    expect(moveIndex(2, 1, 5)).toBe(3);
    expect(moveIndex(3, 1, 0)).toBe(0);
  });
});
