/**
 * Per-thread wake lock. In-memory; does not survive restart, which is fine
 * because at restart no wake is in flight.
 */
export class WakeLock {
  private held = new Set<string>();

  tryAcquire(threadId: string): (() => void) | null {
    if (this.held.has(threadId)) return null;
    this.held.add(threadId);
    return () => this.held.delete(threadId);
  }

  isHeld(threadId: string): boolean {
    return this.held.has(threadId);
  }
}
