type Rect = { x: number; y: number; w: number; h: number };

/** Squarified treemap. `values` must be sorted descending and positive. */
export function squarify(values: number[], rect: Rect): Rect[] {
  const out: Rect[] = new Array(values.length);
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const areas = values.map((v) => (v / total) * rect.w * rect.h);
  let { x, y, w, h } = rect;
  let i = 0;
  while (i < areas.length) {
    const short = Math.min(w, h);
    const worst = (r: number[]) => {
      const s = r.reduce((a, b) => a + b, 0);
      return Math.max((short * short * Math.max(...r)) / (s * s), (s * s) / (short * short * Math.min(...r)));
    };
    const row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]]) <= worst(row)) row.push(areas[j++]);
    const s = row.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const colW = s / h;
      let cy = y;
      row.forEach((a, k) => {
        const ch = a / colW;
        out[i + k] = { x, y: cy, w: colW, h: ch };
        cy += ch;
      });
      x += colW;
      w -= colW;
    } else {
      const rowH = s / w;
      let cx = x;
      row.forEach((a, k) => {
        const cw = a / rowH;
        out[i + k] = { x: cx, y, w: cw, h: rowH };
        cx += cw;
      });
      y += rowH;
      h -= rowH;
    }
    i = j;
  }
  return out;
}
