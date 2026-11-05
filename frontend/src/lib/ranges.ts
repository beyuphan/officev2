/** Page range helpers shared by the page picker and the text field ("1-3,5,8-"). */

/** 1-based sorted unique page numbers, or null when the text is not a valid range for `total` pages. */
export function parseRanges(spec: string, total: number): number[] | null {
  const pages = new Set<number>();
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/) ?? part.match(/^(\d+)$/);
    if (!m) return null;
    const single = m.length === 2;
    const start = single ? Number(m[1]) : m[1] === "" ? 1 : Number(m[1]);
    const end = single ? start : m[2] === "" ? total : Number(m[2]);
    if (start < 1 || end > total || start > end) return null;
    for (let p = start; p <= end; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** {1,2,3,5,8,9} -> "1-3,5,8-9" */
export function toRanges(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : `${sorted[i]}`);
    i = j + 1;
  }
  return out.join(",");
}

export type PlanEntry = { page: number; rotate: number };

/** Plain-language list of what a page plan does, so the user can follow every change. */
export function describePlan(plan: PlanEntry[], total: number): string[] {
  const lines: string[] = [];
  const counts = new Map<number, number>();
  plan.forEach((p) => counts.set(p.page, (counts.get(p.page) ?? 0) + 1));
  const removed: number[] = [];
  for (let p = 1; p <= total; p++) if (!counts.has(p)) removed.push(p);
  if (removed.length) lines.push(`Removed: ${removed.length === 1 ? "page" : "pages"} ${toRanges(removed)}`);
  const copies = [...counts].filter(([, n]) => n > 1).map(([p, n]) => `page ${p} ×${n}`);
  if (copies.length) lines.push(`Duplicated: ${copies.join(", ")}`);
  const rotated = plan.map((p, i) => ({ ...p, pos: i + 1 })).filter((p) => p.rotate % 360 !== 0);
  if (rotated.length) lines.push(`Rotated: ${rotated.map((p) => `page ${p.page} by ${p.rotate}°`).join(", ")}`);
  const kept = plan.map((p) => p.page);
  const inOrder = kept.every((p, i) => i === 0 || p >= kept[i - 1]);
  if (!inOrder) lines.push(`New order: ${kept.join(", ")}`);
  if (!lines.length) lines.push("No changes yet.");
  return lines;
}
