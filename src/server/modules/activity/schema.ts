import type { Database } from "bun:sqlite";

export function initializeActivitySchema(db: Database): void {
  db.exec(`
    create table if not exists llm_calls (
      id text primary key,
      purpose text not null,
      scope_type text not null default '',
      scope_id text not null default '',
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
      updated_at text not null,
      -- Time to first token: how long the provider took to start answering,
      -- as opposed to how long the whole answer took. Null on calls from
      -- before it was measured; nothing can backfill it.
      ttft_ms integer,
      -- What a price needs and what it came to. Columns rather than metadata:
      -- retention reduces metadata_json after 90 days, and the Activity
      -- summary sums the amount in its scan without reading JSON.
      provider_name text,
      reported_cost_micros integer,
      reported_cost_field text,
      cache_write_1h_tokens integer,
      -- The 5-minute part of the same split: beside the 1-hour count it says
      -- how long the provider kept what a call wrote (null when it did not say).
      cache_write_5m_tokens integer,
      service_tier text,
      cost_micros integer,
      cost_source text,
      cost_api_micros integer,
      cost_ref text,
      cost_note text
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
  // The pricing pass's queue: calls not priced yet.
  db.exec("create index if not exists idx_llm_calls_unpriced on llm_calls (created_at) where cost_source is null");
  // What the pricing pass saw last (settings per connection, the data
  // version) and the clears it still has to do.
  db.exec("create table if not exists pricing_seen (key text primary key, value text not null)");
}
