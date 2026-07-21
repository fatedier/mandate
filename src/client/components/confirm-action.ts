import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  /** Multi-line allowed; rendered with `whitespace-pre-line`. */
  description?: string;
  /** Confirm button label. Default: "Confirm" (or "Delete" for destructive). */
  confirmLabel?: string;
  /** Cancel button label. Default: "Cancel". */
  cancelLabel?: string;
  /** Destructive: confirm button gets the destructive variant (red),
   *  default confirm label becomes "Delete". */
  destructive?: boolean;
}

interface ConfirmState {
  pending: ConfirmRequest | null;
  resolver: ((answer: boolean) => void) | null;
  open: (req: ConfirmRequest, resolver: (answer: boolean) => void) => void;
  resolve: (answer: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  resolver: null,
  open: (pending, resolver) => set({ pending, resolver }),
  resolve: (answer) => {
    const r = get().resolver;
    set({ pending: null, resolver: null });
    r?.(answer);
  }
}));

/** Imperative replacement for `window.confirm`. Returns a Promise that
 *  resolves to true on confirm, false on cancel / Esc / backdrop click.
 *
 *  Singleton: a second call while one is still open auto-cancels the
 *  first (resolves false) and replaces it. */
export function confirmAction(req: ConfirmRequest): Promise<boolean> {
  const cur = useConfirmStore.getState();
  if (cur.resolver) cur.resolver(false);
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().open(req, resolve);
  });
}
