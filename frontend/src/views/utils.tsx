import { useEffect, useState } from "react";
import { Segmented, Title } from "../shared";
import { cleanPaste, convertTime, decodeJwt, formatJson, formatSql, fromBase64, minifyJson, toBase64 } from "../lib/text";

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

function Output({ value, error }: { value: string; error?: string }) {
  if (error) return <p className="msg bad">{error}</p>;
  if (!value) return null;
  return (
    <div className="field">
      <div className="inline">
        <span className="label" style={{ flex: 1, marginBottom: 0 }}>
          Result
        </span>
        <button className="icon text" onClick={() => copy(value)}>
          Copy
        </button>
      </div>
      <pre className="out">{value}</pre>
    </div>
  );
}

function safe<T>(fn: () => T): { value?: T; error?: string } {
  try {
    return { value: fn() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------- Clean paste + scratchpad ---------- */

export function TextTools() {
  const [mode, setMode] = useState<"paste" | "pad">("paste");
  const [input, setInput] = useState("");
  const [pad, setPad] = useState(() => localStorage.getItem("lf.scratchpad") ?? "");
  useEffect(() => {
    localStorage.setItem("lf.scratchpad", pad);
  }, [pad]);
  const cleaned = cleanPaste(input);

  return (
    <>
      <Title
        title="Text"
        hint={
          mode === "paste"
            ? "Paste text copied from a PDF. Line breaks inside paragraphs are removed and hyphenated words are joined."
            : "A scratch area for temporary text. It is kept on this computer only and never asks to be saved."
        }
      />
      <Segmented
        label="Tool"
        value={mode}
        onChange={setMode}
        options={[
          { id: "paste", label: "Clean paste" },
          { id: "pad", label: "Scratchpad" },
        ]}
      />
      {mode === "paste" ? (
        <>
          <div className="field">
            <label className="label" htmlFor="tt-in">
              Pasted text
            </label>
            <textarea id="tt-in" rows={8} value={input} onChange={(e) => setInput(e.target.value)} />
          </div>
          <Output value={cleaned} />
        </>
      ) : (
        <div className="field">
          <label className="label" htmlFor="tt-pad">
            Scratchpad
          </label>
          <textarea id="tt-pad" rows={14} value={pad} onChange={(e) => setPad(e.target.value)} />
          <div className="actions">
            <button onClick={() => copy(pad)} disabled={!pad}>
              Copy all
            </button>
            <button onClick={() => setPad("")} disabled={!pad}>
              Clear
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- Dev lab ---------- */

type Lab = "jwt" | "json" | "base64" | "sql" | "time";

export function DevLab() {
  const [tool, setTool] = useState<Lab>("jwt");
  const [input, setInput] = useState("");
  const [b64mode, setB64mode] = useState<"encode" | "decode">("encode");
  const [jsonMode, setJsonMode] = useState<"format" | "minify">("format");

  let result: { value?: string; error?: string } = {};
  let extra: React.ReactNode = null;
  if (input.trim()) {
    if (tool === "jwt") {
      const r = safe(() => decodeJwt(input));
      if (r.error) result = { error: r.error };
      else if (r.value) {
        result = { value: JSON.stringify({ header: r.value.header, payload: r.value.payload }, null, 2) };
        extra = (
          <ul className="notes">
            {r.value.times.map((t) => (
              <li key={t.claim}>
                <span className="mono">{t.claim}</span> {t.iso}
                {t.claim === "exp" && new Date(t.iso) < new Date() ? <b className="state failed"> expired</b> : null}
              </li>
            ))}
            <li className="muted">The signature is not verified here. Decoding happens on this computer; the token is never sent anywhere.</li>
          </ul>
        );
      }
    } else if (tool === "json") {
      result = safe(() => (jsonMode === "format" ? formatJson(input) : minifyJson(input)));
    } else if (tool === "base64") {
      result = safe(() => (b64mode === "encode" ? toBase64(input) : fromBase64(input)));
    } else if (tool === "sql") {
      result = safe(() => formatSql(input));
    } else {
      const r = safe(() => convertTime(input));
      result = r.error ? { error: r.error } : { value: `${r.value!.seconds}\n${r.value!.iso}` };
    }
  }

  const hints: Record<Lab, string> = {
    jwt: "Paste a token to read its claims. Nothing is uploaded.",
    json: "Validate, beautify or minify JSON.",
    base64: "Encode or decode text (UTF-8, base64 and base64url).",
    sql: "Tidy a SQL statement: keywords in capitals, one clause per line.",
    time: "Convert a Unix timestamp (seconds or milliseconds) or a date to both forms.",
  };

  return (
    <>
      <Title title="Dev lab" hint={hints[tool]} />
      <Segmented
        label="Tool"
        value={tool}
        onChange={(t) => {
          setTool(t);
        }}
        options={[
          { id: "jwt", label: "JWT" },
          { id: "json", label: "JSON" },
          { id: "base64", label: "Base64" },
          { id: "sql", label: "SQL" },
          { id: "time", label: "Time" },
        ]}
      />
      {tool === "json" && (
        <Segmented
          label="Action"
          value={jsonMode}
          onChange={setJsonMode}
          options={[
            { id: "format", label: "Format" },
            { id: "minify", label: "Minify" },
          ]}
        />
      )}
      {tool === "base64" && (
        <Segmented
          label="Action"
          value={b64mode}
          onChange={setB64mode}
          options={[
            { id: "encode", label: "Encode" },
            { id: "decode", label: "Decode" },
          ]}
        />
      )}
      <div className="field">
        <label className="label" htmlFor="dl-in">
          Input
        </label>
        <textarea id="dl-in" rows={7} className="mono" value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />
      </div>
      <Output value={result.value ?? ""} error={result.error} />
      {extra}
    </>
  );
}
