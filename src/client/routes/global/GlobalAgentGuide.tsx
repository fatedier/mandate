import { useState } from "react";
import { Link } from "react-router";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ViewState";
import { PaneHeaderTitle } from "@/shell/pane-header-slots";
import { useGlobalAgentStore } from "@/store/global-agent";
import { DEFAULT_GLOBAL_AGENT_NAME, GLOBAL_AGENT_NAME_MAX, normalizeGlobalAgentName } from "@shared/global-agent-name";

const ABILITIES = [
  "Ask what's going on anywhere: what needs you, how a worker is doing.",
  "Tell a worker what to do. I'll pass it on.",
  "Hand me something new. I'll send it to the right thread and tell you where it went."
];

/** First open, until named: what it is, a name with a
 *  live preview, whether voice works, Start. A blank name is "Mandate". */
export function GlobalAgentGuide({ voiceConfigured }: { voiceConfigured: boolean }) {
  const saveName = useGlobalAgentStore((s) => s.saveName);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = normalizeGlobalAgentName(name) || DEFAULT_GLOBAL_AGENT_NAME;
  const start = async () => {
    setSaving(true);
    setError(null);
    const result = await saveName(chosen);
    setSaving(false);
    if ("error" in result) setError(result.error);
  };
  return (
    <div className="mx-auto flex w-full max-w-[30rem] flex-col gap-5 px-4 pt-10 pb-8">
      <PaneHeaderTitle>
        <div className="flex min-w-0 items-baseline gap-2 text-sm">
          <span className="truncate font-semibold text-foreground">Your agent</span>
          <span className="truncate text-xs text-faint">Set up</span>
        </div>
      </PaneHeaderTitle>
      <h1 className="text-xl font-semibold text-foreground text-balance">Hi, I'm {chosen}.</h1>
      <p className="text-sm text-muted-foreground">I can see every thread and worker. Type or talk to me about any of them.</p>
      <ol className="flex flex-col gap-2 text-sm">
        {ABILITIES.map((text, i) => (
          <li key={text} className="flex items-start gap-2.5">
            <span aria-hidden className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-status-review/10 text-2xs font-semibold text-status-review">{i + 1}</span>
            <span>{text}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="global-agent-name" className="text-sm font-semibold">What should I be called?</label>
        <input
          id="global-agent-name"
          value={name}
          maxLength={GLOBAL_AGENT_NAME_MAX}
          placeholder={DEFAULT_GLOBAL_AGENT_NAME}
          onChange={(e) => setName(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
        />
        <span className="text-xs text-faint">You can change it later in Settings.</span>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-border-soft bg-panel px-3 py-2 text-xs text-muted-foreground">
        <Mic className="size-3.5 shrink-0" aria-hidden />
        {voiceConfigured
          ? <span>Voice is set up. Press the mic to talk.</span>
          : <span>Voice isn't set up yet. Set it up in <Link to="/settings?tab=voice" className="underline">Settings › Voice</Link>.</span>}
      </div>
      {error ? <InlineError detail={error}>Couldn't save the name.</InlineError> : null}
      <Button data-slot="global-agent-start" className="self-start" disabled={saving} onClick={() => void start()}>
        {saving ? "Starting…" : "Start"}
      </Button>
    </div>
  );
}
