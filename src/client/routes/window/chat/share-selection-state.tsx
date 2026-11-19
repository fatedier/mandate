import { createContext, useCallback, useMemo, useRef, useState } from "react";
import type { TranscriptRow } from "./transcript-rows";
import { preselection, rangeBetween } from "./share-selection";

/** Picking messages to share, in one conversation: whether it is under way,
 *  what is picked, and the actions on it. The conversation owns it; its
 *  transcript draws it and tells it which rows can be shared. */
export interface ShareSelection {
  selecting: boolean;
  selected: ReadonlySet<string>;
  /** Starts picking at a row: its exchange is picked (preselection). */
  begin(entryKey: string): void;
  /** A row picked or not; with `range`, every row from the last one clicked
   *  to this one is picked. */
  toggle(key: string, range: boolean): void;
  leave(): void;
  /** The transcript's rows and those of them that can be shared, as it last
   *  drew them. */
  setRows(all: readonly TranscriptRow[], shareable: readonly TranscriptRow[]): void;
  /** The rows that can be shared. */
  rows(): readonly TranscriptRow[];
  /** What the transcript does just before picking ends (notes where the
   *  reader is, to keep them there). */
  onLeave(before: (() => void) | null): void;
}

export const ShareSelectionContext = createContext<ShareSelection | null>(null);

/** Begins picking at a row, from that row's action line (a row that can be
 *  shared says so itself). Given by the transcript of a conversation that can
 *  share; none elsewhere. The same function while the conversation lasts: a
 *  new message must not draw every row's line again. */
export const ShareBeginContext = createContext<((rowKey: string) => void) | null>(null);

interface State {
  /** The conversation it is for: another one starts with nothing picked. */
  key: string;
  selecting: boolean;
  selected: ReadonlySet<string>;
  /** The row clicked last, where a Shift range starts. */
  anchor: string | null;
}

const idle = (key: string): State => ({ key, selecting: false, selected: new Set(), anchor: null });

export function useShareSelection(conversationKey: string): ShareSelection {
  const rowsRef = useRef<readonly TranscriptRow[]>([]);
  const allRowsRef = useRef<readonly TranscriptRow[]>([]);
  const beforeLeave = useRef<(() => void) | null>(null);
  const [state, setState] = useState<State>(() => idle(conversationKey));
  if (state.key !== conversationKey) setState(idle(conversationKey));
  const current = state.key === conversationKey ? state : idle(conversationKey);

  const begin = useCallback((entryKey: string) => {
    setState({ key: conversationKey, selecting: true, selected: preselection(entryKey, allRowsRef.current, rowsRef.current), anchor: entryKey });
  }, [conversationKey]);
  const toggle = useCallback((key: string, range: boolean) => {
    setState((s) => {
      const selected = new Set(s.selected);
      if (range && s.anchor !== null) for (const k of rangeBetween(rowsRef.current, s.anchor, key)) selected.add(k);
      else if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      return { ...s, selected, anchor: key };
    });
  }, []);
  const leave = useCallback(() => {
    beforeLeave.current?.();
    setState((s) => idle(s.key));
  }, []);
  const setRows = useCallback((all: readonly TranscriptRow[], shareable: readonly TranscriptRow[]) => {
    allRowsRef.current = all;
    rowsRef.current = shareable;
  }, []);
  const rows = useCallback(() => rowsRef.current, []);
  const onLeave = useCallback((before: (() => void) | null) => { beforeLeave.current = before; }, []);

  return useMemo(
    () => ({ selecting: current.selecting, selected: current.selected, begin, toggle, leave, setRows, rows, onLeave }),
    [current.selecting, current.selected, begin, toggle, leave, setRows, rows, onLeave]
  );
}
