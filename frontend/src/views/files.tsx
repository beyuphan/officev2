import { failed } from "../lib/notify";
import { buildPresets, describeRule, type Folders, type Preset } from "../lib/autopilot";
import { useCallback, useEffect, useMemo, useState } from "react";
import { del, get, post, put, runJob, type Job } from "../api";
import {
  CheckField,
  FolderField,
  Message,
  ProgressBar,
  Segmented,
  Table,
  TextField,
  Title,
  baseName,
  dirName,
  formatBytes,
} from "../shared";
import { squarify } from "../lib/treemap";

/* ------------------------------------------------------------------------------------------ */
/* Bulk rename                                                                                */
/* ------------------------------------------------------------------------------------------ */

type PlanItem = { source: string; target: string; conflict: string | null };

export function Rename({ onDone }: { onDone: () => void }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [regex, setRegex] = useState(false);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [withExt, setWithExt] = useState(false);
  const [recursive, setRecursive] = useState(false);
  const [startAt, setStartAt] = useState("1");
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const body = () => ({
    folder,
    pattern,
    replacement,
    regex,
    ignore_case: ignoreCase,
    include_extension: withExt,
    recursive,
    start_at: Number(startAt) || 0,
  });
  const ready = folder && pattern;

  async function preview() {
    setBusy(true);
    setMessage(null);
    try {
      setPlan(await post<PlanItem[]>("/files/rename/preview", body()));
    } catch (e) {
      setPlan(null);
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    try {
      const r = await post<{ renamed: number; skipped: { source: string; reason: string }[] }>("/files/rename/apply", body());
      setMessage({
        ok: true,
        text: `${r.renamed} renamed${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}. You can undo this in Activity.`,
      });
      setPlan(null);
      onDone();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const okCount = plan?.filter((p) => !p.conflict).length ?? 0;

  return (
    <>
      <Title
        title="Rename"
        hint="Rename many files by a rule. Always preview first. Use {n} or {n:03} for a counter; with regex, \1 inserts a captured group."
      />
      <FolderField label="Folder" value={folder} onPick={(f) => { setFolder(f); setPlan(null); }} />
      <div className="row3">
        <TextField id="rn-p" label="Find" mono value={pattern} onChange={(v) => { setPattern(v); setPlan(null); }} />
        <TextField id="rn-r" label="Replace with" mono value={replacement} onChange={(v) => { setReplacement(v); setPlan(null); }} />
        <TextField id="rn-s" label="Counter starts at" type="number" mono value={startAt} onChange={(v) => { setStartAt(v); setPlan(null); }} />
      </div>
      <div className="checks">
        <CheckField label="Regular expression" checked={regex} onChange={(v) => { setRegex(v); setPlan(null); }} />
        <CheckField label="Ignore case" checked={ignoreCase} onChange={(v) => { setIgnoreCase(v); setPlan(null); }} />
        <CheckField label="Include file extension" checked={withExt} onChange={(v) => { setWithExt(v); setPlan(null); }} />
        <CheckField label="Include subfolders" checked={recursive} onChange={(v) => { setRecursive(v); setPlan(null); }} />
      </div>
      <div className="actions">
        <button disabled={!ready || busy} onClick={preview}>
          Preview
        </button>
        <button className="primary" disabled={!plan || okCount === 0 || busy} onClick={apply}>
          Rename {plan ? okCount : ""} file{okCount === 1 ? "" : "s"}
        </button>
      </div>
      <Message m={message} />
      {plan && plan.length === 0 && <p className="muted">No file names match.</p>}
      {plan && plan.length > 0 && (
        <Table
          head={
            <tr>
              <th>Current name</th>
              <th>New name</th>
              <th className="status">Note</th>
            </tr>
          }
        >
          {plan.map((p) => (
            <tr key={p.source} className={p.conflict ? "withdrawn" : ""}>
              <td className="mono trunc" title={p.source}>
                {baseName(p.source)}
              </td>
              <td className="mono trunc" title={p.target}>
                {baseName(p.target)}
              </td>
              <td className="state failed">{p.conflict ?? ""}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Clean up: temp files, developer junk, duplicates, quarantine                                */
/* ------------------------------------------------------------------------------------------ */

type Item = { path: string; size: number; label: string; group?: number };
type CleanMode = "temp" | "junk" | "dupes";
type Batch = { batch: string; size: number; created_at: number };

export function Cleanup({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<CleanMode>("temp");
  const [folder, setFolder] = useState<string | null>(null);
  const [days, setDays] = useState("1");
  const [items, setItems] = useState<Item[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Job["progress"]>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [purgeDays, setPurgeDays] = useState("30");
  const [confirmPurge, setConfirmPurge] = useState(false);

  const loadBatches = useCallback(() => {
    get<Batch[]>("/files/quarantine").then(setBatches).catch(failed("Could not load the quarantine list"));
  }, []);
  useEffect(loadBatches, [loadBatches]);

  const needsFolder = mode !== "temp";

  async function scan() {
    setScanning(true);
    setMessage(null);
    setItems(null);
    try {
      let job: Job;
      if (mode === "temp") job = await runJob("/files/clean/scan", { older_than_days: Number(days) || 0 }, (j) => setProgress(j.progress));
      else if (mode === "junk") job = await runJob("/files/junk/scan", { root: folder }, (j) => setProgress(j.progress));
      else job = await runJob("/files/duplicates", { roots: [folder] }, (j) => setProgress(j.progress));
      if (job.state !== "done") {
        setMessage({ ok: false, text: job.error ?? job.state });
        return;
      }
      let list: Item[];
      const preselect = new Set<string>();
      if (mode === "dupes") {
        list = [];
        (job.result.groups as { size: number; files: string[] }[]).forEach((g, gi) =>
          g.files.forEach((f, fi) => {
            list.push({ path: f, size: g.size, label: `copy ${gi + 1}`, group: gi });
            if (fi > 0) preselect.add(f); // keep the first file of each group
          }),
        );
      } else {
        list = (job.result.items as { path: string; size: number; kind?: string; is_dir?: boolean }[]).map((i) => ({
          path: i.path,
          size: i.size,
          label: i.kind ?? (i.is_dir ? "folder" : "file"),
        }));
        list.forEach((i) => preselect.add(i.path));
      }
      setItems(list);
      setPicked(preselect);
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  const selectedSize = useMemo(() => (items ?? []).filter((i) => picked.has(i.path)).reduce((a, i) => a + i.size, 0), [items, picked]);

  async function quarantine() {
    try {
      const r = await post<{ moved: number; freed_bytes: number; failed: { path: string; reason: string }[] }>("/files/quarantine", {
        paths: [...picked],
      });
      setMessage({
        ok: true,
        text: `${r.moved} item(s) moved to quarantine, ${formatBytes(r.freed_bytes)} freed${r.failed.length ? `; ${r.failed.length} could not be moved (${r.failed[0].reason})` : ""}. Undo in Activity.`,
      });
      setItems((cur) => (cur ?? []).filter((i) => !picked.has(i.path) || r.failed.some((f) => f.path === i.path)));
      setPicked(new Set());
      loadBatches();
      onDone();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  async function purge() {
    const r = await post<{ removed_batches: number; freed_bytes: number }>("/files/quarantine/purge", { older_than_days: Number(purgeDays) || 0 });
    setMessage({ ok: true, text: `${r.removed_batches} batch(es) permanently removed, ${formatBytes(r.freed_bytes)} freed.` });
    setConfirmPurge(false);
    loadBatches();
  }

  const toggle = (p: string) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  return (
    <>
      <Title
        title="Clean up"
        hint="Find space to reclaim. Nothing is deleted: selected items move to a quarantine folder and can be restored from Activity."
      />
      <Segmented
        label="Look for"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setItems(null);
          setMessage(null);
        }}
        options={[
          { id: "temp", label: "Temporary files" },
          { id: "junk", label: "Developer junk" },
          { id: "dupes", label: "Duplicate files" },
        ]}
      />
      {mode === "temp" && (
        <TextField id="cl-days" label="Older than (days)" type="number" mono value={days} onChange={setDays} hint="Your user temp folders only" />
      )}
      {mode === "junk" && <p className="hint">Finds node_modules, __pycache__, virtual environments, Rust target folders next to a Cargo.toml, build caches.</p>}
      {mode === "dupes" && <p className="hint">Files with identical content. The first copy in each group stays selected as the one to keep.</p>}
      {needsFolder && <FolderField label="Folder to scan" value={folder} onPick={setFolder} />}
      <div className="actions">
        <button disabled={scanning || (needsFolder && !folder)} onClick={scan}>
          {scanning ? "Scanning…" : "Scan"}
        </button>
        {items && items.length > 0 && (
          <button className="primary" disabled={picked.size === 0} onClick={quarantine}>
            Move {picked.size} to quarantine ({formatBytes(selectedSize)})
          </button>
        )}
      </div>
      {scanning && <ProgressBar progress={progress} />}
      <Message m={message} />
      {items && items.length === 0 && <p className="muted">Nothing found.</p>}
      {items && items.length > 0 && (
        <Table
          head={
            <tr>
              <th className="num">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={picked.size === items.length}
                  onChange={(e) => setPicked(e.target.checked ? new Set(items.map((i) => i.path)) : new Set())}
                />
              </th>
              <th>Item</th>
              <th className="op">Kind</th>
              <th className="status">Size</th>
            </tr>
          }
        >
          {items.map((i, idx) => (
            <tr key={i.path} className={mode === "dupes" && idx > 0 && items[idx - 1].group !== i.group ? "groupstart" : ""}>
              <td className="num">
                <input type="checkbox" aria-label={`Select ${baseName(i.path)}`} checked={picked.has(i.path)} onChange={() => toggle(i.path)} />
              </td>
              <td className="trunc" title={i.path}>
                <span className="mono">{baseName(i.path)}</span> <small className="note">{dirName(i.path)}</small>
              </td>
              <td className="muted">{i.label}</td>
              <td className="mono nowrap">{formatBytes(i.size)}</td>
            </tr>
          ))}
        </Table>
      )}

      <hr />
      <h2>Quarantine</h2>
      {batches.length === 0 ? (
        <p className="muted">Empty.</p>
      ) : (
        <>
          <p className="hint">
            {batches.length} batch(es), {formatBytes(batches.reduce((a, b) => a + b.size, 0))}. Restore items from Activity.
          </p>
          <div className="inline">
            <TextField id="q-days" label="Remove permanently if older than (days)" type="number" mono value={purgeDays} onChange={setPurgeDays} />
          </div>
          <CheckField label="I understand this cannot be undone" checked={confirmPurge} onChange={setConfirmPurge} />
          <div className="actions">
            <button disabled={!confirmPurge} onClick={purge}>
              Remove permanently
            </button>
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Disk map (treemap)                                                                          */
/* ------------------------------------------------------------------------------------------ */

type Node = { name: string; path: string; size: number; is_dir: boolean; children: Node[] };
export function DiskMap() {
  const [root, setRoot] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [tree, setTree] = useState<Node | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<Job["progress"]>(null);
  const [error, setError] = useState("");

  async function scan(path: string) {
    setScanning(true);
    setError("");
    try {
      const job = await runJob("/files/usage", { path, depth: 1, top: 60 }, (j) => setProgress(j.progress));
      if (job.state !== "done") throw new Error(job.error ?? job.state);
      setTree(job.result as Node);
      setRoot(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }

  const blocks = useMemo(() => {
    if (!tree) return [];
    const kids = tree.children.filter((c) => c.size > 0);
    const rects = squarify(kids.map((k) => k.size), { x: 0, y: 0, w: 100, h: 100 });
    return kids.map((k, i) => ({ node: k, rect: rects[i], rank: i }));
  }, [tree]);

  return (
    <>
      <Title title="Disk map" hint="See which folders take the space. Click a folder block to look inside it." />
      <FolderField
        label="Folder"
        value={root && trail.length === 0 ? root : trail.length ? trail[trail.length - 1] : null}
        onPick={(p) => {
          setTrail([]);
          scan(p);
        }}
      />
      {scanning && <ProgressBar progress={progress} />}
      {error && <p className="msg bad">{error}</p>}
      {tree && (
        <>
          <div className="crumbs">
            <span className="mono">{tree.path}</span>
            <span className="muted"> · {formatBytes(tree.size)}</span>
            {trail.length > 0 && (
              <button
                className="icon text"
                onClick={() => {
                  const next = trail.slice(0, -1);
                  setTrail(next);
                  scan(next.length ? next[next.length - 1] : (root as string));
                }}
              >
                Up
              </button>
            )}
          </div>
          <div className="treemap" role="img" aria-label="Folder sizes">
            {blocks.map(({ node, rect, rank }) => (
              <button
                key={node.path + node.name}
                className={`tile ${node.is_dir ? "dir" : "file"}`}
                style={{
                  left: `${rect.x}%`,
                  top: `${rect.y}%`,
                  width: `${rect.w}%`,
                  height: `${rect.h}%`,
                  background: `color-mix(in srgb, var(--ink) ${Math.max(6, 34 - rank * 2)}%, var(--panel))`,
                }}
                title={`${node.path}
${formatBytes(node.size)}`}
                disabled={!node.is_dir || node.name === "(other)"}
                onClick={() => {
                  setTrail([...trail, node.path]);
                  scan(node.path);
                }}
              >
                {rect.w > 7 && rect.h > 9 && (
                  <span className="in">
                    <b>{node.name}</b>
                    <span className="mono">{formatBytes(node.size)}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Autopilot (rules)                                                                           */
/* ------------------------------------------------------------------------------------------ */

type Rule = { id: number; name: string; enabled: boolean; folder: string; extensions: string[]; name_regex: string; min_size: number; dest: string };

export function Autopilot({ onDone }: { onDone: () => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [exts, setExts] = useState("");
  const [regex, setRegex] = useState("");
  const [minKb, setMinKb] = useState("0");
  const [dest, setDest] = useState<string | null>(null);
  const [byType, setByType] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [folders, setFolders] = useState<Folders | null>(null);
  useEffect(() => {
    get<Folders>("/files/known-folders").then(setFolders).catch(failed("Could not find your folders"));
  }, []);

  const load = useCallback(() => {
    get<Rule[]>("/files/rules").then(setRules).catch(failed("Could not load your rules"));
  }, []);
  useEffect(load, [load]);

  async function add() {
    try {
      await post("/files/rules", {
        name,
        folder,
        extensions: exts.split(",").map((e) => e.trim()).filter(Boolean),
        name_regex: regex,
        min_size: Math.round(Number(minKb) * 1024) || 0,
        dest: byType ? `${dest}\\{ext}` : dest,
      });
      setName("");
      setExts("");
      setRegex("");
      setMessage({ ok: true, text: "Rule saved. It now watches the folder for new files." });
      load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }
  async function toggle(r: Rule) {
    await put(`/files/rules/${r.id}`, { ...r, enabled: !r.enabled });
    load();
  }
  async function remove(r: Rule) {
    await del(`/files/rules/${r.id}`);
    load();
  }
  async function runNow(r: Rule) {
    try {
      const res = await post<{ moved: number }>(`/files/rules/${r.id}/run`);
      setMessage({ ok: true, text: `${res.moved} file(s) moved. Undo in Activity.` });
      onDone();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  const presets = folders ? buildPresets(folders) : [];
  const draft = { folder: folder ?? "", extensions: exts.split(",").map((e) => e.trim().replace(/^\./, "")).filter(Boolean), name_regex: regex, min_size: Math.round(Number(minKb) * 1024) || 0, dest: byType && dest ? `${dest}\\{ext}` : dest ?? "" };

  async function turnOn(pr: Preset) {
    try {
      await post("/files/rules", pr.rule);
      setMessage({ ok: true, text: `Turned on: ${describeRule(pr.rule)} New files are moved by themselves. To tidy what is already there, press \u201cMove what is there now\u201d.` });
      load();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <>
      <Title
        title="Autopilot"
        hint={"Files that land in a folder (usually Downloads) are put away for you. Example: “When a PNG lands in Downloads, move it to Pictures › PNG.” Pick a ready-made rule below, or write your own. Every move can be undone in Activity."}
      />

      <h2>Ready-made rules</h2>
      <div className="ap-cards">
        {presets.map((pr) => {
          const on = rules.some((r) => r.name === pr.rule.name);
          return (
            <div key={pr.id} className={`ap-card${on ? " on" : ""}`}>
              <b>{pr.title}</b>
              <small>{pr.example}</small>
              <button className={on ? "" : "primary"} disabled={on} onClick={() => void turnOn(pr)}>
                {on ? "Turned on" : "Turn on"}
              </button>
            </div>
          );
        })}
      </div>
      <Message m={message} />

      <h2>Your rules</h2>
      <Table
        head={
          <tr>
            <th>What it does</th>
            <th className="act" style={{ width: 290 }}>
              <span className="sr">Actions</span>
            </th>
          </tr>
        }
        empty={rules.length === 0 ? "Nothing is on yet. Turn on a ready-made rule above." : undefined}
      >
        {rules.map((r) => (
          <tr key={r.id} className={r.enabled ? "" : "withdrawn"}>
            <td>
              <b>{r.name}</b>
              <small className="note" style={{ display: "block" }}>
                {describeRule(r)}
              </small>
            </td>
            <td className="act">
              <button className="icon text" onClick={() => runNow(r)} title="Also move the matching files that are in the folder already">
                Move what is there now
              </button>
              <button className="icon text" onClick={() => toggle(r)}>
                {r.enabled ? "Pause" : "Resume"}
              </button>
              <button className="icon text" onClick={() => remove(r)}>
                Delete
              </button>
            </td>
          </tr>
        ))}
      </Table>

      <details className="ap-own">
        <summary>Write my own rule</summary>
        <TextField id="ap-name" label="Name" value={name} onChange={setName} hint="For example: Invoices" />
        <FolderField label="When a file lands in this folder" value={folder} onPick={setFolder} />
        <div className="row3">
          <TextField id="ap-ext" label="and its type is" mono value={exts} onChange={setExts} hint="Comma separated, like pdf, docx. Empty means any type" />
          <TextField id="ap-re" label="and its name contains (optional)" mono value={regex} onChange={setRegex} hint="A word or pattern, e.g. invoice" />
          <TextField id="ap-kb" label="and it is bigger than (KB)" type="number" mono value={minKb} onChange={setMinKb} />
        </div>
        <FolderField label="move it to" value={dest} onPick={setDest} />
        <CheckField label="Put each type in its own subfolder (pdf, png, zip\u2026)" checked={byType} onChange={setByType} />
        {folder && dest && <p className="hint ap-sentence">{describeRule(draft)}</p>}
        <div className="actions">
          <button className="primary" disabled={!name.trim() || !folder || !dest} onClick={add}>
            Turn on this rule
          </button>
        </div>
      </details>
    </>
  );
}
