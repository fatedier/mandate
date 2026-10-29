import { STATUS_CODES } from "node:http";

/** An HTTP status as its code and standard reason, "403 Forbidden". The
 *  server's own status text is never used: it is the server's words, and here
 *  they would reach the model outside the web-text markers, as if Mandate's. */
export function statusLine(status: number): string {
  const reason = STATUS_CODES[status];
  return reason ? `${status} ${reason}` : String(status);
}
