import { useState, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { quickDays } from "./task-format";

export interface Due {
  dueDate: string | null;
  dueTime: string | null;
}

const chipClass = (on: boolean) => cn(
  "inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
  on ? "border-ring/60 bg-sel text-foreground" : "border-border-soft text-muted-foreground hover:bg-sel hover:text-foreground"
);
const FIELD = "h-7 rounded-md border border-border-soft bg-background px-2 text-xs text-foreground outline-none focus:border-ring";

/** A day from the platform's own date field. */
function DateField({ value, onChange }: { value: Due; onChange: (due: Due) => void }) {
  return (
    <input
      type="date"
      aria-label="Pick a date"
      value={value.dueDate ?? ""}
      onChange={(event) => onChange({ dueDate: event.target.value || null, dueTime: event.target.value ? value.dueTime : null })}
      className={FIELD}
    />
  );
}

/** Once there is a day: Add a time, or the platform's time field and Remove time. */
function TimeControls({ value, onChange }: { value: Due; onChange: (due: Due) => void }) {
  const [adding, setAdding] = useState(false);
  if (!value.dueDate) return null;
  if (!adding && !value.dueTime) return <button type="button" className={chipClass(false)} onClick={() => setAdding(true)}>Add a time</button>;
  return (
    <span className="flex items-center gap-2">
      <input type="time" aria-label="Time" value={value.dueTime ?? ""} onChange={(event) => onChange({ ...value, dueTime: event.target.value || null })} className={FIELD} />
      <button type="button" className={chipClass(false)} onClick={() => { setAdding(false); onChange({ ...value, dueTime: null }); }}>Remove time</button>
    </span>
  );
}


/** New task's Due: No date, Today, Tomorrow, Next week, or Pick a date; then
 *  a time if wanted. */
export function DueChoices({ value, onChange, now }: { value: Due; onChange: (due: Due) => void; now: number }) {
  const quick = quickDays(now);
  const [picking, setPicking] = useState(false);
  const choose = (dueDate: string | null) => {
    setPicking(false);
    onChange({ dueDate, dueTime: dueDate ? value.dueTime : null });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" aria-pressed={!picking && !value.dueDate} className={chipClass(!picking && !value.dueDate)} onClick={() => choose(null)}>No date</button>
        {quick.map(([label, day]) => (
          <button key={label} type="button" aria-pressed={!picking && value.dueDate === day} className={chipClass(!picking && value.dueDate === day)} onClick={() => choose(day)}>{label}</button>
        ))}
        <button type="button" aria-pressed={picking} className={chipClass(picking)} onClick={() => setPicking(true)}>Pick a date</button>
      </div>
      {(picking || value.dueDate) && (
        <div className="flex flex-wrap items-center gap-2">
          {picking && <DateField value={value} onChange={onChange} />}
          <TimeControls value={value} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

/** A phone's Due sheet: Today, Tomorrow, Next week, Clear (each closes it),
 *  then the date field and the time (saved as they change). */
export function DueSheetChoices({ value, onChange, now }: { value: Due; onChange: (due: Due, done: boolean) => void; now: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {quickDays(now).map(([label, day]) => (
          <button key={label} type="button" className={cn(chipClass(value.dueDate === day), "h-9 px-3.5 text-sm")} onClick={() => onChange({ dueDate: day, dueTime: value.dueTime }, true)}>{label}</button>
        ))}
        {value.dueDate && <button type="button" className={cn(chipClass(false), "h-9 px-3.5 text-sm")} onClick={() => onChange({ dueDate: null, dueTime: null }, true)}>Clear</button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <DateField value={value} onChange={(due) => onChange(due, false)} />
        <TimeControls value={value} onChange={(due) => onChange(due, false)} />
      </div>
    </div>
  );
}

/** The detail's Due: its button opens Today, Tomorrow, Next week, Clear, the
 *  date field and the time; each choice is saved as it is made. */
export function DuePicker({ value, onChange, now, children }: { value: Due; onChange: (due: Due) => void; now: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const choose = (due: Due) => {
    onChange(due);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="flex w-auto flex-col gap-2.5 p-3">
        <div className="flex flex-wrap gap-1.5">
          {quickDays(now).map(([label, day]) => (
            <button key={label} type="button" className={chipClass(value.dueDate === day)} onClick={() => choose({ dueDate: day, dueTime: value.dueTime })}>{label}</button>
          ))}
          {value.dueDate && <button type="button" className={chipClass(false)} onClick={() => choose({ dueDate: null, dueTime: null })}>Clear</button>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateField value={value} onChange={onChange} />
          <TimeControls value={value} onChange={onChange} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
