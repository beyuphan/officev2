import { describe, expect, it, vi } from "vitest";

// the hook only holds one piece of state; run it against a tiny stand-in for React's useState
let stored: unknown = null;
vi.mock("react", () => ({
  useState: (initial: unknown) => [stored ?? initial, (v: unknown) => (stored = v)],
}));

import { useStyleClipboard } from "./useStyleClipboard";

type Item = { type: string; color: string };
const styleOf = (i: Item) => (i.type === "text" ? { kind: "text", style: { color: i.color } } : i.type === "box" ? { kind: "shape", style: { color: i.color } } : null);

describe("style clipboard", () => {
  it("copies a look and offers it only to the same kind of item", () => {
    stored = null;
    let board = useStyleClipboard<Item>(styleOf);
    expect(board.has).toBe(false);
    board.copy({ type: "text", color: "#f00" });
    board = useStyleClipboard<Item>(styleOf); // the next render sees the stored look
    expect(board.has).toBe(true);
    expect(board.styleFor({ type: "text", color: "#000" })).toEqual({ color: "#f00" });
    expect(board.styleFor({ type: "box", color: "#000" })).toBeNull();
    expect(board.styleFor(undefined)).toBeNull();
  });
  it("ignores items that have no look", () => {
    stored = null;
    const board = useStyleClipboard<Item>(styleOf);
    board.copy({ type: "image", color: "#000" });
    expect(stored).toBeNull();
  });
});
