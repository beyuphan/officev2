/** Pure text utilities for the Clean paste and Dev lab tools. */

const LIST_MARKER = /^([•\-*–·]|\d+[.)]|[a-z][.)])\s+/i;

/**
 * Repairs text copied out of PDFs: removes hard line breaks inside paragraphs and joins words that
 * were hyphenated across lines. Blank lines keep separating paragraphs; list items keep their own line.
 */
export function cleanPaste(input: string): string {
  const text = input.replace(/\r\n?/g, "\n");
  const paragraphs = text.split(/\n[ \t]*\n/);
  const out: string[] = [];
  for (const para of paragraphs) {
    const lines: string[] = [];
    for (const raw of para.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const prev = lines[lines.length - 1];
      if (prev === undefined || LIST_MARKER.test(line)) {
        lines.push(line);
      } else if (/\p{L}-$/u.test(prev) && /^\p{Ll}/u.test(line)) {
        lines[lines.length - 1] = prev.slice(0, -1) + line; // "inter-\nnational" -> "international"
      } else {
        lines[lines.length - 1] = prev + " " + line;
      }
    }
    if (lines.length) out.push(lines.join("\n").replace(/[ \t]{2,}/g, " "));
  }
  return out.join("\n\n");
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export type Jwt = {
  header: unknown;
  payload: Record<string, unknown>;
  hasSignature: boolean;
  times: { claim: string; iso: string }[];
};

/** Decodes (does NOT verify) a JWT. Everything happens locally. */
export function decodeJwt(token: string): Jwt {
  const parts = token.trim().replace(/^Bearer\s+/i, "").split(".");
  if (parts.length < 2 || parts.length > 3) throw new Error("A JWT has two or three dot-separated parts.");
  const dec = new TextDecoder();
  let header: unknown, payload: Record<string, unknown>;
  try {
    header = JSON.parse(dec.decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
  } catch {
    throw new Error("The header or payload is not valid base64url JSON.");
  }
  const times = ["iat", "nbf", "exp"]
    .filter((c) => typeof payload[c] === "number")
    .map((c) => ({ claim: c, iso: new Date((payload[c] as number) * 1000).toISOString() }));
  return { header, payload, hasSignature: parts.length === 3 && parts[2].length > 0, times };
}

export function formatJson(input: string, indent = 2): string {
  return JSON.stringify(JSON.parse(input), null, indent);
}
export const minifyJson = (input: string): string => JSON.stringify(JSON.parse(input));

export function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
export function fromBase64(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s.trim().replace(/\s+/g, "")));
}

const CLAUSES = [
  "SELECT DISTINCT", "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "UNION ALL", "UNION",
  "LEFT OUTER JOIN", "RIGHT OUTER JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN", "JOIN",
];
const KEYWORDS = ["AS", "ON", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "CASE", "WHEN", "THEN", "ELSE", "END", "ASC", "DESC", "BY", "EXISTS"];

/** Small SQL formatter: uppercases keywords and puts major clauses on their own line. Strings are left alone. */
export function formatSql(sql: string): string {
  const segments = sql.split(/('(?:[^']|'')*'|"(?:[^"]|"")*")/); // odd indexes are quoted literals
  const joined = segments.map((s, i) => (i % 2 ? `\u0000${i}\u0000` : s)).join("");
  let text = joined.replace(/\s+/g, " ").trim();
  const clauseRx = new RegExp(`\\b(${CLAUSES.map((c) => c.replace(/ /g, "\\s+")).join("|")})\\b`, "gi");
  text = text.replace(clauseRx, (m) => "\n" + m.replace(/\s+/g, " ").toUpperCase());
  const kwRx = new RegExp(`\\b(${KEYWORDS.join("|")})\\b`, "gi");
  text = text.replace(kwRx, (m) => m.toUpperCase());
  text = text.replace(/\s+(AND|OR)\s/g, "\n  $1 ");
  text = text.replace(/,\s*/g, ",\n  ").replace(/\(\s*\n\s*/g, "(").replace(/\n\s*\)/g, ")");
  // keep commas inside parentheses on one line (function args, IN lists, VALUES)
  let depth = 0;
  let res = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth > 0 && ch === "\n") {
      while (i + 1 < text.length && text[i + 1] === " ") i++;
      res += " ";
      continue;
    }
    res += ch;
  }
  return res
    .replace(/\u0000(\d+)\u0000/g, (_m, idx) => segments[Number(idx)])
    .replace(/^\n/, "")
    .replace(/ +\n/g, "\n");
}

/** "1700000000" or "1700000000000" or an ISO date -> both representations. */
export function convertTime(input: string): { seconds: number; iso: string } {
  const t = input.trim();
  let ms: number;
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    ms = Math.abs(n) >= 1e11 ? n : n * 1000; // 11+ digits means milliseconds
  } else {
    ms = Date.parse(t);
  }
  if (Number.isNaN(ms)) throw new Error("Not a Unix timestamp or a date.");
  return { seconds: Math.floor(ms / 1000), iso: new Date(ms).toISOString() };
}
