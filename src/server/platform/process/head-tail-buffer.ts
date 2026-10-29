/** A capped byte buffer for a command's output, which counts what it drops.
 *
 *  With `keepTail` it keeps the first half and the last half of what is
 *  pushed: the head gets floor(max / 2), the tail the rest, and
 *  the text reads head, `... N bytes omitted ...`, tail. Without it, it keeps
 *  the first `max` bytes and the text is just those.
 *
 *  Memory stays at the cap however much is pushed, and each byte is copied
 *  once: the tail is a ring of fixed size, so a run of small chunks after a
 *  large one does not recopy what the tail holds. */
export class HeadTailBuffer {
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  /** The tail, allocated when first used: `ringLength` bytes from `ringStart`, wrapping. */
  private ring: Buffer | null = null;
  private ringStart = 0;
  private ringLength = 0;
  private omitted = 0;

  constructor(maxBytes: number, options: { keepTail?: boolean } = {}) {
    const keepTail = options.keepTail ?? true;
    this.headBudget = keepTail ? Math.floor(maxBytes / 2) : maxBytes;
    this.tailBudget = keepTail ? maxBytes - this.headBudget : 0;
  }

  get omittedBytes(): number {
    return this.omitted;
  }

  get retainedBytes(): number {
    return this.headBytes + this.ringLength;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    let rest = chunk;
    if (this.headBytes < this.headBudget) {
      const take = Math.min(this.headBudget - this.headBytes, rest.length);
      // Copied, so a kept slice does not hold the whole chunk it came from.
      this.head.push(Buffer.from(rest.subarray(0, take)));
      this.headBytes += take;
      rest = rest.subarray(take);
      if (rest.length === 0) return;
    }
    if (this.tailBudget === 0) {
      this.omitted += rest.length;
      return;
    }
    this.pushTail(rest);
  }

  /** What toString decodes, as bytes: for output written on as it came. */
  bytes(): Buffer {
    const head = Buffer.concat(this.head);
    if (this.tailBudget === 0) return head;
    const tail = this.tailBytes();
    if (this.omitted === 0) return Buffer.concat([head, tail]);
    return Buffer.concat([head, Buffer.from(`\n... ${this.omitted} bytes omitted ...\n`), tail]);
  }

  toString(): string {
    const head = Buffer.concat(this.head);
    if (this.tailBudget === 0) return head.toString("utf8");
    const tail = this.tailBytes();
    if (this.omitted === 0) return Buffer.concat([head, tail]).toString("utf8");
    return `${head.toString("utf8")}\n... ${this.omitted} bytes omitted ...\n${tail.toString("utf8")}`;
  }

  private pushTail(bytes: Buffer): void {
    const cap = this.tailBudget;
    const ring = (this.ring ??= Buffer.alloc(cap));
    if (bytes.length >= cap) {
      // These bytes alone fill the tail: everything before their last `cap` goes.
      this.omitted += this.ringLength + bytes.length - cap;
      bytes.copy(ring, 0, bytes.length - cap);
      this.ringStart = 0;
      this.ringLength = cap;
      return;
    }
    const end = (this.ringStart + this.ringLength) % cap;
    const first = Math.min(bytes.length, cap - end);
    bytes.copy(ring, end, 0, first);
    if (first < bytes.length) bytes.copy(ring, 0, first);
    const total = this.ringLength + bytes.length;
    if (total > cap) {
      const over = total - cap;
      this.ringStart = (this.ringStart + over) % cap;
      this.ringLength = cap;
      this.omitted += over;
    } else {
      this.ringLength = total;
    }
  }

  private tailBytes(): Buffer {
    if (!this.ring || this.ringLength === 0) return Buffer.alloc(0);
    const end = this.ringStart + this.ringLength;
    if (end <= this.tailBudget) return this.ring.subarray(this.ringStart, end);
    return Buffer.concat([this.ring.subarray(this.ringStart), this.ring.subarray(0, end - this.tailBudget)]);
  }
}
