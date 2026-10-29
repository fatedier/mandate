import { create } from "zustand";

interface ConfirmRequest {
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
  /** Where focus goes when the question closes: what had it when the
   *  question was asked, or a menu item's menu button (see menuTriggerOf).
   *  Kept until the dialog gives it focus, so a follow-up keeps it too. */
  returnFocus: HTMLElement | null;
  open: (req: ConfirmRequest, resolver: (answer: boolean) => void, returnFocus: HTMLElement | null) => void;
  resolve: (answer: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  resolver: null,
  returnFocus: null,
  open: (pending, resolver, returnFocus) => set({ pending, resolver, returnFocus }),
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
  const active = typeof document === "undefined" ? null : document.activeElement;
  // Asked as the open question closes — a follow-up, from inside it or once
  // it has gone and taken focus with it: focus goes back where that one's would.
  const followUp = !active || active === document.body || active.closest("[data-confirm-dialog]") !== null;
  const returnFocus = followUp ? cur.returnFocus : menuTriggerOf(active) ?? (active instanceof HTMLElement ? active : null);
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().open(req, resolve, returnFocus);
  });
}

/** The button of the menu an element sits in, through the menus it opened
 *  from: a menu item asking a question is gone by the time it closes, its
 *  menu having closed as the question opened. Null outside a menu, or for a
 *  menu that names no button. */
function menuTriggerOf(element: Element | null): HTMLElement | null {
  let menu: Element | null = element?.closest('[role="menu"]') ?? null;
  if (!menu) return null;
  for (;;) {
    const id: string | null = menu.getAttribute("aria-labelledby");
    const trigger: HTMLElement | null = id ? document.getElementById(id) : null;
    if (!trigger || menu.contains(trigger)) return null;
    const outer: Element | null = trigger.closest('[role="menu"]');
    if (!outer) return trigger;
    menu = outer;
  }
}
