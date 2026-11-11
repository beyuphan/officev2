import { useState } from "react";
import { get } from "./api";
import { ConfirmDialog } from "./shared";

type ModelInfo = { id: string; name: string; size_mb: number; installed: boolean };

/** What to tell the person before a download starts. Kept apart so it can be tested and reworded in one place. */
export function downloadWarning(m: Pick<ModelInfo, "name" | "size_mb">): string {
  return `The first time, "${m.name}" is downloaded (${m.size_mb} MB). After that it is kept on this computer and works without internet, so this happens only once. On mobile data or a slow connection it can take a while.`;
}

/**
 * Ask before a feature downloads its model for the first time.
 * `ensure("rembg-u2netp")` resolves true when the model is already here or the person agrees to the download,
 * false when they decline. The person stays on the same screen with their files still chosen.
 */
export function useModelGate() {
  const [ask, setAsk] = useState<{ model: ModelInfo; answer: (ok: boolean) => void } | null>(null);

  async function ensure(modelId: string): Promise<boolean> {
    let model: ModelInfo | undefined;
    try {
      model = (await get<ModelInfo[]>("/models")).find((m) => m.id === modelId);
    } catch {
      return true; // cannot tell: let the job run and report whatever happens
    }
    if (!model || model.installed) return true;
    return new Promise((resolve) => setAsk({ model, answer: resolve }));
  }

  const done = (ok: boolean) => {
    ask?.answer(ok);
    setAsk(null);
  };

  const dialog = ask && (
    <ConfirmDialog
      title="A download is needed once"
      text={downloadWarning(ask.model)}
      cancelLabel="Not now"
      choices={[{ label: `Download ${ask.model.size_mb} MB and continue`, kind: "primary", onClick: () => done(true) }]}
      onCancel={() => done(false)}
    />
  );
  return { ensure, dialog };
}
