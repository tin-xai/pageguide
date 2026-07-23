-- ============================================================
-- PageGuide User Study — Supabase Schema
-- ============================================================
-- Run this in your Supabase project's SQL editor to create the table the study writes to.
-- Every row is one completed Find or Guide task, always done with PageGuide (there is no
-- without-extension control condition in this study — see user_study_data/README.md).
-- ============================================================

create table if not exists study_task_results (
  id                 bigserial    primary key,
  inserted_at        timestamptz  not null default now(),

  tool               text         not null default 'pageguide', -- lets you union this with
                                                                  -- exports from other agents/tools
                                                                  -- doing the same task list
  participant_id     text         not null,
  task_index         smallint     not null,           -- 0-based position in the session's queue
  total_tasks        smallint     not null,
  task_id            text         not null,           -- matches the "id" field in tasks.json
  task_type          text         not null check (task_type in ('find','guide')),
  question_or_task   text,                             -- the question/instruction text shown
  url                text,

  -- Timing & answer
  time_ms            integer      not null,
  answer             text,
  answer_correct     boolean,                          -- null for guide tasks (self-reported only)

  -- Post-task survey
  confidence         text,                             -- 'very'|'somewhat'|'notsure'|'guessed'
  helpfulness        text,                             -- 'very'|'somewhat'|'not'|'unused'

  -- Chat usage
  chat_turn_count     integer     not null default 0,
  chat_transcript     jsonb,

  -- Interaction/behavior tracking (content/study_tracker.js via the background service worker)
  scroll_count        integer     not null default 0,
  ctrl_f_count        integer     not null default 0,
  text_select_count   integer     not null default 0,
  click_count         integer     not null default 0,
  mouse_move_px       integer     not null default 0,
  page_visit_count    integer     not null default 0,
  page_visit_urls     jsonb,

  guide_screenshot    text,                             -- base64 jpeg, guide tasks only, optional

  completed_at        timestamptz
);

create index if not exists idx_study_results_participant on study_task_results (participant_id);
create index if not exists idx_study_results_task on study_task_results (task_id);

-- Row Level Security: the anon key used by the extension should only be able to INSERT, never
-- read/update/delete other participants' rows. Adjust to taste in the Supabase dashboard.
alter table study_task_results enable row level security;

create policy "Allow anonymous inserts" on study_task_results
  for insert
  to anon
  with check (true);
