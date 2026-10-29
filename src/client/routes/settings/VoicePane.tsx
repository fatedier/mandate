import { useState } from "react";
import { InlineError } from "@/components/ViewState";
import { loginCodex, logoutCodex as signOutCodex } from "./settings-api";
import { CodexAuthBox } from "./settings-codex-auth";
import { useSaveUnit, useSettingsConfig } from "./settings-config";
import { SecretField, SelectField, TextField } from "./settings-fields";
import { SettingRow, SettingSubGroup } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { StatusChip } from "./SettingsStatus";
import { DEFAULT_CODEX_REALTIME_MODEL } from "./types";
import {
  buildVoicePayload,
  formFromConfig as voiceFormFromConfig,
  nextVoiceProviderForm,
  voiceCodexAuth,
  voiceLanguageOptions,
  voiceProviderOptions,
  voiceProviderType,
  voiceStatus
} from "./voice-settings-model";
import { errorText } from "@shared/error-text";

const STATUS_CHIP = {
  ready: { tone: "ready", label: "Ready" },
  expired: { tone: "attention", label: "Sign-in expired" },
  unconfigured: { tone: "idle", label: "Not configured" }
} as const;

/** Voice pane: one save unit over the whole realtime + session form. */
export function VoicePane() {
  const { config, reload } = useSettingsConfig();
  const unit = useSaveUnit({
    derive: voiceFormFromConfig,
    buildPatch: buildVoicePayload
  });
  // Codex sign-in/sign-out is a side flow against the auth endpoints — its
  // notices/errors are local, never the save unit's.
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [authError, setAuthError] = useState<{ message: string; detail?: string } | null>(null);
  const form = unit.form;
  if (!form || !config) return null;

  const isCodex = voiceProviderType(config, form.provider) === "codex";
  const canCodexAuth = config.models.providers[form.provider.trim()]?.type === "codex";
  const status = STATUS_CHIP[voiceStatus(config, form)];

  const startCodexLogin = async () => {
    const providerName = form.provider.trim();
    if (!canCodexAuth) {
      setAuthError({ message: "Save an OpenAI Codex provider in Models before signing in here." });
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice("");
    try {
      await loginCodex(providerName, () => setAuthNotice("Browser sign-in opened."));
      await reload();
      setAuthNotice("Codex sign-in complete.");
    } catch (err) {
      setAuthNotice("");
      setAuthError({ message: "Couldn't sign in.", detail: errorText(err) });
    } finally {
      setAuthBusy(false);
    }
  };

  const logoutCodex = async () => {
    const providerName = form.provider.trim();
    setAuthBusy(true);
    setAuthError(null);
    setAuthNotice("");
    try {
      await signOutCodex(providerName);
      await reload();
      setAuthNotice("Codex sign-out complete.");
    } catch (err) {
      setAuthError({ message: "Couldn't sign out.", detail: errorText(err) });
    } finally {
      setAuthBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        title="Realtime voice"
        description="Which model answers when you talk to Mandate."
        headerSlot={<StatusChip tone={status.tone} label={status.label} />}
        rows
        footer={unit.footer}
      >
        <SettingRow anchor="voice-provider" label="Provider">
          <SelectField
            ariaLabel="Voice provider"
            value={form.provider}
            options={voiceProviderOptions(config, form.provider)}
            onChange={(provider) =>
              unit.setForm((prev) => nextVoiceProviderForm(config, prev, provider))
            }
          />
        </SettingRow>
        <SettingRow anchor="voice-model" label="Model">
          <TextField
            ariaLabel="Realtime model"
            value={form.model}
            mono
            placeholder={isCodex ? DEFAULT_CODEX_REALTIME_MODEL : "gpt-realtime-mini"}
            onChange={(model) => unit.setForm((prev) => ({ ...prev, model }))}
          />
        </SettingRow>
        <SettingRow anchor="voice-voice" label="Voice" description="The speaking voice to use.">
          <TextField
            ariaLabel="Voice"
            value={form.voice}
            mono
            onChange={(voice) => unit.setForm((prev) => ({ ...prev, voice }))}
          />
        </SettingRow>
        <SettingRow anchor="voice-language" label="Language">
          <SelectField
            ariaLabel="Voice language"
            value={form.language}
            options={voiceLanguageOptions(form.language)}
            onChange={(language) => unit.setForm((prev) => ({ ...prev, language }))}
          />
        </SettingRow>

        {isCodex ? (
          <SettingRow
            label="Account"
            description={authNotice || undefined}
            fit="auto"
            stacked
          >
            <CodexAuthBox
              auth={voiceCodexAuth(config, form.provider)}
              busy={authBusy}
              canAuth={canCodexAuth}
              saveFirstText="Save provider in Models first"
              onLogin={() => void startCodexLogin()}
              onLogout={() => void logoutCodex()}
            />
          </SettingRow>
        ) : (
          <>
            <SettingRow
              anchor="voice-base-url"
              label="Realtime base URL"
              description="Blank uses OpenAI. An Azure address switches to Azure's key and deployment."
            >
              <TextField
                ariaLabel="Realtime base URL"
                value={form.baseURL}
                placeholder="wss://api.openai.com/v1/realtime"
                mono
                onChange={(baseURL) => unit.setForm((prev) => ({ ...prev, baseURL }))}
              />
            </SettingRow>
            <SettingRow anchor="voice-deployment" label="Deployment" description="Azure only. Blank uses the model name.">
              <TextField
                ariaLabel="Deployment"
                value={form.deployment}
                onChange={(deployment) => unit.setForm((prev) => ({ ...prev, deployment }))}
              />
            </SettingRow>
            <SettingRow anchor="voice-api-key" label="API key">
              <SecretField
                configured={config.voice.apiKeyConfigured}
                value={form.apiKey}
                clear={form.clearApiKey}
                onValueChange={(apiKey) => unit.setForm((prev) => ({ ...prev, apiKey }))}
                onClearChange={(clearApiKey) => unit.setForm((prev) => ({ ...prev, clearApiKey }))}
              />
            </SettingRow>
          </>
        )}
        {authError ? (
          <InlineError detail={authError.detail} className="px-4 py-2">{authError.message}</InlineError>
        ) : null}

        {/* Session limits are three numbers that only make sense together, so
            they share one row rather than claiming three. */}
        <SettingSubGroup label="Session limits">
          <div className="grid gap-3 sm:grid-cols-3">
            <div id="setting-voice-idle" className="scroll-mt-4">
              <TextField
                label="Idle timeout"
                value={form.idleTimeoutMinutes}
                suffix="min"
                hint="Stops voice after this long without you speaking. 0 means no limit."
                onChange={(idleTimeoutMinutes) =>
                  unit.setForm((prev) => ({ ...prev, idleTimeoutMinutes }))
                }
              />
            </div>
            <div id="setting-voice-max" className="scroll-mt-4">
              <TextField
                label="Max length"
                value={form.maxSessionMinutes}
                suffix="min"
                hint="Stops voice after this long in total. 0 means no limit."
                onChange={(maxSessionMinutes) =>
                  unit.setForm((prev) => ({ ...prev, maxSessionMinutes }))
                }
              />
            </div>
            <div id="setting-voice-context" className="scroll-mt-4">
              <TextField
                label="Context messages"
                value={form.contextMessageCount}
                hint="Recent messages voice hears when it starts. 0 starts fresh."
                onChange={(contextMessageCount) =>
                  unit.setForm((prev) => ({ ...prev, contextMessageCount }))
                }
              />
            </div>
          </div>
        </SettingSubGroup>
      </SettingsSection>
    </div>
  );
}
