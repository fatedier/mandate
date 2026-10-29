import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/select";
import {
  PROVIDER_TYPE_OPTIONS,
  type ProviderType,
  type SettingsConfigResponse
} from "@/routes/settings/types";
import type { SetupStatusResponse } from "@shared/api-contracts";
import { StatusLine, TextInput } from "./shared";
import { defaultProviderName } from "./quick-model";
import type { QuickModelForm, SaveTarget } from "./types";

export function ModelsStep({
  config,
  status,
  form,
  setForm,
  updateProviderType,
  saving,
  authenticatedCodexProvider,
  onSaveAndSignIn
}: {
  config: SettingsConfigResponse;
  status: SetupStatusResponse;
  form: QuickModelForm;
  setForm: (updater: QuickModelForm | ((current: QuickModelForm) => QuickModelForm)) => void;
  updateProviderType: (providerType: ProviderType) => void;
  saving: SaveTarget;
  authenticatedCodexProvider: string;
  onSaveAndSignIn: () => void;
}) {
  const providerName = form.providerName.trim();
  const provider = config.models.providers[providerName];
  const codexAuthStatus = provider?.type === "codex" ? provider.auth?.status : undefined;
  const signedInThisSession = Boolean(providerName) && authenticatedCodexProvider === providerName;
  const needsCodexSignIn =
    form.providerType === "codex" && codexAuthStatus !== "authenticated" && !signedInThisSession;
  const providerNamePlaceholder = defaultProviderName(form.providerType);
  const providerNameDescription =
    form.providerType === "codex"
      ? "Use codex unless you need multiple Codex sign-ins. Model IDs will look like codex/gpt-5.6-sol."
      : "A short local alias for this provider. It becomes the prefix in model IDs, for example proxy/gpt-5.5.";
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.65fr)]">
      <div className="grid gap-4 rounded-lg border border-border-soft bg-background/45 p-4">
        <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Provider type</span>
            <SimpleSelect
              value={form.providerType}
              options={PROVIDER_TYPE_OPTIONS}
              onValueChange={(value) => updateProviderType(value as ProviderType)}
              aria-label="Provider type"
              className="h-10 text-sm"
            />
          </label>
          <TextInput
            label="Provider name"
            value={form.providerName}
            onChange={(value) => setForm((current) => ({ ...current, providerName: value }))}
            placeholder={providerNamePlaceholder}
            description={providerNameDescription}
          />
          <TextInput
            label="Default model"
            value={form.model}
            onChange={(value) => setForm((current) => ({ ...current, model: value }))}
            mono
          />
        </div>

        {form.providerType !== "codex" && (
          <div className="grid gap-x-4 gap-y-4 md:grid-cols-2">
            <TextInput
              label="Base URL"
              value={form.baseURL}
              onChange={(value) => setForm((current) => ({ ...current, baseURL: value }))}
              mono
            />
            <TextInput
              label="API key"
              value={form.apiKey}
              onChange={(value) => setForm((current) => ({ ...current, apiKey: value }))}
              type="password"
            />
            {form.providerType === "kilo" && (
              <TextInput
                label="Organization ID"
                value={form.organizationId}
                onChange={(value) => setForm((current) => ({ ...current, organizationId: value }))}
                mono
              />
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Next saves this step.</p>
          {form.providerType === "codex" && (
            <Button
              size="sm"
              variant={needsCodexSignIn ? "default" : "outline"}
              onClick={onSaveAndSignIn}
              disabled={Boolean(saving)}
            >
              {saving === "codex" ? "Signing in…" : needsCodexSignIn ? "Sign in" : "Sign in again"}
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border-soft bg-background/45 p-4">
        <div className="text-sm font-medium">Current status</div>
        <div className="mt-4 grid gap-2.5">
          <StatusLine
            ready={status.models.defaultModelReady}
            label="Default model"
            detail={status.models.defaultModel || "Not set"}
          />
          <StatusLine
            ready={status.models.managerModelReady}
            label="Manager"
            detail={config.agent.managerModel.model || "Not set"}
          />
          <StatusLine
            ready={status.models.workerModelReady}
            label="Worker"
            detail={config.agent.workerModel.model || "Not set"}
          />
        </div>
      </div>
    </div>
  );
}
