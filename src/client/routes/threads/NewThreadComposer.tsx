import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { threadHref } from "@/lib/feature-href";
import { errorText } from "@shared/error-text";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import type { Mention } from "@shared/mentions";

/** Starts a thread with its first message. No project
 *  picker: the manager infers the project when it starts a worker. It is the
 *  thread's own composer, laid out by Home: the same card and send button,
 *  and its first message can carry images. */
/** Home's first message can @ any open thread: there is no thread yet to leave out. */
const HOME_MENTIONS = { excludeId: null };

export function NewThreadComposer({ autoFocus = false, focusKey }: {
  autoFocus?: boolean;
  /** Each new value puts the cursor in the composer: New thread used while
   *  Home is already open changes only the URL, and autoFocus only works on
   *  mount. */
  focusKey?: string;
}) {
  const navigate = useNavigate();
  const create = useManagerThreadsStore((s) => s.create);
  // Returns its promise: the composer keeps what was typed until the thread
  // exists, and keeps it if the thread could not be started.
  const start = async (content: string, attachments?: AgentMessageAttachment[], mentions?: Mention[]) => {
    try {
      const thread = await create({ content, attachments, mentions });
      navigate(threadHref(thread.id));
    } catch (e) {
      toast.error(errorText(e, "Could not start the thread"));
      throw e;
    }
  };
  return (
    <>
      <label htmlFor="new-thread-composer" className="sr-only">New thread</label>
      <ChatInput
        layout="inline"
        textareaId="new-thread-composer"
        placeholder="Start a new thread"
        sendLabel="Start thread"
        autoFocus={autoFocus}
        focusKey={focusKey}
        onSend={start}
        mentions={HOME_MENTIONS}
      />
    </>
  );
}
