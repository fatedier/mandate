import { isRecord } from "@shared/guards";
import type { ToolRunRow } from "../tool-run-summary";
import { CodeBlock, DetailSection, MarkdownBlock, OutputBlock, type DetailLayout } from "./blocks";
import { GenericDetails } from "./GenericDetails";
import { PaneWaitDetails } from "./PaneDetails";
import { commandMonitorResult, monitorArgs, type CommandMonitorArgs } from "./parse";
import { RawArguments, StructuredSection } from "./ValueViews";

/** The server's default give-up time for a command monitor (tools/monitor.ts). */
const COMMAND_DEFAULT_TIMEOUT = "24h";

/** A monitor call. On a pane it is the watch it replaced; on a command, what
 *  it runs, how often, until what, and what the first run read — or why it
 *  was refused, or that the condition already held. */
export function MonitorDetails({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  const args = monitorArgs(row.call.args);
  if (!args) return <GenericDetails row={row} layout={layout} />;
  const value = row.result && !row.result.isError ? row.result.result : null;
  const result = isRecord(value) ? value : null;
  if (args.pane) {
    // What took, from the result: the server fills in the default.
    const took = result?.unchangedFor;
    const quiet = typeof took === "string" ? took : null;
    return <PaneWaitDetails row={row} layout={layout} target={args.pane} quiet={quiet} note={args.note} />;
  }
  const command = args.command!;
  // A result in a shape this view does not draw exactly — an unknown status,
  // a key it would drop, an output that is not text — is shown as it came.
  const decoded = row.result && !row.result.isError ? commandMonitorResult(value) : null;
  if (row.result && !row.result.isError && !decoded) return <GenericDetails row={row} layout={layout} />;
  const output = decoded?.output ?? null;
  const stderr = decoded && decoded.kind !== "refused" ? decoded.stderr : null;
  const stderrBlock = stderr ? <OutputBlock label="Stderr" text={stderr} layout={layout} /> : null;
  const commandSection = <CommandSection command={command} />;
  // Everything else the result carried, as it came (the output has a block
  // of its own above it, the exit code a line): nothing it says is dropped,
  // and its JSON is a tap away.
  const rest = isRecord(value) && decoded?.kind !== "refused"
    ? <StructuredSection label="Result" value={without(value, ["output", "exitCode", "stderr"])} raw={value} layout={layout} />
    : null;
  if (row.result?.isError) {
    return (
      <>
        {commandSection}
        <OutputBlock label="Error" text={row.result.error ?? "(no error message)"} tone="red" layout={layout} />
        <RawArguments args={row.call.args} />
      </>
    );
  }
  if (decoded?.kind === "refused") {
    return (
      <>
        <DetailSection label="Error" tone="red">
          <div data-slot="monitor-error" className="rounded-sm bg-red/10 p-2 text-xs text-red [overflow-wrap:anywhere]">{decoded.error}</div>
        </DetailSection>
        {commandSection}
        {output !== null && <OutputBlock label="Output" text={output || "(no output)"} layout={layout} />}
        <RawArguments args={row.call.args} />
      </>
    );
  }
  if (decoded?.kind === "satisfied") {
    return (
      <>
        {commandSection}
        {output !== null && <OutputBlock label="Output" text={output || "(no output)"} layout={layout} />}
        {stderrBlock}
        {rest}
        <RawArguments args={row.call.args} />
      </>
    );
  }
  const succeeds = command.wakeWhen === "succeeds";
  const when = `Every ${command.every} · ${succeeds ? "wakes when it succeeds" : "wakes when its output changes"} · gives up after ${args.timeout ?? COMMAND_DEFAULT_TIMEOUT}`;
  const exitCode = decoded?.kind === "registered" ? decoded.exitCode : null;
  return (
    <>
      {commandSection}
      <DetailSection label="When">
        <div data-slot="monitor-when" className="text-xs text-foreground">{when}</div>
      </DetailSection>
      {args.note && (
        <DetailSection label="Note" copyText={args.note}>
          <MarkdownBlock text={args.note} />
        </DetailSection>
      )}
      {output !== null && (
        <DetailSection label="First run" copyText={output}>
          {exitCode !== null && (
            <div data-slot="monitor-exit" className="mb-1 text-2xs text-faint">
              {/* Under succeeds a failed run is "not yet" — unless it wrote to
                  stderr, which is likely an error (the server warns too). */}
              exit {exitCode}{succeeds && exitCode !== 0 ? (stderr ? " · wrote to stderr" : " · not yet") : ""}
            </div>
          )}
          <CodeBlock text={output || "(no output)"} />
        </DetailSection>
      )}
      {stderrBlock}
      {rest}
      <RawArguments args={row.call.args} />
    </>
  );
}

/** The command, under the description it was given (shown in its place on
 *  the row). */
function CommandSection({ command }: { command: CommandMonitorArgs }) {
  return (
    <DetailSection label="Command" copyText={command.run} slot="monitor-command">
      {command.description && <div className="mb-1 text-xs text-foreground">{command.description}</div>}
      <CodeBlock text={command.run} />
    </DetailSection>
  );
}

function without(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
