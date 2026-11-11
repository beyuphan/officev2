import { describe, expect, it } from "vitest";
import { ALL_EXTS, OPTIONS, defaultParams, kindOf, optionsFor, outputExt, overview } from "./convertoptions";

describe("convert options", () => {
  it("recognizes the kind of a file", () => {
    expect(kindOf("C:\\a\\Report.PDF")).toBe("pdf");
    expect(kindOf("/x/foto.heic")).toBe("image");
    expect(kindOf("budget.xlsx")).toBe("office");
    expect(kindOf("notes.md")).toBe("web");
    expect(kindOf("movie.mkv")).toBeNull();
    expect(ALL_EXTS).toContain("docx");
  });
  it("offers something for every kind and has unique ids", () => {
    for (const k of ["pdf", "image", "office", "web"] as const) expect(optionsFor(k).length).toBeGreaterThan(0);
    expect(new Set(OPTIONS.map((o) => o.id)).size).toBe(OPTIONS.length);
    expect(overview()).toHaveLength(4);
    expect(overview()[0].to).toContain("Word document");
  });
  it("builds the request the engine expects", () => {
    const word = OPTIONS.find((o) => o.id === "word")!;
    expect(word.body("a.pdf", "b.docx", {})).toEqual({ input: "a.pdf", output: "b.docx" });
    const target = OPTIONS.find((o) => o.id === "target")!;
    expect(target.body("a.pdf", "b.pdf", { max_mb: "5" })).toMatchObject({ max_mb: 5 });
    expect(target.body("a.pdf", "b.pdf", { max_mb: "-3" })).toMatchObject({ max_mb: 2 }); // nonsense falls back to the default
    const img = OPTIONS.find((o) => o.id === "format")!;
    expect(img.body("p.png", "dir", { format: "avif" })).toMatchObject({ inputs: ["p.png"], out_dir: "dir", format: "avif" });
  });
  it("takes the output extension from the choice", () => {
    const text = OPTIONS.find((o) => o.id === "text")!;
    expect(outputExt(text, { format: "md" })).toBe("md");
    expect(outputExt(OPTIONS.find((o) => o.id === "tables")!, {})).toBeNull();
    expect(defaultParams(text)).toEqual({ format: "txt" });
  });
});
