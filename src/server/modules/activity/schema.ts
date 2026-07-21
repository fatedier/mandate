import type { Database } from "bun:sqlite";
import { ensureColumn } from "../../platform/db/ensure-column.js";

export function initializeActivitySchema(db: Database): void {
  db.exec(`
    create table if not exists llm_calls (
      id text primary key,
      purpose text not null,
      scope_type text not null default '',
      scope_id text not null default '',
      parent_call_id text,
      provider text not null default '',
      model text not null default '',
      base_url text not null default '',
      api_mode text not null default '',
      request_hash text not null default '',
      response_hash text not null default '',
      request_json text,
      response_json text,
      output_json text,
      usage_json text,
      metadata_json text,
      input_tokens integer,
      output_tokens integer,
      total_tokens integer,
      reasoning_tokens integer,
      cache_read_tokens integer,
      cache_write_tokens integer,
      status text not null,
      error_json text,
      started_at text not null,
      finished_at text,
      latency_ms integer,
      created_at text not null,
      updated_at text not null
    )
  `);
  db.exec(
    "create index if not exists idx_llm_calls_purpose_created on llm_calls (purpose, created_at)"
  );
  db.exec(
    "create index if not exists idx_llm_calls_scope_created on llm_calls (scope_type, scope_id, created_at)"
  );
  db.exec(
    "create index if not exists idx_llm_calls_status_created on llm_calls (status, created_at)"
  );
  // Time to first token: how long the provider took to start answering, as
  // opposed to how long the whole answer took. Added convergently rather than
  // by migration, so an existing store gains the column on its next boot and
  // every row written before that keeps a null — which is the truth. Nothing
  // can backfill it: the stream timings a finished call recorded end up in
  // `metadata.stream`, and the first timestamp there is the SDK's own local
  // `start` event, measured at 14.9ms against a mean latency of 11 seconds.
  ensureColumn(db, "llm_calls", "ttft_ms", "integer");
}
