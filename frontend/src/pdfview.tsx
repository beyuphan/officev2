import { useEffect, useRef, useState, type ReactNode } from "react";
import { post } from "./api";
import { SourceField, pdfFilter } from "./shared";

export type PageData = {
  page: number;
  total: number;
  image: string;
  width: number;
  height: number;
  page_width: number;
  page_height: number;
  stamped?: boolean;
};

type Rendered = { data: PageData | null; loading: boolean; error: string };

/** Fetches a rendered page from `url`. Changing `body` re-fetches (debounced); stale answers are dropped. */
export function useRendered(url: string, body: object | null, delay = 0, skip = false): Rendered {
  const [state, setState] = useState<Rendered>({ data: null, loading: false, error: "" });
  const seq = useRef(0);
  if (skip) body = null;
  const key = body ? JSON.stringify(body) : "";

  useEffect(() => {
    if (!body) {
      setState({ data: null, loading: false, error: "" });
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: "" }));
    const t = setTimeout(async () => {
      try {
        const data = await post<PageData>(url, body);
        if (mine === seq.current) setState({ data, loading: false, error: "" });
      } catch (e) {
        if (mine === seq.current) setState({ data: null, loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, key, delay]);

  return state;
}

export type Box = {
  id: string;
  rect: [number, number, number, number]; // points, displayed page coordinates
  tone: "hit" | "off" | "manual" | "info";
  label?: string;
};

/** A rendered page with boxes drawn on it. Boxes are positioned in page points so they stay put at any size. */
export function PageCanvas({
  data,
  boxes = [],
  onBoxClick,
  onDraw,
  note,
}: {
  data: PageData;
  boxes?: Box[];
  onBoxClick?: (id: string) => void;
  onDraw?: (rect: [number, number, number, number]) => void;
  note?: ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const toPoints = (clientX: number, clientY: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return [((clientX - r.left) / r.width) * data.page_width, ((clientY - r.top) / r.height) * data.page_height] as const;
  };
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  return (
    <div className="page-frame">
      <div
        ref={wrap}
        className={`page ${onDraw ? "drawable" : ""}`}
        style={{ aspectRatio: `${data.page_width} / ${data.page_height}` }}
        onPointerDown={(e) => {
          if (!onDraw || e.target !== e.currentTarget.querySelector("img")) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const [x, y] = toPoints(e.clientX, e.clientY);
          setDrag({ x0: x, y0: y, x1: x, y1: y });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const [x, y] = toPoints(e.clientX, e.clientY);
          setDrag({ ...drag, x1: x, y1: y });
        }}
        onPointerUp={() => {
          if (!drag) return;
          const r: [number, number, number, number] = [
            Math.max(0, Math.min(drag.x0, drag.x1)),
            Math.max(0, Math.min(drag.y0, drag.y1)),
            Math.min(data.page_width, Math.max(drag.x0, drag.x1)),
            Math.min(data.page_height, Math.max(drag.y0, drag.y1)),
          ];
          setDrag(null);
          if (r[2] - r[0] > 4 && r[3] - r[1] > 4) onDraw?.(r);
        }}
      >
        <img src={`data:image/png;base64,${data.image}`} alt={`Page ${data.page}`} draggable={false} />
        {boxes.map((b) => (
          <button
            key={b.id}
            className={`box ${b.tone}`}
            title={b.label}
            aria-label={b.label ?? "area"}
            disabled={!onBoxClick}
            onClick={() => onBoxClick?.(b.id)}
            style={{ left: pct(b.rect[0], data.page_width), top: pct(b.rect[1], data.page_height), width: pct(b.rect[2] - b.rect[0], data.page_width), height: pct(b.rect[3] - b.rect[1], data.page_height) }}
          />
        ))}
        {drag && (
          <div
            className="box manual drawing"
            style={{
              left: pct(Math.min(drag.x0, drag.x1), data.page_width),
              top: pct(Math.min(drag.y0, drag.y1), data.page_height),
              width: pct(Math.abs(drag.x1 - drag.x0), data.page_width),
              height: pct(Math.abs(drag.y1 - drag.y0), data.page_height),
            }}
          />
        )}
      </div>
      {note && <div className="page-note">{note}</div>}
    </div>
  );
}

export function PageNav({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  return (
    <div className="pagenav">
      <button className="icon text" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </button>
      <span className="mono">
        Page{" "}
        <input
          aria-label="Page number"
          type="number"
          min={1}
          max={total}
          value={page}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n >= 1 && n <= total) onChange(n);
          }}
        />{" "}
        of {total}
      </span>
      <button className="icon text" disabled={page >= total} onClick={() => onChange(page + 1)}>
        Next
      </button>
    </div>
  );
}

/** One page in the viewer, with an error / loading / password state. */
export function PagePreview({
  file,
  page,
  onPage,
  boxes,
  onBoxClick,
  onDraw,
  extra,
  note,
}: {
  file: string | null;
  page: number;
  onPage: (p: number) => void;
  boxes?: Box[];
  onBoxClick?: (id: string) => void;
  onDraw?: (rect: [number, number, number, number]) => void;
  extra?: { url: string; body: object; delay?: number };
  note?: (d: PageData) => ReactNode;
}) {
  const plain = useRendered("/pdf/render", file && !extra ? { input: file, page, width: 900 } : null);
  const special = useRendered(extra?.url ?? "/pdf/render", file && extra ? extra.body : null, extra?.delay ?? 250);
  const { data, loading, error } = extra ? special : plain;
  // keep showing the last image while a new one loads, so the preview never flashes empty
  const last = useRef<PageData | null>(null);
  if (data) last.current = data;
  const shown = data ?? (loading ? last.current : null);

  if (!file) return <p className="muted preview-empty">Choose a PDF to see its pages here.</p>;
  if (error) return <p className="msg bad">{error}</p>;
  if (!shown) return <p className="muted preview-empty">Loading preview…</p>;
  return (
    <div className={loading ? "preview loading" : "preview"}>
      <PageNav page={page} total={shown.total} onChange={onPage} />
      <PageCanvas data={shown} boxes={boxes} onBoxClick={onBoxClick} onDraw={onDraw} note={note?.(shown)} />
    </div>
  );
}

export type Thumb = { image: string; width: number; height: number };

/** All page thumbnails of a PDF, loaded progressively in small batches. */
export function useThumbs(file: string | null, width = 150): { thumbs: Map<number, Thumb>; total: number; loading: boolean; error: string } {
  const [state, setState] = useState({ thumbs: new Map<number, Thumb>(), total: 0, loading: false, error: "" });

  useEffect(() => {
    if (!file) {
      setState({ thumbs: new Map(), total: 0, loading: false, error: "" });
      return;
    }
    let cancelled = false;
    (async () => {
      setState({ thumbs: new Map(), total: 0, loading: true, error: "" });
      let start = 1;
      let total = Infinity;
      const acc = new Map<number, Thumb>();
      try {
        while (start <= total && !cancelled) {
          const res = await post<{ total: number; items: (Thumb & { page: number })[] }>("/pdf/thumbnails", { input: file, start, count: 12, width });
          total = res.total;
          res.items.forEach((i) => acc.set(i.page, { image: i.image, width: i.width, height: i.height }));
          if (!cancelled) setState({ thumbs: new Map(acc), total, loading: start + 12 <= total, error: "" });
          start += 12;
        }
      } catch (e) {
        if (!cancelled) setState({ thumbs: new Map(acc), total: 0, loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, width]);

  return state;
}

export const thumbSrc = (t: Thumb) => `data:image/png;base64,${t.image}`;

/** SourceField plus a first-page thumbnail and the page count. */
export function PdfSource({ label = "Source", file, onPick, peek = true }: { label?: string; file: string | null; onPick: (p: string) => void; peek?: boolean }) {
  const { data, error } = useRendered("/pdf/render", file ? { input: file, page: 1, width: 160 } : null, 0, !peek);
  const locked = /password/i.test(error);
  return (
    <div className="pdfsource">
      <SourceField label={label} file={file} onPick={onPick} filters={pdfFilter} />
      {file && peek && (
        <div className="peek">
          {data ? (
            <>
              <img src={`data:image/png;base64,${data.image}`} alt="First page" />
              <span className="mono note">
                {data.total} page{data.total === 1 ? "" : "s"}
              </span>
            </>
          ) : locked ? (
            <span className="note">Password protected: no preview.</span>
          ) : error ? (
            <span className="note">{error}</span>
          ) : (
            <span className="note">Loading preview…</span>
          )}
        </div>
      )}
    </div>
  );
}
