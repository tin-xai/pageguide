-- ============================================================
-- PageGuide User Study — Supabase Schema
-- ============================================================
-- Run this in your Supabase project's SQL editor to create the tables the study writes to.
-- The extension (sidepanel/study.js) creates one study_sessions row per participant at study
-- start, then inserts one study_task_results row per completed Find/Guide task.
--
-- Every task is done WITH the extension available (there is no without-extension control condition
-- in this study), so `condition` is a single constant label — see STUDY_CONDITION in study.js.
-- Recall ("hide") and agent columns exist so this table stays compatible with the richer
-- userstudy protocol; in the Find/Guide study user_hidden_selectors is left empty, while
-- scroll_agent_count and agent_think_ms are populated from the guide agent.
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
  notes_time_ms         integer,                         -- time from task start until Done/notes saved
  answer_time_ms        integer,                         -- time from Answer screen render until Submit
  -- answer_time_ms split at the moment the participant commits to a choice: before is reading the
  -- agent's answer and deciding, after is finding the evidence for it on the page. Null on a
  -- one-stage answer (a guide task, or a recorder's pass).
  answer_multiple_choice_ms integer,
  find_supporting_answer_ms integer,
  -- Guide tasks: the participant's verdict on a replayed trajectory. guide_errors is a list even
  -- when empty ("found no error"), so it can be told apart from null ("never asked"). Each entry is
  -- {type, steps:[n]} — steps is a list of step NUMBERS, picked from buttons rather than typed, so
  -- it needs no parsing and cannot carry "2-3" or "step 4".
  guide_answer_correct  boolean,
  -- The SCORED Q1b answer (GUIDE_PROBLEM_TYPES ids). A list even when empty, like guide_errors:
  -- "picked no problem" and "was never asked" are different findings. guide_answer_problem beside
  -- it is the optional free-text elaboration — read, never scored.
  guide_answer_problems jsonb,
  guide_answer_problem  text,
  guide_errors          jsonb,

  -- ── Scored against the trajectory's ground truth (_scoreGuideAnswer, guide_trajectories.js) ──
  -- TWO GROUPS, never averaged together: the study times them separately because they measure
  -- different things.
  --   detection    — did the participant notice it went wrong? Answerable from the agent's answer.
  --   localization — can they find WHERE? Needs the steps, so this is where grounding should tell.
  -- NULL means "not scored" (no ground truth recorded, or nothing to be precise about) and never
  -- zero — otherwise an unfinished stimulus is indistinguishable from a participant who got
  -- everything wrong, and the difference vanishes into a mean.
  score_verdict_correct    boolean,
  score_problem_precision  real,
  score_problem_recall     real,
  score_problem_exact      boolean,
  score_type_precision     real,
  score_type_recall        real,
  score_step_precision     real,
  score_step_recall        real,
  score_step_exact         boolean,
  score_no_error_agreement boolean,
  evidence_responses    jsonb,                           -- two-hop supporting paragraphs selected on the Answer screen
  answer                text,
  answer_correct        boolean,                          -- null for guide tasks (self-reported)
  question_or_task      text,                             -- the question/instruction shown
  confidence            text,
  helpfulness           text,
  chat_turn_count       integer     not null default 0,
  chat_transcript       jsonb,

  -- Recall ("hide") task field — unused by the Find/Guide study (kept for schema compatibility)
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

-- ---------- Migrations for tables that already exist ----------
-- `create table if not exists` above does nothing to a table that is already there, so every
-- column added after the first deploy has to be added again here. This matters more than it looks:
-- persistResult() posts exactly SUPABASE_TASK_COLUMNS (sidepanel/study.js), and an insert naming a
-- column the table lacks is REJECTED WHOLE. The failure is caught and logged, the result is kept
-- locally, and the study goes on looking fine while nothing reaches Supabase — so run this before
-- the next participant, not after.
-- Idempotent: safe to re-run against a table that already has them.
alter table public.study_task_results
  add column if not exists guide_answer_problems    jsonb,
  add column if not exists score_verdict_correct    boolean,
  add column if not exists score_problem_precision  real,
  add column if not exists score_problem_recall     real,
  add column if not exists score_problem_exact      boolean,
  add column if not exists score_type_precision     real,
  add column if not exists score_type_recall        real,
  add column if not exists score_step_precision     real,
  add column if not exists score_step_recall        real,
  add column if not exists score_step_exact         boolean,
  add column if not exists score_no_error_agreement boolean;

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

-- ---------- Pre-recorded agent responses (study stimuli, not results) ----------
-- The study shows every participant the SAME agent answer per (task × condition) rather than a live
-- one, so the arms differ only in what is shown. The researcher records each answer once from the
-- side panel (💾 Save on an answer); chrome.storage.local is the source of truth and this table is
-- the shareable mirror. `evidence` holds the findEvidenceShots array, including the base64 crops.
create table if not exists public.study_canned_responses (
  id              bigint generated always as identity primary key,
  task_id         text        not null,               -- id from user_study_data/tasks.json
  condition       text        not null,               -- grounding | nongrounding (older rows: grounding-visual/-text)
  url             text,
  question        text,
  answer_raw      text,                               -- WITH [N:"text"] and [ev:key] markers intact
  answer_display  text,
  evidence        jsonb,                              -- [{shot, note, index, key, source_image_id, marks}]
  highlight_count integer,
  edited          boolean     not null default false,
  recorded_at     timestamptz not null default now(),
  unique (task_id, condition)
);

-- Where each [N:"…"] citation actually points, resolved on the LIVE page when the answer was
-- recorded or when its page was captured. Added after the fact: an index number is only meaningful
-- while the run that issued it is still installed, so the site could previously do nothing but
-- search the snapshot for the quoted text — which missed phrases split across tags ("Foundation
-- series" inside an <i>) and misfired when one quote sat inside another ("El pedante"). Shape:
--   [{index, quote, tag, text, ordinal, truncated}]
alter table public.study_canned_responses add column if not exists citation_anchors jsonb;

create index if not exists idx_scr_task_condition on public.study_canned_responses (task_id, condition);

alter table public.study_canned_responses enable row level security;

-- Participants only ever READ these — playback needs select, nothing else.
create policy "anon can read canned responses"
  on public.study_canned_responses for select to anon using (true);

-- NOTE ON TRUST: the extension ships the anon key, so granting anon INSERT here would let anyone
-- holding the extension overwrite the study's stimuli. Recording is done by the researcher on their
-- own machine, so prefer running the insert from the SQL editor or with a service-role key, and let
-- the Save button fall back to "local only" when the write is refused. Uncomment the policy below
-- only if you accept that anyone with the anon key can rewrite what participants see.
-- create policy "anon can write canned responses"
--   on public.study_canned_responses for insert to anon with check (true);


-- ─────────────────────────────────────────────────────────────────────────────
-- GROUND TRUTH FOR THE SUPPORTING QUESTIONS
-- What a participant's picked sentence is scored against. One row per task, holding every accepted
-- sentence per hop — the answer can genuinely be in more than one place on a page, and marking a
-- participant wrong for pointing at the other one would be scoring the page, not the participant.
-- Authored by the researcher from the study's Answer screen, by pointing at the page.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.study_ground_truth (
  id          bigint generated always as identity primary key,
  task_id     text        not null,                   -- id from user_study_data/tasks.json
  hops        jsonb       not null,                   -- {"1": [{text, index, url}], "2": [...]}
  updated_at  timestamptz not null default now(),
  unique (task_id)
);

create index if not exists idx_sgt_task on public.study_ground_truth (task_id);

alter table public.study_ground_truth enable row level security;

-- Read-only for the extension, same reasoning as study_canned_responses above: the anon key ships
-- with the extension, so authoring writes should come from the SQL editor or a service-role key and
-- the Save button falls back to "local only" when the write is refused.
create policy "anon can read ground truth"
  on public.study_ground_truth for select to anon using (true);


-- ═════════════════════════════════════════════════════════════════════════════
-- STIMULI FOR THE BROWSER-BASED STUDY (user_study_website)
--
-- The extension reads its stimuli from disk: the Find questions from
-- user_study_data/tasks.json, the guide trajectories from chrome.storage.local.
-- A website has neither. These two tables are the published form of both, so a
-- participant can run the same study from a URL with nothing installed.
--
-- SAME TRUST MODEL as study_canned_responses above: anon may READ, anon may NOT
-- write. The extension and the site both ship the anon key, so anon INSERT here
-- would let any holder overwrite the study's stimuli mid-run. Author with the
-- SQL editor or a service-role key.
-- ═════════════════════════════════════════════════════════════════════════════

-- ---------- FIND: the questions ----------
-- Mirrors user_study_data/tasks.json. That file stays the AUTHORING format and
-- this is its published copy — two hand-editable copies of the question set is
-- exactly the drift that shows a participant a question the analysis does not
-- have.
create table if not exists public.study_tasks (
  id           text        primary key,               -- e.g. 'PEDANT-V1'
  task_type    text        not null,                  -- 'find' (guide tasks come from trajectories)
  type         text,                                  -- 'FIND X VISUAL' | 'FIND X TEXT' — the Find condition axis
  title        text,
  url          text        not null,                  -- the page the participant works on
  question     text        not null,
  answer       text,                                  -- the correct option (_gradeFindAnswer compares against this)
  distractors  jsonb,                                 -- ['…','…'] shuffled with `answer` into the choices
  in_study     boolean     not null default true,     -- hold a question back without deleting it
  task_index   smallint,                              -- display order; null sorts last
  updated_at   timestamptz not null default now()
);

create index if not exists idx_st_type on public.study_tasks (task_type, in_study);

alter table public.study_tasks enable row level security;

create policy "anon can read tasks"
  on public.study_tasks for select to anon using (true);


-- ---------- GUIDE: the captured trajectories ----------
-- The guide half has no tasks.json equivalent: a trajectory is AUTHORED in the
-- recorder (🧭 Record Guide User Study) out of a real run, so this table is its
-- only published form.
--
-- `arms` carries BOTH conditions including the base64 screenshots, already
-- downscaled to 1024px/q0.86 by _downscaleStudyShot (sidepanel/study_responses.js).
-- A 9-step run is ~1.5 MB, which is why clients fetch ONE trajectory at a time
-- rather than the whole set. Postgres TOASTs the column, so the size is fine on
-- the storage side; it is the transfer that wants care.
--
-- `ground_truth` is the researcher's own answers, in the same closed vocabularies
-- the participant answers in, so scoring is a set comparison rather than someone
-- reading two sentences and deciding whether they meant the same thing:
--   {correctness: 'success' | 'failure',
--    problems:    ['hallucinated_result' | 'incomplete' | 'could_not_complete', …],
--    problem:     'free-text elaboration — read, never scored',
--    errors:      [{type: 'loop' | 'mismatch' | 'wrong_target', steps: [3, 7]}],
--    no_error:    false}
-- no_error is the affirmative "I looked, there were none", distinct from an empty
-- errors list — which would otherwise also mean "not filled in yet", and the two
-- must not score alike.
create table if not exists public.study_guide_trajectories (
  id                text        primary key,          -- the trajectory id (its source session id)
  source_session_id text,
  goal              text        not null,             -- the task shown to the participant
  title             text,
  condition         text,                             -- 'visual' | 'text'  (GUIDE_CONDITIONS)
  in_study          boolean     not null default true,
  ground_truth      jsonb,
  arms              jsonb       not null,             -- {grounding: {…}, nongrounding: {…} | null}
  captured_at       timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists idx_sgtraj_queue on public.study_guide_trajectories (in_study, condition);

alter table public.study_guide_trajectories enable row level security;

create policy "anon can read guide trajectories"
  on public.study_guide_trajectories for select to anon using (true);

-- Uncomment ONLY on a project you are willing to let any anon-key holder rewrite.
-- The researcher's upload path uses a service-role key instead; the ⬆ button falls
-- back to "local only" when the write is refused.
-- create policy "anon can write guide trajectories"
--   on public.study_guide_trajectories for all to anon using (true) with check (true);


-- ---------- FIND: the page itself, frozen ----------
-- A Find task asks a participant to check an answer against a page. On the website that page cannot
-- be shown live, for two independent reasons:
--
--   1. Most sites refuse to be framed at all (publicdomainreview.org sends X-Frame-Options: DENY).
--   2. Worse, a cross-origin frame CANNOT BE SCRIPTED. Even where framing is allowed, we could not
--      index the page, inject highlights or scroll to a citation — so the grounded arm would be
--      indistinguishable from the non-grounded one, and the study would measure nothing.
--
-- A snapshot served from our own origin is same-origin, and therefore scriptable. `html` is a
-- fully self-contained capture: stylesheets, images and fonts inlined as data: URIs, scripts
-- stripped. It never touches the network when rendered, so it cannot change under a participant
-- and cannot phone home from inside the study.
--
-- Sizes are real: an inlined article runs 2-20 MB. Clients fetch ONE page at a time, never the set.
create table if not exists public.study_task_pages (
  task_id      text        primary key references public.study_tasks (id) on delete cascade,
  url          text,                                  -- where it was captured from
  title        text,
  html         text        not null,                  -- self-contained snapshot
  bytes        integer,                               -- size at capture, for spotting bloat
  captured_at  timestamptz not null default now()
);

-- Two tasks can share one page: MUFC-V1 and MUFC-V1-TEXT are the same Wikipedia article asked
-- under the two Find conditions. The snapshot is multi-megabyte, so storing it twice is wasteful
-- and — worse — lets the two copies drift, which would make the conditions differ in the page
-- itself rather than only in the grounding. One row per URL; clients look the page up by url when
-- a task has no row of its own.
create index if not exists idx_stp_url on public.study_task_pages (url);

alter table public.study_task_pages enable row level security;

create policy "anon can read task pages"
  on public.study_task_pages for select to anon using (true);
