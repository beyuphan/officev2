import { describe, expect, it } from "vitest";
import { routeDrop, setPending, takePending, toolForFile } from "./handoff";

describe("handoff", () => {
  it("routes dropped files by extension", () => {
    expect(toolForFile("C:\a\Fatura.PDF")).toBe("pdfedit");
    expect(toolForFile("/x/foto.HEIC")).toBe("photo");
    expect(toolForFile("notes.docx")).toBeNull();
    expect(toolForFile("noext")).toBeNull();
  });
  it("sends several PDFs to Pages and one file to its editor", () => {
    expect(routeDrop(["a.pdf", "b.pdf", "c.png"])).toEqual({ tool: "pages", paths: ["a.pdf", "b.pdf"] });
    expect(routeDrop(["a.pdf", "c.png"])).toEqual({ tool: "pdfedit", paths: ["a.pdf"] });
    expect(routeDrop(["c.png"])).toEqual({ tool: "photo", paths: ["c.png"] });
    expect(routeDrop(["x.docx"])).toBeNull();
  });
  it("hands a file over exactly once", () => {
    setPending("a.pdf");
    expect(takePending()).toBe("a.pdf");
    expect(takePending()).toBeNull();
  });
});
