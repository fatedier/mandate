import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/MarkdownView";
import { cn } from "@/lib/utils";
import type { WebSearchCheckResult } from "@shared/api/settings";
import { useSaveUnit, useSettingsConfig } from "./settings-config";
import { SecretField, SelectField, TextField } from "./settings-fields";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { StatusChip } from "./SettingsStatus";
import type { WebSearchFieldSettings } from "./types";
import { useWebSearchCheck } from "./useWebSearchCheck";
import {
  buildWebSearchPatch,
  checkWorksText,
  chosenKind,
  webSearchFormFromConfig,
  webSearchStatus,
  type WebSearchForm
} from "./web-search-settings-model";

/** Web search: which backend the agents search with, its own fields, and a
 *  check. The page draws whatever kinds the server lists: it knows none. */
export function WebSearchPane() {
  const { config, saving } = useSettingsConfig();
  const unit = useSaveUnit({ derive: webSearchFormFromConfig, buildPatch: buildWebSearchPatch });
  const check = useWebSearchCheck(config);
  const form = unit.form;
  if (!form || !config) return null;

  const section = config.webSearch;
  const kind = chosenKind(section, form.use);
  const status = webSearchStatus(config);
  const options = [{ value: "off", label: "Off" }, ...section.kinds.map((k) => ({ value: k.id, label: k.label }))];
  // Only what is saved is checked: not while a change waits for its save, nor
  // while a save is on its way (the form may read as saved against the old
  // setup while the server already has the new one) — asked of the store,
  // which a pane mounted again mid-save still shares.
  const canCheck = status.label === "Ready" && !unit.footer.dirty && !saving && !check.checking;

  const setValue = (key: string, value: string) =>
    unit.setForm((prev) => ({ ...prev, values: { ...prev.values, [kind!.id]: { ...prev.values[kind!.id], [key]: value } } }));
  const setSecret = (key: string, change: Partial<WebSearchForm["secrets"][string][string]>) =>
    unit.setForm((prev) => ({
      ...prev,
      secrets: { ...prev.secrets, [kind!.id]: { ...prev.secrets[kind!.id], [key]: { ...prev.secrets[kind!.id]![key]!, ...change } } }
    }));

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        title="Web search"
        description="Lets every agent search the web with the backend you choose."
        headerSlot={<StatusChip tone={status.tone} label={status.label} />}
        rows
        footer={unit.footer}
      >
        <SettingRow anchor="web-search-use" label="Search with" description={kind?.description ?? "Agents have no web search."}>
          <SelectField
            ariaLabel="Search with"
            value={kind ? kind.id : "off"}
            options={options}
            onChange={(use) => unit.setForm((prev) => ({ ...prev, use }))}
          />
        </SettingRow>
        {kind?.fields.map((field) => (
          <SettingRow key={field.key} anchor={`web-search-${kind.id}-${field.key}`} label={field.label} description={field.description}>
            <FieldControl
              field={field}
              value={form.values[kind.id]?.[field.key] ?? ""}
              secret={form.secrets[kind.id]?.[field.key] ?? { draft: "", remove: false }}
              onValue={(value) => setValue(field.key, value)}
              onSecret={(change) => setSecret(field.key, change)}
            />
          </SettingRow>
        ))}
        {kind ? (
          <SettingRow
            anchor="web-search-check"
            label="Check"
            description="Runs one real search."
            fit="auto"
            hint={check.result && !unit.footer.dirty ? <CheckDetail result={check.result} /> : null}
          >
            <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
              {check.result && !unit.footer.dirty ? (
                <span
                  data-slot="web-search-check-result"
                  className={cn("text-xs", check.result.result === "works" ? "text-live" : "text-destructive")}
                >
                  {check.result.result === "works"
                    ? checkWorksText(check.result.count, check.result.ms, Boolean(check.result.answer))
                    : `Search failed: ${check.result.message}`}
                </span>
              ) : null}
              <Button size="xs" variant="outline" disabled={!canCheck} onClick={check.run}>
                {check.checking ? "Checking…" : unit.footer.dirty ? "Save to check" : "Check search"}
              </Button>
            </div>
          </SettingRow>
        ) : null}
      </SettingsSection>
    </div>
  );
}

function FieldControl({ field, value, secret, onValue, onSecret }: {
  field: WebSearchFieldSettings;
  value: string;
  secret: { draft: string; remove: boolean };
  onValue: (value: string) => void;
  onSecret: (change: Partial<{ draft: string; remove: boolean }>) => void;
}) {
  switch (field.type) {
    case "secret":
      return (
        <SecretField
          configured={Boolean(field.configured)}
          value={secret.draft}
          clear={secret.remove}
          ariaLabel={field.label}
          onValueChange={(draft) => onSecret({ draft })}
          onClearChange={(remove) => onSecret({ remove })}
        />
      );
    case "url":
      return <TextField ariaLabel={field.label} value={value} mono placeholder={field.placeholder} onChange={onValue} />;
    case "model":
    case "provider":
    case "choice":
      return (
        <SelectField
          ariaLabel={field.label}
          value={value}
          options={value || field.type === "choice" ? field.options ?? [] : [{ value: "", label: field.label }, ...(field.options ?? [])]}
          onChange={onValue}
        />
      );
  }
}

/** Under the check's line, the user's look at the search: the answer and the
 *  first pages it found, or what a model wrote instead of searching. Never
 *  what an agent is given: that stays the search's own text. */
function CheckDetail({ result }: { result: WebSearchCheckResult }) {
  if (result.result === "failed") {
    return result.reply ? <p data-slot="web-search-check-reply" className="line-clamp-3 break-words text-muted-foreground">{`\u201c${result.reply}\u201d`}</p> : null;
  }
  if (!result.answer && result.top.length === 0) return null;
  return (
    <div data-slot="web-search-check-found" className="flex min-w-0 flex-col gap-1">
      {result.answer && (
        // The answer is Markdown from the web: its phrasing only, a link its words.
        <p data-slot="web-search-check-answer" className="line-clamp-3 break-words text-muted-foreground">
          <MarkdownView text={result.answer} inline />
        </p>
      )}
      {result.top.length > 0 && (
        // A dot of its own: a list marker is clipped with the line it truncates.
        <ul className="flex min-w-0 flex-col gap-0.5">
          {result.top.map((page) => (
            <li key={page.url} className="flex min-w-0 gap-1.5">
              <span aria-hidden>·</span>
              <span data-slot="web-search-check-page" className="min-w-0 truncate">
                {page.title ? `${page.title} \u2014 ${pageHost(page.url)}` : pageAddress(page.url)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A page's site, as its address names it. */
function pageHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return pageAddress(url);
  }
}

/** A page's address without its scheme. */
function pageAddress(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}
