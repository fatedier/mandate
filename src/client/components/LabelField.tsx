import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Cog, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LABEL_MAX } from "@shared/labels";

/** A label as a chip or the field shows it: a task's or a thread's. `auto`
 *  is a task's alone (where its threads' workers ran). */
export interface ShownLabel {
  name: string;
  by: "owner" | "agent" | "auto";
}

const LABEL_CHIP = "inline-flex h-[18px] max-w-40 shrink-0 items-center gap-1 rounded-full px-2 text-2xs font-medium";
const SUGGESTED = 6;

/** One label: automatic ones (where the threads' workers ran) tinted and
 *  marked, the agent's marked; each says what it is on hover. */
export function LabelChip({ label, agentName, slot = "task-label", className, children }: {
  label: ShownLabel; agentName: string; slot?: string; className?: string; children?: ReactNode;
}) {
  const auto = label.by === "auto";
  return (
    <span
      data-slot={slot}
      data-by={label.by}
      title={auto ? `Automatic: its threads' workers ran in ${label.name}` : label.by === "agent" ? `Added by ${agentName}` : undefined}
      className={cn(LABEL_CHIP, auto ? "bg-[color-mix(in_oklab,var(--live)_14%,transparent)] text-live" : label.by === "agent" ? "bg-[color-mix(in_oklab,var(--status-review)_14%,transparent)] text-status-review" : "bg-sel text-muted-foreground", className)}
    >
      {auto && <Cog aria-hidden className="size-3 shrink-0" />}
      <span className="truncate">{label.name}</span>
      {label.by === "agent" && <Sparkles aria-hidden className="size-3 shrink-0" />}
      {children}
    </span>
  );
}

/**
 * The labels of a task or a thread, edited in place: each with × to remove
 * (an automatic one has none), and a field that adds one, suggesting the
 * names in use as the owner types and offering to create a new one.
 * `slot` names its parts for whoever shows it: `<slot>-labels-field`,
 * `<slot>-label`, `<slot>-label-suggestion`, `<slot>-label-error`.
 */
export function LabelField({ labels, known, agentName, onAdd, onRemove, slot = "task", autoFocus = false }: {
  labels: readonly ShownLabel[];
  /** The names in use, on tasks and threads alike. */
  known: readonly string[];
  agentName: string;
  onAdd(name: string): void;
  onRemove(name: string): void;
  slot?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [tooLong, setTooLong] = useState(false);
  const name = text.trim();
  const key = name.toLowerCase();
  const has = new Set(labels.map((l) => l.name.toLowerCase()));
  const suggestions = name ? known.filter((l) => !has.has(l.toLowerCase()) && l.toLowerCase().includes(key)).slice(0, SUGGESTED) : [];
  const exists = known.some((l) => l.toLowerCase() === key) || has.has(key);
  const add = (label: string) => {
    if (label.trim().length > LABEL_MAX) {
      setTooLong(true);
      return;
    }
    setTooLong(false);
    setText("");
    onAdd(label.trim());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || !name) return;
    event.preventDefault();
    add(name);
  };
  return (
    <div data-slot={`${slot}-labels-field`} className="flex min-w-0 flex-col gap-1 py-1">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {labels.map((label) => (
          <LabelChip key={label.name} label={label} agentName={agentName} slot={`${slot}-label`}>
            {label.by !== "auto" && (
              <button
                type="button"
                aria-label={`Remove label ${label.name}`}
                onClick={() => onRemove(label.name)}
                className="hit relative -mr-1 rounded-full p-px opacity-70 hover:opacity-100"
              >
                <X aria-hidden className="size-3" />
              </button>
            )}
          </LabelChip>
        ))}
        <input
          type="text"
          aria-label="Add a label"
          placeholder="Add a label"
          autoFocus={autoFocus}
          value={text}
          onChange={(event) => { setText(event.target.value); setTooLong(false); }}
          onKeyDown={onKeyDown}
          className="h-6 min-w-24 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
        />
      </div>
      {name && (suggestions.length > 0 || !exists) && (
        <div className="flex max-w-72 flex-col rounded-md border border-border-soft bg-panel p-1 text-[13px] shadow-sm">
          {suggestions.map((label) => (
            <button key={label} type="button" data-slot={`${slot}-label-suggestion`} onClick={() => add(label)} className="rounded-sm px-2 py-1 text-left hover:bg-sel pointer-coarse:min-h-11">
              {label}
            </button>
          ))}
          {!exists && (
            <button type="button" data-slot={`${slot}-label-suggestion`} onClick={() => add(name)} className="rounded-sm px-2 py-1 text-left text-muted-foreground hover:bg-sel pointer-coarse:min-h-11">
              Create "{name}"
            </button>
          )}
        </div>
      )}
      {tooLong && <p data-slot={`${slot}-label-error`} className="text-xs text-destructive">A label is at most 40 characters.</p>}
    </div>
  );
}
