import { describe, expect, it } from "vitest";
import { buildPresets, describeRule } from "./autopilot";

const F = { downloads: "C:\\Users\\a\\Downloads", pictures: "C:\\Users\\a\\Pictures", documents: "C:\\Users\\a\\Documents", desktop: "C:\\Users\\a\\Desktop" };

describe("autopilot presets", () => {
  it("builds rules that point at the person's own folders", () => {
    const png = buildPresets(F).find((p) => p.id === "png")!;
    expect(png.rule).toMatchObject({ folder: F.downloads, extensions: ["png"], dest: "C:\\Users\\a\\Pictures\\PNG" });
  });
  it("has unique ids and a sentence for each", () => {
    const all = buildPresets(F);
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    all.forEach((p) => expect(p.example.length).toBeGreaterThan(10));
  });
  it("says a rule in one sentence", () => {
    const png = buildPresets(F).find((p) => p.id === "png")!;
    expect(describeRule(png.rule, "en")).toBe("PNG files that land in Downloads move to Pictures \u203a PNG.");
    const sort = buildPresets(F).find((p) => p.id === "sort")!;
    expect(describeRule(png.rule, "tr")).toBe("PNG dosyaları Downloads klasörüne indiğinde Pictures › PNG klasörüne taşınır.");
    expect(describeRule(sort.rule, "en")).toContain("a folder named after the type");
    expect(describeRule({ folder: "/home/a/Downloads", extensions: [], name_regex: "^invoice", min_size: 2048, dest: "/home/a/Documents/Invoices" }, "en")).toBe(
      "Files with a name matching \u201c^invoice\u201d bigger than 2 KB that land in Downloads move to Documents \u203a Invoices.",
    );
  });
});
