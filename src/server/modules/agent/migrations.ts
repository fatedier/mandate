import type { Migration } from "../../platform/db/migrations.js";

/** Overview conversations were excluded from the history search index because
 *  they have no project and no feature. They are indexed now, but every one of
 *  their existing messages carries a row in agent_message_search_skipped, and
 *  backfillAgentHistoryIndex uses that table to decide what it has already
 *  handled. Clearing those marks is what lets the backfill pick them up.
 *
 *  Deliberately does not run the backfill itself: AgentHistoryStore.search()
 *  calls backfill() on every invocation and processes them in batches, so
 *  paying ~12,500 rows inside startup would only make boot slower.
 *
 *  Scoped to main threads: a side thread is unindexable whatever its scope, so
 *  its marks are correct and clearing them would only make every later search
 *  reconsider messages it will reject again. Marks on messages that are still
 *  unindexable for another reason — a system role, a runtime-context source —
 *  are restored by the backfill the first time it looks at them. */
export const agentMigrations: Migration[] = [
  {
    // Prefixed with the declaring module's registry id, which is "agents" —
    // not the directory name. The prefix is what gives each module its own
    // slice of a primary key shared across all of them.
    id: "agents/2026-07-29-index-overview-history",
    up: (db) => {
      db.prepare(`
        delete from agent_message_search_skipped
        where message_id in (
          select m.id
          from agent_messages m
          join agent_threads t on t.id = m.thread_id
          where t.scope = 'overview' and t.kind = 'main'
        )
      `).run();
    }
  },
  {
    // Identity rename (spec 2026-08-17): overview→manager, feature→worker,
    // and the pre-existing "manager-self" self-note source becomes "self".
    // The overview-singleton partial index embeds the old value in its
    // predicate, so it is rebuilt under a NEW name — redefining an index
    // under its old name would be skipped by "if not exists".
    id: "agents/2026-08-17-agent-identity-rename",
    up: (db) => {
      db.prepare("update agent_threads set scope='manager' where scope='overview'").run();
      db.prepare("update agent_threads set scope='worker' where scope='feature'").run();
      db.prepare("update agent_tasks set channel='manager' where channel='overview'").run();
      db.prepare("update agent_tasks set source='manager' where source='overview'").run();
      for (const table of ["agent_messages", "agent_mailbox"]) {
        db.prepare(`update ${table} set source='manager' where source='overview'`).run();
        db.prepare(`update ${table} set source='self' where source='manager-self'`).run();
      }
      db.prepare("update work_items set summary_updated_by='worker' where summary_updated_by='feature-agent'").run();
      db.prepare("update work_items set summary_updated_by='manager' where summary_updated_by='overview'").run();
      db.exec("drop index if exists idx_agent_threads_overview_singleton");
      db.exec(`
        create unique index if not exists idx_agent_threads_manager_singleton
          on agent_threads(scope)
          where kind = 'main' and scope = 'manager' and archived_at is null
      `);
    }
  },
  {
    id: "agents/2026-09-15-drop-message-superseded-marker",
    up: (db) => {
      const columns = db.prepare("pragma table_info(agent_messages)").all() as Array<{ name: string }>;
      if (columns.some((column) => column.name === "superseded_by_summary_id")) {
        db.exec("alter table agent_messages drop column superseded_by_summary_id");
      }
    }
  }
];
