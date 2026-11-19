import { Link, useSearchParams } from "react-router";
import type { ActivityLedgerDto } from "@shared/api-contracts";
import { Section, SectionLink } from "@/components/Section";
import { formatCount } from "../activity-model";
import { AGENT_HEADS, LEDGER_COPY, roleLabel } from "../ledger-copy";
import { formatUsd, ledgerMoneyLabel } from "../money";
import { logsQuery } from "../useActivityFilters";

const HEAD = "label-micro py-2 font-normal text-chrome";
const ROW = "border-t border-border-soft py-2.5";

/** Who spent the window's money: one row per role, its cache-expired part in
 *  amber on its share bar. Without spend, shares are by calls. */
export function AgentsSection({ ledger, estimated, day = null }: { ledger: ActivityLedgerDto; estimated: boolean; day?: string | null }) {
  const [searchParams] = useSearchParams();
  // The day these rows count, when one is picked: the log opens on it.
  const onDay: Record<string, string> = day ? { day } : {};
  if (ledger.agents.length === 0) return null;

  const bySpend = ledger.agents.some((a) => a.spendMicros > 0);
  const peak = Math.max(1, ...ledger.agents.map((a) => (bySpend ? a.spendMicros : a.calls)));

  return (
    <Section
      title={LEDGER_COPY.byAgent}
      meta={LEDGER_COPY.byAgentMeta}
      trailing={<SectionLink to={`/activity?${logsQuery(searchParams, onDay)}`}>{LEDGER_COPY.openLogs}</SectionLink>}
    >
      <div className="@container">
        <div className="grid grid-cols-[minmax(0,1.3fr)_4rem_4.5rem_minmax(4rem,1fr)_5.5rem] items-center gap-x-3.5 px-3.5 text-xs @max-[40rem]:grid-cols-[minmax(0,1fr)_4.5rem_minmax(3.5rem,0.8fr)_4.5rem] @max-[28rem]:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem]">
          <span className={HEAD}>{AGENT_HEADS.agent}</span>
          <span className={`${HEAD} text-right @max-[40rem]:hidden`}>{AGENT_HEADS.calls}</span>
          <span className={`${HEAD} text-right`}>{AGENT_HEADS.spend}</span>
          <span className={`${HEAD} @max-[28rem]:hidden`}>{AGENT_HEADS.share}</span>
          <span className={`${HEAD} text-right`}>{AGENT_HEADS.expired}</span>
          {ledger.agents.map((agent) => {
            const value = bySpend ? agent.spendMicros : agent.calls;
            const expired = bySpend ? Math.min(agent.expiredExtraMicros, agent.spendMicros) : 0;
            return [
              <Link
                key={`${agent.role}-name`}
                to={`/activity?${logsQuery(searchParams, { ...onDay, agent: agent.role })}`}
                className={`${ROW} hit relative truncate font-medium text-foreground hover:text-muted-foreground pointer-coarse:flex pointer-coarse:min-h-[45px] pointer-coarse:items-center`}
              >
                {roleLabel(agent.role)}
              </Link>,
              <span key={`${agent.role}-calls`} className={`${ROW} num text-right text-muted-foreground @max-[40rem]:hidden`}>{formatCount(agent.calls)}</span>,
              <span key={`${agent.role}-spend`} className={`${ROW} num text-right`}>{ledgerMoneyLabel(agent.spendMicros, agent.money, estimated)}</span>,
              <span key={`${agent.role}-share`} className={`${ROW} flex items-center @max-[28rem]:hidden`}>
                <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-sel">
                  <span className="bg-amber" style={{ width: `${(expired / peak) * 100}%` }} />
                  <span className="bg-faint" style={{ width: `${(Math.max(0, value - expired) / peak) * 100}%`, minWidth: value > 0 ? "2px" : undefined }} />
                </span>
              </span>,
              <span key={`${agent.role}-expired`} className={`${ROW} num text-right ${agent.expiredExtraMicros > 0 ? "text-amber" : "text-faint"}`}>
                {agent.expiredExtraMicros > 0 ? formatUsd(agent.expiredExtraMicros, estimated) : "—"}
              </span>
            ];
          })}
        </div>
      </div>
    </Section>
  );
}
