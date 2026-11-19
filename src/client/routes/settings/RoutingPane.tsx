import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { InlineError } from "@/components/ViewState";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { FollowsDefault, RouteChain, RouteSummary } from "./RouteChain";
import {
  agentChain,
  buildAgentRoutePatch,
  buildDefaultRoutePatch,
  buildWorkerRoutePatch,
  buildManagerRoutePatch,
  buildPersonalRoutePatch,
  buildDecisionsPatch,
  buildJudgementUseRoutePatch,
  decisionsChatRun,
  decisionsRun,
  defaultChain,
  isDecisionModelRef,
  deriveAgentRoute,
  deriveDecisions,
  deriveDefaultRoute,
  deriveJudgementUseRoute,
  deriveWorkerRoute,
  deriveManagerRoute,
  derivePersonalRoute,
  withAgentChain,
  withDefaultChain,
  type AgentRoute,
  type AgentRouteForm,
  type JudgementUse
} from "./routing-form";
import { useSaveUnit, useSettingsConfig, type SectionFooterState } from "./settings-config";
import { SettingsSection } from "./SettingsSection";
import type { SettingsConfigResponse, SettingsConfigUpdate } from "@shared/settings";

/** Model routing pane: the routes in two groups by what a route without
 *  its own falls back to: the default route and the agents and background
 *  work that run on it, then Decisions, the models asked for quick
 *  judgements, and the uses that run on them. Each route is a row that says
 *  what it runs now and opens in place to its chain, one at a time. A route
 *  that is on saves each change to its steps as it is made; switching a
 *  route of its own on or off is a change the route's Save sends (with the
 *  steps of a route just switched on, which does not exist until then).
 *  Decisions' switch, and each use's On, save at once: the chains are kept
 *  either way. */
export function RoutingPane() {
  const { config } = useSettingsConfig();
  // Which route is open. Settled once the config is read: a fresh install's
  // default route, which has no model yet, opens; nothing else does.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  if (config && chosen === undefined) setChosen(deriveDefaultRoute(config).model ? null : "default");
  const row = (route: string) => ({
    open: chosen === route,
    onToggle: () => setChosen((prev) => (prev === route ? null : route)),
    onChoose: () => setChosen(route)
  });
  return (
    <div className="flex flex-col gap-6">
      <LaneGroup title="Agents and background work" hint="Each runs on the default route unless it has its own.">
        <DefaultRouteBlock {...row("default")} />
        <AgentRouteBlock
          {...row("personal")}
          route="personal"
          title="Personal agent"
          routeLabel="Personal agent's route"
          description="The personal agent, with its compaction."
          switchAriaLabel="Own route for the personal agent"
          derive={derivePersonalRoute}
          buildPatch={buildPersonalRoutePatch}
        />
        <AgentRouteBlock
          {...row("manager")}
          route="manager"
          title="Managers"
          routeLabel="the managers' route"
          description="Every thread's manager, with its compaction."
          switchAriaLabel="Own route for managers"
          derive={deriveManagerRoute}
          buildPatch={buildManagerRoutePatch}
        />
        <AgentRouteBlock
          {...row("worker")}
          route="worker"
          title="Workers"
          routeLabel="the workers' route"
          description="The agent inside each worker, with its compaction."
          switchAriaLabel="Own route for workers"
          derive={deriveWorkerRoute}
          buildPatch={buildWorkerRoutePatch}
        />
        <AgentRouteBlock
          {...row("subagent")}
          route="subagent"
          title="Subagents"
          routeLabel="the subagents' route"
          description="The subagents an agent starts for a self-contained job, with their compaction."
          switchAriaLabel="Own route for subagents"
          unsetNote="Not set: uses the model of the agent that asks."
          unsetSummary="The asking agent's model"
          derive={deriveSubagentRoute}
          buildPatch={buildSubagentRoutePatch}
        />
        <AgentRouteBlock
          {...row("page")}
          route="page"
          title="Page updates"
          routeLabel="the page updates' route"
          description="The subagents that change the personal agent's page."
          switchAriaLabel="Own route for page updates"
          unsetNote="Not set: runs as the subagents do."
          unsetSummary="As subagents"
          derive={derivePageRoute}
          buildPatch={buildPageRoutePatch}
        />
        <AgentRouteBlock
          {...row("dream")}
          route="dream"
          title="Dream"
          routeLabel="the dream's route"
          description="The background pass that reviews, merges and prunes memories, and writes the briefs agents read first."
          switchAriaLabel="Own route for the dream"
          derive={deriveDreamRoute}
          buildPatch={buildDreamRoutePatch}
        />
        <AgentRouteBlock
          {...row("skillReview")}
          route="skillReview"
          title="Skill review"
          routeLabel="the skill review's route"
          description="Reviews finished work when an agent asks, and writes skills."
          switchAriaLabel="Own route for skill reviews"
          unsetNote="Not set: uses the Dream's model."
          unsetSummary="The Dream's model"
          derive={deriveSkillReviewRoute}
          buildPatch={buildSkillReviewRoutePatch}
        />
        <AgentRouteBlock
          {...row("extraction")}
          route="extraction"
          title="Memory extraction"
          routeLabel="memory extraction's route"
          description="Picks what to remember from conversations as they leave context."
          switchAriaLabel="Own route for memory extraction"
          derive={deriveExtractionRoute}
          buildPatch={buildExtractionRoutePatch}
        />
      </LaneGroup>
      <LaneGroup title="Quick judgements" hint="Each runs on Decisions unless it has its own.">
        <DecisionsBlock {...row("decisions")} />
        <AgentRouteBlock
          {...row("managerRequestCheck")}
          route="managerRequestCheck"
          title="Manager request check"
          routeLabel="manager request check's route"
          description="While a manager thread works on, tells the personal agent when a request it sent there is done."
          switchAriaLabel="Own route for manager request check"
          unsetNote={(config) => (config.agent.managerRequestCheckEnabled && decisionsRun(config) ? "Not set: uses Decisions." : "Off: the personal agent hears when the whole thread stops.")}
          unsetSummary={usesDecisions}
          decisions
          enabled={{ key: "managerRequestCheckEnabled", ariaLabel: "Manager request check on" }}
          derive={deriveManagerRequestCheckRoute}
          buildPatch={buildManagerRequestCheckRoutePatch}
        />
        <AgentRouteBlock
          {...row("managerStopCheck")}
          route="managerStopCheck"
          title="Manager stop check"
          routeLabel="manager stop check's route"
          description="When a manager thread stops, sorts what its last reply leaves for you: a decision, a result to read, or nothing."
          switchAriaLabel="Own route for manager stop check"
          unsetNote={(config) => (config.agent.managerStopCheckEnabled && decisionsRun(config) ? "Not set: uses Decisions." : "Off: no thread turns blue.")}
          unsetSummary={usesDecisions}
          decisions
          enabled={{ key: "managerStopCheckEnabled", ariaLabel: "Manager stop check on" }}
          derive={deriveManagerStopCheckRoute}
          buildPatch={buildManagerStopCheckRoutePatch}
        />
        <AgentRouteBlock
          {...row("memoryRepeatCheck")}
          route="memoryRepeatCheck"
          title="Memory repeat check"
          routeLabel="memory repeat check's route"
          description="Before memory extraction stores a memory, reads the stored ones most like it, and leaves it out when one already says it."
          switchAriaLabel="Own route for memory repeat check"
          unsetNote={(config) => (config.agent.memoryRepeatCheckEnabled && decisionsRun(config) ? "Not set: uses Decisions." : "Off: memory extraction stores every memory it picks.")}
          unsetSummary={usesDecisions}
          decisions
          enabled={{ key: "memoryRepeatCheckEnabled", ariaLabel: "Memory repeat check on" }}
          derive={deriveMemoryRepeatCheckRoute}
          buildPatch={buildMemoryRepeatCheckRoutePatch}
        />
        <AgentRouteBlock
          {...row("toolReviewScreen")}
          route="toolReviewScreen"
          title="Tool-call review: screen"
          routeLabel="the tool-call review screen's route"
          description="Picks the commands that need a second look. A fast decision model suits it."
          switchAriaLabel="Own route for the tool-call review screen"
          unsetNote={(config) => (decisionsRun(config) ? "Not set: uses Decisions." : "Off: every reviewed command gets a second look.")}
          unsetSummary={usesDecisions}
          decisions
          derive={deriveToolReviewScreenRoute}
          buildPatch={buildToolReviewScreenRoutePatch}
        />
        <AgentRouteBlock
          {...row("toolReviewSecondLook")}
          route="toolReviewSecondLook"
          title="Tool-call review: second look"
          routeLabel="the tool-call review second look's route"
          description="Decides whether a flagged command is held back, and writes the reason the agent reads."
          switchAriaLabel="Own route for the tool-call review second look"
          unsetNote={(config) => (decisionsChatRun(config) ? "Not set: uses the chat models in Decisions." : "Off: the tool-call review needs a chat model here or in Decisions.")}
          unsetSummary={(config) => (decisionsChatRun(config) ? "Decisions' chat models" : OFF)}
          derive={deriveToolReviewSecondLookRoute}
          buildPatch={buildToolReviewSecondLookRoutePatch}
        />
      </LaneGroup>
    </div>
  );
}

/** What a row says when its route runs nothing. */
const OFF = "Off";
/** A use of Decisions without a route of its own: Decisions, while they run. */
const usesDecisions = (config: SettingsConfigResponse) => (decisionsRun(config) ? "Decisions" : OFF);

/** Routes that fall back to the same one, under a heading saying which. */
function LaneGroup({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section data-slot="lane-group" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <span data-slot="lane-group-hint" className="text-xs text-muted-foreground">{hint}</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

/** An open route's first line: what it is for, and its switches beside it. */
function LaneHead({ description, children }: { description: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <p data-slot="lane-description" className="min-w-0 flex-1 basis-60 text-xs text-muted-foreground">{description}</p>
      {children ? <span className="flex shrink-0 items-center gap-3">{children}</span> : null}
    </div>
  );
}

/** A row's words for what its route runs, when that is not a chain. */
function SummaryText({ text }: { text: string }) {
  return <span className={cn("text-xs", text === OFF ? "text-faint" : "text-muted-foreground")}>{text}</span>;
}

/** A row's open and toggle, from the pane; `onChoose` makes it the open one. */
type RowProps = { open: boolean; onToggle: () => void; onChoose: () => void };

/** A row's open and toggle, with a failed save holding it open: while only
 *  the error holds it, its toggle does nothing (it cannot close, and the row
 *  that is open stays so), and a Retry makes it the open row, so a save that
 *  takes does not shut it at once. */
function heldOpen(row: RowProps, failed: boolean): { open: boolean; onToggle: () => void } {
  return { open: row.open || failed, onToggle: failed && !row.open ? () => {} : row.onToggle };
}
const retrying = (row: RowProps, retry: () => void) => () => {
  row.onChoose();
  retry();
};

const deriveManagerRequestCheckRoute = (config: SettingsConfigResponse) => deriveJudgementUseRoute(config, "managerRequestCheck");
const buildManagerRequestCheckRoutePatch = (form: AgentRouteForm) => buildJudgementUseRoutePatch("managerRequestCheck", form);
const deriveManagerStopCheckRoute = (config: SettingsConfigResponse) => deriveJudgementUseRoute(config, "managerStopCheck");
const buildManagerStopCheckRoutePatch = (form: AgentRouteForm) => buildJudgementUseRoutePatch("managerStopCheck", form);
const deriveMemoryRepeatCheckRoute = (config: SettingsConfigResponse) => deriveJudgementUseRoute(config, "memoryRepeatCheck");
const buildMemoryRepeatCheckRoutePatch = (form: AgentRouteForm) => buildJudgementUseRoutePatch("memoryRepeatCheck", form);
const deriveToolReviewScreenRoute = (config: SettingsConfigResponse) => deriveJudgementUseRoute(config, "toolReviewScreen");
const buildToolReviewScreenRoutePatch = (form: AgentRouteForm) => buildJudgementUseRoutePatch("toolReviewScreen", form);
/** The second look writes the reason a held call carries: it runs on chat
 *  models only, so its chain shows those (while unset, Decisions' chat
 *  models; a decision model saved in its route never runs). */
const deriveToolReviewSecondLookRoute = (config: SettingsConfigResponse): AgentRouteForm => {
  const form = deriveJudgementUseRoute(config, "toolReviewSecondLook");
  const [first, ...rest] = [form.selection, ...form.fallbacks].filter((step) => step.model && !isDecisionModelRef(config, step.model));
  return { override: form.override, selection: first ?? { model: "", reasoningEffort: form.selection.reasoningEffort }, fallbacks: rest };
};
const buildToolReviewSecondLookRoutePatch = (form: AgentRouteForm) => buildJudgementUseRoutePatch("toolReviewSecondLook", form);

/** A use's On: whether it runs at all, saved at once. */
type OnSwitchSetting = { key: `${Exclude<JudgementUse, "toolReviewScreen" | "toolReviewSecondLook">}Enabled`; ariaLabel: string };
const onSwitchPatch = (key: OnSwitchSetting["key"], enabled: boolean): SettingsConfigUpdate => ({ agent: { [key]: enabled } });

const deriveDreamRoute = (config: SettingsConfigResponse) => deriveAgentRoute(config, "dream");
const buildDreamRoutePatch = (form: AgentRouteForm) => buildAgentRoutePatch("dream", form);
const deriveExtractionRoute = (config: SettingsConfigResponse) => deriveAgentRoute(config, "extraction");
const buildExtractionRoutePatch = (form: AgentRouteForm) => buildAgentRoutePatch("extraction", form);
const deriveSubagentRoute = (config: SettingsConfigResponse) => deriveAgentRoute(config, "subagent");
const buildSubagentRoutePatch = (form: AgentRouteForm) => buildAgentRoutePatch("subagent", form);
const derivePageRoute = (config: SettingsConfigResponse) => deriveAgentRoute(config, "page");
const buildPageRoutePatch = (form: AgentRouteForm) => buildAgentRoutePatch("page", form);
const deriveSkillReviewRoute = (config: SettingsConfigResponse) => deriveAgentRoute(config, "skillReview");
const buildSkillReviewRoutePatch = (form: AgentRouteForm) => buildAgentRoutePatch("skillReview", form);

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

function DefaultRouteBlock(row: RowProps) {
  const { config } = useSettingsConfig();
  const unit = useSaveUnit({ derive: deriveDefaultRoute, buildPatch: buildDefaultRoutePatch });
  const form = unit.form;
  if (!form || !config) return null;
  return (
    <div data-route="default">
      <SettingsSection
        title="Default route"
        anchor="route-default"
        // A change that failed to save stays in view, with its Retry.
        collapse={heldOpen(row, Boolean(unit.footer.error))}
        summary={<RouteSummary steps={defaultChain(form)} config={config} />}
        headerSlot={<SavedMark footer={unit.footer} />}
      >
        <LaneHead description="Used wherever a route of its own isn't set." />
        <RouteChain
          steps={defaultChain(form)}
          config={config}
          routeLabel="the default route"
          onChange={(steps) => unit.saveNow((prev) => withDefaultChain(prev, steps))}
        />
        <SaveFailed footer={unit.footer} onRetry={retrying(row, unit.footer.onSave)} />
      </SettingsSection>
    </div>
  );
}

/** Decisions: the models Mandate asks for quick judgements, a chain of chat
 *  and decision models. Its switch saves at once and keeps the chain: the
 *  chain's last step cannot be removed, so the switch is how it is off. */
function DecisionsBlock(row: RowProps) {
  const { config } = useSettingsConfig();
  const unit = useSaveUnit({ derive: deriveDecisions, buildPatch: buildDecisionsPatch });
  const form = unit.form;
  if (!form || !config) return null;
  return (
    <div data-route="decisions">
      <SettingsSection
        title="Decisions"
        anchor="route-decisions"
        collapse={heldOpen(row, Boolean(unit.footer.error))}
        summary={form.enabled ? <RouteSummary steps={agentChain(form)} config={config} /> : <SummaryText text={OFF} />}
        headerSlot={<SavedMark footer={unit.footer} />}
      >
        <LaneHead description="The models Mandate asks for quick judgements. Each use below runs on them unless it has its own.">
          <label className="flex items-center gap-2 text-2xs text-faint">
            On
            <Switch
              checked={form.enabled}
              aria-label="Decisions on"
              onCheckedChange={(enabled) => unit.saveNow((prev) => ({ ...prev, enabled }))}
            />
          </label>
        </LaneHead>
        <RouteChain
          steps={agentChain(form)}
          config={config}
          routeLabel="Decisions"
          decisions
          onChange={(steps) => unit.saveNow((prev) => withAgentChain(prev, steps))}
        />
        <SaveFailed footer={unit.footer} onRetry={retrying(row, unit.footer.onSave)} />
      </SettingsSection>
    </div>
  );
}

function AgentRouteBlock({
  open: rowOpen,
  onToggle,
  onChoose,
  route,
  title,
  routeLabel,
  description,
  switchAriaLabel,
  unsetNote,
  unsetSummary = "Default route",
  decisions = false,
  enabled,
  derive,
  buildPatch
}: RowProps & {
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
  /** What the route's row says it runs while it has none of its own. */
  unsetSummary?: string | ((config: SettingsConfigResponse) => string);
  /** A use of Decisions: its menus list decision models too. */
  decisions?: boolean;
  /** A use that can be off whatever its route: an On switch in the header,
   *  saved at once, as Decisions' is. */
  enabled?: OnSwitchSetting;
  derive: (config: SettingsConfigResponse) => AgentRouteForm;
  buildPatch: (form: AgentRouteForm) => SettingsConfigUpdate;
}) {
  const { config } = useSettingsConfig();
  const row: RowProps = { open: rowOpen, onToggle, onChoose };
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
  // What the row says it runs: nothing while a use is off, else its own
  // chain, else what it falls back to.
  const summary = enabled && onUnit.form && !onUnit.form.enabled
    ? <SummaryText text={OFF} />
    : on
      ? <RouteSummary steps={agentChain(form)} config={config} />
      : <SummaryText text={typeof unsetSummary === "function" ? unsetSummary(config) : unsetSummary} />;
  return (
    <div data-route={route}>
      <SettingsSection
        title={title}
        anchor={`route-${route}`}
        // A change that failed to save stays in view, with its Retry.
        collapse={heldOpen(row, Boolean(unit.footer.error || onUnit.footer.error))}
        summary={summary}
        headerSlot={<SavedMark footer={{ ...unit.footer, justSaved: unit.footer.justSaved || onUnit.footer.justSaved }} />}
        footer={switchPending ? {
          ...unit.footer,
          dirty: true,
          onSave: () => unit.saveNow((prev) => ({ ...prev, override: switchedTo ?? prev.override }))
        } : undefined}
      >
        <LaneHead description={description}>
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
        </LaneHead>
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
        {switchPending ? null : <SaveFailed footer={unit.footer} onRetry={retrying(row, () => unit.saveNow((prev) => ({ ...prev, override: savedOn })))} />}
        {enabled ? <SaveFailed footer={onUnit.footer} onRetry={retrying(row, onUnit.footer.onSave)} /> : null}
      </SettingsSection>
    </div>
  );
}

