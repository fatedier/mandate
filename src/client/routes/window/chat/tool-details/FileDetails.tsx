import { cn } from "@/lib/utils";
import { lineChanges, rowStatus, type ToolRunRow } from "../tool-run-summary";
import { DetailSection, LineCounts, PathLine, type DetailLayout } from "./blocks";
import { GenericDetails, ResultSection } from "./GenericDetails";
import { isLongText, useInlineCap } from "./inline-cap";
import { isWriteSuccess, parseNumberedLines, readArgs, writeArgs, type NumberedLine } from "./parse";
import { RawArguments } from "./ValueViews";

/** Lines of a file with their numbers in a gutter that stays put while the
 *  code scrolls sideways under it; long, capped in the transcript as other
 *  output is. Copy takes the text without the numbers — or `copyText`, when
 *  the caller has the text exactly as it was. */
function NumberedBlock({ label, lines, layout, copyText }: {
  label: string;
  lines: NumberedLine[];
  layout: DetailLayout;
  copyText?: string;
}) {
  const text = lines.map((line) => line.text).join("\n");
  const cap = useInlineCap(layout, isLongText(text));
  return (
    <DetailSection label={label} copyText={copyText ?? text} actions={cap.toggle}>
      <div data-slot="tool-numbered" className={cn("max-w-full rounded-sm bg-code-bg font-mono text-2xs", cap.boxClass)}>
        <div className="scroll-x-quiet">
          <div className="inline-flex min-w-full">
            <pre
              aria-hidden
              data-slot="tool-gutter"
              className="sticky left-0 shrink-0 select-none bg-code-bg py-2 pl-2 pr-3 text-right text-faint"
            >
              {lines.map((line) => line.number).join("\n")}
            </pre>
            <pre className="whitespace-pre py-2 pr-2 text-foreground">{text}</pre>
          </div>
        </div>
      </div>
    </DetailSection>
  );
}

function lineCount(n: number): string {
  return n === 1 ? "1 line" : `${n} lines`;
}

/** A read call: the file, the lines it came back with (from the result, not
 *  the arguments, which can ask past the end), and those lines numbered. */
export function ReadDetails({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  const args = readArgs(row.call.args);
  if (!args) return <GenericDetails row={row} layout={layout} />;
  const { result } = row;
  const lines = result && !result.isError ? parseNumberedLines(result.result) : null;
  const range = lines && lines.length > 0
    ? (lines.length === 1 ? `line ${lines[0]!.number}` : `lines ${lines[0]!.number}–${lines[lines.length - 1]!.number}`)
    : undefined;
  return (
    <>
      <DetailSection label="File" copyText={args.path}>
        <PathLine path={args.path} note={range} />
      </DetailSection>
      {lines
        ? <NumberedBlock label="Content" lines={lines} layout={layout} />
        : <ResultSection row={row} failed={rowStatus(row) === "error"} layout={layout} />}
      <RawArguments args={row.call.args} />
    </>
  );
}

/** A write call: the file and what was written to it, numbered from the top.
 *  The success result says the path again and a byte count, so it is left
 *  out when it names this very path; anything else it says is shown. */
export function WriteDetails({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  const args = writeArgs(row.call.args);
  if (!args) return <GenericDetails row={row} layout={layout} />;
  const { result } = row;
  // A final newline ends the last line rather than starting another, as an
  // editor's line count and `wc -l` have it; an empty file has none.
  const body = args.content.endsWith("\n") ? args.content.slice(0, -1) : args.content;
  const lines = args.content === "" ? [] : body.split("\n");
  const plainSuccess = Boolean(result && !result.isError && isWriteSuccess(result.result, args.path));
  return (
    <>
      {/* Beside the file, not the content: a file emptied has no content to
          stand beside. */}
      <DetailSection label="File" copyText={args.path} actions={<LineCounts changes={lineChanges(row)} />}>
        <PathLine path={args.path} note={lineCount(lines.length)} />
      </DetailSection>
      {lines.length > 0
        ? <NumberedBlock label="Content" lines={lines.map((text, index) => ({ number: index + 1, text }))} layout={layout} copyText={args.content} />
        : <div data-slot="tool-empty-file" className="text-2xs text-faint">Empty file</div>}
      {!plainSuccess && <ResultSection row={row} failed={rowStatus(row) === "error"} layout={layout} />}
      <RawArguments args={row.call.args} />
    </>
  );
}
