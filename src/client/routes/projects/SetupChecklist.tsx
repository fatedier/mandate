import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-paths";
import { cn } from "@/lib/utils";
import { loginCodex, readJson } from "@/routes/settings/settings-api";
import { 
  PROVIDER_DEFAULT_MODEL_IDS,
  type ProviderType,
  type SettingsConfigResponse,
  type SettingsConfigUpdate
 } from "@/routes/settings/types";
import type { SetupStatusResponse } from "@shared/api-contracts";
import { ModelsStep } from "./setup/ModelsStep";
import { PreferencesStep } from "./setup/PreferencesStep";
import { ProjectStep } from "./setup/ProjectStep";
import { 
  readSetupSessionActive,
  shouldResumePartialSetup,
  writeSetupSessionActive
 } from "./setup/session-storage";
import { StepIcon } from "./setup/shared";
import { TerminalStep } from "./setup/TerminalStep";
import { 
  blankQuickModelForm,
  buildQuickModelPayload,
  quickModelFormFromConfig,
  validateProviderName,
  validateQuickModelForm
 } from "./setup/quick-model";
import type { QuickModelForm, SaveTarget, SetupStepId } from "./setup/types";
import { RefreshButton } from "@/components/RefreshButton";

const STEPS: Array<{ id: SetupStepId; title: string; subtitle: string }> = [
  {
    id: "models",
    title: "Models",
    subtitle: "Choose the provider Mandate should use for chat and agents."
  },
  {
    id: "terminal",
    title: "Terminal",
    subtitle: "Mandate uses tmux windows and panes as the visible workspace for agent work."
  },
  {
    id: "preferences",
    title: "Agent preferences",
    subtitle:
      "Tell agents who should handle planning, implementation, review, and other delegated work."
  },
  {
    id: "project",
    title: "Project",
    subtitle:
      "Create the first project from a working directory, or adopt an existing tmux session."
  }
];

const STEP_DESCRIPTIONS: Record<SetupStepId, string> = {
  models:
    "Models power chat and agent coordination. This quick setup chooses one provider and assigns it to the default, manager, and worker roles.",
  terminal:
    "Mandate keeps agent work visible by running terminal tools inside tmux. If tmux is unavailable, projects can be listed but agents will not have a reliable visible workspace.",
  preferences:
    "Use this to describe delegation preferences in plain language, such as which coding assistant should design, implement, or review work. It is guidance for agents, not a strict policy engine.",
  project:
    "A project connects Mandate to a working directory and creates the tmux session/window used by its features. Start with one project; more can be added later."
};

export function SetupChecklist({
  hasProjects,
  onVisibleChange
}: {
  hasProjects: boolean;
  onVisibleChange?: (visible: boolean) => void;
}) {
  const [status, setStatus] = useState<SetupStatusResponse | null>(null);
  const [config, setConfig] = useState<SettingsConfigResponse | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [modelForm, setModelForm] = useState<QuickModelForm>(
    blankQuickModelForm("openai-compatible")
  );
  const [preferences, setPreferences] = useState("");
  const [firstRunSession, setFirstRunSession] = useState(readSetupSessionActive);
  const [authenticatedCodexProvider, setAuthenticatedCodexProvider] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<SaveTarget>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [setupRes, configRes] = await Promise.all([
        fetch(api.setupStatus),
        fetch(api.settingsConfig)
      ]);
      const [setupPayload, configPayload] = await Promise.all([
        readJson<SetupStatusResponse>(setupRes),
        readJson<SettingsConfigResponse>(configRes)
      ]);
      if (setupPayload.firstRun || shouldResumePartialSetup(setupPayload, setupPayload.projects.count > 0)) {
        setFirstRunSession(true);
        writeSetupSessionActive(true);
      }
      setStatus(setupPayload);
      setConfig(configPayload);
      setModelForm(quickModelFormFromConfig(configPayload));
      setPreferences(configPayload.agent.preferences);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const steps = useMemo(() => {
    return STEPS.map((step) => ({
      ...step,
      state: stepState(step.id, status, hasProjects)
    }));
  }, [hasProjects, status]);

  const activeStep = steps[stepIndex] ?? steps[0]!;
  const setupComplete = Boolean(
    status?.models.ready && status.terminal.ready && hasProjects && status.agent.preferencesReady
  );
  const setupVisible = Boolean(
    status ? (status.firstRun || firstRunSession) && !setupComplete : error
  );

  useEffect(() => {
    if (!setupComplete || !firstRunSession) return;
    const timer = window.setTimeout(() => {
      setFirstRunSession(false);
      writeSetupSessionActive(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [firstRunSession, setupComplete]);

  useEffect(() => {
    if (!status && !error) return;
    const timer = window.setTimeout(() => {
      onVisibleChange?.(setupVisible);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [error, onVisibleChange, setupVisible, status]);

  const saveModels = async (): Promise<boolean> => {
    if (!config) return false;
    const validationError = validateQuickModelForm(modelForm);
    if (validationError) {
      setError(validationError);
      return false;
    }

    setSaving("models");
    setError("");
    setNotice("");
    const providerName = modelForm.providerName.trim();
    try {
      const payload = buildQuickModelPayload(config, modelForm);
      const res = await fetch(api.settingsConfig, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const nextConfig = await readJson<SettingsConfigResponse>(res);
      setConfig(nextConfig);
      setModelForm(quickModelFormFromConfig(nextConfig, providerName));

      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving("");
    }
  };

  const signInCodex = async (): Promise<void> => {
    if (!config) return;
    const validationError = validateProviderName(modelForm.providerName);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving("codex");
    setError("");
    setNotice("");
    setFirstRunSession(true);
    writeSetupSessionActive(true);
    const providerName = modelForm.providerName.trim();
    const nextForm: QuickModelForm = {
      ...modelForm,
      providerName,
      providerType: "codex"
    };
    try {
      setModelForm(nextForm);
      await loginCodex(providerName, () => setNotice("Browser sign-in opened."));
      setNotice("Codex sign-in complete.");
      setAuthenticatedCodexProvider(providerName);
      await load();
      setModelForm(nextForm);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving("");
    }
  };

  const savePreferences = async (): Promise<boolean> => {
    setSaving("preferences");
    setError("");
    setNotice("");
    try {
      const payload: SettingsConfigUpdate = { agent: { preferences } };
      const res = await fetch(api.settingsConfig, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const nextConfig = await readJson<SettingsConfigResponse>(res);
      setConfig(nextConfig);
      setPreferences(nextConfig.agent.preferences);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving("");
    }
  };

  const updateProviderType = (providerType: ProviderType) => {
    setModelForm((current) => {
      return {
        ...current,
        providerType,
        model: PROVIDER_DEFAULT_MODEL_IDS[providerType],
        baseURL: "",
        organizationId: "",
        apiKey: ""
      };
    });
  };

  const goNext = async () => {
    if (stepIndex >= steps.length - 1 || saving) return;
    const currentStep = activeStep.id;
    let canContinue = true;
    if (currentStep === "models") {
      canContinue = await saveModels();
    } else if (currentStep === "preferences") {
      canContinue = await savePreferences();
    }
    if (!canContinue) return;
    setStepIndex((index) => Math.min(steps.length - 1, index + 1));
  };

  if (!setupVisible) return null;

  return (
    <section className="rounded-lg border border-border-soft bg-card">
      <div className="border-b border-border-soft p-4 md:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Set up Mandate</h2>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-muted-foreground">
              Mandate coordinates AI agents around visible tmux workspaces. Complete the basics
              once: connect a model provider, verify terminal access, set delegation preferences,
              then create a project. These settings can still be adjusted later.
            </p>
          </div>
          <RefreshButton scope="local" what="setup status" refreshing={loading} onRefresh={() => void load()} />
        </div>

        <div className="mt-5 grid gap-2 md:grid-cols-4">
          {steps.map((step, index) => (
            <button
              key={step.id}
              type="button"
              className={cn(
                "flex min-w-0 items-center gap-2.5 rounded-md border px-3 py-2.5 text-left text-sm transition-colors",
                index === stepIndex
                  ? "border-ring bg-accent/40 text-foreground"
                  : "border-border-soft bg-background/50 text-muted-foreground hover:border-border"
              )}
              onClick={() => setStepIndex(index)}
            >
              <StepIcon state={step.state} />
              <span className="truncate font-medium">{step.title}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="p-5">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-4 rounded-md border border-phase-done/35 bg-phase-done/10 px-3 py-2 text-sm text-phase-done">
            {notice}
          </div>
        )}

        {!status || !config ? (
          <div className="text-sm text-muted-foreground">Checking setup…</div>
        ) : (
          <>
            <div className="mb-4">
              <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {activeStep.title}
              </div>
              <h3 className="mt-2 max-w-4xl text-xl font-semibold leading-snug">
                {activeStep.subtitle}
              </h3>
              <p className="mt-2 max-w-4xl text-sm leading-6 text-muted-foreground">
                {STEP_DESCRIPTIONS[activeStep.id]}
              </p>
            </div>

            {activeStep.id === "models" && (
              <ModelsStep
                config={config}
                status={status}
                form={modelForm}
                setForm={setModelForm}
                updateProviderType={updateProviderType}
                saving={saving}
                authenticatedCodexProvider={authenticatedCodexProvider}
                onSaveAndSignIn={() => void signInCodex()}
              />
            )}
            {activeStep.id === "terminal" && (
              <TerminalStep status={status} loading={loading} onRefresh={() => void load()} />
            )}
            {activeStep.id === "preferences" && (
              <PreferencesStep value={preferences} onChange={setPreferences} />
            )}
            {activeStep.id === "project" && (
              <ProjectStep hasProjects={hasProjects} status={status} />
            )}

            <div className="mt-5 flex items-center justify-between border-t border-border-soft pt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={stepIndex === 0}
                onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button
                size="sm"
                disabled={stepIndex >= steps.length - 1 || Boolean(saving)}
                onClick={() => void goNext()}
              >
                {saving === "models" || saving === "preferences" ? "Saving…" : "Next"}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function stepState(
  step: SetupStepId,
  status: SetupStatusResponse | null,
  hasProjects: boolean
): "ready" | "action" | "warning" {
  if (!status) return "action";
  if (step === "models") return status.models.ready ? "ready" : "action";
  if (step === "terminal") return status.terminal.ready ? "ready" : "warning";
  if (step === "preferences") return status.agent.preferencesReady ? "ready" : "action";
  return hasProjects ? "ready" : "action";
}
