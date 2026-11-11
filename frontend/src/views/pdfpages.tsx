import { useState } from "react";
import { ChevronDown, ChevronUp, Copy, FilePlus, Files, RotateCcw, RotateCw, Scissors, Trash2 } from "lucide-react";

export type PageOp = "delete" | "up" | "down" | "rotate-left" | "rotate-right" | "duplicate" | "blank" | "merge" | "split";

/** Page tools of the editor: they work on the page you are looking at and never touch the original file. */
export function PagesMenu({ current, total, hasEdits, busy, onOp, onExtract }: { current: number; total: number; hasEdits: boolean; busy: boolean; onOp: (op: PageOp) => void; onExtract: (range: string) => void }) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState("");
  const run = (op: PageOp) => {
    setOpen(false);
    onOp(op);
  };
  return (
    <div className="numwrap">
      <button aria-expanded={open} disabled={busy} onClick={() => setOpen((o) => !o)} title="Delete, move, rotate or add pages">
        <Files size={15} strokeWidth={1.5} aria-hidden /> Page tools
      </button>
      {open && (
        <div className="numpanel pagesmenu" role="menu" aria-label="Page tools">
          <p className="hint" style={{ margin: 0 }}>
            Page {current} of {total}
          </p>
          <button role="menuitem" onClick={() => run("up")} disabled={current <= 1}>
            <ChevronUp size={15} strokeWidth={1.5} aria-hidden /> Move up
          </button>
          <button role="menuitem" onClick={() => run("down")} disabled={current >= total}>
            <ChevronDown size={15} strokeWidth={1.5} aria-hidden /> Move down
          </button>
          <button role="menuitem" onClick={() => run("rotate-left")} disabled={hasEdits} title={hasEdits ? "Rotate before you add things to this page" : undefined}>
            <RotateCcw size={15} strokeWidth={1.5} aria-hidden /> Rotate left
          </button>
          <button role="menuitem" onClick={() => run("rotate-right")} disabled={hasEdits} title={hasEdits ? "Rotate before you add things to this page" : undefined}>
            <RotateCw size={15} strokeWidth={1.5} aria-hidden /> Rotate right
          </button>
          <button role="menuitem" onClick={() => run("duplicate")}>
            <Copy size={15} strokeWidth={1.5} aria-hidden /> Duplicate this page
          </button>
          <button role="menuitem" onClick={() => run("blank")}>
            <FilePlus size={15} strokeWidth={1.5} aria-hidden /> Add a blank page after
          </button>
          <button role="menuitem" onClick={() => run("merge")}>
            <Files size={15} strokeWidth={1.5} aria-hidden /> Add pages from another PDF…
          </button>
          <button role="menuitem" onClick={() => run("split")} disabled={current <= 1} title="Cut the PDF into two files, the second starting at this page">
            <Scissors size={15} strokeWidth={1.5} aria-hidden /> Split before this page…
          </button>
          <div className="extractrow">
            <input aria-label="Pages to keep" placeholder="Keep only pages, e.g. 1-3,5" value={range} onChange={(e) => setRange(e.target.value)} />
            <button
              disabled={!range.trim()}
              onClick={() => {
                setOpen(false);
                onExtract(range.trim());
                setRange("");
              }}
            >
              Save these pages…
            </button>
          </div>
          <button role="menuitem" className="danger" onClick={() => run("delete")} disabled={total <= 1}>
            <Trash2 size={15} strokeWidth={1.5} aria-hidden /> Delete this page
          </button>
        </div>
      )}
    </div>
  );
}

/** Close, open another, and saving options: the things you do once, out of the way of the things you do all the time. */
export function FileMenu({ what = "PDF", flatten, onFlatten, onOpen, onClose }: { what?: string; flatten?: boolean; onFlatten?: (v: boolean) => void; onOpen: () => void; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const run = (f: () => void) => {
    setOpen(false);
    f();
  };
  return (
    <div className="numwrap">
      <button aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        File
      </button>
      {open && (
        <div className="numpanel pagesmenu" role="menu" aria-label="File">
          <button role="menuitem" onClick={() => run(onOpen)}>
            Open another {what}…
          </button>
          <button role="menuitem" onClick={() => run(onClose)} title={`Close this ${what} and go back to the start`}>
            Close this {what}
          </button>
          {onFlatten && (
            <label className="flatten" title="Makes highlights, shapes and notes part of the page so they cannot be edited later.">
              <input type="checkbox" checked={!!flatten} onChange={(e) => onFlatten(e.target.checked)} /> Flatten notes and marks when saving
            </label>
          )}
        </div>
      )}
    </div>
  );
}
