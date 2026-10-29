import type { ProviderType } from "@/routes/settings/types";

export type SetupStepId = "models" | "terminal" | "preferences" | "project";

export type QuickModelForm = {
  providerName: string;
  providerType: ProviderType;
  model: string;
  baseURL: string;
  organizationId: string;
  apiKey: string;
};

export type SaveTarget = "" | "models" | "codex" | "preferences";
