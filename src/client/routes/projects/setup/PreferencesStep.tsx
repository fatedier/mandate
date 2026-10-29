import { DISABLE_TEXT_ASSIST_PROPS } from "@/lib/input-assist";

export function PreferencesStep({
  value,
  onChange
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-4 rounded-lg border border-border-soft bg-background/45 p-4">
      <textarea
        className="min-h-32 rounded-md border border-border bg-background px-3 py-2.5 text-sm leading-6 outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/20"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Example: Prefer Claude for planning and Codex for implementation."
        {...DISABLE_TEXT_ASSIST_PROPS}
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm leading-6 text-muted-foreground">
          Keep this as plain language. Agents use it as a delegation preference, not as a hard rule.
        </p>
        <p className="shrink-0 text-sm text-muted-foreground">Next saves this step.</p>
      </div>
    </div>
  );
}
