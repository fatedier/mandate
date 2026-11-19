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
  // The log's model filter (filter-options.ts): every provider and model with
  // its latest call, read from these columns alone; the table carries each
  // call's payloads, hundreds of MB read from disk to group them.
  db.exec(
    "create index if not exists idx_llm_calls_models on llm_calls (provider_name, provider, model, created_at)"
  );
  db.exec(
    "create index if not exists idx_llm_calls_status_created on llm_calls (status, created_at)"
  );
  // A thread's calls newest finished first, as the compression gate reads its
  // last prompt size before every step: in order, not by sorting thousands.
  db.exec(
    "create index if not exists idx_llm_calls_scope_finished on llm_calls (scope_type, scope_id, coalesce(finished_at, updated_at, created_at), created_at)"
  );
  // Every call newest first, as the Logs page lists them: the first page is
  // read in order, not by sorting every call there is.
  db.exec("create index if not exists idx_llm_calls_created on llm_calls (created_at, id)");
  // A thread's steps that keep its cache (window-verdicts' anchors), newest
  // first: the step before a call is found in order, however many other
  // calls the thread has. Its condition is the anchors' own, so a read of
  // them names it in full.
  db.exec(
    "create index if not exists idx_llm_calls_anchor_steps on llm_calls (scope_id, created_at, id) " +
    "where scope_type = 'agent_thread' and purpose in ('agent_wake_step', 'agent_compression', 'agent_cache_seal') and status = 'succeeded'"
  );
  // The pricing pass's queue: calls not priced yet.
  db.exec("create index if not exists idx_llm_calls_unpriced on llm_calls (created_at) where cost_source is null");
  // The Unpriced calls by the time they were recorded: the last 30 days'
  // are priced again after the price data changes without reading every call.
  db.exec("create index if not exists idx_llm_calls_unpriced_recorded on llm_calls (created_at) where cost_source = 'unpriced'");
  // What the pricing pass saw last (settings per connection, the data
  // version) and the clears it still has to do.
  db.exec("create table if not exists pricing_seen (key text primary key, value text not null)");
}
