import type { CalendarViewKind } from "./calendar-dates";

/** Where the calendar is drawn: the view chosen is remembered for each. */
export type CalendarPlace = "page" | "panel" | "phone";

const KEY = (place: CalendarPlace) => `mandate.calendar.view.${place}`;
const VIEWS: readonly CalendarViewKind[] = ["day", "week", "month", "list"];

/** The view last chosen in that place, in this browser; Week, or List on a phone, before any. */
export function rememberedView(place: CalendarPlace): CalendarViewKind {
  try {
    const saved = window.localStorage.getItem(KEY(place));
    if (saved && (VIEWS as readonly string[]).includes(saved)) return saved as CalendarViewKind;
  } catch {
    // Storage refused (a private window): the default.
  }
  return place === "phone" ? "list" : "week";
}

export function rememberView(place: CalendarPlace, view: CalendarViewKind): void {
  try {
    window.localStorage.setItem(KEY(place), view);
  } catch {
    // Not kept: the default next time.
  }
}
