import { describe, expect, it } from "vitest";
import { cleanPaste, convertTime, decodeJwt, formatJson, formatSql, fromBase64, minifyJson, toBase64 } from "./text";
import { squarify } from "./treemap";

describe("cleanPaste", () => {
  it("joins hard-wrapped lines and keeps paragraphs", () => {
    const input = "The quick brown fox\njumps over the lazy\ndog.\n\nSecond paragraph\nstarts here.";
    expect(cleanPaste(input)).toBe("The quick brown fox jumps over the lazy dog.\n\nSecond paragraph starts here.");
  });
  it("repairs words hyphenated across lines, including Turkish letters", () => {
    expect(cleanPaste("inter-\nnational trade")).toBe("international trade");
    expect(cleanPaste("çalış-\nışma saati")).toBe("çalışışma saati");
    expect(cleanPaste("well-\nKnown")).toBe("well- Known"); // capital letter: a real hyphen, keep it
  });
  it("keeps list items on their own lines and handles CRLF", () => {
    expect(cleanPaste("Intro line\r\nwraps here\r\n- first item\r\n- second item")).toBe(
      "Intro line wraps here\n- first item\n- second item",
    );
    expect(cleanPaste("1. one\n2. two")).toBe("1. one\n2. two");
  });
  it("returns an empty string for blank input", () => {
    expect(cleanPaste("  \n\n  ")).toBe("");
  });
});

describe("decodeJwt", () => {
  // {"alg":"HS256","typ":"JWT"} . {"sub":"1234","name":"Çağlar","exp":4102444800} . signature
  const b64 = (o: object) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "1234", name: "Çağlar", exp: 4102444800 })}.sig`;
  it("decodes header and payload, including UTF-8 and time claims", () => {
    const r = decodeJwt(token);
    expect(r.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(r.payload.name).toBe("Çağlar");
    expect(r.times).toEqual([{ claim: "exp", iso: "2100-01-01T00:00:00.000Z" }]);
    expect(r.hasSignature).toBe(true);
    expect(decodeJwt("Bearer " + token).payload.sub).toBe("1234");
  });
  it("rejects garbage", () => {
    expect(() => decodeJwt("not-a-token")).toThrow(/two or three/);
    expect(() => decodeJwt("a.b.c")).toThrow(/base64url/);
  });
});

describe("json and base64", () => {
  it("formats and minifies", () => {
    expect(formatJson('{"a":[1,2],"b":{"c":null}}')).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": null\n  }\n}');
    expect(minifyJson('{ "a": 1,\n "b": [ 1, 2 ] }')).toBe('{"a":1,"b":[1,2]}');
    expect(() => formatJson("{bad")).toThrow();
  });
  it("round-trips UTF-8 base64 and accepts base64url", () => {
    expect(toBase64("Merhaba dünya ✓")).toBe("TWVyaGFiYSBkw7xueWEg4pyT");
    expect(fromBase64("TWVyaGFiYSBkw7xueWEg4pyT")).toBe("Merhaba dünya ✓");
    expect(fromBase64("a-_b")).toBeTypeOf("string");
  });
});

describe("formatSql", () => {
  it("uppercases keywords and breaks major clauses", () => {
    const out = formatSql("select id, name from users u left join orders o on o.uid = u.id where u.active = 1 and o.total > 10 order by name desc limit 5");
    expect(out.split("\n")).toEqual([
      "SELECT id,",
      "  name",
      "FROM users u",
      "LEFT JOIN orders o ON o.uid = u.id",
      "WHERE u.active = 1",
      "  AND o.total > 10",
      "ORDER BY name DESC",
      "LIMIT 5",
    ]);
  });
  it("leaves string literals untouched and keeps function arguments on one line", () => {
    const out = formatSql("select count(a, b) from t where name = 'select from where, and' ");
    expect(out).toContain("'select from where, and'");
    expect(out).toContain("COUNT(a, b)".toLowerCase());
  });
});

describe("convertTime", () => {
  it("accepts seconds, milliseconds and ISO dates", () => {
    expect(convertTime("1700000000")).toEqual({ seconds: 1700000000, iso: "2023-11-14T22:13:20.000Z" });
    expect(convertTime("1700000000000").seconds).toBe(1700000000);
    expect(convertTime("2023-11-14T22:13:20Z").seconds).toBe(1700000000);
    expect(() => convertTime("yesterday-ish")).toThrow();
  });
});

describe("squarify", () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  it("fills the rectangle exactly with areas proportional to the values", () => {
    const values = [60, 25, 10, 5];
    const rs = squarify(values, rect);
    const total = rs.reduce((a, r) => a + r.w * r.h, 0);
    expect(total).toBeCloseTo(10000, 3);
    rs.forEach((r, i) => expect((r.w * r.h) / 10000).toBeCloseTo(values[i] / 100, 3));
  });
  it("keeps every tile inside the bounds and tiles do not overlap", () => {
    const rs = squarify([50, 30, 20, 10, 5, 5, 1], rect);
    rs.forEach((r) => {
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(100 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(100 + 1e-9);
    });
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox > 1e-6 && oy > 1e-6).toBe(false);
      }
  });
  it("handles empty and zero totals", () => {
    expect(squarify([], rect)).toEqual([]);
    expect(squarify([0, 0], rect).every((r) => r.w === 0 && r.h === 0)).toBe(true);
  });
});
