import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useNow } from "@/hooks/useNow";
import { useTaskBoardStore } from "@/store/task-board";
import { errorText } from "@shared/error-text";
import { DueChoices, type Due } from "./DuePicker";

/** The owner's new task: a title, a description of any length, a due date.
 *  Nobody is told; the owner mentions the agent when it should start. */
export function NewTaskDialog({ agentName, onDone }: { agentName: string; onDone: (createdId: string | null) => void }) {
  const now = useNow();
  const create = useTaskBoardStore((s) => s.create);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [due, setDue] = useState<Due>({ dueDate: null, dueTime: null });
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      const task = await create({ title: title.trim(), description, dueDate: due.dueDate, dueTime: due.dueTime });
      toast.message("Task created");
      onDone(task.id);
    } catch (err) {
      toast.error(errorText(err));
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onDone(null); }}>
      <DialogContent className="sm:max-w-[560px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="text-base">New task</DialogTitle>
        </DialogHeader>
        <input
          autoFocus
          placeholder="What needs to happen?"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}
          className="h-9 w-full rounded-md border border-border-soft bg-background px-3 text-sm outline-none focus:border-ring"
        />
        <textarea
          placeholder="Description (optional). Paste as much as you like; Markdown works."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={6}
          className="min-h-28 w-full resize-y rounded-md border border-border-soft bg-background px-3 py-2 text-sm outline-none focus:border-ring"
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Due</span>
          <DueChoices value={due} onChange={setDue} now={now} />
        </div>
        <p className="text-xs text-muted-foreground">Nobody is told. When it should start, mention @{agentName} in a comment.</p>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={() => onDone(null)}>Cancel</Button>
          <Button type="button" disabled={!title.trim() || saving} onClick={() => void submit()}>Create task</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
