import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/select";
import { openInSystemBrowser } from "@/lib/open-external";
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
          // A caption names the input; `ariaLabel` beside one gives it a
          // name without the hint the caption wraps.
          aria-label={ariaLabel}
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
  placeholder,
  onChange
}: {
  label?: string;
  ariaLabel?: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  /** What an unset field ("") says; in the body face, as it is a sentence
   *  and not a model id. */
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <FieldShell label={label}>
      <SimpleSelect
        className={cn(CONTROL, "font-mono text-xs data-[placeholder]:font-sans")}
        itemClassName="font-mono text-xs"
        aria-label={label ?? ariaLabel}
        value={value}
        options={options}
        placeholder={placeholder}
        onValueChange={onChange}
      />
    </FieldShell>
  );
}

/**
 * An API key, one state at a time: a field to paste one when none is
 * saved (with the provider's key page beside it); "Saved" with Replace and
 * Remove when one is; "Removed when you save" with Undo after Remove. The
 * form's fields stay as they were: `value` is a new key (blank keeps the
 * saved one), `clear` removes it.
 */
export function SecretField({
  configured,
  value,
  clear,
  getKeyUrl,
  ariaLabel = "API key",
  onValueChange,
  onClearChange
}: {
  configured: boolean;
  value: string;
  clear: boolean;
  /** The field's name for a screen reader; a page with two keys names each. */
  ariaLabel?: string;
  /** The provider's page for getting a key, offered while none is saved. */
  getKeyUrl?: string;
  onValueChange: (value: string) => void;
  onClearChange: (value: boolean) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  // A typed key that empties from outside (a save landed) leaves the saved
  // one in place: back to Saved. One the person deleted keeps the field open
  // for the next try.
  const previous = useRef(value);
  const deletedByHand = useRef(false);
  useEffect(() => {
    if (previous.current && !value && !deletedByHand.current) setReplacing(false);
    previous.current = value;
  }, [value]);

  if (configured && clear) {
    return (
      <div className="flex min-h-9 items-center gap-2 text-sm">
        <span className="text-chrome">Removed when you save</span>
        <span className="flex-1" />
        <Button variant="ghost" size="xs" onClick={() => onClearChange(false)}>Undo</Button>
      </div>
    );
  }
  if (configured && !replacing && !value) {
    return (
      <div className="flex min-h-9 items-center gap-2 text-sm">
        <KeyRound className="size-3.5 shrink-0 text-faint" aria-hidden />
        <span className="text-muted-foreground">Saved</span>
        <span className="flex-1" />
        <Button variant="ghost" size="xs" onClick={() => setReplacing(true)}>Replace</Button>
        <Button variant="ghost" size="xs" onClick={() => onClearChange(true)}>Remove</Button>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <input
        className={cn(CONTROL, "min-w-0 flex-1 font-mono text-xs")}
        type="password"
        value={value}
        aria-label={ariaLabel}
        placeholder={configured ? "Paste the new key" : "Paste key"}
        // Focused when Replace opened it, not when a page with a key typed
        // already shows it again.
        autoFocus={replacing}
        onChange={(event) => {
          deletedByHand.current = event.target.value === "";
          onValueChange(event.target.value);
        }}
      />
      {configured ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            onValueChange("");
            setReplacing(false);
          }}
        >
          Cancel
        </Button>
      ) : getKeyUrl ? (
        <ExternalLink href={getKeyUrl}>Get a key</ExternalLink>
      ) : null}
    </div>
  );
}

/** A link out of Mandate, quiet, with an arrow; the desktop app opens it in
 *  the system browser. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="hit relative inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      onClick={(event) => {
        if (openInSystemBrowser(href)) event.preventDefault();
      }}
    >
      {children}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  );
}
