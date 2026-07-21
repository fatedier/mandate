import { AlertTriangle, CheckCircle2, Circle } from "lucide-react";
import { DISABLE_TEXT_ASSIST_PROPS } from "@/lib/input-assist";
import { cn } from "@/lib/utils";

export function TextInput({
  label,
  value,
  onChange,
  placeholder,
  description,
  type = "text",
  mono = false
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  description?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        className={cn(
          "h-10 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/20",
          mono && "font-mono text-sm"
        )}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        {...DISABLE_TEXT_ASSIST_PROPS}
      />
      {description && <span className="text-xs leading-5 text-muted-foreground">{description}</span>}
    </label>
  );
}

export function StatusLine({
  ready,
  label,
  detail,
  multiline = false
}: {
  ready: boolean;
  label: string;
  detail: string;
  multiline?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      {ready ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-phase-done" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
      )}
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className={cn(
          "mt-0.5 text-xs text-muted-foreground",
          multiline ? "whitespace-pre-line leading-5" : "truncate"
        )}>{detail}</div>
      </div>
    </div>
  );
}

export function StepIcon({ state }: { state: "ready" | "action" | "warning" }) {
  if (state === "ready") return <CheckCircle2 className="h-4 w-4 shrink-0 text-phase-done" />;
  if (state === "warning") return <AlertTriangle className="h-4 w-4 shrink-0 text-amber" />;
  return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />;
}
