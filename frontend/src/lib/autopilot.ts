import { getLang } from "./i18n";

/** Ready-made Autopilot rules, and a way to say any rule in one plain sentence. */

export type Folders = { downloads: string; pictures: string; documents: string; desktop: string };

export type RuleDraft = { name: string; folder: string; extensions: string[]; name_regex: string; min_size: number; dest: string };

export type Preset = { id: string; title: string; example: string; rule: RuleDraft };

const join = (base: string, ...rest: string[]) => {
  const sep = base.includes("\\") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...rest].join(sep);
};

export function buildPresets(f: Folders): Preset[] {
  const rule = (name: string, folder: string, extensions: string[], dest: string): RuleDraft => ({ name, folder, extensions, name_regex: "", min_size: 0, dest });
  return [
    { id: "png", title: "PNG pictures", example: "A PNG lands in Downloads and moves to Pictures › PNG.", rule: rule("PNG pictures to Pictures", f.downloads, ["png"], join(f.pictures, "PNG")) },
    { id: "photos", title: "Photos", example: "JPG, HEIC and WebP photos from Downloads go to Pictures › Photos.", rule: rule("Photos to Pictures", f.downloads, ["jpg", "jpeg", "heic", "webp"], join(f.pictures, "Photos")) },
    { id: "pdf", title: "PDF files", example: "Every PDF from Downloads goes to Documents › PDF.", rule: rule("PDFs to Documents", f.downloads, ["pdf"], join(f.documents, "PDF")) },
    { id: "office", title: "Word, Excel and PowerPoint", example: "Office files from Downloads go to Documents › Office.", rule: rule("Office files to Documents", f.downloads, ["doc", "docx", "xls", "xlsx", "ppt", "pptx"], join(f.documents, "Office")) },
    { id: "archives", title: "Zip and other archives", example: "ZIP, RAR and 7z files from Downloads go to Downloads › Archives.", rule: rule("Archives", f.downloads, ["zip", "rar", "7z"], join(f.downloads, "Archives")) },
    { id: "installers", title: "Installers", example: "Setup programs (EXE, MSI) go to Downloads › Installers, out of the way.", rule: rule("Installers", f.downloads, ["exe", "msi"], join(f.downloads, "Installers")) },
    { id: "sort", title: "Sort everything by type", example: "Whatever lands in Downloads is put into a folder named after its type (Downloads › Sorted › pdf, png, zip…).", rule: rule("Sort Downloads by type", f.downloads, [], join(f.downloads, "Sorted", "{ext}")) },
  ];
}

const last = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** "PNG files that land in Downloads move to Pictures › PNG." (or the same in Turkish) */
export function describeRule(r: Pick<RuleDraft, "folder" | "extensions" | "name_regex" | "min_size" | "dest">, lang: "en" | "tr" = getLang()): string {
  const types = r.extensions.map((e) => e.toUpperCase()).join(", ");
  const dest = r.dest.split(/[\\/]/).filter(Boolean);
  const shown = dest.length > 2 ? dest.slice(-2).join(" › ") : dest.join(" › ");
  if (lang === "tr") {
    const what = types ? `${types} dosyaları` : "Dosyalar";
    const extra = [r.name_regex ? `adı “${r.name_regex}” ile eşleşen` : "", r.min_size ? `${Math.round(r.min_size / 1024)} KB'dan büyük` : ""].filter(Boolean).join(" ");
    return `${extra ? `${extra} ` : ""}${what} ${last(r.folder)} klasörüne indiğinde ${shown.replace("{ext}", "türünün adını taşıyan bir klasöre")} ${shown.includes("{ext}") ? "konur" : "klasörüne taşınır"}.`.replace(/^./, (c) => c.toUpperCase());
  }
  const what = types ? `${types} files` : "Files";
  const extra = [r.name_regex ? `with a name matching “${r.name_regex}”` : "", r.min_size ? `bigger than ${Math.round(r.min_size / 1024)} KB` : ""].filter(Boolean).join(" ");
  return `${what}${extra ? ` ${extra}` : ""} that land in ${last(r.folder)} move to ${shown.replace("{ext}", "a folder named after the type")}.`;
}
