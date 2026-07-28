-- ============================================================
-- PageGuide User Study — Supabase Schema
-- ============================================================
-- Run this in your Supabase project's SQL editor to create the tables the study writes to.
-- The extension (sidepanel/study.js) creates one study_sessions row per participant at study
-- start, then inserts one study_task_results row per completed Find/Guide task.
--
-- Every task is done WITH the extension available (there is no without-extension control condition
-- in this study), so `condition` is a single constant label — see STUDY_CONDITION in study.js.
-- Recall ("hide") columns and agent columns exist so this table stays compatible with the richer
-- userstudy protocol; in the Find/Guide study hidden_count/hide_recall/user_hidden_selectors are
-- left empty, while scroll_agent_count and agent_think_ms are populated from the guide agent.
-- ============================================================

-- ---------- Parent table: one row per participant/session ----------
create table if not exists public.study_sessions (
  id              bigint generated always as identity primary key,
  participant_id  text        not null,
  condition_order text        not null,
  created_at      timestamptz not null default now()
);

-- ---------- Child table: one row per completed Find/Guide task ----------
create table if not exists public.study_task_results (
  id                    bigint generated always as identity primary key,
  session_id            bigint      references public.study_sessions (id) on delete cascade,
  participant_id        text        not null,
  block_index           smallint    not null,            -- single block in the Find/Guide study (0)
  task_index            smallint    not null,            -- 0-based position in the session's queue
  question_index        smallint    not null,            -- 0-based index within the task's own type
  task_type             text        not null,            -- 'find' | 'guide'
  condition             text        not null,            -- constant label (see STUDY_CONDITION)
  time_ms               integer     not null,
  answer                text,
  answer_correct        boolean,                          -- null for guide tasks (self-reported)
  question_or_task      text,                             -- the question/instruction shown
  confidence            text,
  helpfulness           text,
  chat_turn_count       integer     not null default 0,
  chat_transcript       jsonb,

  -- Recall ("hide") task fields — unused by the Find/Guide study (kept for schema compatibility)
  hidden_count          integer     not null default 0,
  hide_recall           real,
  user_hidden_selectors jsonb,

  guide_screenshot      text,                             -- optional base64 capture for guide tasks

  -- Interaction/behavior tracking (content/study_tracker.js via the background service worker)
  scroll_user_count     integer     not null default 0,
  scroll_agent_count    integer     not null default 0,  -- PageGuide's programmatic scrolls
  ctrl_f_count          integer     not null default 0,
  text_select_count     integer     not null default 0,
  click_count           integer     not null default 0,
  mouse_move_px         bigint      not null default 0,
  agent_think_ms        jsonb,                            -- [ms, …], one per agent LLM turn
  page_visit_count      integer     not null default 0,
  page_visit_urls       jsonb,

  task_data             jsonb,                            -- the full task object from tasks.json
  created_at            timestamptz not null default now()
);

-- ---------- Indexes ----------
create index if not exists idx_str_session_id     on public.study_task_results (session_id);
create index if not exists idx_str_participant    on public.study_task_results (participant_id);
create index if not exists idx_str_condition_task on public.study_task_results (condition, task_type);
create index if not exists idx_sessions_participant on public.study_sessions (participant_id);

-- ---------- Row Level Security ----------
alter table public.study_sessions     enable row level security;
alter table public.study_task_results enable row level security;

-- The extension ships the anon (publishable) key, so the anon role needs INSERT.
create policy "anon can insert sessions"
  on public.study_sessions     for insert to anon with check (true);

create policy "anon can insert task results"
  on public.study_task_results for insert to anon with check (true);

-- Optional: allow the anon role to read back the inserted session row so study.js can capture the
-- generated session_id and link task rows to it. Without this, inserts still succeed but
-- session_id is logged as null. Restrict/remove if you don't want anon reads.
create policy "anon can read own sessions"
  on public.study_sessions     for select to anon using (true);
