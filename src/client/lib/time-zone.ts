/** The reader's IANA time zone. The Activity page sends it, and the server
 *  cuts its days in it, so a bar's date is the reader's own. */
export function readerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
