import { TERMINAL_THEME } from "@/hooks/terminal/terminal-theme";
import { cn } from "@/lib/utils";
import { callDescription, rowStatus, type ToolRunRow } from "../tool-run-summary";
import { CodeBlock, DetailSection, MarkdownBlock, ProseBlock, type DetailLayout } from "./blocks";
import { GenericDetails, ResultSection } from "./GenericDetails";
import { isLongText, useInlineCap } from "./inline-cap";
import { keyPresses, type KeyPress } from "./keys";
import { parsePaneRead, readPaneArgs, sendKeysArgs } from "./parse";
import { TargetSection } from "./targets";
import { RawArguments } from "./ValueViews";

function KeyChip({ press }: { press: KeyPress }) {
  if (press.kind === "key") {
    return (
      <kbd data-kind="key" className="rounded-xs border border-b-2 border-border bg-code-bg px-1.5 py-0.5 font-mono text-2xs font-semibold text-foreground">
        {press.text}
      </kbd>
    );
  }
  return (
    <span
      data-kind="typed"
      className="inline-flex max-w-full items-baseline gap-1.5 rounded-xs border border-border-soft bg-code-bg px-1.5 py-0.5"
    >
      <span className="shrink-0 text-2xs text-faint">typed</span>
      <span className="min-w-0 whitespace-pre-wrap font-mono text-2xs text-foreground">{press.text}</span>
    </span>
  );
}

/** The keys a send_keys call pressed, in order: keycaps for named keys, typed
 *  text as it was typed. Args in a form not read (see keyPresses) are shown
 *  as sent. */
function KeySequence({ args }: { args: string[] }) {
  const presses = keyPresses(args);
  if (!presses) return <CodeBlock text={args.map((arg) => JSON.stringify(arg)).join(" ")} />;
  return (
    <div data-slot="tool-keys" className="flex flex-wrap items-center gap-1.5">
      {presses.map((press, index) => (
        <span key={index} className="contents">
          {index > 0 && <span aria-hidden className="text-2xs text-faint">then</span>}
          <KeyChip press={press} />
        </span>
      ))}
    </div>
  );
}

/** A send_keys call as what it did: why (its description), to which pane,
 *  and the keys, not an args array to decode. */
export function SendKeysDetails({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  const args = sendKeysArgs(row.call.args);
  if (!args) return <GenericDetails row={row} layout={layout} />;
  const description = callDescription(row.call);
  return (
    <>
      {description && (
        <DetailSection label="Description">
          <ProseBlock text={description} />
        </DetailSection>
      )}
      <TargetSection kind="pane" id={args.paneId} callId={row.call.toolCallId} />
      <DetailSection label="Keys" copyText={args.args.join(" ")}>
        <KeySequence args={args.args} />
      </DetailSection>
      <ResultSection row={row} failed={rowStatus(row) === "error"} layout={layout} />
      <RawArguments args={row.call.args} />
    </>
  );
}

/** A pane's capture in the terminal's own colours, lines never reflowed;
 *  long, capped in the transcript as other output is. */
function TerminalBlock({ text, layout }: { text: string; layout: DetailLayout }) {
  const cap = useInlineCap(layout, isLongText(text));
  return (
    <DetailSection label="Screen" copyText={text} actions={cap.toggle}>
      <div
        data-slot="tool-terminal"
        className={cn("max-w-full rounded-sm bg-terminal-bg text-2xs", cap.boxClass)}
        style={{ color: TERMINAL_THEME.foreground }}
      >
        <pre className="scroll-x-quiet whitespace-pre p-2 font-mono">{text}</pre>
      </div>
    </DetailSection>
  );
}

function Notes({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div data-slot="tool-notes" className="flex flex-col gap-0.5 text-2xs text-faint">
      {lines.map((line, index) => <p key={index}>{line}</p>)}
    </div>
  );
}

/** A read_pane call: the pane, then its screen as the terminal showed it. The
 *  notes the tool adds for the agent — how much above is unchanged since its
 *  last read, a watch it already holds — sit outside the screen in small
 *  print, since they were never on it. */
export function ReadPaneDetails({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  const args = readPaneArgs(row.call.args);
  if (!args) return <GenericDetails row={row} layout={layout} />;
  const { result } = row;
  const text = result && !result.isError && typeof result.result === "string" ? result.result : null;
  const read = text === null ? null : parsePaneRead(text);
  return (
    <>
      <TargetSection kind="pane" id={args.paneId} callId={row.call.toolCallId} note={typeof args.lines === "number" ? `last ${args.lines} lines` : undefined} />
      {read ? (
        <>
          <Notes lines={read.before} />
          {read.screen !== null && <TerminalBlock text={read.screen} layout={layout} />}
          <Notes lines={read.after} />
        </>
      ) : (
        <ResultSection row={row} failed={rowStatus(row) === "error"} layout={layout} />
      )}
      <RawArguments args={row.call.args} />
    </>
  );
}

/** What a watch or a pane monitor waits on — the feature (the manager's),
 *  the pane and how long it must be quiet — and why. */
export function PaneWaitDetails({ row, layout, target, quiet, note }: {
  row: ToolRunRow;
  layout: DetailLayout;
  target: { paneId: string; featureId?: string | null; projectSlug?: string | null; featureSlug?: string | null };
  quiet: string | null;
  note?: string | null;
}) {
  const featureSlug = target.projectSlug && target.featureSlug ? `${target.projectSlug}/${target.featureSlug}` : target.featureSlug ?? null;
  return (
    <>
      {target.featureId
        ? <TargetSection kind="feature" id={target.featureId} callId={row.call.toolCallId} />
        : featureSlug && <TargetSection kind="feature" id={featureSlug} callId={row.call.toolCallId} />}
      <TargetSection kind="pane" id={target.paneId} callId={row.call.toolCallId} note={quiet ? `quiet for ${quiet}` : undefined} />
      {note && (
        <DetailSection label="Note" copyText={note}>
          <MarkdownBlock text={note} />
        </DetailSection>
      )}
      <ResultSection row={row} failed={rowStatus(row) === "error"} layout={layout} />
      <RawArguments args={row.call.args} />
    </>
  );
}
