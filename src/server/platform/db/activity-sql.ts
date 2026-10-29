/**
 * A message that is not an idle compaction's summary, as SQL over
 * agent_messages' own columns: such
 * a summary moves no thread up the list, counts as no worker's use of its
 * project, and restarts no retention's silence. It uses the row's own
 * columns, so it rides any `(thread_id, seq)` walk; no table it is joined
 * with has a `source` or `content`. The coalesce keeps a row with no trigger
 * in (a NULL would turn the whole `not` NULL).
 */
export const NOT_IDLE_SUMMARY = "not (source = 'compression' and coalesce(json_extract(content, '$.trigger'), '') = 'idle')";
