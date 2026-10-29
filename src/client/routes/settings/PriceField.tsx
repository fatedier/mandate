import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { CustomPriceSetting, ModelPriceSetting, PriceMatchDto, PricingStatusResponse, ProviderBilling } from "@shared/api/pricing";
import { parseModelPriceSetting } from "@shared/settings";
import { useSaveUnit } from "./settings-config";
import { SelectField } from "./settings-fields";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { BILLING_OPTIONS, matchLine, priceDataLine } from "./price-text";
import { searchPriceCatalog, usePriceMatch, usePricingStatus } from "./usePricing";

type Mode = "automatic" | "as" | "your";

const MODES: ReadonlyArray<{ value: Mode; label: string }> = [
  { value: "automatic", label: "Automatic" },
  { value: "as", label: "Price as…" },
  { value: "your", label: "Your price" }
];

const RATE_FIELDS: ReadonlyArray<{ key: keyof CustomPriceSetting; label: string }> = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite", label: "Cache write" },
  { key: "cacheWrite1h", label: "1-hour cache write" }
];

const OPTION_CLASS =
  "flex h-auto min-w-0 flex-col items-start gap-0.5 rounded-md border border-border-soft px-3 py-2 text-left hover:bg-sel data-[state=on]:border-status-review/70 data-[state=on]:bg-status-review/10";

function modeOf(value: ModelPriceSetting | undefined): Mode {
  if (!value) return "automatic";
  return "as" in value ? "as" : "your";
}

/** The rates as typed; empty optional ones are left out. */
function yourPriceOf(fields: Record<keyof CustomPriceSetting, string>): ModelPriceSetting | null {
  const draft: Record<string, number> = {};
  for (const { key } of RATE_FIELDS) {
    const text = fields[key].trim();
    if (!text) continue;
    draft[key] = Number(text);
  }
  const parsed = parseModelPriceSetting(draft);
  return parsed.ok ? parsed.value : null;
}

/**
 * A model's price: Automatic (the price lists, shown as found), Price as (a
 * price-list model, searched), or Your price (rates typed, USD per 1M tokens).
 * `onChange` gets the setting and whether it can be saved as it stands.
 */
export function PriceField({ providerName, modelId, value, disabled, onChange }: {
  providerName: string;
  modelId: string;
  value: ModelPriceSetting | undefined;
  disabled: boolean;
  onChange: (next: ModelPriceSetting | undefined, valid: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>(modeOf(value));
  const [fields, setFields] = useState<Record<keyof CustomPriceSetting, string>>(() => {
    const custom = value && !("as" in value) ? value : null;
    return {
      input: custom ? String(custom.input) : "",
      output: custom ? String(custom.output) : "",
      cacheRead: custom?.cacheRead !== undefined ? String(custom.cacheRead) : "",
      cacheWrite: custom?.cacheWrite !== undefined ? String(custom.cacheWrite) : "",
      cacheWrite1h: custom?.cacheWrite1h !== undefined ? String(custom.cacheWrite1h) : ""
    };
  });
  const [chosen, setChosen] = useState<{ ref: string; label: string } | null>(() =>
    value && "as" in value ? { ref: value.as, label: value.as.slice(value.as.indexOf(":") + 1) } : null
  );
  const match = usePriceMatch(providerName, modelId);

  const choose = (next: Mode) => {
    setMode(next);
    if (next === "automatic") onChange(undefined, true);
    else if (next === "as") onChange(chosen ? { as: chosen.ref } : undefined, chosen !== null);
    else {
      const price = yourPriceOf(fields);
      onChange(price ?? undefined, price !== null);
    }
  };
  const take = (picked: PriceMatchDto) => {
    setChosen({ ref: picked.ref, label: picked.label });
    setMode("as");
    onChange({ as: picked.ref }, true);
  };
  const type = (key: keyof CustomPriceSetting, text: string) => {
    const next = { ...fields, [key]: text };
    setFields(next);
    const price = yourPriceOf(next);
    onChange(price ?? undefined, price !== null);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground">Price</span>
      <ToggleGroup
        type="single"
        spacing={1.5}
        aria-label="Price"
        disabled={disabled}
        className="grid w-full grid-cols-3"
        value={mode}
        onValueChange={(next) => { if (next) choose(next as Mode); }}
      >
        {MODES.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value} className={OPTION_CLASS}>
            <span className="text-xs font-semibold text-foreground">{option.label}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {mode === "automatic" ? (
        <div data-price-automatic className="flex flex-col gap-1">
          {match?.found ? (
            <p className="text-xs leading-relaxed text-chrome">{matchLine(match.found)}</p>
          ) : match ? (
            <>
              <p className="text-xs leading-relaxed text-chrome">No price found.</p>
              {match.suggestion ? <Suggestion suggestion={match.suggestion} disabled={disabled} onTake={take} /> : null}
            </>
          ) : null}
        </div>
      ) : mode === "as" ? (
        <PriceAsSearch chosen={chosen} disabled={disabled} onPick={take} />
      ) : (
        <div data-price-your className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
            {RATE_FIELDS.map((field) => (
              <label key={field.key} className="flex min-w-0 flex-col gap-1 text-2xs text-chrome">
                {field.label}
                <input
                  aria-label={field.label}
                  inputMode="decimal"
                  disabled={disabled}
                  value={fields[field.key]}
                  onChange={(event) => type(field.key, event.target.value)}
                  className="num h-8 min-w-0 rounded-md border border-border-soft bg-transparent px-2 font-mono text-xs text-foreground"
                />
              </label>
            ))}
          </div>
          <p className="text-2xs text-faint">USD per 1M tokens</p>
          <p className="text-xs leading-relaxed text-chrome">Applies to every call of this model, past and future.</p>
        </div>
      )}
    </div>
  );
}

/** "Looks like …" and the one action that takes it. */
export function Suggestion({ suggestion, disabled, onTake }: {
  suggestion: PriceMatchDto;
  disabled: boolean;
  onTake: (suggestion: PriceMatchDto) => void;
}) {
  return (
    <div data-price-suggestion className="flex flex-wrap items-center gap-2 text-xs text-chrome">
      <span>Looks like {suggestion.label}.</span>
      <Button variant="outline" size="xs" disabled={disabled} onClick={() => onTake(suggestion)}>Use its price</Button>
    </div>
  );
}

function PriceAsSearch({ chosen, disabled, onPick }: {
  chosen: { ref: string; label: string } | null;
  disabled: boolean;
  onPick: (picked: PriceMatchDto) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PriceMatchDto[]>([]);
  useEffect(() => {
    const text = query.trim();
    if (!text) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchPriceCatalog(text, controller.signal)
        .then((found) => { if (!controller.signal.aborted) setResults(found); })
        .catch(() => { /* a search that failed shows what it had */ });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  const shown = query.trim() ? results : [];
  return (
    <div data-price-as className="flex flex-col gap-2">
      {chosen ? (
        <span className="flex items-center gap-1.5 text-xs text-foreground">
          <Check className="size-3.5" aria-hidden />
          {chosen.label}
        </span>
      ) : null}
      <input
        aria-label="Search price lists"
        disabled={disabled}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="h-8 min-w-0 rounded-md border border-border-soft bg-transparent px-2 text-xs text-foreground"
      />
      {shown.length ? (
        <div className="flex max-h-48 flex-col overflow-auto rounded-md border border-border-soft">
          {shown.map((result) => (
            <button
              key={result.ref}
              type="button"
              disabled={disabled}
              title={matchLine(result)}
              className={cn("truncate px-2.5 py-1.5 text-left text-xs hover:bg-sel pointer-coarse:min-h-11", chosen?.ref === result.ref && "bg-sel")}
              onClick={() => onPick(result)}
            >
              {result.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A connection's Billing, with the plan hint when its address looks like one. */
export function BillingRow({ billing, planSuggested, onChange }: {
  billing: ProviderBilling;
  planSuggested: boolean;
  onChange: (billing: ProviderBilling) => void;
}) {
  return (
    <SettingRow
      label="Billing"
      description="How this provider charges you. Calls on a plan show as Included; free calls are not counted as spend."
      hint={planSuggested && billing === "usage" ? (
        <span className="flex flex-wrap items-center gap-2">
          <span>This address looks like a plan.</span>
          <Button variant="outline" size="xs" onClick={() => onChange("plan")}>Set to Subscription or plan</Button>
        </span>
      ) : undefined}
    >
      <SelectField ariaLabel="Billing" value={billing} options={BILLING_OPTIONS} onChange={onChange} />
    </SettingRow>
  );
}

/** The Prices section as it shows: the switch and the data's date. */
export function PricesSectionView({ autoUpdate, status, onAutoUpdate }: {
  autoUpdate: boolean;
  status: PricingStatusResponse | null;
  onAutoUpdate: (on: boolean) => void;
}) {
  return (
    <SettingsSection title="Prices" rows anchor="prices">
      <SettingRow label="Update prices automatically" hint={status ? priceDataLine(status) : undefined} fit="auto">
        <Switch aria-label="Update prices automatically" checked={autoUpdate} onCheckedChange={onAutoUpdate} />
      </SettingRow>
    </SettingsSection>
  );
}

/** The Prices section, saved at once like any switch. */
export function PricesSection() {
  const unit = useSaveUnit({
    derive: (config) => ({ autoUpdate: config.models.prices.autoUpdate }),
    buildPatch: (form) => ({ models: { prices: { autoUpdate: form.autoUpdate } } })
  });
  const status = usePricingStatus();
  if (!unit.form) return null;
  return <PricesSectionView autoUpdate={unit.form.autoUpdate} status={status} onAutoUpdate={(on) => unit.saveNow(() => ({ autoUpdate: on }))} />;
}
