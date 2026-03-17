-- ============================================================
-- XWebAgent User Study — Supabase Schema
-- ============================================================
-- Run this in the Supabase SQL editor to create the two tables.
-- The serial primary key on study_sessions is the cornerstone
-- of the participant-assignment strategy (see design note below).
-- ============================================================


-- ============================================================
-- DESIGN: Batch Condition + Rolling Task Assignment
-- ============================================================
--
-- GOAL
--   Each participant does ONE condition (control OR extension).
--   Condition alternates in batches of 5.
--   Each participant gets a deterministic, non-repeating 3-task
--   slice from each 10-task feature pool.
--
-- HOW N IS ASSIGNED (race-condition safe)
--   When a participant clicks "Start Study", the client inserts
--   a row into study_sessions BEFORE anything else.
--   Postgres assigns the next serial id atomically — two
--   simultaneous inserts always receive different ids.
--   That id IS participant number N.
--
-- CONDITION BATCHING  (batch_size = 5)
--   batch_group = floor((N - 1) / 5)      -- 0-based group index
--   condition   = (batch_group % 2 == 0)   -- even → control
--                   ? 'control'
--                   : 'extension'
--
--   N=1..5  → batch 0 → control
--   N=6..10 → batch 1 → extension
--   N=11..15→ batch 2 → control
--   ...
--
-- TASK ROLLING  (pool_size = 10, tasks_per_user = 3)
--   offset = ((N - 1) * 3) % pool_size
--   user gets pool[ offset .. offset+2 ]  (wraps around)
--
--   N=1  → offset 0  → tasks 0,1,2
--   N=2  → offset 3  → tasks 3,4,5
--   N=3  → offset 6  → tasks 6,7,8
--   N=4  → offset 9  → tasks 9,0,1  (wrap)
--   N=5  → offset 2  → tasks 2,3,4
--   ...
--   Because gcd(3, 10) = 1, all 10 starting offsets appear
--   across 10 consecutive participants → full, fair coverage.
--
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- Table 1: study_sessions
--   One row per participant. The serial id becomes N.
-- ────────────────────────────────────────────────────────────

create table if not exists study_sessions (
  id               bigserial primary key,          -- participant number N (atomic, unique)
  participant_id   text        not null,            -- name entered at welcome screen
  condition_order  text        not null default 'pending',  -- 'control' | 'extension' (patched after insert)
  created_at       timestamptz not null default now()
);

-- Optional: useful index for looking up all sessions by name
create index if not exists idx_sessions_participant
  on study_sessions (participant_id);


-- ────────────────────────────────────────────────────────────
-- Table 2: study_task_results
--   One row per completed task question.
--   6 rows total per participant (3 task types × 2 questions).
-- ────────────────────────────────────────────────────────────

create table if not exists study_task_results (
  id                     bigserial    primary key,
  session_id             bigint       references study_sessions (id) on delete cascade,
  participant_id         text         not null,           -- denormalised for easier querying

  -- Position in study
  block_index            smallint     not null default 0, -- always 0 (single-block design)
  task_index             smallint     not null,           -- 0=find, 1=guide, 2=hide
  question_index         smallint     not null,           -- 0..2 within task type
  task_type              text         not null check (task_type in ('find','guide','hide')),
  condition              text         not null check (condition in ('control','extension')),

  -- Timing & answer
  time_ms                integer      not null,
  answer                 text,
  answer_correct         boolean,                        -- null for guide/hide
  question_or_task       text,                          -- the question or task text shown

  -- Post-task survey
  confidence             text,                          -- 'very'|'somewhat'|'notsure'|'guessed'
  helpfulness            text,                          -- 'very'|'somewhat'|'not'|'unused' (extension only)

  -- Chat usage (extension condition)
  chat_turn_count        integer      not null default 0,
  chat_transcript        jsonb,

  -- Hide task metrics
  hidden_count           integer      not null default 0,
  hide_recall            real,                          -- 0..1, matched/total ground-truth elements
  user_hidden_selectors  jsonb,

  -- Guide task
  guide_screenshot       text,                          -- base64 PNG, null if denied

  -- Behaviour tracking
  scroll_user_count      integer      not null default 0,
  scroll_agent_count     integer      not null default 0,
  ctrl_f_count           integer      not null default 0,
  text_select_count      integer      not null default 0,
  click_count            integer      not null default 0,
  mouse_move_px          bigint       not null default 0,
  agent_think_ms         jsonb,                          -- array of per-step LLM latencies in ms (guide task)
  page_visit_count       integer      not null default 0,
  page_visit_urls        jsonb,

  -- Raw task object for reference
  task_data              jsonb,

  created_at             timestamptz  not null default now()
);

-- Indexes for common analysis queries
create index if not exists idx_results_session
  on study_task_results (session_id);

create index if not exists idx_results_condition_type
  on study_task_results (condition, task_type);


-- ────────────────────────────────────────────────────────────
-- Row-Level Security (recommended for anon key access)
-- ────────────────────────────────────────────────────────────
-- The extension uses the anon key, so enable RLS and allow
-- INSERT from anon role only (no SELECT/UPDATE from clients).

alter table study_sessions    enable row level security;
alter table study_task_results enable row level security;

-- Allow the extension to insert sessions
create policy "anon insert sessions"
  on study_sessions for insert
  to anon with check (true);

-- Allow the extension to update its own session row (to patch condition_order)
create policy "anon update own session"
  on study_sessions for update
  to anon using (true);

-- Allow the extension to insert task results
create policy "anon insert results"
  on study_task_results for insert
  to anon with check (true);

-- Researcher reads everything via the service role key (bypasses RLS)
-- No need to add a policy for that — service role always bypasses RLS.


-- ────────────────────────────────────────────────────────────
-- Handy views for analysis
-- ────────────────────────────────────────────────────────────

-- Per-participant summary
create or replace view v_participant_summary as
select
  ss.id                                           as participant_n,
  ss.participant_id                               as name,
  ss.condition_order                              as condition,
  ss.created_at::date                             as study_date,
  count(r.id)                                     as tasks_completed,
  round(avg(r.time_ms) / 1000.0, 1)              as avg_time_sec,
  sum(case when r.answer_correct then 1 else 0 end)
    filter (where r.task_type = 'find')           as find_correct,
  round((avg(r.hide_recall) filter (where r.task_type = 'hide'))::numeric, 3)
                                                  as avg_hide_recall
from study_sessions ss
left join study_task_results r on r.session_id = ss.id
group by ss.id, ss.participant_id, ss.condition_order, ss.created_at;

-- Condition × task-type comparison (main analysis table)
create or replace view v_condition_task_stats as
select
  condition,
  task_type,
  count(*)                                        as n,
  round(avg(time_ms) / 1000.0, 1)                as avg_time_sec,
  round(stddev(time_ms) / 1000.0, 1)             as sd_time_sec,
  sum(case when answer_correct then 1 else 0 end)
    filter (where task_type = 'find')             as find_correct,
  round((avg(hide_recall) filter (where task_type = 'hide'))::numeric, 3)
                                                  as avg_hide_recall,
  round(avg(chat_turn_count)::numeric, 2)         as avg_chat_turns
from study_task_results
group by condition, task_type
order by task_type, condition;
