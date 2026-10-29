import { useState } from "react";
import { Check } from "lucide-react";
import { InlineError } from "@/components/ViewState";
import { Switch } from "@/components/ui/switch";
import { FollowsDefault, RouteChain } from "./RouteChain";
import {
  agentChain,
  buildAgentRoutePatch,
  buildDefaultRoutePatch,
  buildWorkerRoutePatch,
  buildManagerRoutePatch,
  buildGlobalRoutePatch,
  buildDecisionsPatch,
  buildJudgementUseRoutePatch,
  decisionsRun,
  defaultChain,
  deriveAgentRoute,
  deriveDecisions,
  deriveDefaultRoute,
  deriveJudgementUseRoute,
  deriveWorkerRoute,
  deriveManagerRoute,
  deriveGlobalRoute,
  withAgentChain,
  withDefaultChain,
  type AgentRoute,
  type AgentRouteForm,
  type JudgementUse
} from "./routing-form";
import { useSaveUnit, useSettingsConfig, type SectionFooterState } from "./settings-config";
import { SettingsSection } from "./SettingsSection";
import type { SettingsConfigResponse, SettingsConfigUpdate } from "./types";

/** Model routing pane: the default route and the routes that can have their
 *  own, each drawn as the chain it is tried in; then Decisions, the models
 *  asked for quick judgements, and the uses that run on them. A route that
 *  is on saves each change to its steps as it is made; switching a route of
 *  its own on or off is a change the route's Save sends (with the steps of a
 *  route just switched on, which does not exist until then). Decisions'
 *  switch, and each use's On, save at once: the chains are kept either way. */
export function RoutingPane() {
  return (
    <div className="flex flex-col gap-4">
      <DefaultRouteBlock />
      <AgentRouteBlock
        route="global"
        title="Your agent"
        routeLabel="Your agent's route"
        description="Your agent, with its compaction."
        switchAriaLabel="Own route for Your agent"
        derive={deriveGlobalRoute}
        buildPatch={buildGlobalRoutePatch}
      />
      <AgentRouteBlock
        route="manager"
        title="Managers"
        routeLabel="the managers' route"
        description="Every thread's manager, with its compaction."
        switchAriaLabel="Own route for managers"
        derive={deriveManagerRoute}
        buildPatch={buildManagerRoutePatch}
      />
      <AgentRouteBlock
        route="worker"
        title="Workers"
        routeLabel="the workers' route"
        description="The agent inside each worker, with its compaction."
        switchAriaLabel="Own route for workers"
        derive={deriveWorkerRoute}
        buildPatch={buildWorkerRoutePatch}
      />
      <AgentRouteBlock
        route="subagent"
        title="Subagents"
        routeLabel="the subagents' route"
        description="The subagents an agent starts for a self-contained job, with their compaction."
        switchAriaLabel="Own route for subagents"
        unsetNote="Not set: uses the model of the agent that asks."
        derive={deriveSubagentRoute}
        buildPatch={buildSubagentRoutePatch}
      />
      <AgentRouteBlock
        route="page"
        title="Page updates"
        routeLabel="the page updates' route"
        description="The subagents that change Your agent's page."
        switchAriaLabel="Own route for page updates"
        unsetNote="Not set: runs as the subagents do."
        derive={derivePageRoute}
        buildPatch={buildPageRoutePatch}
      />
      <AgentRouteBlock
        route="dream"
        title="Dream"
        routeLabel="the dream's route"
        description="The background pass that reviews, merges and prunes memories, and writes the briefs agents read first."
        switchAriaLabel="Own route for the dream"
        derive={deriveDreamRoute}
        buildPatch={buildDreamRoutePatch}
      />
      <AgentRouteBlock
        route="extraction"
        title="Memory extraction"
        routeLabel="memory extraction's route"
        description="Picks what to remember from conversations as they leave context."
        switchAriaLabel="Own route for memory extraction"
        derive={deriveExtractionRoute}
        buildPatch={buildExtractionRoutePatch}
      />
      <DecisionsBlock />
      <AgentRouteBlock
        route="managerRequestCheck"
        title="Manager request check"
        routeLabel="manager request check's route"
        description="While a manager thread works on, tells Your agent when a request it sent there is done."
        switchAriaLabel="Own route for manager request check"
        unsetNote={(config) => (config.agent.managerRequestCheckEnabled && decisionsRun(config) ? "Not set: uses Decisions." : "Off: Your agent hears when the whole thread stops.")}
        decisions
        enabled={{ key: "managerRequestCheckEnabled", ariaLabel: "Manager request check on" }}
        derive={deriveManagerRequestCheckRoute}
        buildPatch={buildManagerRequestCheckRoutePatch}
      />
      <AgentRouteBlock
        route="managerStopCheck"
        title="Manager stop check"
        routeLabel="manager stop check's route"
        description="When a manager thread stops, sorts what its last reply leaves for you: a decision, a result to read, or nothing."
        switchAriaLabel="Own route for manager stop check"
        unsetNote={(config) => (config.agent.managerStopCheckEnabled && decisionsRun(config) ? "Not set: uses Decisions." : "Off: no thread turns blue.")}
        decisions
        enabled={{ key: "managerStopCheckEnabled", ariaLabel: "Manager stop check on" }}
        derive={deriveManagerStopCheckRoute}
        buildPatch={buildManagerStopCheckRoutePatch}
      />
      <AgentRouteBlock
        route="memoryRepeatCheck"
        title="Memory repeat check"
        routeLabel="memory repeat check's route"
        description="Before memory extraction stores a memory, reads the stored ones most like it, and leaves it out when one already says it."
        switchAriaLabel="Own route for memory repeat check"
        unsetNote={(config) => (config.agent.memoryRepeatCheckEnabled && decisionsRun(config) ? "Not set: uses Decisions." : "Off: memory extraction stores every memory it picks.")}
        decisions
        enabled={{ key: "memoryRepeatCheckEnabled", ariaLabel: "Memory repeat check on" }}
        derive={deriveMemoryRepeatCheckRoute}
        buildPatch={buildMemoryRepeatCheckRoutePatch}
      />
    </div>
  );
}

const deriveManagerRequestCheckRoute = (config: SettingsConfigResponse) => deriveJudgementUseRoute(config, "managerRequestCheck");
const buildManagerRequestCheckRoutePatch = (form: AgentRouteForm) => buildJudgementUseRoutePatch("managerRequestCheck", form);
const deriveManagerStopCheckRoute = (config: SettingsConfigResponse) => deriveJudgementUseRoute(config, "managerStopCheck");
const buildManagerStopCheckRoutePatch = (form: AgentRouteForm) => buildJudgementUseRoutePatch("managerStopCheck", form);
const deriveMemoryRepeatCheckRoute = (config: SettingsConfigResponse) => deriveJudgementUseRoute(config, "memoryRepeatCheck");
const buildMemoryRepeatCheckRoutePatch = (form: AgentRouteForm) => buildJudgementUseRoutePatch("memoryRepeatCheck", form);

/** A use's On: whether it runs at all, saved at once. */
type OnSwitchSetting = { key: `${JudgementUse}Enabled`; ariaLabel: string };
const onSwitchPatch = (key: OnSwitchSetting["key"], enabled: boolean): SettingsConfigUpdate => ({ agent: { [key]: enabled } });

const deriveDreamRoute = (config: SettingsConfigResponse) => deriveAgentRoute(config, "dream");
const buildDreamRoutePatch = (form: AgentRouteForm) => buildAgentRoutePatch("dream", form);
const deriveExtractionRoute = (config: SettingsConfigResponse) => deriveAgentRoute(config, "extraction");
const buildExtractionRoutePatch = (form: AgentRouteForm) => buildAgentRoutePatch("extraction", form);
const deriveSubagentRoute = (config: SettingsConfigResponse) => deriveAgentRoute(config, "subagent");
const buildSubagentRoutePatch = (form: AgentRouteForm) => buildAgentRoutePatch("subagent", form);
const derivePageRoute = (config: SettingsConfigResponse) => deriveAgentRoute(config, "page");
const buildPageRoutePatch = (form: AgentRouteForm) => buildAgentRoutePatch("page", form);

/** A change saved at once: "Saved" beside the route's title for a moment. */
function SavedMark({ footer }: { footer: SectionFooterState }) {
  return footer.justSaved ? (
    <span data-slot="route-saved" className="inline-flex items-center gap-1 text-2xs text-live">
      <Check className="size-3" aria-hidden />
      Saved
    </span>
  ) : null;
}

/** A change saved at once that failed: it stays on the page, with why and Retry. */
function SaveFailed({ footer, onRetry }: { footer: SectionFooterState; onRetry: () => void }) {
  return footer.error ? (
    <InlineError detail={footer.error.detail} onRetry={onRetry} className="pt-3">{footer.error.message}</InlineError>
  ) : null;
}

function DefaultRouteBlock() {
  const { config } = useSettingsConfig();
  const unit = useSaveUnit({ derive: deriveDefaultRoute, buildPatch: buildDefaultRoutePatch });
  const form = unit.form;
  if (!form || !config) return null;
  return (
    <div data-route="default">
      <SettingsSection
        title="Default route"
        description="Used wherever a route of its own isn't set."
        headerSlot={<SavedMark footer={unit.footer} />}
      >
        <RouteChain
          steps={defaultChain(form)}
          config={config}
          routeLabel="the default route"
          onChange={(steps) => unit.saveNow((prev) => withDefaultChain(prev, steps))}
          searchAnchors={{ model: "route-model", effort: "route-effort", fallbacks: "route-fallbacks" }}
        />
        <SaveFailed footer={unit.footer} onRetry={unit.footer.onSave} />
      </SettingsSection>
    </div>
  );
}

/** Decisions: the models Mandate asks for quick judgements, a chain of chat
 *  and decision models. Its switch saves at once and keeps the chain: the
 *  chain's last step cannot be removed, so the switch is how it is off. */
function DecisionsBlock() {
  const { config } = useSettingsConfig();
  const unit = useSaveUnit({ derive: deriveDecisions, buildPatch: buildDecisionsPatch });
  const form = unit.form;
  if (!form || !config) return null;
  return (
    <div data-route="decisions">
      <SettingsSection
        title="Decisions"
        description="The models Mandate asks for quick judgements. Each use below runs on them unless it has its own."
        headerSlot={
          <span className="flex items-center gap-3">
            <SavedMark footer={unit.footer} />
            <label className="flex items-center gap-2 text-2xs text-faint">
              On
              <Switch
                checked={form.enabled}
                aria-label="Decisions on"
                onCheckedChange={(enabled) => unit.saveNow((prev) => ({ ...prev, enabled }))}
              />
            </label>
          </span>
        }
      >
        <RouteChain
          steps={agentChain(form)}
          config={config}
          routeLabel="Decisions"
          decisions
          onChange={(steps) => unit.saveNow((prev) => withAgentChain(prev, steps))}
        />
        <SaveFailed footer={unit.footer} onRetry={unit.footer.onSave} />
      </SettingsSection>
    </div>
  );
}

function AgentRouteBlock({
  route,
  title,
  routeLabel,
  description,
  switchAriaLabel,
  unsetNote,
  decisions = false,
  enabled,
  derive,
  buildPatch
}: {
  route: AgentRoute;
  title: string;
  routeLabel: string;
  description: string;
  switchAriaLabel: string;
  /** What the route runs while it has none of its own, in words, for a route
   *  that does not then follow the default (the subagent route: the asking
   *  agent's; manager request check: Decisions, or nothing). Without it, the
   *  default's chain is shown. */
  unsetNote?: string | ((config: SettingsConfigResponse) => string);
  /** A use of Decisions: its menus list decision models too. */
  decisions?: boolean;
  /** A use that can be off whatever its route: an On switch in the header,
   *  saved at once, as Decisions' is. */
  enabled?: OnSwitchSetting;
  derive: (config: SettingsConfigResponse) => AgentRouteForm;
  buildPatch: (form: AgentRouteForm) => SettingsConfigUpdate;
}) {
  const { config } = useSettingsConfig();
  // Where the switch was moved to, until the route's Save sends it. Kept out
  // of the form: the steps' own saves, and their answers, never carry it.
  const [switchedTo, setSwitchedTo] = useState<boolean | null>(null);
  // While it waits, the route's steps are a draft: a change to the default
  // route (which a route not on follows) does not replace them.
  const unit = useSaveUnit({ derive, buildPatch, keep: switchedTo !== null });
  // The On switch's own save, apart from the route's: nothing else rides on it.
  const onUnit = useSaveUnit({
    derive: (c) => ({ enabled: enabled ? Boolean(c.agent[enabled.key]) : false }),
    buildPatch: (f) => (enabled ? onSwitchPatch(enabled.key, f.enabled) : {})
  });
  const form = unit.form;
  if (!form || !config) return null;
  const savedOn = Boolean(config.agent.modelOverrides?.[route]);
  // Moved back, or saved: nothing is waiting.
  if (switchedTo !== null && switchedTo === savedOn) setSwitchedTo(null);
  // As saved, unless the switch moved: never the form's own override, which
  // a Save that failed leaves as it tried.
  const on = switchedTo ?? savedOn;
  // The switch moved and not saved yet: the route's Save sends it, with the
  // steps of a route switched on (it does not exist until then).
  const switchPending = switchedTo !== null && switchedTo !== savedOn;
  // What a route without its own runs: the default as saved.
  const saved = deriveDefaultRoute(config);
  return (
    <div data-route={route}>
      <SettingsSection
        title={title}
        description={description}
        headerSlot={
          <span className="flex items-center gap-3">
            <SavedMark footer={{ ...unit.footer, justSaved: unit.footer.justSaved || onUnit.footer.justSaved }} />
            {enabled && onUnit.form ? (
              <label className="flex items-center gap-2 text-2xs text-faint">
                On
                <Switch
                  checked={onUnit.form.enabled}
                  aria-label={enabled.ariaLabel}
                  onCheckedChange={(next) => onUnit.saveNow((prev) => ({ ...prev, enabled: next }))}
                />
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-2xs text-faint">
              Own route
              <Switch
                checked={on}
                aria-label={switchAriaLabel}
                onCheckedChange={setSwitchedTo}
              />
            </label>
          </span>
        }
        footer={switchPending ? {
          ...unit.footer,
          dirty: true,
          onSave: () => unit.saveNow((prev) => ({ ...prev, override: switchedTo ?? prev.override }))
        } : undefined}
      >
        {on ? (
          <RouteChain
            steps={agentChain(form)}
            config={config}
            routeLabel={routeLabel}
            decisions={decisions}
            onChange={(steps) => (switchPending
              ? unit.setForm((prev) => withAgentChain(prev, steps))
              // Saved with the route as it is saved: on.
              : unit.saveNow((prev) => withAgentChain({ ...prev, override: savedOn }, steps)))}
          />
        ) : unsetNote ? (
          <p data-slot="route-unset" className="text-xs text-muted-foreground">{typeof unsetNote === "function" ? unsetNote(config) : unsetNote}</p>
        ) : (
          <FollowsDefault steps={defaultChain(saved)} />
        )}
        {switchPending ? null : <SaveFailed footer={unit.footer} onRetry={() => unit.saveNow((prev) => ({ ...prev, override: savedOn }))} />}
        {enabled ? <SaveFailed footer={onUnit.footer} onRetry={onUnit.footer.onSave} /> : null}
      </SettingsSection>
    </div>
  );
}

