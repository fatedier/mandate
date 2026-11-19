/** A wake the person stopped. Thrown from wherever the loop notices; the loop
 *  ends the wake as canceled when it sees one. */
export class WakeCanceledError extends Error {
  constructor() {
    super("Stopped by user.");
    this.name = "WakeCanceledError";
  }
}
