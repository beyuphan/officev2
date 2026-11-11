/** What a file can be turned into. One list drives the Convert screen, so a new option is one entry here. */

export type FileKind = "pdf" | "image" | "office" | "web";

const EXTS: Record<FileKind, string[]> = {
  pdf: ["pdf"],
  image: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif", "avif", "heic", "heif", "ico"],
  office: ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf"],
  web: ["html", "htm", "md", "markdown", "txt"],
};

export const KIND_NAME: Record<FileKind, string> = { pdf: "PDF", image: "photo", office: "Word, Excel or PowerPoint file", web: "web page, Markdown or text file" };

export const ALL_EXTS = Object.values(EXTS).flat();

export function kindOf(path: string): FileKind | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (Object.keys(EXTS) as FileKind[]).find((k) => EXTS[k].includes(ext)) ?? null;
}

export type Param =
  | { id: string; label: string; type: "number"; value: string; hint?: string }
  | { id: string; label: string; type: "select"; value: string; options: { id: string; label: string }[] };

export type Option = {
  id: string;
  kind: FileKind;
  title: string;
  text: string;
  path: string;
  /** one file (asks where to save it) or several files in a folder */
  output: { type: "file"; ext: string | ((p: Record<string, string>) => string); suffix?: string } | { type: "folder" };
  params?: Param[];
  body: (file: string, target: string, p: Record<string, string>) => Record<string, unknown>;
};

const n = (v: string, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export const OPTIONS: Option[] = [
  // ---- a PDF ----
  { id: "word", kind: "pdf", title: "Word document", text: "An editable .docx. Simple layouts convert best; scans will not.", path: "/pdf/to-docx", output: { type: "file", ext: "docx" }, body: (f, o) => ({ input: f, output: o }) },
  {
    id: "text", kind: "pdf", title: "Plain text or Markdown", text: "Just the words of the PDF.", path: "/pdf/extract-text",
    output: { type: "file", ext: (p) => p.format }, params: [{ id: "format", label: "As", type: "select", value: "txt", options: [{ id: "txt", label: "Text (.txt)" }, { id: "md", label: "Markdown (.md)" }] }],
    body: (f, o, p) => ({ input: f, output: o, format: p.format }),
  },
  { id: "tables", kind: "pdf", title: "Excel tables (CSV)", text: "Every table becomes a file Excel opens. Needs a PDF with real text, not a scan.", path: "/pdf/tables-to-csv", output: { type: "folder" }, body: (f, o) => ({ input: f, out_dir: o }) },
  { id: "html", kind: "pdf", title: "Web page (HTML)", text: "A web page made from the text of the PDF.", path: "/pdf/to-html", output: { type: "file", ext: "html" }, body: (f, o) => ({ input: f, output: o }) },
  {
    id: "pictures", kind: "pdf", title: "Pictures of the pages", text: "Every page saved as a JPG or PNG picture.", path: "/pdf/to-images", output: { type: "folder" },
    params: [
      { id: "format", label: "Picture type", type: "select", value: "png", options: [{ id: "png", label: "PNG (sharp)" }, { id: "jpg", label: "JPG (smaller)" }] },
      { id: "dpi", label: "Sharpness (DPI)", type: "number", value: "150", hint: "150 is good for the screen, 300 for printing" },
    ],
    body: (f, o, p) => ({ input: f, out_dir: o, format: p.format, dpi: Math.round(n(p.dpi, 150)) }),
  },
  {
    id: "compress", kind: "pdf", title: "Make it smaller", text: "Lower the picture quality so the file shrinks. Text stays sharp.", path: "/pdf/compress", output: { type: "file", ext: "pdf", suffix: "-small" },
    params: [
      { id: "dpi", label: "Picture sharpness (DPI)", type: "number", value: "120", hint: "72 for screens, 150 for office use" },
      { id: "quality", label: "Picture quality", type: "number", value: "70", hint: "1 to 100" },
    ],
    body: (f, o, p) => ({ input: f, output: o, dpi: n(p.dpi, 120), quality: n(p.quality, 70) }),
  },
  {
    id: "target", kind: "pdf", title: "Make it fit a size limit", text: "Say how big the file may be (for an e-mail or upload form). It is compressed just enough.", path: "/pdf/compress-to-size",
    output: { type: "file", ext: "pdf", suffix: "-small" }, params: [{ id: "max_mb", label: "At most (MB)", type: "number", value: "2", hint: "2 fits most e-mail forms" }],
    body: (f, o, p) => ({ input: f, output: o, max_mb: n(p.max_mb, 2) }),
  },
  {
    id: "splitsize", kind: "pdf", title: "Cut into parts by size", text: "Parts that each stay under a size, for example for an e-mail limit.", path: "/pdf/split-by-size", output: { type: "folder" },
    params: [{ id: "max_mb", label: "Each part at most (MB)", type: "number", value: "10" }], body: (f, o, p) => ({ input: f, out_dir: o, max_mb: n(p.max_mb, 10) }),
  },
  { id: "repair", kind: "pdf", title: "Repair a damaged file", text: "Rescue a PDF that will not open. A clean copy of what could be recovered is saved.", path: "/pdf/repair", output: { type: "file", ext: "pdf", suffix: "-repaired" }, body: (f, o) => ({ input: f, output: o }) },
  { id: "metadata", kind: "pdf", title: "Remove hidden information", text: "Title, author, creator and other fields stored inside the file.", path: "/pdf/clean-metadata", output: { type: "file", ext: "pdf", suffix: "-clean" }, body: (f, o) => ({ input: f, output: o }) },

  // ---- a photo ----
  {
    id: "format", kind: "image", title: "Another picture type", text: "JPG, PNG, WebP, AVIF or an icon.", path: "/media/images", output: { type: "folder" },
    params: [
      { id: "format", label: "Convert to", type: "select", value: "jpeg", options: [{ id: "jpeg", label: "JPG" }, { id: "png", label: "PNG" }, { id: "webp", label: "WebP" }, { id: "avif", label: "AVIF" }, { id: "ico", label: "Icon (.ico)" }] },
    ],
    body: (f, o, p) => ({ inputs: [f], out_dir: o, format: p.format, quality: 90, max_side: 0, strip_metadata: false }),
  },
  {
    id: "smaller", kind: "image", title: "Make it smaller", text: "A lighter picture to send or upload. Location and camera details are removed.", path: "/media/images", output: { type: "folder" },
    params: [{ id: "max_side", label: "Longest side (pixels)", type: "number", value: "1920", hint: "1920 is plenty for the screen" }],
    body: (f, o, p) => ({ inputs: [f], out_dir: o, format: "webp", quality: 80, max_side: Math.round(n(p.max_side, 1920)), strip_metadata: true }),
  },
  { id: "topdf", kind: "image", title: "PDF", text: "A one-page PDF with this picture.", path: "/pdf/from-images", output: { type: "file", ext: "pdf" }, body: (f, o) => ({ inputs: [f], output: o, page_size: "fit" }) },

  // ---- Word, Excel, PowerPoint ----
  { id: "office", kind: "office", title: "PDF", text: "Needs LibreOffice installed on this computer.", path: "/pdf/from-office", output: { type: "file", ext: "pdf" }, body: (f, o) => ({ input: f, output: o }) },

  // ---- web page, Markdown, text ----
  { id: "web", kind: "web", title: "PDF", text: "Pictures next to the file are included.", path: "/pdf/from-web", output: { type: "file", ext: "pdf" }, body: (f, o) => ({ input: f, output: o }) },
];

export const optionsFor = (kind: FileKind): Option[] => OPTIONS.filter((o) => o.kind === kind);

/** The "what can I convert?" list: one line per kind of file. */
export function overview(): { from: string; to: string[] }[] {
  return (Object.keys(EXTS) as FileKind[]).map((k) => ({
    from: { pdf: "A PDF", image: "A photo (JPG, PNG, WebP, HEIC…)", office: "Word, Excel, PowerPoint", web: "A web page, Markdown or text file" }[k],
    to: optionsFor(k).map((o) => o.title),
  }));
}

export function outputExt(o: Option, p: Record<string, string>): string | null {
  return o.output.type === "file" ? (typeof o.output.ext === "function" ? o.output.ext(p) : o.output.ext) : null;
}

export const defaultParams = (o: Option): Record<string, string> => Object.fromEntries((o.params ?? []).map((q) => [q.id, q.value]));
