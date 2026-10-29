export const MEMORY_VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "browse", label: "Browse" }
] as const;

export type MemoryView = (typeof MEMORY_VIEWS)[number]["id"];

export function memoryViewFromParam(value: string | null): MemoryView {
  return (MEMORY_VIEWS as readonly { id: string }[]).some((v) => v.id === value)
    ? (value as MemoryView)
    : "overview";
}

/** Overview is the landing view, so it carries no param. */
export function paramForMemoryView(view: MemoryView): string | null {
  return view === "overview" ? null : view;
}
