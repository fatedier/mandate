/** One cleanup an archive may do, as a box the user can untick. */
export interface CleanupChoice {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** The cleanup boxes of an archive dialog, a worker's or a thread's: remove
 *  the worktree, delete the branch. A choice that does not apply is null and
 *  draws nothing; with neither the block is not drawn at all.
 *
 *  Each box is tapped through its label: 44px tall on a touch screen, where a
 *  one-line description left it at 39. */
export function ArchiveCleanupChoices({ worktree, branch, disabled }: {
  worktree: CleanupChoice | null;
  branch: CleanupChoice | null;
  disabled: boolean;
}) {
  const choices = [worktree, branch].filter((choice): choice is CleanupChoice => choice !== null);
  if (choices.length === 0) return null;
  return (
    <div className="rounded-md border border-border-soft bg-muted/20 p-3 space-y-3">
      {choices.map((choice) => (
        <label key={choice.label} className="flex items-start gap-3 text-sm pointer-coarse:min-h-11">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-primary"
            checked={choice.checked}
            disabled={disabled}
            onChange={(event) => choice.onChange(event.currentTarget.checked)}
          />
          <span className="min-w-0">
            <span className="block font-medium text-foreground">{choice.label}</span>
            <span className="block text-xs text-muted-foreground">{choice.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
