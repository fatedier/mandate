import type { ReactNode } from "react";
import { SimpleSelect } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Shared control chrome. Every field is the same height and carries the same
 * focus treatment, so a column of them reads as one instrument panel rather
 * than a pile of separately-styled inputs.
 */
const CONTROL =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none " +
  "focus:border-ring focus:ring-[3px] focus:ring-ring/20 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Fields render bare inside a SettingRow, which already shows the name. Pass
 * `label` only where the control still has to caption itself — repeated rows
 * (fallbacks, provider models) where a per-row name is the only way to tell
 * the columns apart.
 */
function FieldShell({
  label,
  hint,
  children
}: {
  label?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  if (!label && !hint) return <>{children}</>;
  const Tag = label ? "label" : "div";
  return (
    <Tag className="flex min-w-0 flex-col gap-1 text-sm">
      {label ? <span className="label-micro text-chrome">{label}</span> : null}
      {children}
      {hint ? <span className="text-xs leading-relaxed text-chrome">{hint}</span> : null}
    </Tag>
  );
}

export function TextField({
  label,
  ariaLabel,
  value,
  disabled,
  mono,
  suffix,
  placeholder,
  hint,
  onChange
}: {
  label?: string;
  ariaLabel?: string;
  value: string;
  disabled?: boolean;
  mono?: boolean;
  suffix?: string;
  placeholder?: string;
  hint?: ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <FieldShell label={label} hint={hint}>
      <div className="flex h-9 overflow-hidden rounded-md border border-border bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
        <input
          className={cn(
            "min-w-0 flex-1 bg-transparent px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50",
            mono && "font-mono text-xs"
          )}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={label ? undefined : ariaLabel}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        {suffix && (
          <span className="flex items-center border-l border-border px-2 text-xs text-chrome">
            {suffix}
          </span>
        )}
      </div>
    </FieldShell>
  );
}

export function SelectField<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  hint,
  onChange
}: {
  label?: string;
  ariaLabel?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  hint?: ReactNode;
  onChange: (value: T) => void;
}) {
  return (
    <FieldShell label={label} hint={hint}>
      <SimpleSelect
        className={CONTROL}
        aria-label={label ?? ariaLabel}
        value={value}
        options={options}
        onValueChange={(next) => onChange(next as T)}
      />
    </FieldShell>
  );
}

/** SelectField's markup with the mono treatment `provider/model` refs get
 *  everywhere else. SelectField itself stays proportional — machine ids only. */
export function ModelRefField({
  label,
  ariaLabel,
  value,
  options,
  onChange
}: {
  label?: string;
  ariaLabel?: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <FieldShell label={label}>
      <SimpleSelect
        className={cn(CONTROL, "font-mono text-xs")}
        itemClassName="font-mono text-xs"
        aria-label={label ?? ariaLabel}
        value={value}
        options={options}
        onValueChange={onChange}
      />
    </FieldShell>
  );
}

/**
 * API key entry. The configured/not-set state is the field's own status, not a
 * separate setting, so it rides on the control rather than claiming a row.
 */
export function SecretField({
  label,
  configured,
  value,
  clear,
  onValueChange,
  onClearChange
}: {
  label?: string;
  configured: boolean;
  value: string;
  clear: boolean;
  onValueChange: (value: string) => void;
  onClearChange: (value: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-sm">
      {label ? (
        <div className="flex items-center justify-between gap-2">
          <span className="label-micro text-chrome">{label}</span>
          <SecretState configured={configured} />
        </div>
      ) : null}
      <input
        className={cn(CONTROL, "font-mono text-xs")}
        type="password"
        value={value}
        disabled={clear}
        aria-label={label ?? "API key"}
        placeholder={configured ? "Blank keeps current key" : "Paste key"}
        onChange={(event) => onValueChange(event.target.value)}
      />
      <div className="flex items-center justify-between gap-2">
        {label ? <span /> : <SecretState configured={configured} />}
        {configured ? (
          <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-chrome hover:text-muted-foreground">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={clear}
              onChange={(event) => onClearChange(event.target.checked)}
            />
            <span>Clear saved key</span>
          </label>
        ) : null}
      </div>
    </div>
  );
}

function SecretState({ configured }: { configured: boolean }) {
  return (
    <span className={cn("text-2xs", configured ? "text-phase-done" : "text-chrome")}>
      {configured ? "Configured" : "Not set"}
    </span>
  );
}
