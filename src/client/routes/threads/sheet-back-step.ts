import { useEffect, useEffectEvent, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useRouteCovered } from "@/lib/covered-route";

/**
 * On a phone the worker sheet is a step in the history, so the phone's Back
 * closes the sheet before it leaves the thread. The sheet's own
 * state stays where it was (the store: an agent, a report card and the page
 * itself all open it there); its step is a history entry for the same address,
 * marked in its state. One reconciler keeps the two together:
 *
 *  - the sheet opens          → its step is added;
 *  - Back takes the step      → the sheet closes;
 *  - the sheet closes itself  → its step is taken back (its Close, a pull
 *    down, a wider screen), so no Back is left that does nothing;
 *  - a step is arrived on from elsewhere (Back from a page the sheet led
 *    to, a reload) → the sheet reopens, as the entry says it was.
 *
 * Under a canvas modal the page does nothing: the history's top entry is the
 * canvas's, and a step back from here would close the canvas.
 */

/** The mark of the sheet's step, in a location's state. */
export const SHEET_STEP = "workerSheet";

/** The step this page added: its entry's key once the entry is seen,
 *  "pending" from adding it until then, "leaving" while it is being taken
 *  back, null for none. */
export type SheetStepMark = string | null;

export interface SheetStepFacts {
  /** The sheet is open. */
  open: boolean;
  /** This page's location is a sheet step. */
  marked: boolean;
  /** This page's location's key. */
  key: string;
  step: SheetStepMark;
  /** A canvas modal is open over this page. */
  covered: boolean;
  /** The phone layout, the only one with a sheet. */
  phone: boolean;
}

export type SheetStepAction =
  | { do: "none"; step: SheetStepMark }
  /** Push a marked entry for this address. */
  | { do: "add"; step: "pending" }
  /** Back took the step: close the sheet. */
  | { do: "close"; step: null }
  /** The sheet closed some other way: go back over its step. */
  | { do: "back"; step: "leaving" }
  /** Arrived on a step: open the sheet as it was left. */
  | { do: "reopen"; step: string }
  /** A step where no sheet can be (a wide screen): unmark the entry in place. */
  | { do: "strip"; step: null };

export function sheetStep({ open, marked, key, step, covered, phone }: SheetStepFacts): SheetStepAction {
  if (covered) return { do: "none", step };
  if (open) {
    // On its step: this entry is the one Back will take.
    if (marked) return { do: "none", step: key };
    if (step === "pending") return { do: "none", step };
    if (step === null || step === "leaving") return phone ? { do: "add", step: "pending" } : { do: "none", step: null };
    // It stood on its step and no longer does: Back took it.
    return { do: "close", step: null };
  }
  if (marked) {
    if (step === "leaving") return { do: "none", step };
    if (step === key || step === "pending") return { do: "back", step: "leaving" };
    return phone ? { do: "reopen", step: key } : { do: "strip", step: null };
  }
  return { do: "none", step: step === "pending" ? step : null };
}

function stateOf(state: unknown): Record<string, unknown> {
  return state && typeof state === "object" ? state as Record<string, unknown> : {};
}

/** Keeps the phone's worker sheet and its step in the history together.
 *  `onBack` closes the sheet; `onReturn` opens it as it was left.
 *
 *  `open` says when to look; `readOpen` says what is true then. The sheet's
 *  state is shared by every thread's page, and the page of a thread just
 *  arrived at first draws while the page it replaced is still to close its
 *  sheet: by the time effects run that has happened, and a sheet read as it
 *  was drawn would be taken for this page's own and given a step. */
export function useSheetBackStep({ mark = SHEET_STEP, open, readOpen, phone, onBack, onReturn }: {
  /** The mark of this page's step in the history's state: the worker
   *  sheet's by default; another page's own (Your agent's page). */
  mark?: string;
  open: boolean;
  readOpen: () => boolean;
  phone: boolean;
  onBack: () => void;
  onReturn: () => void;
}): void {
  const location = useLocation();
  const navigate = useNavigate();
  const covered = useRouteCovered();
  const marked = stateOf(location.state)[mark] === true;
  const step = useRef<SheetStepMark>(null);

  const reconcile = useEffectEvent(() => {
    const action = sheetStep({ open: readOpen(), marked, key: location.key, step: step.current, covered, phone });
    step.current = action.step;
    const here = { pathname: location.pathname, search: location.search, hash: location.hash };
    switch (action.do) {
      case "add":
        navigate(here, { state: { ...stateOf(location.state), [mark]: true } });
        return;
      case "back":
        navigate(-1);
        return;
      case "strip": {
        const rest = { ...stateOf(location.state) };
        delete rest[mark];
        navigate(here, { replace: true, state: rest });
        return;
      }
      case "close":
        onBack();
        return;
      case "reopen":
        onReturn();
        return;
      case "none":
        return;
    }
  });
  useEffect(() => {
    reconcile();
  }, [open, marked, location.key, covered, phone]);
  // The step is this mounting's to remember. In development React mounts,
  // undoes and mounts again (StrictMode): the page's own cleanup closes the
  // sheet in between, and a step remembered across that would read as "the
  // sheet closed, take its step back" and pop the entry just arrived on.
  useEffect(() => () => {
    step.current = null;
  }, []);
}
