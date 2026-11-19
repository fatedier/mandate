import type { Database } from "bun:sqlite";

/**
 * Learned skills: procedures agents keep for kinds of work that come back,
 * one per row, global (scope 'user', as memory names its global partition)
 * or one project's. Every change is a revision in learned_skill_versions
 * (the latest 30 and the first are kept); one action over several skills
 * shares a change_id, recorded in learned_skill_actions for good, so a
 * revert takes the whole action back. Uses are the
 * loads by the `skill` tool. Reviews of finished work are queued and recorded
 * in skill_review_runs; skill_review_marks says how far a thread's work was
 * reviewed.
 */
export function initializeLearnedSkillsSchema(db: Database): void {
  db.exec(`
    create table if not exists learned_skills (
      id              text primary key,
      name            text not null,
      description     text not null,
      body            text not null,
      scope           text not null check (scope in ('user', 'project')),
      project_id      text,
      status          text not null default 'available' check (status in ('available', 'archived')),
      revision        integer not null,
      created_at      text not null,
      updated_at      text not null,
      last_used_at    text,
      archived_reason text,
      absorbed_into   text,
      check ((scope = 'user' and project_id is null) or (scope = 'project' and project_id is not null))
    );
    create unique index if not exists idx_learned_skills_name on learned_skills(name);
    create index if not exists idx_learned_skills_where on learned_skills(scope, project_id, status);
    create index if not exists idx_learned_skills_status on learned_skills(status);

    create table if not exists learned_skill_versions (
      skill_id        text not null,
      revision        integer not null,
      name            text not null,
      description     text not null,
      body            text not null,
      status          text not null,
      scope           text not null,
      project_id      text,
      archived_reason text,
      absorbed_into   text,
      change          text not null check (change in ('create', 'patch', 'rewrite', 'revert', 'archive', 'restore', 'merge', 'move')),
      by_actor        text not null check (by_actor in ('agent', 'review', 'dream', 'rule')),
      thread_id       text,
      run_id          text,
      change_id       text not null,
      reason          text,
      at              text not null,
      primary key (skill_id, revision)
    );

    -- Which revisions each action wrote, kept after the old revisions' text
    -- goes: what a revert of an action must take back, and what blocks it.
    create table if not exists learned_skill_actions (
      change_id text not null,
      skill_id  text not null,
      revision  integer not null,
      primary key (change_id, skill_id, revision)
    );

    create table if not exists learned_skill_uses (
      skill_id  text not null,
      at        text not null,
      thread_id text,
      agent     text not null
    );
    create index if not exists idx_learned_skill_uses_skill_at on learned_skill_uses(skill_id, at);

    create table if not exists skill_review_marks (
      thread_id       text primary key,
      reviewed_to_seq integer not null,
      at              text not null
    );

    create table if not exists skill_review_runs (
      id            text primary key,
      thread_id     text not null,
      requested_by  text,
      focus         text,
      from_seq      integer not null,
      to_seq        integer not null,
      status        text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped')),
      provider      text,
      model         text,
      outcome       text check (outcome in ('none', 'created', 'changed', 'restored')),
      skill_id      text,
      revision      integer,
      reason        text,
      error         text,
      created_at    text not null,
      started_at    text,
      finished_at   text,
      metadata_json text
    );
    create index if not exists idx_skill_review_runs_status on skill_review_runs(status, created_at);
    create index if not exists idx_skill_review_runs_thread on skill_review_runs(thread_id, status);
    create index if not exists idx_skill_review_runs_created on skill_review_runs(created_at);

    -- The weekly tidy of all learned skills. Its changes are the version
    -- rows that carry its id (run_id).
    create table if not exists skill_tidy_runs (
      id            text primary key,
      status        text not null check (status in ('running', 'succeeded', 'failed')),
      provider      text,
      model         text,
      changes       integer not null default 0,
      reason        text,
      error         text,
      created_at    text not null,
      started_at    text not null,
      finished_at   text,
      metadata_json text
    );
    create index if not exists idx_skill_tidy_runs_started on skill_tidy_runs(started_at);
  `);
}
