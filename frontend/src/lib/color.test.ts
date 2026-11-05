import { describe, expect, it } from "vitest";
import { hexToRgb, parseColor, rgbToHsl, urlHost } from "./color";

describe("parseColor", () => {
  it("accepts hex and rgb forms that are the whole text", () => {
    for (const ok of ["#fff", "#FF5733", "#ff573380", "rgb(10, 20, 30)", "rgba(10,20,30,.5)", "rgb(10 20 30)"]) {
      expect(parseColor(ok), ok).toBe(ok);
    }
    expect(parseColor("  #abc123  ")).toBe("#abc123");
  });
  it("rejects look-alikes", () => {
    for (const bad of ["#ggg", "#12345", "rgb(300, 0, 0)", "color: #fff", "red", "", "#fff #000"]) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });
});

describe("color conversion", () => {
  it("hex to rgb", () => {
    expect(hexToRgb("#FF5733")).toEqual({ r: 255, g: 87, b: 51 });
    expect(hexToRgb("336699")).toEqual({ r: 51, g: 102, b: 153 });
    expect(hexToRgb("#fff")).toBeNull();
  });
  it("rgb to hsl on known values", () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(rgbToHsl({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 100, l: 50 });
    expect(rgbToHsl({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, l: 50 });
    expect(rgbToHsl({ r: 51, g: 102, b: 153 })).toEqual({ h: 210, s: 50, l: 40 });
  });
});

describe("urlHost", () => {
  it("returns the host only for a single http(s) URL", () => {
    expect(urlHost("https://example.com/a?b=1")).toBe("example.com");
    expect(urlHost("http://localhost:3000")).toBe("localhost:3000");
    expect(urlHost("see https://example.com")).toBeNull();
    expect(urlHost("ftp://example.com")).toBeNull();
    expect(urlHost("not a url")).toBeNull();
  });
});
