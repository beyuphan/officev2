import { toolForFile } from "./handoff";

export type OpenRequest = { paths: string[]; convert: boolean };

/**
 * What the app was asked to do when Windows started it with these words:
 *   officev2.exe "C:\a.pdf"              -> open the file in its editor
 *   officev2.exe --convert "C:\a.pdf"    -> open the Convert screen for it
 * Anything that is not a file this app can open is ignored.
 */
export function parseOpenArgs(args: string[]): OpenRequest {
  return {
    paths: args.filter((a) => !a.startsWith("--") && toolForFile(a) !== null),
    convert: args.includes("--convert"),
  };
}

/** Explorer starts the app once per selected file, so the files of one selection arrive a moment apart. */
export function collectBurst(onReady: (all: string[]) => void, waitMs = 600) {
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (args: string[]) => {
    pending = [...pending, ...args];
    clearTimeout(timer);
    timer = setTimeout(() => {
      const all = pending;
      pending = [];
      onReady(all);
    }, waitMs);
  };
}
