import { cn } from "@/lib/utils";
import { callDescription, rowStatus, type ToolRunRow } from "../tool-run-summary";
import { CodeBlock, DetailSection, OutputBlock, ProseBlock, type DetailLayout } from "./blocks";
import { GenericDetails } from "./GenericDetails";
import { bashArgs, formatPayload, parseBashResult } from "./parse";
import { RawArguments } from "./ValueViews";

/** A timeout as it was given: whole seconds as seconds, anything finer as
 *  milliseconds, never rounded into a different number. */
function formatTimeout(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** A bash call: what it was for, the command, and
 *  what it printed — stdout and stderr apart rather than one transcript, and a
 *  non-zero exit said in words. */
export function BashDetails({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  const { call, result } = row;
  const args = bashArgs(call.args);
  if (!args) return <GenericDetails row={row} layout={layout} />;
  const description = callDescription(call);
  const { command, cwd, timeout } = args;
  const failed = rowStatus(row) === "error";
  const transcript = result && !result.isError ? parseBashResult(result.result) : null;

  return (
    <>
      {description && (
        <DetailSection label="Description">
          <ProseBlock text={description} />
        </DetailSection>
      )}
      <DetailSection label="Command" copyText={command}>
        <CodeBlock text={command} />
        {(cwd || typeof timeout === "number") && (
          <div data-slot="bash-options" className="mt-1 text-2xs text-faint [overflow-wrap:anywhere]">
            {cwd && <>in <span className="font-mono">{cwd}</span></>}
            {cwd && typeof timeout === "number" && " · "}
            {typeof timeout === "number" && `timeout ${formatTimeout(timeout)}`}
          </div>
        )}
      </DetailSection>
      {result?.isError && (
        <OutputBlock label="Error" text={result.error ?? "(no error message)"} tone="red" layout={layout} />
      )}
      {transcript && (
        <>
          {/* Any non-zero exit, red only when it counts as a failure: grep's
              1 is no failure, but it is the answer. The sheet says this in
              its status line, under the title. */}
          {transcript.exitCode !== 0 && layout === "inline" && (
            <div data-slot="bash-exit" className={cn("text-2xs", failed ? "text-red" : "text-faint")}>
              Exited with code {transcript.exitCode}
            </div>
          )}
          {transcript.stdout && <OutputBlock label="Output" text={transcript.stdout} layout={layout} />}
          {/* stderr is not always errors — progress and warnings go there too —
              so it is only red when the command failed. */}
          {transcript.stderr && (
            <OutputBlock label="Stderr" text={transcript.stderr} tone={failed ? "red" : "plain"} layout={layout} />
          )}
          {!transcript.stdout && !transcript.stderr && (
            <div data-slot="bash-no-output" className="text-2xs text-faint">No output</div>
          )}
        </>
      )}
      {result && !result.isError && !transcript && (
        <OutputBlock label={failed ? "Error" : "Output"} text={formatPayload(result.result)} tone={failed ? "red" : "plain"} layout={layout} />
      )}
      <RawArguments args={call.args} />
    </>
  );
}
