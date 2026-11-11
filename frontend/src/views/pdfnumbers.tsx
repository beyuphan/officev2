import { useState } from "react";
import { Hash } from "lucide-react";
import { parseRanges } from "../lib/ranges";
import { FontPicker } from "../shared";

/** Page numbers, headers and footers inside the PDF editor. They are saved together with everything else. */

export type Numbers = {
  on: boolean;
  format: string;
  position: string;
  size: number;
  color: string;
  font: string;
  startAt: number;
  pages: string;
  extraOn: boolean;
  extraText: string;
  extraPos: string;
};

export const NUMBERS_OFF: Numbers = {
  on: false,
  format: "Page {n} of {total}",
  position: "bottom-center",
  size: 10,
  color: "#444444",
  font: "Arial",
  startAt: 1,
  pages: "",
  extraOn: false,
  extraText: "{file}",
  extraPos: "top-right",
};

const FORMATS = [
  { id: "{n}", label: "1" },
  { id: "Page {n}", label: "Page 1" },
  { id: "Page {n} of {total}", label: "Page 1 of 9" },
  { id: "{n} / {total}", label: "1 / 9" },
  { id: "- {n} -", label: "- 1 -" },
];
const POSITIONS = [
  { id: "bottom-center", label: "Bottom, middle" },
  { id: "bottom-right", label: "Bottom, right" },
  { id: "bottom-left", label: "Bottom, left" },
  { id: "top-center", label: "Top, middle" },
  { id: "top-right", label: "Top, right" },
  { id: "top-left", label: "Top, left" },
];

/** What the engine needs (or null when nothing is switched on). */
export function numbersRequest(n: Numbers) {
  if (!n.on && !n.extraOn) return null;
  const items = [
    ...(n.on ? [{ position: n.position, text: n.format }] : []),
    ...(n.extraOn && n.extraText.trim() ? [{ position: n.extraPos, text: n.extraText }] : []),
  ];
  if (!items.length) return null;
  return { items, pages: n.pages.trim() || null, size: n.size, margin: 28, color: n.color, font: n.font, bold: false, start_at: Math.max(0, Math.round(n.startAt)), opacity: 1 };
}

const fill = (tpl: string, page: number, total: number, startAt: number, file: string) =>
  tpl
    .replace(/\{n(?::0?(\d+))?\}/g, (_m, w) => String(page - 1 + startAt).padStart(Number(w) || 0, "0"))
    .replace("{total}", String(total + startAt - 1))
    .replace("{file}", file)
    .replace("{date}", new Date().toISOString().slice(0, 10));

/** The texts for one page, drawn over it so the user sees them in place. */
export function NumbersOverlay({ n, page, total, file, scale, pw, ph }: { n: Numbers; page: number; total: number; file: string; scale: number; pw: number; ph: number }) {
  const req = numbersRequest(n);
  if (!req) return null;
  const only = n.pages.trim() ? parseRanges(n.pages, total) : null;
  if (only && !only.includes(page)) return null;
  const m = (req.margin / pw) * 100;
  const mv = (req.margin / ph) * 100;
  return (
    <div className="numoverlay" aria-hidden>
      {req.items.map((it, i) => {
        const [v, h] = it.position.split("-");
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              [v === "top" ? "top" : "bottom"]: `${mv}%`,
              ...(h === "left" ? { left: `${m}%` } : h === "right" ? { right: `${m}%` } : { left: "50%", transform: "translateX(-50%)" }),
              fontSize: `${n.size * scale}px`,
              color: n.color,
              fontFamily: `"${n.font}", Arial, sans-serif`,
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            {fill(it.text, page, total, n.startAt, file)}
          </span>
        );
      })}
    </div>
  );
}

export function NumbersButton({ n, onChange, fonts, onFonts }: { n: Numbers; onChange: (n: Numbers) => void; fonts: string[]; onFonts: (all: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const set = (c: Partial<Numbers>) => onChange({ ...n, ...c });
  const active = n.on || n.extraOn;
  return (
    <div className="numwrap">
      <button className={active ? "on" : ""} aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Page numbers, headers and footers">
        <Hash size={15} strokeWidth={1.5} aria-hidden /> Page numbers{active ? " ✓" : ""}
      </button>
      {open && (
        <div className="numpanel" role="dialog" aria-label="Page numbers">
          <label className="check">
            <input type="checkbox" checked={n.on} onChange={(e) => set({ on: e.target.checked })} /> Number the pages
          </label>
          {n.on && (
            <div className="numgrid">
              <label>
                <span>Look</span>
                <select value={n.format} onChange={(e) => set({ format: e.target.value })}>
                  {FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                  {!FORMATS.some((f) => f.id === n.format) && <option value={n.format}>{n.format}</option>}
                </select>
              </label>
              <label>
                <span>Where</span>
                <select value={n.position} onChange={(e) => set({ position: e.target.value })}>
                  {POSITIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Start at</span>
                <input type="number" min={0} value={n.startAt} onChange={(e) => set({ startAt: Number(e.target.value) })} />
              </label>
              <label>
                <span>Only pages</span>
                <input placeholder="all, or 2-10" value={n.pages} onChange={(e) => set({ pages: e.target.value })} />
              </label>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={n.extraOn} onChange={(e) => set({ extraOn: e.target.checked })} /> Add a header or footer text
          </label>
          {n.extraOn && (
            <div className="numgrid">
              <label>
                <span>Text</span>
                <input value={n.extraText} onChange={(e) => set({ extraText: e.target.value })} />
              </label>
              <label>
                <span>Where</span>
                <select value={n.extraPos} onChange={(e) => set({ extraPos: e.target.value })}>
                  {POSITIONS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {(n.on || n.extraOn) && (
            <div className="numgrid">
              <label>
                <span>Font</span>
                <FontPicker value={n.font} fonts={fonts} onChange={(f) => set({ font: f })} onFonts={onFonts} />
              </label>
              <label>
                <span>Size</span>
                <input type="number" min={6} max={40} value={n.size} onChange={(e) => set({ size: Math.min(40, Math.max(6, Number(e.target.value) || 10)) })} />
              </label>
              <label>
                <span>Color</span>
                <input type="color" value={n.color} onChange={(e) => set({ color: e.target.value })} />
              </label>
            </div>
          )}
          <p className="hint">
            In a text you can use <code>{"{n}"}</code> (page number), <code>{"{total}"}</code>, <code>{"{file}"}</code> and <code>{"{date}"}</code>. They appear on the pages and are saved with your other edits.
          </p>
        </div>
      )}
    </div>
  );
}
