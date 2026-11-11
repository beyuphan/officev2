import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectBurst, parseOpenArgs } from "./openargs";

describe("open arguments", () => {
  it("keeps files this app can open and reads --convert", () => {
    expect(parseOpenArgs(["C:\\a\\Report.PDF", "C:\\b\\notes.docx", "--hidden"])).toEqual({ paths: ["C:\\a\\Report.PDF"], convert: false });
    expect(parseOpenArgs(["--convert", "C:\\x\\photo.heic"])).toEqual({ paths: ["C:\\x\\photo.heic"], convert: true });
    expect(parseOpenArgs([])).toEqual({ paths: [], convert: false });
  });
});

describe("a selection arriving file by file", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("is handed over once, after things go quiet", () => {
    const seen: string[][] = [];
    const add = collectBurst((all) => seen.push(all), 600);
    add(["a.pdf"]);
    vi.advanceTimersByTime(300);
    add(["b.pdf"]);
    vi.advanceTimersByTime(300);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(seen).toEqual([["a.pdf", "b.pdf"]]);
  });
});
