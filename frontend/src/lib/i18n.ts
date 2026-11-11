/**
 * Interface language. The app's texts are written in English in the code; Turkish is applied on top of them by a
 * dictionary (lib/tr.ts), so a new screen works in English straight away and is translated by adding its words.
 *
 * `start()` watches the page and swaps every text, placeholder, tooltip and label it knows. React keeps writing its
 * own English; the watcher notices and translates again, so nothing in the components has to change.
 */
import { EXACT, PATTERNS } from "./tr";

export type Lang = "en" | "tr";
export const LANGS: { id: Lang; label: string }[] = [
  { id: "tr", label: "Türkçe" },
  { id: "en", label: "English" },
];

const KEY = "officev2.lang";
const ATTRS = ["placeholder", "title", "aria-label", "alt"] as const;

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "tr" || saved === "en") return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

let lang: Lang = initial();
export const getLang = () => lang;

const exact = new Map<string, string>(Object.entries(EXACT));
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Turkish for an English text, or the text itself when nothing matches. Spaces around it are kept. */
export function translate(text: string, to: Lang = lang): string {
  if (to === "en") return text;
  const core = squash(text);
  if (!core) return text;
  let out = exact.get(core);
  if (out === undefined) {
    for (const [rx, tpl] of PATTERNS) {
      const m = core.match(rx);
      if (m) {
        out = tpl.replace(/\$(\d)/g, (_x, i) => translate(m[Number(i)] ?? "", to));
        break;
      }
    }
  }
  if (out === undefined) return text;
  const lead = text.match(/^\s*/)![0];
  const trail = text.match(/\s*$/)![0];
  return lead + out + trail;
}

/** `t("Save")`: for the few texts built in code. */
export const t = (text: string): string => translate(text);

/* ---- the watcher ---- */

const textOrig = new WeakMap<Text, string>();
const textOut = new WeakMap<Text, string>();
const attrOrig = new WeakMap<Element, Record<string, string>>();
const attrOut = new WeakMap<Element, Record<string, string>>();

function doText(n: Text) {
  const cur = n.nodeValue ?? "";
  const known = textOrig.get(n);
  const out = textOut.get(n);
  const orig = known === undefined || (out !== undefined && cur !== out) ? cur : known; // a different text: React wrote something new
  textOrig.set(n, orig);
  const next = translate(orig);
  textOut.set(n, next);
  if (next !== cur) n.nodeValue = next;
}

function doAttrs(el: Element) {
  for (const a of ATTRS) {
    const cur = el.getAttribute(a);
    if (cur === null) continue;
    const origs = attrOrig.get(el) ?? {};
    const outs = attrOut.get(el) ?? {};
    const orig = origs[a] === undefined || (outs[a] !== undefined && cur !== outs[a]) ? cur : origs[a];
    origs[a] = orig;
    const next = translate(orig);
    outs[a] = next;
    attrOrig.set(el, origs);
    attrOut.set(el, outs);
    if (next !== cur) el.setAttribute(a, next);
  }
}

const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    if (!SKIP.has(root.parentElement?.tagName ?? "")) doText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (SKIP.has(el.tagName) || el.closest("[data-notranslate]")) return;
  doAttrs(el);
  el.childNodes.forEach(walk);
}

let observer: MutationObserver | null = null;

export function start(): void {
  if (observer || typeof document === "undefined") return;
  document.documentElement.lang = lang;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") {
        if (!SKIP.has(r.target.parentElement?.tagName ?? "")) doText(r.target as Text);
      } else if (r.type === "attributes") doAttrs(r.target as Element);
      else r.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  walk(document.body);
}

export function setLang(next: Lang): void {
  lang = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = next;
  walk(document.body);
  window.dispatchEvent(new Event("officev2-lang"));
}
