import type { AgentMessagePatchDto, AgentMessageStreamDto } from "../../../shared/api-contracts.js";

/** One encoder per connection: its baseline is exactly what that reader saw. */
export class MessageStreamEncoder {
  private streams: Map<string, AgentMessageStreamDto>;

  constructor(streams: AgentMessageStreamDto[]) {
    this.streams = new Map(streams.map((stream) => [stream.threadId, stream]));
  }

  patch(stream: AgentMessageStreamDto): AgentMessagePatchDto | null {
    const previous = this.streams.get(stream.threadId);
    this.streams.set(stream.threadId, stream);
    const sameWake = previous?.wakeId === stream.wakeId;
    if (sameWake && previous.totalText === stream.totalText) return null;
    // Fallbacks can clear or replace text; a new step/wake starts at zero.
    const offset = sameWake && stream.totalText.startsWith(previous.totalText)
      ? previous.totalText.length
      : 0;
    return { threadId: stream.threadId, wakeId: stream.wakeId, offset, deltaText: stream.totalText.slice(offset) };
  }

  finish(threadId: string, wakeId: string): void {
    if (this.streams.get(threadId)?.wakeId === wakeId) this.streams.delete(threadId);
  }
}
