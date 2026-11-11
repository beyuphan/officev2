import { useCallback, useRef, useState, type MutableRefObject } from "react";

const LIMIT = 60;

type Options<T> = {
  /** the current state, and a ref that always holds the newest one */
  value: T;
  valueRef: MutableRefObject<T>;
  setValue: (v: T) => void;
  /** a snapshot was just stored for undo */
  onRecord?: (snapshot: T) => void;
  /** undo or redo is about to replace `current` */
  onLeave?: (current: T) => void;
  /** undo or redo has put `snapshot` back */
  onRestore?: (snapshot: T) => void;
};

/**
 * Undo and redo for an editor whose state is one value (a list of edits).
 * `touch()` makes one undo step out of a burst of changes (a drag, typing, a slider);
 * `begin()` / `end()` do the same for a gesture whose end is known.
 */
export function useHistory<T>(o: Options<T>) {
  const [past, setPast] = useState<T[]>([]);
  const [future, setFuture] = useState<T[]>([]);
  const gestureOpen = useRef(false);
  const gestureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Store a snapshot as the next thing undo goes back to. */
  const push = (snapshot: T) => {
    o.onRecord?.(snapshot);
    setPast((p) => [...p.slice(-(LIMIT - 1)), snapshot]);
    setFuture([]);
  };
  const record = () => push(o.valueRef.current);

  const touch = () => {
    if (!gestureOpen.current) {
      gestureOpen.current = true;
      record();
    }
    clearTimeout(gestureTimer.current);
    gestureTimer.current = setTimeout(() => (gestureOpen.current = false), 700);
  };
  const begin = () => {
    gestureOpen.current = false;
    touch();
    clearTimeout(gestureTimer.current); // stays open until end()
  };
  const end = () => {
    gestureOpen.current = false;
  };

  const undo = useCallback(() => {
    if (!past.length) return;
    const snapshot = past[past.length - 1];
    o.onLeave?.(o.value);
    setFuture((f) => [...f, o.value]);
    o.setValue(snapshot);
    setPast(past.slice(0, -1));
    o.onRestore?.(snapshot);
  }, [past, o.value]); // eslint-disable-line react-hooks/exhaustive-deps
  const redo = useCallback(() => {
    if (!future.length) return;
    const snapshot = future[future.length - 1];
    o.onLeave?.(o.value);
    setPast((p) => [...p, o.value]);
    o.setValue(snapshot);
    setFuture((f) => f.slice(0, -1));
    o.onRestore?.(snapshot);
  }, [future, o.value]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    past,
    future,
    push,
    record,
    touch,
    begin,
    end,
    undo,
    redo,
    /** forget the last stored step (a change that turned out to touch nothing) */
    dropLast: () => setPast((p) => p.slice(0, -1)),
    /** forget everything, for a freshly opened file */
    clear: () => {
      setPast([]);
      setFuture([]);
    },
  };
}
