-- PageGuide V2 — complete from-scratch schema for Find AND Guide
-- ============================================================================
-- Run this ENTIRE file, once, in the SQL editor of a blank Supabase project.
-- It creates everything V2 needs and touches none of the V1 `study_*` tables,
-- so the original study can keep running in its own project untouched.
--
-- After running it, set the Admin password (it is deliberately not settable
-- from the browser):
--
--   select public.set_pageguide_find_v2_admin_password('a long private password');
--
-- WHAT V2 CHANGES, FOR BOTH TASK TYPES
--
-- Every item carries FOUR authored agent answers rather than one:
--
--                   grounded                    non-grounded
--   correct         correct_grounding           correct_nongrounding
--   incorrect       incorrect_grounding         incorrect_nongrounding
--
-- Each cell has its own answer text AND its own references, because an
-- incorrect answer is not a correct one with the citations deleted, and a
-- non-grounded answer is not a grounded one with the brackets stripped. Both
-- are study variables, so both are written rather than derived.
--
-- Which cell a participant is dealt is counterbalanced on both axes from their
-- assignment slot: variant (slot + queue position) % 4 walks
-- correct/grounded -> correct/non-grounded -> incorrect/grounded ->
-- incorrect/non-grounded. The judgment is scored against the answer that was
-- SHOWN, recorded in `variant_key`, not against a fixed property of the row.
--
-- WHERE FIND AND GUIDE DIFFER
--
--   Find  — stimulus is a saved page; the participant answers Yes/No and then
--           points at the passage or image that supports the judgment.
--   Guide — stimulus is the agent's recorded run; the participant gives a
--           verdict and then the full V1 taxonomy: which problems occurred,
--           a free-text problem, and the {step, type} pairs where it went
--           wrong. Those are scored exactly as V1 scored them.
--
-- The names below are the ones the shipped client already calls. Do not rename
-- them without changing app/find_v2_supabase.js to match.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;


-- ── Shared: settings ────────────────────────────────────────────────────────
-- Private. No anon policy and no direct grants: the password hash is read only
-- inside SECURITY DEFINER functions. The browser never holds a service-role
-- key, and the admin password lives only in one browser tab's sessionStorage.
create table if not exists public.pageguide_find_v2_settings (
  singleton           boolean primary key default true check (singleton),
  admin_password_hash text,
  next_assignment     bigint not null default 0,
  updated_at          timestamptz not null default now()
);

insert into public.pageguide_find_v2_settings (singleton)
values (true)
on conflict (singleton) do nothing;


-- ── Shared: sessions ────────────────────────────────────────────────────────
-- One row per sitting, covering BOTH task types: a participant does one queue,
-- and `assignment_slot` counterbalances it. The name is historical (V2 began as
-- Find-only) and is kept because the client calls it; the table is not
-- Find-specific and Guide results reference it too.
create table if not exists public.pageguide_find_v2_sessions (
  id                bigint generated always as identity primary key,
  participant_id    text not null,
  assignment_slot   bigint not null,
  condition_order   text not null,
  created_at        timestamptz not null default now()
);


-- ── Find: items ─────────────────────────────────────────────────────────────
-- One row per Find question. The page snapshot is stored with the item so a
-- blank project is self-contained; queue queries name their columns explicitly
-- and omit `page_html`, so the multi-megabyte page is fetched only when its
-- task actually opens.
create table if not exists public.pageguide_find_v2_claims (
  id                    text primary key,
  source_task_id        text,
  title                 text,
  url                   text not null default '',
  task_style            text not null default 'find_text'
                          check (task_style in ('find_text', 'find_visual')),
  question              text not null default '',
  -- The four authored answers:
  --   { "correct_grounding": {"answer_text": "...",
  --                           "citation_anchors": [], "evidence": []},
  --     "correct_nongrounding": {...}, "incorrect_grounding": {...},
  --     "incorrect_nongrounding": {...} }
  answer_variants       jsonb not null default '{}'::jsonb,
  -- 'balanced' lets the slot counterbalance the correctness axis. The pinned
  -- modes are for an item with only one defensible key — e.g. one where no
  -- plausible wrong answer could be written.
  correctness_mode      text not null default 'balanced'
                          check (correctness_mode in ('balanced', 'always_correct', 'always_incorrect')),
  -- Where the supporting passage or image actually is. Shared by all four
  -- answers: it does not change with the answer shown, so the evidence question
  -- is scored the same way in every cell.
  evidence_ground_truth jsonb not null default '{}'::jsonb,
  -- Legacy single-answer columns. Kept so a row authored before the four-answer
  -- editor still plays, and as the last fallback when a variant is blank.
  answer_text           text not null default '',
  claim_correct         boolean not null default true,
  evidence              jsonb not null default '[]'::jsonb,
  citation_anchors      jsonb not null default '[]'::jsonb,
  page_title            text,
  page_html             text not null default '',
  page_bytes            integer,
  in_study              boolean not null default false,
  task_index            integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);


-- ── Guide: items ────────────────────────────────────────────────────────────
-- One row per Guide task. The stimulus is the agent's recorded run rather than
-- a page: `trajectory` holds the ordered steps and their screenshots, in the
-- shape app/trajectory_edit.js already reads.
--
-- `guide_ground_truth` is what the participant's taxonomy answer is scored
-- against, and is deliberately SEPARATE from `answer_variants`: the four
-- authored answers vary the agent's stated conclusion, while the run itself —
-- and therefore which step actually went wrong — is one fixed thing.
create table if not exists public.pageguide_guide_v2_tasks (
  id                    text primary key,
  source_task_id        text,
  -- The id of the capture in the recorder's own bank. Equal to source_task_id for anything the
  -- extension publishes; kept as its own column because it is what the rows seeded by hand are
  -- keyed to, and therefore what a re-publish matches on. See supabase_migration_guide_v2_arms.sql.
  source_trajectory_id  text,
  title                 text,
  url                   text not null default '',
  task_style            text not null default 'guide_text'
                          check (task_style in ('guide_text', 'guide_visual')),
  -- What the agent was asked to do, shown to the participant as the task.
  goal                  text not null default '',
  -- The four authored final answers, same shape and same rules as Find.
  answer_variants       jsonb not null default '{}'::jsonb,
  correctness_mode      text not null default 'balanced'
                          check (correctness_mode in ('balanced', 'always_correct', 'always_incorrect')),
  -- THE STIMULUS. Both copies of the run, in the recorder's own shape:
  --   { "grounding":    { steps: [...], initial_state, final_state, answer, answer_evidence, ... },
  --     "nongrounding": the same run with every screenshot and evidence marker stripped }
  -- This is what the site renders. It is also the only place the initial/final bookends live —
  -- they have no column of their own, and they are what tells a participant whether the task got
  -- done, so a row without `arms` has no trajectory to show.
  arms                  jsonb not null default '{}'::jsonb,
  -- An older flattened view of the same steps: [{ "index": 0, "action": "...", "screenshot": "…",
  -- "url": "...", "note": "..." }, ...]. Empty on rows that keep their run in `arms`.
  trajectory            jsonb not null default '[]'::jsonb,
  trajectory_bytes      integer,
  step_count            integer not null default 0,
  -- The answer key for the taxonomy questions:
  --   { "correct": false,
  --     "problems": ["wrong_element", ...],
  --     "errors": [{"step": 4, "type": "wrong_click"}, ...] }
  guide_ground_truth    jsonb not null default '{}'::jsonb,
  -- Did the run actually finish the task? The scored verdict, and the same fact as
  -- guide_ground_truth -> 'correct'.
  agent_completed       boolean,
  -- Did the agent SAY it finished? Deliberately separate: an agent that failed and announced
  -- success is the hallucinated-result case, and it is only distinguishable from an agent that
  -- failed and said so if both facts are recorded. Nullable — unset means "not authored yet",
  -- which must not read as false.
  claims_completion     boolean,
  in_study              boolean not null default false,
  task_index            integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);


-- ── Find: results ───────────────────────────────────────────────────────────
-- One row per submitted Find judgment.
create table if not exists public.pageguide_find_v2_results (
  id                         bigint generated always as identity primary key,
  result_key                 text not null unique,
  client_run_id              text,
  session_id                 bigint references public.pageguide_find_v2_sessions (id) on delete cascade,
  participant_id             text not null,
  claim_id                   text not null references public.pageguide_find_v2_claims (id),
  task_index                 integer not null,
  question_index             integer not null,
  task_style                 text not null,
  condition                  text not null check (condition in ('grounding', 'nongrounding')),
  -- Which of the four authored answers this participant actually saw.
  -- `condition` is the grounding half of the same variant, kept as its own
  -- column so plain by-arm queries stay readable.
  variant_key                text not null default 'correct_grounding'
                               check (variant_key in ('correct_grounding', 'correct_nongrounding',
                                                      'incorrect_grounding', 'incorrect_nongrounding')),
  question                   text not null,
  -- The answer text as shown. Stored per result because the item can be
  -- re-authored later, and a verdict is only interpretable against the exact
  -- wording that produced it.
  claim_text_snapshot        text not null,
  claim_correct_snapshot     boolean not null,
  participant_verdict        boolean not null,
  verdict_correct            boolean not null,
  answer_time_ms             integer not null,
  verdict_time_ms            integer,
  evidence_time_ms           integer,
  evidence_responses         jsonb not null default '[]'::jsonb,
  score_evidence_precision   real,
  score_evidence_recall      real,
  score_evidence_exact       boolean,
  score_evidence_hop_exact   jsonb,
  confidence                 text,
  helpfulness                text,
  notes                      text,
  interaction_summary        jsonb,
  -- Nullable and NOT defaulted to zero: a row whose instrumentation never
  -- started observed nothing, and a 0 would average in as a participant who sat
  -- perfectly still rather than as the missing measurement it is.
  scroll_user_count          integer,
  ctrl_f_count               integer,
  text_select_count          integer,
  click_count                integer,
  mouse_move_px              integer,
  created_at                 timestamptz not null default now()
);


-- ── Guide: results ──────────────────────────────────────────────────────────
-- One row per submitted Guide judgment. The verdict and the four-variant
-- columns line up with Find so the two can be pooled; everything from
-- `guide_answer_problems` down is V1's error taxonomy and its scores, kept
-- exactly as V1 recorded them.
create table if not exists public.pageguide_guide_v2_results (
  id                         bigint generated always as identity primary key,
  result_key                 text not null unique,
  client_run_id              text,
  session_id                 bigint references public.pageguide_find_v2_sessions (id) on delete cascade,
  participant_id             text not null,
  task_id                    text not null references public.pageguide_guide_v2_tasks (id),
  task_index                 integer not null,
  question_index             integer not null,
  task_style                 text not null,
  condition                  text not null check (condition in ('grounding', 'nongrounding')),
  variant_key                text not null default 'correct_grounding'
                               check (variant_key in ('correct_grounding', 'correct_nongrounding',
                                                      'incorrect_grounding', 'incorrect_nongrounding')),
  goal                       text not null default '',
  answer_text_snapshot       text not null default '',
  answer_correct_snapshot    boolean not null,
  -- The taxonomy answer, as given.
  guide_answer_correct       boolean,
  guide_answer_problems      jsonb not null default '[]'::jsonb,
  guide_answer_problem       text,
  guide_errors               jsonb not null default '[]'::jsonb,
  -- Timing, split the same way Find splits it.
  time_ms                    integer not null,
  answer_time_ms             integer,
  verdict_time_ms            integer,
  localization_time_ms       integer,
  -- Scores against `guide_ground_truth`, computed client-side by
  -- window._scoreGuideAnswer and stored rather than recomputed.
  score_verdict_correct      boolean,
  score_problem_precision    real,
  score_problem_recall       real,
  score_problem_exact        boolean,
  score_type_precision       real,
  score_type_recall          real,
  score_step_precision       real,
  score_step_recall          real,
  score_step_exact           boolean,
  score_no_error_agreement   boolean,
  confidence                 text,
  helpfulness                text,
  notes                      text,
  interaction_summary        jsonb,
  scroll_user_count          integer,
  ctrl_f_count               integer,
  text_select_count          integer,
  click_count                integer,
  mouse_move_px              integer,
  created_at                 timestamptz not null default now()
);


-- ── Indexes ─────────────────────────────────────────────────────────────────
create index if not exists idx_pg_find_v2_claim_queue
  on public.pageguide_find_v2_claims (in_study, task_index, id);
create index if not exists idx_pg_find_v2_claim_correct
  on public.pageguide_find_v2_claims (correctness_mode, task_style);

create index if not exists idx_pg_guide_v2_task_queue
  on public.pageguide_guide_v2_tasks (in_study, task_index, id);
create index if not exists idx_pg_guide_v2_task_correct
  on public.pageguide_guide_v2_tasks (correctness_mode, task_style);

create index if not exists idx_pg_find_v2_result_session
  on public.pageguide_find_v2_results (session_id);
create index if not exists idx_pg_find_v2_result_claim
  on public.pageguide_find_v2_results (claim_id, condition);
create index if not exists idx_pg_find_v2_result_variant
  on public.pageguide_find_v2_results (variant_key, task_style);
create index if not exists idx_pg_find_v2_result_created
  on public.pageguide_find_v2_results (created_at desc);

create index if not exists idx_pg_guide_v2_result_session
  on public.pageguide_guide_v2_results (session_id);
create index if not exists idx_pg_guide_v2_result_task
  on public.pageguide_guide_v2_results (task_id, condition);
create index if not exists idx_pg_guide_v2_result_variant
  on public.pageguide_guide_v2_results (variant_key, task_style);
create index if not exists idx_pg_guide_v2_result_created
  on public.pageguide_guide_v2_results (created_at desc);


-- ── Row level security ──────────────────────────────────────────────────────
-- Participants read stimuli and write their own results. Nothing else.
--
-- Results are protected twice over: `anon` holds no SELECT privilege on them
-- (revoked below, because Supabase's schema defaults may have granted it), and
-- they carry no SELECT policy under RLS. Admin reads them through a
-- password-checked function, so a leaked anon key cannot download the dataset.
alter table public.pageguide_find_v2_claims   enable row level security;
alter table public.pageguide_guide_v2_tasks   enable row level security;
alter table public.pageguide_find_v2_sessions enable row level security;
alter table public.pageguide_find_v2_results  enable row level security;
alter table public.pageguide_guide_v2_results enable row level security;
alter table public.pageguide_find_v2_settings enable row level security;

-- Revoke first, explicitly. A Supabase project grants broad default privileges
-- on the public schema to `anon`, so a freshly created table can arrive with
-- SELECT already granted. Withholding a grant is therefore NOT enough to keep
-- results private here — the grant has to be taken away. RLS with no select
-- policy is the second lock; this is the first, and neither depends on the
-- other. Verified against the live project: without this, a select on the
-- results tables returns 200 rather than a permission error.
revoke all on public.pageguide_find_v2_results  from anon;
revoke all on public.pageguide_guide_v2_results from anon;
revoke all on public.pageguide_find_v2_sessions from anon;
revoke all on public.pageguide_find_v2_settings from anon;

grant select on public.pageguide_find_v2_claims to anon;
grant select on public.pageguide_guide_v2_tasks to anon;
grant insert, update on public.pageguide_find_v2_results to anon;
grant insert, update on public.pageguide_guide_v2_results to anon;
grant usage, select on sequence public.pageguide_find_v2_results_id_seq to anon;
grant usage, select on sequence public.pageguide_guide_v2_results_id_seq to anon;

drop policy if exists "anon reads Find V2 claims" on public.pageguide_find_v2_claims;
create policy "anon reads Find V2 claims"
  on public.pageguide_find_v2_claims for select to anon using (true);

drop policy if exists "anon reads Guide V2 tasks" on public.pageguide_guide_v2_tasks;
create policy "anon reads Guide V2 tasks"
  on public.pageguide_guide_v2_tasks for select to anon using (true);

drop policy if exists "anon inserts Find V2 results" on public.pageguide_find_v2_results;
create policy "anon inserts Find V2 results"
  on public.pageguide_find_v2_results for insert to anon with check (true);

-- Update is granted only so a retried submission can land on the same
-- `result_key` instead of failing; it is not a general edit permission.
drop policy if exists "anon updates Find V2 result retries" on public.pageguide_find_v2_results;
create policy "anon updates Find V2 result retries"
  on public.pageguide_find_v2_results for update to anon using (true) with check (true);

drop policy if exists "anon inserts Guide V2 results" on public.pageguide_guide_v2_results;
create policy "anon inserts Guide V2 results"
  on public.pageguide_guide_v2_results for insert to anon with check (true);

drop policy if exists "anon updates Guide V2 result retries" on public.pageguide_guide_v2_results;
create policy "anon updates Guide V2 result retries"
  on public.pageguide_guide_v2_results for update to anon using (true) with check (true);


-- ── Admin password ──────────────────────────────────────────────────────────
-- Run this yourself in the SQL editor after installing the schema:
--
--   select public.set_pageguide_find_v2_admin_password('a long private password');
--
-- It is deliberately not executable by the browser roles.
create or replace function public.set_pageguide_find_v2_admin_password(p_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if length(coalesce(p_password, '')) < 12 then
    raise exception 'The V2 admin password must be at least 12 characters.';
  end if;

  update public.pageguide_find_v2_settings
  set admin_password_hash = encode(digest(p_password, 'sha256'), 'hex'),
      updated_at = now()
  where singleton = true;
end;
$$;

revoke all on function public.set_pageguide_find_v2_admin_password(text) from public, anon, authenticated;

create or replace function public.pageguide_find_v2_require_admin(p_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  expected_hash text;
begin
  select admin_password_hash into expected_hash
  from public.pageguide_find_v2_settings
  where singleton = true;

  if expected_hash is null then
    raise exception 'V2 admin password is not configured. Run set_pageguide_find_v2_admin_password in the SQL editor.'
      using errcode = '28000';
  end if;

  if encode(digest(coalesce(p_password, ''), 'sha256'), 'hex') <> expected_hash then
    raise exception 'Incorrect V2 admin password.' using errcode = '28000';
  end if;
end;
$$;

revoke all on function public.pageguide_find_v2_require_admin(text) from public, anon, authenticated;

-- A lightweight login check for the Admin panel.
create or replace function public.pageguide_find_v2_admin_check(p_password text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.pageguide_find_v2_require_admin(p_password);
  return true;
end;
$$;

grant execute on function public.pageguide_find_v2_admin_check(text) to anon;


-- ── Normalizing the four authored answers ───────────────────────────────────
-- Shared by both save functions. The browser may send extra keys, missing keys,
-- or a string where an object belongs; a queue query that meets any of those at
-- run time fails in front of a participant, so the shape is rebuilt here rather
-- than trusted. Browser validation is guidance, not an authorization boundary.
create or replace function public.pageguide_v2_normalize_variants(p_in jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_in jsonb := case when jsonb_typeof(p_in) = 'object' then p_in else '{}'::jsonb end;
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_one jsonb;
begin
  foreach v_key in array array['correct_grounding', 'correct_nongrounding',
                               'incorrect_grounding', 'incorrect_nongrounding']
  loop
    v_one := case when jsonb_typeof(v_in -> v_key) = 'object' then v_in -> v_key else '{}'::jsonb end;
    v_out := v_out || jsonb_build_object(v_key, jsonb_build_object(
      'answer_text', coalesce(btrim(v_one ->> 'answer_text'), ''),
      'citation_anchors', case when jsonb_typeof(v_one -> 'citation_anchors') = 'array'
                               then v_one -> 'citation_anchors' else '[]'::jsonb end,
      'evidence', case when jsonb_typeof(v_one -> 'evidence') = 'array'
                       then v_one -> 'evidence' else '[]'::jsonb end));
  end loop;
  return v_out;
end;
$$;

-- The cells an item can actually be dealt under a given mode. A live item must
-- have text for every one of them: refusing that here is the difference between
-- an authoring mistake and a participant reaching a task with a blank answer.
create or replace function public.pageguide_v2_assert_authored(p_variants jsonb, p_mode text)
returns void
language plpgsql
immutable
as $$
declare
  v_key text;
  v_needed text[] := case p_mode
    when 'always_correct' then array['correct_grounding', 'correct_nongrounding']
    when 'always_incorrect' then array['incorrect_grounding', 'incorrect_nongrounding']
    else array['correct_grounding', 'correct_nongrounding',
               'incorrect_grounding', 'incorrect_nongrounding']
  end;
begin
  foreach v_key in array v_needed loop
    if coalesce(p_variants #>> array[v_key, 'answer_text'], '') = '' then
      raise exception 'A live item needs an authored answer for %. Write it, or pin correctness_mode.', v_key;
    end if;
  end loop;
end;
$$;


-- ── Save a Find item ────────────────────────────────────────────────────────
create or replace function public.save_pageguide_find_v2_claim(
  p_password text,
  p_claim jsonb
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id text := nullif(btrim(p_claim ->> 'id'), '');
  v_style text := coalesce(nullif(btrim(p_claim ->> 'task_style'), ''), 'find_text');
  v_question text := coalesce(btrim(p_claim ->> 'question'), '');
  v_url text := coalesce(btrim(p_claim ->> 'url'), '');
  v_in_study boolean := coalesce((p_claim ->> 'in_study')::boolean, false);
  v_page_html text := coalesce(p_claim ->> 'page_html', '');
  v_mode text := coalesce(nullif(btrim(p_claim ->> 'correctness_mode'), ''), 'balanced');
  v_variants jsonb;
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if v_id is null or v_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$' then
    raise exception 'Item id must be 2-80 characters using letters, numbers, dot, dash, or underscore.';
  end if;
  if v_style not in ('find_text', 'find_visual') then
    raise exception 'task_style must be find_text or find_visual.';
  end if;
  if v_mode not in ('balanced', 'always_correct', 'always_incorrect') then
    raise exception 'correctness_mode must be balanced, always_correct, or always_incorrect.';
  end if;

  v_variants := public.pageguide_v2_normalize_variants(p_claim -> 'answer_variants');

  if v_in_study then
    perform public.pageguide_v2_assert_authored(v_variants, v_mode);
    if v_question = '' or v_url = '' or v_page_html = '' then
      raise exception 'A live Find item needs a question, URL, and captured page HTML.';
    end if;
  end if;

  insert into public.pageguide_find_v2_claims (
    id, source_task_id, title, url, task_style, question, answer_variants, correctness_mode,
    evidence_ground_truth, answer_text, claim_correct, evidence, citation_anchors,
    page_title, page_html, page_bytes, in_study, task_index, updated_at
  ) values (
    v_id,
    nullif(btrim(p_claim ->> 'source_task_id'), ''),
    nullif(btrim(p_claim ->> 'title'), ''),
    v_url,
    v_style,
    v_question,
    v_variants,
    v_mode,
    case when jsonb_typeof(p_claim -> 'evidence_ground_truth') = 'object'
         then p_claim -> 'evidence_ground_truth' else '{}'::jsonb end,
    -- The legacy columns mirror the grounded variant of the key this item leans
    -- to, so anything still reading them sees one coherent answer.
    case when v_mode = 'always_incorrect'
         then coalesce(v_variants #>> array['incorrect_grounding', 'answer_text'], '')
         else coalesce(v_variants #>> array['correct_grounding', 'answer_text'], '') end,
    v_mode <> 'always_incorrect',
    case when v_mode = 'always_incorrect'
         then coalesce(v_variants #> array['incorrect_grounding', 'evidence'], '[]'::jsonb)
         else coalesce(v_variants #> array['correct_grounding', 'evidence'], '[]'::jsonb) end,
    case when v_mode = 'always_incorrect'
         then coalesce(v_variants #> array['incorrect_grounding', 'citation_anchors'], '[]'::jsonb)
         else coalesce(v_variants #> array['correct_grounding', 'citation_anchors'], '[]'::jsonb) end,
    nullif(btrim(p_claim ->> 'page_title'), ''),
    v_page_html,
    length(convert_to(v_page_html, 'UTF8')),
    v_in_study,
    coalesce((p_claim ->> 'task_index')::integer, 0),
    now()
  )
  on conflict (id) do update set
    source_task_id = excluded.source_task_id,
    title = excluded.title,
    url = excluded.url,
    task_style = excluded.task_style,
    question = excluded.question,
    answer_variants = excluded.answer_variants,
    correctness_mode = excluded.correctness_mode,
    evidence_ground_truth = excluded.evidence_ground_truth,
    answer_text = excluded.answer_text,
    claim_correct = excluded.claim_correct,
    evidence = excluded.evidence,
    citation_anchors = excluded.citation_anchors,
    page_title = excluded.page_title,
    page_html = excluded.page_html,
    page_bytes = excluded.page_bytes,
    in_study = excluded.in_study,
    task_index = excluded.task_index,
    updated_at = now();

  return v_id;
end;
$$;

grant execute on function public.save_pageguide_find_v2_claim(text, jsonb) to anon;


-- ── Save a Guide item ───────────────────────────────────────────────────────
-- SUPERSEDED by supabase_migration_guide_v2_arms.sql, which teaches it the four columns above.
-- The version below writes neither `arms` nor `source_trajectory_id`, so it produces rows the site
-- cannot render; it is kept here only so this file still reads as one whole schema.
create or replace function public.save_pageguide_guide_v2_task(
  p_password text,
  p_task jsonb
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id text := nullif(btrim(p_task ->> 'id'), '');
  v_style text := coalesce(nullif(btrim(p_task ->> 'task_style'), ''), 'guide_text');
  v_goal text := coalesce(btrim(p_task ->> 'goal'), '');
  v_in_study boolean := coalesce((p_task ->> 'in_study')::boolean, false);
  v_mode text := coalesce(nullif(btrim(p_task ->> 'correctness_mode'), ''), 'balanced');
  v_traj jsonb := case when jsonb_typeof(p_task -> 'trajectory') = 'array'
                       then p_task -> 'trajectory' else '[]'::jsonb end;
  v_gt jsonb := case when jsonb_typeof(p_task -> 'guide_ground_truth') = 'object'
                     then p_task -> 'guide_ground_truth' else '{}'::jsonb end;
  v_variants jsonb;
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if v_id is null or v_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$' then
    raise exception 'Item id must be 2-80 characters using letters, numbers, dot, dash, or underscore.';
  end if;
  if v_style not in ('guide_text', 'guide_visual') then
    raise exception 'task_style must be guide_text or guide_visual.';
  end if;
  if v_mode not in ('balanced', 'always_correct', 'always_incorrect') then
    raise exception 'correctness_mode must be balanced, always_correct, or always_incorrect.';
  end if;

  v_variants := public.pageguide_v2_normalize_variants(p_task -> 'answer_variants');

  if v_in_study then
    perform public.pageguide_v2_assert_authored(v_variants, v_mode);
    if v_goal = '' then
      raise exception 'A live Guide item needs the goal the agent was given.';
    end if;
    if jsonb_array_length(v_traj) = 0 then
      raise exception 'A live Guide item needs a recorded trajectory with at least one step.';
    end if;
    -- Without a key there is nothing to score the taxonomy answer against, and
    -- the localization questions silently become unscored free text.
    if not (v_gt ? 'correct') then
      raise exception 'A live Guide item needs guide_ground_truth with at least a "correct" key.';
    end if;
  end if;

  insert into public.pageguide_guide_v2_tasks (
    id, source_task_id, title, url, task_style, goal, answer_variants, correctness_mode,
    trajectory, trajectory_bytes, step_count, guide_ground_truth, in_study, task_index, updated_at
  ) values (
    v_id,
    nullif(btrim(p_task ->> 'source_task_id'), ''),
    nullif(btrim(p_task ->> 'title'), ''),
    coalesce(btrim(p_task ->> 'url'), ''),
    v_style,
    v_goal,
    v_variants,
    v_mode,
    v_traj,
    length(convert_to(v_traj::text, 'UTF8')),
    jsonb_array_length(v_traj),
    v_gt,
    v_in_study,
    coalesce((p_task ->> 'task_index')::integer, 0),
    now()
  )
  on conflict (id) do update set
    source_task_id = excluded.source_task_id,
    title = excluded.title,
    url = excluded.url,
    task_style = excluded.task_style,
    goal = excluded.goal,
    answer_variants = excluded.answer_variants,
    correctness_mode = excluded.correctness_mode,
    trajectory = excluded.trajectory,
    trajectory_bytes = excluded.trajectory_bytes,
    step_count = excluded.step_count,
    guide_ground_truth = excluded.guide_ground_truth,
    in_study = excluded.in_study,
    task_index = excluded.task_index,
    updated_at = now();

  return v_id;
end;
$$;

grant execute on function public.save_pageguide_guide_v2_task(text, jsonb) to anon;


-- ── Claim a counterbalancing slot ───────────────────────────────────────────
-- Atomic: the UPDATE ... RETURNING takes the row lock, so two participants
-- pressing Start at the same moment cannot be handed the same slot.
create or replace function public.claim_pageguide_find_v2_session(p_participant_id text)
returns table (session_id bigint, assignment_slot bigint, condition_order text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant text := coalesce(nullif(btrim(p_participant_id), ''), 'anonymous');
begin
  update public.pageguide_find_v2_settings
  set next_assignment = next_assignment + 1,
      updated_at = now()
  where singleton = true
  returning next_assignment - 1 into assignment_slot;

  -- Names the cell this sitting STARTS on. The browser walks
  -- (slot + queue position) % 4 from there; this label only records it, and
  -- window.FindV2Variants.deal in app/find_v2_variants.js is authoritative for
  -- the order actually shown. Change one, change the other.
  condition_order := 'v2_cycle4_from_' || case assignment_slot % 4
    when 0 then 'correct_grounding'
    when 1 then 'correct_nongrounding'
    when 2 then 'incorrect_grounding'
    else 'incorrect_nongrounding'
  end;

  insert into public.pageguide_find_v2_sessions (
    participant_id, assignment_slot, condition_order
  ) values (
    v_participant, assignment_slot, condition_order
  ) returning id into session_id;

  return next;
end;
$$;

grant execute on function public.claim_pageguide_find_v2_session(text) to anon;


-- ── Reading results in Admin ────────────────────────────────────────────────
-- Results are private under RLS. Admin reads them through these password-checked
-- functions. The cap protects the browser from an accidental unbounded response.
create or replace function public.pageguide_find_v2_admin_results(
  p_password text,
  p_limit integer default 20000
)
returns setof public.pageguide_find_v2_results
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.pageguide_find_v2_require_admin(p_password);
  return query
    select * from public.pageguide_find_v2_results
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 20000), 20000));
end;
$$;

grant execute on function public.pageguide_find_v2_admin_results(text, integer) to anon;

create or replace function public.pageguide_guide_v2_admin_results(
  p_password text,
  p_limit integer default 20000
)
returns setof public.pageguide_guide_v2_results
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.pageguide_find_v2_require_admin(p_password);
  return query
    select * from public.pageguide_guide_v2_results
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 20000), 20000));
end;
$$;

grant execute on function public.pageguide_guide_v2_admin_results(text, integer) to anon;
