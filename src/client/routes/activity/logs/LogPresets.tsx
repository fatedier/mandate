import { cn } from "@/lib/utils";
import { PRESETS, type PresetId } from "../ledger-copy";

/** The log's presets, one at a time; they combine with the filters below. On
 *  a phone the line scrolls sideways rather than wrapping. */
export function LogPresets({ selected, onSelect }: { selected: PresetId; onSelect: (preset: PresetId) => void }) {
  return (
    <div role="group" aria-label="Show" className="flex gap-1.5 overflow-x-auto px-3 pt-2 pb-1 [scrollbar-width:none]">
      {PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          data-log-preset
          aria-pressed={preset.id === selected}
          onClick={() => onSelect(preset.id)}
          className={cn(
            "hit relative inline-flex h-7 shrink-0 items-center rounded-full border px-3 text-2xs whitespace-nowrap transition-colors pointer-coarse:min-h-11",
            preset.id === selected
              ? preset.id === "expired"
                ? "border-amber/40 bg-amber/10 font-semibold text-amber"
                : "border-border bg-sel font-semibold text-foreground"
              : "border-border-soft text-muted-foreground hover:text-foreground"
          )}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}
