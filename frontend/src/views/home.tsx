import { type LucideIcon, Aperture, EyeOff, FileOutput, FilePenLine, ListOrdered } from "lucide-react";
import { setHint } from "../lib/handoff";

type Task = { id: string; title: string; text: string; Icon: LucideIcon; view: string; hint?: string };

const TASKS: Task[] = [
  { id: "pdfedit", title: "Edit or sign a PDF", text: "Add text, a signature, highlights or notes", Icon: FilePenLine, view: "pdfedit" },
  { id: "photo", title: "Edit a photo", text: "Crop, brighten, add text, hide a face", Icon: Aperture, view: "photo" },
  { id: "convert", title: "Convert a file", text: "PDF to Word, photo to another type, make a file smaller", Icon: FileOutput, view: "convert" },
  { id: "redact", title: "Hide private information", text: "Black out names, IBAN, e-mail for good", Icon: EyeOff, view: "redact" },
  { id: "pages", title: "Combine, split or reorder pages", text: "Merge PDFs, drag pages around, cut a file into parts", Icon: ListOrdered, view: "pages" },
];

/** Everything else, in plain words, so nobody has to guess what a tool name means. */
const MORE: { group: string; items: { view: string; hint?: string; title: string; text: string }[] }[] = [
  {
    group: "More with PDFs",
    items: [
      { view: "pdfbatch", title: "Many PDFs at once", text: "Same steps for a whole folder, saved as a set" },
      { view: "scanclean", title: "Clean up a scan", text: "Straighten, trim and whiten scanned pages" },
      { view: "printlayout", title: "Print layout", text: "Several pages per sheet, or a booklet" },
      { view: "attachments", title: "Attachments and page labels", text: "Hide files inside, number pages i, ii, iii" },
      { view: "pagesize", title: "Page size and margins", text: "Crop white edges, change to A4" },
      { view: "watermark", title: "Watermark", text: "Put a text or logo on every page" },
      { view: "protect", title: "Password", text: "Lock a PDF, or unlock one you know the password of" },
      { view: "ocr", title: "Read scanned pages", text: "Turn a scan into a PDF you can search" },
      { view: "forms", title: "Fill in forms", text: "Type into the fields of a form" },
      { view: "props", title: "Title, author, bookmarks", text: "Information stored inside the file" },
      { view: "sign", title: "Digital signature", text: "Sign with your certificate, check who signed" },
      { view: "compare", title: "Compare two PDFs", text: "See what changed between two versions" },
    ],
  },
  {
    group: "Photos",
    items: [
      { view: "background", title: "Remove background", text: "Cut the subject out as a transparent PNG" },
      { view: "collage", title: "Panorama and HDR", text: "Join overlapping photos, balance dark and bright shots" },
      { view: "social", title: "Sizes for social media", text: "Instagram, YouTube, LinkedIn and more" },
      { view: "idphoto", title: "Passport photos", text: "Crop to size and fill a print sheet" },
      { view: "collage", title: "Collage and GIF", text: "Combine pictures, make an animated GIF" },
    ],
  },
  {
    group: "Files and everyday",
    items: [
      { view: "rename", title: "Rename many files", text: "With a preview before anything changes" },
      { view: "cleanup", title: "Free up space", text: "Temp files, developer junk and duplicates" },
      { view: "diskmap", title: "Disk map", text: "See what takes the most room" },
      { view: "autopilot", title: "Autopilot", text: "Sort new downloads by rules" },
      { view: "clipboard", title: "Clipboard history", text: "Things you copied before" },
      { view: "screen", title: "Screen tools", text: "Pick a color, copy text from the screen" },
      { view: "vault", title: "Private vault", text: "Encrypted storage for sensitive files" },
      { view: "transcribe", title: "Speech to text", text: "Turn a recording into text (needs an add-on)" },
      { view: "documents", title: "Ask your documents", text: "Search your files by meaning (needs an add-on)" },
      { view: "addons", title: "Add-ons", text: "Install the heavier features only if you want them" },
    ],
  },
];

export function Home({ go }: { go: (id: string) => void }) {
  const open = (view: string, hint?: string) => {
    setHint(hint ?? null);
    go(view);
  };
  return (
    <div className="home">
      <h1>What do you want to do?</h1>
      <p className="muted">
        Pick a task, or <b>drop a PDF or photo anywhere in this window</b> to start editing it. Everything stays on your computer and your originals are never changed.
      </p>
      <div className="tasks">
        {TASKS.map(({ id, title, text, Icon, view, hint }) => (
          <button key={id} className="task" onClick={() => open(view, hint)}>
            <Icon size={20} strokeWidth={1.5} aria-hidden />
            <span>
              <b>{title}</b>
              <small>{text}</small>
            </span>
          </button>
        ))}
      </div>
      {MORE.map((g) => (
        <section key={g.group} className="morelist">
          <h2>{g.group}</h2>
          <ul>
            {g.items.map((it) => (
              <li key={it.title}>
                <button onClick={() => open(it.view, it.hint)}>
                  <b>{it.title}</b>
                  <small>{it.text}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="muted small">Video tools are coming later. Press <kbd>Ctrl K</kbd> to search every tool by name.</p>
    </div>
  );
}
