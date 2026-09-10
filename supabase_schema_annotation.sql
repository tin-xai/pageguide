-- PageGuide — annotator-website schema (step-level + answer-level agreement)
-- ============================================================================
-- Run this ENTIRE file, once, in the SQL editor of the SAME Supabase project
-- that already holds supabase_schema_v2.sql. It reuses that schema's admin
-- password (pageguide_find_v2_settings / pageguide_find_v2_require_admin), so
-- "📝 Record Annotation Trajectories" in the panel publishes with the password
-- you already set:
--
--   select public.set_pageguide_find_v2_admin_password('a long private password');
--
-- TWO TABLES
--
--   pageguide_annotation_trajectories — one row per captured Guide run. Mirrors
--     pageguide_guide_v2_tasks column for column where the meaning is the same
--     (id, source ids, title, url, task_style, goal, arms, trajectory,
--     trajectory_bytes, step_count, claims_completion, task_index) and drops
--     the study-only ones (answer_variants, correctness_mode,
--     guide_ground_truth). The annotators ARE the ground truth here.
--
--   pageguide_annotation_results — one row per (trajectory, annotator): the
--     step-level labels and the answer-level verdict. Two rows on one
--     trajectory from two annotators is what the agreement page compares.
--
-- WHO CAN DO WHAT (anon key only, no service-role key in the browser)
--   publish a trajectory    — RPC gated by the admin password
--   read trajectories       — anon select, in_annotation = true only
--   save an annotation      — RPC, open to anyone holding the site link
--   read annotations        — anon select (the agreement page needs both raters)
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;


-- ── Trajectories ────────────────────────────────────────────────────────────
create table if not exists public.pageguide_annotation_trajectories (
  id                    text primary key,
  -- The task id from annotate/tasks.json the run was made for (blank if unknown).
  source_task_id        text,
  -- The capture's id in the extension's own bank; what a re-publish matches on.
  source_trajectory_id  text,
  title                 text,
  url                   text not null default '',
  task_style            text not null default 'guide_text'
                          check (task_style in ('guide_text', 'guide_visual')),
  -- What the agent was asked to do, shown to the annotator as the task.
  goal                  text not null default '',
  -- THE STIMULUS, in the recorder's own shape (same as pageguide_guide_v2_tasks.arms):
  --   { "grounding": { steps: [...], initial_state, final_state, answer, answer_evidence, trail } }
  -- Only the grounded copy is kept: annotators always see the screenshots.
  arms                  jsonb not null default '{}'::jsonb,
  -- The flattened steps the site grades:
  --   [{ "n": 1, "instruction": "...", "action": "click", "target_text": "...",
  --      "url": "...", "screenshot": "data:image/..." }, ...]
  trajectory            jsonb not null default '[]'::jsonb,
  trajectory_bytes      integer,
  step_count            integer not null default 0,
  -- The agent's final answer, as shown to the annotator for the answer-level verdict.
  agent_answer          text not null default '',
  -- Did the agent SAY it finished? Nullable — unset means "not recorded".
  claims_completion     boolean,
  -- Visible to annotators. false = draft / withdrawn.
  in_annotation         boolean not null default false,
  task_index            integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists pageguide_annotation_trajectories_queue_idx
  on public.pageguide_annotation_trajectories (in_annotation, task_index, id);


-- ── Results ─────────────────────────────────────────────────────────────────
create table if not exists public.pageguide_annotation_results (
  id                bigint generated always as identity primary key,
  trajectory_id     text not null references public.pageguide_annotation_trajectories (id) on delete cascade,
  annotator_id      text not null,
  -- One entry per step, in step order:
  --   [{ "step": 1, "correct": true, "error_type": "", "note": "" },
  --    { "step": 2, "correct": false, "error_type": "wrong_target", "note": "clicked the ad" }]
  -- error_type is one of GUIDE_ERROR_TYPES (loop | mismatch | wrong_target) or "".
  step_labels       jsonb not null default '[]'::jsonb,
  step_count        integer not null default 0,
  -- The answer-level verdict.
  answer_correct    boolean,
  -- One or more of GUIDE_PROBLEM_TYPES (hallucinated_result | incomplete | could_not_complete).
  answer_problems   jsonb not null default '[]'::jsonb,
  answer_note       text not null default '',
  -- How long the annotator spent on this trajectory.
  duration_ms       integer,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (trajectory_id, annotator_id)
);

create index if not exists pageguide_annotation_results_traj_idx
  on public.pageguide_annotation_results (trajectory_id, annotator_id);


-- ── Row level security ──────────────────────────────────────────────────────
alter table public.pageguide_annotation_trajectories enable row level security;
alter table public.pageguide_annotation_results      enable row level security;

drop policy if exists "anon reads live annotation trajectories" on public.pageguide_annotation_trajectories;
create policy "anon reads live annotation trajectories"
  on public.pageguide_annotation_trajectories for select
  to anon using (in_annotation = true);

drop policy if exists "anon reads annotation results" on public.pageguide_annotation_results;
create policy "anon reads annotation results"
  on public.pageguide_annotation_results for select
  to anon using (true);

grant select on public.pageguide_annotation_trajectories to anon;
grant select on public.pageguide_annotation_results      to anon;
-- No insert/update grants: every write goes through the two functions below.


-- ── Publish a trajectory (admin) ────────────────────────────────────────────
-- Same contract as save_pageguide_guide_v2_task: `p_task` is the JSON the panel
-- builds (buildAnnotationTask, sidepanel/annotation_trajectories.js); upsert by id.
create or replace function public.save_pageguide_annotation_trajectory(
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
  v_live boolean := coalesce((p_task ->> 'in_annotation')::boolean, false);
  v_arms jsonb := case when jsonb_typeof(p_task -> 'arms') = 'object'
                       then p_task -> 'arms' else '{}'::jsonb end;
  v_traj jsonb := case when jsonb_typeof(p_task -> 'trajectory') = 'array'
                       then p_task -> 'trajectory' else '[]'::jsonb end;
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if v_id is null or v_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$' then
    raise exception 'Item id must be 2-80 characters using letters, numbers, dot, dash, or underscore.';
  end if;
  if v_style not in ('guide_text', 'guide_visual') then
    raise exception 'task_style must be guide_text or guide_visual.';
  end if;
  if v_live then
    if v_goal = '' then
      raise exception 'A live annotation item needs the goal the agent was given.';
    end if;
    if jsonb_array_length(v_traj) = 0 then
      raise exception 'A live annotation item needs a recorded trajectory with at least one step.';
    end if;
  end if;

  insert into public.pageguide_annotation_trajectories (
    id, source_task_id, source_trajectory_id, title, url, task_style, goal, arms,
    trajectory, trajectory_bytes, step_count, agent_answer, claims_completion,
    in_annotation, task_index, updated_at
  ) values (
    v_id,
    nullif(btrim(p_task ->> 'source_task_id'), ''),
    nullif(btrim(p_task ->> 'source_trajectory_id'), ''),
    nullif(btrim(p_task ->> 'title'), ''),
    coalesce(btrim(p_task ->> 'url'), ''),
    v_style,
    v_goal,
    v_arms,
    v_traj,
    length(convert_to(v_traj::text, 'UTF8')),
    jsonb_array_length(v_traj),
    coalesce(btrim(p_task ->> 'agent_answer'), ''),
    (p_task ->> 'claims_completion')::boolean,
    v_live,
    coalesce((p_task ->> 'task_index')::integer, 0),
    now()
  )
  on conflict (id) do update set
    source_task_id       = excluded.source_task_id,
    source_trajectory_id = excluded.source_trajectory_id,
    title                = excluded.title,
    url                  = excluded.url,
    task_style           = excluded.task_style,
    goal                 = excluded.goal,
    arms                 = excluded.arms,
    trajectory           = excluded.trajectory,
    trajectory_bytes     = excluded.trajectory_bytes,
    step_count           = excluded.step_count,
    agent_answer         = excluded.agent_answer,
    claims_completion    = excluded.claims_completion,
    in_annotation        = excluded.in_annotation,
    task_index           = excluded.task_index,
    updated_at           = now();

  return v_id;
end;
$$;

revoke all on function public.save_pageguide_annotation_trajectory(text, jsonb) from public;
grant execute on function public.save_pageguide_annotation_trajectory(text, jsonb) to anon;


-- ── Save an annotation (annotator) ──────────────────────────────────────────
-- Upsert by (trajectory_id, annotator_id) so an annotator can revise. No
-- password: the site link is the credential, as in the V2 study.
create or replace function public.save_pageguide_annotation(p_annotation jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_traj text := nullif(btrim(p_annotation ->> 'trajectory_id'), '');
  v_who text := nullif(btrim(p_annotation ->> 'annotator_id'), '');
  v_steps jsonb := case when jsonb_typeof(p_annotation -> 'step_labels') = 'array'
                        then p_annotation -> 'step_labels' else '[]'::jsonb end;
  v_problems jsonb := case when jsonb_typeof(p_annotation -> 'answer_problems') = 'array'
                           then p_annotation -> 'answer_problems' else '[]'::jsonb end;
  v_row_id bigint;
begin
  if v_traj is null then raise exception 'trajectory_id is required.'; end if;
  if v_who is null or length(v_who) > 80 then
    raise exception 'annotator_id is required (max 80 characters).';
  end if;
  if not exists (select 1 from public.pageguide_annotation_trajectories where id = v_traj) then
    raise exception 'Unknown trajectory %.', v_traj;
  end if;

  insert into public.pageguide_annotation_results (
    trajectory_id, annotator_id, step_labels, step_count, answer_correct,
    answer_problems, answer_note, duration_ms, updated_at
  ) values (
    v_traj,
    v_who,
    v_steps,
    jsonb_array_length(v_steps),
    (p_annotation ->> 'answer_correct')::boolean,
    v_problems,
    coalesce(p_annotation ->> 'answer_note', ''),
    (p_annotation ->> 'duration_ms')::integer,
    now()
  )
  on conflict (trajectory_id, annotator_id) do update set
    step_labels     = excluded.step_labels,
    step_count      = excluded.step_count,
    answer_correct  = excluded.answer_correct,
    answer_problems = excluded.answer_problems,
    answer_note     = excluded.answer_note,
    duration_ms     = excluded.duration_ms,
    updated_at      = now()
  returning id into v_row_id;

  return v_row_id;
end;
$$;

revoke all on function public.save_pageguide_annotation(jsonb) from public;
grant execute on function public.save_pageguide_annotation(jsonb) to anon;
