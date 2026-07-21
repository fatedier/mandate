import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  buildEmbeddingPatch,
  buildMemoryPayload,
  formFromConfig as memoryFormFromConfig
} from "./memory-settings-model";
import { modelRefOptions } from "./routing-form";
import { useSaveUnit, useSettingsConfig } from "./settings-config";
import { ModelRefField } from "./settings-fields";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import type { SettingsConfigResponse } from "./types";

function deriveEmbeddingForm(config: SettingsConfigResponse): { model: string } {
  return { model: config.memory.embedding.model };
}

/**
 * Memory settings: the embedding model and the dream maintenance switch.
 *
 * The run history that used to sit below these moved to the Memory page. It is
 * a record of what happened to the memories, not a setting — and as a
 * paginated log it was the bulk of a pane whose actual job is two fields.
 */
export function MemoryPane() {
  return (
    <div className="flex flex-col gap-4">
      <EmbeddingsBlock />
      <DreamMaintenanceBlock />
    </div>
  );
}

function EmbeddingsBlock() {
  const { config } = useSettingsConfig();
  const unit = useSaveUnit({
    derive: deriveEmbeddingForm,
    buildPatch: buildEmbeddingPatch
  });
  const form = unit.form;
  if (!form || !config) return null;
  return (
    <SettingsSection title="Embeddings" rows footer={unit.footer}>
      <SettingRow
        anchor="embedding-model"
        label="Embedding model"
        fit="wide"
        description="Turns memories into vectors so they can be recalled by meaning."
      >
        <ModelRefField
          ariaLabel="Embedding model"
          value={form.model}
          options={modelRefOptions(config, form.model)}
          onChange={(model) => unit.setForm((prev) => ({ ...prev, model }))}
        />
      </SettingRow>
    </SettingsSection>
  );
}

function DreamMaintenanceBlock() {
  const unit = useSaveUnit({ derive: memoryFormFromConfig, buildPatch: buildMemoryPayload });
  const form = unit.form;
  if (!form) return null;
  return (
    <SettingsSection
      title="Dream maintenance"
      description="Reviews, merges and prunes stored memories in the background."
      anchor="dream-enabled"
      rows
      headerSlot={
        <Switch
          checked={form.dreamEnabled}
          aria-label="Enable dream maintenance"
          onCheckedChange={(dreamEnabled) => unit.setForm((prev) => ({ ...prev, dreamEnabled }))}
        />
      }
      footer={unit.footer}
    >
      <SettingRow
        anchor="dream-run"
        label="Schedule"
        description="Runs after Mandate has been idle for 1 hour, at most once every 12 hours."
        fit="auto"
      >
        <Button variant="outline" size="sm" asChild>
          <Link to="/memory?view=runs">
            <span>View history</span>
            <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
      </SettingRow>
    </SettingsSection>
  );
}
