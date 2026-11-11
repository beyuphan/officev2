/** Tell the person something went wrong in the background, instead of leaving an empty screen. */
export const NOTICE = "app-notice";

export type Notice = { text: string };

/** Where an error becomes a sentence a person can read. `what` says what was being done. */
export function describeFailure(what: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return `${what}: ${raw}`;
}

export function notify(text: string) {
  window.dispatchEvent(new CustomEvent<Notice>(NOTICE, { detail: { text } }));
}

/**
 * For `.catch(failed("Could not load the font list"))`.
 * When the engine itself is down the banner already says so, so nothing more is shown.
 */
export function failed(what: string) {
  return (error: unknown) => {
    if (error instanceof Error && error.name === "EngineDown") return;
    notify(describeFailure(what, error));
  };
}
