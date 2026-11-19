import { lineChanges, rowStatus, type ToolRunRow } from "../tool-run-summary";
import { DetailSection, DiffBlock, LineCounts, OutputBlock, PathLine, type DetailLayout } from "./blocks";
import { GenericDetails } from "./GenericDetails";
import { editArgs, editReplacements, formatPayload, lineDiff } from "./parse";
import { RawArguments } from "./ValueViews";

/** An edit as the change it made: the file, then the old text against the new
 *  as a diff, rather than two blocks to compare by eye. A success's result is
 *  the path again and a count, so only the count is kept, and only when it
 *  says something: how many places "every occurrence" was. */
export function EditDetails({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  const { call, result } = row;
  const args = editArgs(call.args);
  if (!args) return <GenericDetails row={row} layout={layout} />;
  const replacements = editReplacements(result?.result, args.path);
  const failed = rowStatus(row) === "error";

  return (
    <>
      <DetailSection label="File" copyText={args.path}>
        <PathLine path={args.path} />
      </DetailSection>
      <DetailSection label="Change" copyText={args.newString} actions={<LineCounts changes={lineChanges(row)} />}>
        <DiffBlock lines={lineDiff(args.oldString, args.newString).lines} />
        {args.replaceAll === true && (
          <div data-slot="edit-replace-all" className="mt-1 text-2xs text-faint">
            {replacements === null ? "Every occurrence" : `Every occurrence · ${replacements} ${replacements === 1 ? "place" : "places"}`}
          </div>
        )}
      </DetailSection>
      {result?.isError ? (
        <OutputBlock label="Error" text={result.error ?? "(no error message)"} tone="red" layout={layout} />
      ) : result && replacements === null && (
        // Not the success text this view drops: shown whole, whatever it is.
        <OutputBlock label={failed ? "Error" : "Output"} text={formatPayload(result.result)} tone={failed ? "red" : "plain"} layout={layout} />
      )}
      <RawArguments args={call.args} />
    </>
  );
}
