import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { del, get, post } from "../api";
import { CheckField, FolderField, Message, Table, TextField, Title, formatBytes } from "../shared";

type Status = { exists: boolean; unlocked: boolean; idle_lock_seconds: number };
type VItem = { id: string; name: string; size: number; added_at: number };

export function Vault() {
  const [status, setStatus] = useState<Status | null>(null);
  const [items, setItems] = useState<VItem[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [removeOriginals, setRemoveOriginals] = useState(false);
  const [exportDir, setExportDir] = useState<string | null>(null);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");

  const fail = (e: unknown) => setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });

  const refresh = useCallback(async () => {
    try {
      const s = await get<Status>("/vault/status");
      setStatus(s);
      setItems(s.unlocked ? await get<VItem[]>("/vault/items") : []);
    } catch (e) {
      fail(e);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create() {
    try {
      const r = await post<{ recovery_key: string }>("/vault/create", { password });
      setRecovery(r.recovery_key);
      setPassword("");
      setConfirm("");
      setMessage(null);
      await refresh();
    } catch (e) {
      fail(e);
    }
  }
  async function unlock() {
    try {
      await post("/vault/unlock", useRecovery ? { recovery_key: recoveryInput } : { password });
      setPassword("");
      setRecoveryInput("");
      setMessage(null);
      await refresh();
    } catch (e) {
      fail(e);
    }
  }
  async function lock() {
    await post("/vault/lock");
    setMessage(null);
    await refresh();
  }
  async function add() {
    const picked = (await open({ multiple: true })) as string[] | null;
    if (!picked?.length) return;
    try {
      const r = await post<{ added: string[]; failed: { path: string; reason: string }[] }>("/vault/items", {
        paths: picked,
        delete_original: removeOriginals,
      });
      setMessage({
        ok: r.failed.length === 0,
        text: `${r.added.length} file(s) encrypted${removeOriginals ? "; originals moved to the Recycle Bin" : ""}${r.failed.length ? `; ${r.failed.length} failed (${r.failed[0].reason})` : ""}.`,
      });
      await refresh();
    } catch (e) {
      fail(e);
      await refresh();
    }
  }
  async function exportItem(it: VItem) {
    if (!exportDir) {
      setMessage({ ok: false, text: "Choose an export folder first." });
      return;
    }
    try {
      const r = await post<{ output: string }>(`/vault/items/${it.id}/export`, { out_dir: exportDir });
      setMessage({ ok: true, text: `Decrypted to ${r.output}` });
    } catch (e) {
      fail(e);
    }
  }
  async function remove(it: VItem) {
    try {
      await del(`/vault/items/${it.id}`);
      await refresh();
    } catch (e) {
      fail(e);
    }
  }
  async function changePassword() {
    try {
      await post("/vault/change-password", { old_password: oldPw, new_password: newPw });
      setOldPw("");
      setNewPw("");
      setMessage({ ok: true, text: "Password changed. The recovery key is unchanged." });
    } catch (e) {
      fail(e);
    }
  }

  if (!status) return <p className="muted">Loading…</p>;

  if (recovery) {
    return (
      <>
        <Title title="Vault created" hint="Write down the recovery key and keep it somewhere safe. It is shown only once." />
        <pre className="out recovery">{recovery}</pre>
        <p className="hint">
          If you forget the password, this key is the only way back in. officev2 cannot recover your files without it.
        </p>
        <div className="actions">
          <button onClick={() => navigator.clipboard?.writeText(recovery)}>Copy</button>
          <button className="primary" onClick={() => setRecovery(null)}>
            I have saved it
          </button>
        </div>
      </>
    );
  }

  if (!status.exists) {
    const ok = password.length >= 8 && password === confirm;
    return (
      <>
        <Title
          title="Vault"
          hint="An encrypted store for sensitive files such as ID copies and keys. Encrypted with AES-256; the password never leaves this computer."
        />
        <TextField id="v-pw" label="Master password" type="password" value={password} onChange={setPassword} hint="At least 8 characters. A long phrase is better." />
        <TextField
          id="v-pw2"
          label="Repeat password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          hint={confirm && confirm !== password ? "Passwords do not match." : undefined}
        />
        <div className="actions">
          <button className="primary" disabled={!ok} onClick={create}>
            Create vault
          </button>
        </div>
        <Message m={message} />
      </>
    );
  }

  if (!status.unlocked) {
    return (
      <>
        <Title title="Vault" hint="The vault is locked." />
        {useRecovery ? (
          <TextField id="v-rk" label="Recovery key" mono wide value={recoveryInput} onChange={setRecoveryInput} />
        ) : (
          <TextField id="v-pw" label="Master password" type="password" value={password} onChange={setPassword} />
        )}
        <div className="actions">
          <button className="primary" disabled={useRecovery ? !recoveryInput : !password} onClick={unlock}>
            Unlock
          </button>
          <button className="icon text" onClick={() => setUseRecovery(!useRecovery)}>
            {useRecovery ? "Use password" : "Use recovery key"}
          </button>
        </div>
        <Message m={message} />
      </>
    );
  }

  return (
    <>
      <Title
        title="Vault"
        hint={`Unlocked. It locks itself after ${Math.round(status.idle_lock_seconds / 60)} minutes without use.`}
      />
      <div className="actions tight">
        <button onClick={add}>Add files…</button>
        <button onClick={lock}>Lock now</button>
      </div>
      <CheckField
        label="Move the originals to the Recycle Bin after encrypting"
        checked={removeOriginals}
        onChange={setRemoveOriginals}
        hint="Only after the encrypted copy has been verified. Plain copies in the Recycle Bin are not protected until it is emptied."
      />
      <FolderField label="Decrypt files into" value={exportDir} onPick={setExportDir} />
      <Table
        head={
          <tr>
            <th>Name</th>
            <th className="op">Size</th>
            <th className="date">Added</th>
            <th className="act" style={{ width: 150 }}>
              <span className="sr">Actions</span>
            </th>
          </tr>
        }
        empty={items.length === 0 ? "The vault is empty." : undefined}
      >
        {items.map((it) => (
          <tr key={it.id}>
            <td>{it.name}</td>
            <td className="mono nowrap">{formatBytes(it.size)}</td>
            <td className="mono nowrap">{new Date(it.added_at * 1000).toLocaleDateString()}</td>
            <td className="act">
              <button className="icon text" onClick={() => exportItem(it)}>
                Decrypt
              </button>
              <button className="icon text" onClick={() => remove(it)}>
                Remove
              </button>
            </td>
          </tr>
        ))}
      </Table>
      <Message m={message} />
      <hr />
      <h2>Change password</h2>
      <div className="row3">
        <TextField id="v-old" label="Current password" type="password" value={oldPw} onChange={setOldPw} />
        <TextField id="v-new" label="New password" type="password" value={newPw} onChange={setNewPw} />
      </div>
      <div className="actions">
        <button disabled={!oldPw || newPw.length < 8} onClick={changePassword}>
          Change password
        </button>
      </div>
    </>
  );
}
