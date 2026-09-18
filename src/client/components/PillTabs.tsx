import { cn } from "@/lib/utils";

/** The Feature page's pill tabs, shared. `role="tablist"` (default) gives
 *  tab / aria-selected semantics and, with `idPrefix`, the id / aria-controls
 *  pairing the Activity page's tests rely on; `role="nav"` renders a <nav>
 *  with aria-current for view switchers that are not real tab panels. */
export function PillTabs<T extends string>({
  items, value, onChange, "aria-label": ariaLabel, idPrefix, role = "tablist"
}: {
  items: ReadonlyArray<{ id: T; label: string }>; value: T; onChange: (id: T) => void;
  "aria-label": string; idPrefix?: string; role?: "tablist" | "nav";
}) {
  // Mirrors the Feature page's shipped TabButton (WindowPage.tsx): a --sel
  // fill marks the active pill; no accent underline, no rounded-md.
  const pill = (selected: boolean) => cn(
    "inline-flex h-7 items-center rounded-sm px-2.5 text-xs font-medium transition-colors",
    selected ? "bg-sel text-foreground" : "text-chrome hover:bg-sel hover:text-foreground"
  );
  if (role === "nav") {
    return (
      <nav data-slot="page-tabs" aria-label={ariaLabel} className="flex gap-0.5">
        {items.map((item) => (
          <button key={item.id} type="button" aria-current={item.id === value ? "page" : undefined}
            className={pill(item.id === value)} onClick={() => onChange(item.id)}>{item.label}</button>
        ))}
      </nav>
    );
  }
  return (
    <div data-slot="page-tabs" role="tablist" aria-label={ariaLabel} className="flex gap-0.5">
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button key={item.id} type="button" role="tab" aria-selected={selected}
            id={idPrefix ? `${idPrefix}-tab-${item.id}` : undefined}
            aria-controls={idPrefix && selected ? `${idPrefix}-panel-${item.id}` : undefined}
            className={pill(selected)} onClick={() => onChange(item.id)}>{item.label}</button>
        );
      })}
    </div>
  );
}
