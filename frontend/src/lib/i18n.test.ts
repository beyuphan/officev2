import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { EXACT } from "./tr";

describe("translate", () => {
  it("translates known texts and keeps the spaces around them", () => {
    expect(translate("Save a copy…", "tr")).toBe("Kopya kaydet…");
    expect(translate("  Apply  ", "tr")).toBe("  Uygula  ");
    expect(translate("Save a\n   copy…", "tr")).toBe("Kopya kaydet…");
  });
  it("leaves unknown texts and English untouched", () => {
    expect(translate("Quarterly-report.pdf", "tr")).toBe("Quarterly-report.pdf");
    expect(translate("Save a copy…", "en")).toBe("Save a copy…");
  });
  it("handles texts with numbers", () => {
    expect(translate("Page 3 of 12", "tr")).toBe("Sayfa 3 / 12");
    expect(translate("Edits (4)", "tr")).toBe("Düzenlemeler (4)");
    expect(translate("Photo corners 40 px", "tr")).toBe("Fotoğraf köşeleri 40 px");
  });
  it("translates engine errors, including the dynamic ones", () => {
    expect(translate("the document is password protected; unlock it first", "tr")).toContain("parola korumalı");
    expect(translate("page 9 does not exist (the document has 3)", "tr")).toBe("9. sayfa yok (belgede 3 sayfa var)");
  });
  it("never renames the language choices", () => {
    expect(translate("English", "tr")).toBe("English");
    expect(translate("Türkçe", "tr")).toBe("Türkçe");
  });
  it("keeps each translation on its own text (the dictionary was typed in stretches)", () => {
    const known: Record<string, string> = {
      Cancel: "İptal", Background: "Arka plan", "Base (145 MB)": "Temel (145 MB)", Contrast: "Kontrast", Copy: "Kopyala", Date: "Tarih",
      "Fast (5 MB)": "Hızlı (5 MB)", "Field name": "Alan adı", Fill: "Dolgu", Find: "Bul", Flatten: "Düzleştir", Kind: "Tür", Scan: "Tara",
      "Scan temp files": "Geçici dosyaları tara", "Scanning…": "Taranıyor…", Scratchpad: "Karalama defteri", Select: "Seç", Shadows: "Gölgeler",
      Straighten: "Düzleştir", Strength: "Güç", System: "Sistem", "TC kimlik numbers": "TC kimlik numaraları", "file(s) written": "dosya yazıldı",
      "Photo corners": "Fotoğraf köşeleri", "Frame corners": "Çerçeve köşeleri", "Save a copy…": "Kopya kaydet…", Eraser: "Silgi",
    };
    for (const [en, tr] of Object.entries(known)) expect(EXACT[en], en).toBe(tr);
  });
  it("has no empty entries and no English left in the keys' translations of the main tools", () => {
    for (const [k, v] of Object.entries(EXACT)) expect(v.trim(), k).not.toBe("");
    for (const tool of ["PDF editor", "Photo editor", "Merge", "Redact", "Compare two PDFs", "Add-ons"]) expect(EXACT[tool], tool).toBeTruthy();
  });
});
