-- PageGuide V2 — bring `save_pageguide_guide_v2_task` in line with the table it writes
-- ====================================================================================
-- Run this once in the Supabase SQL editor for the V2 project.
--
-- WHY. `pageguide_guide_v2_tasks` grew four columns after supabase_schema_v2.sql was written —
-- `arms`, `source_trajectory_id`, `agent_completed`, `claims_completion` — and the save function
-- was never taught about any of them. Every row the extension published therefore came out
-- structurally different from the rows that were inserted by hand:
--
--                        inserted by hand        published by the extension
--   arms                 the full two-arm run    {}            <- the stimulus, missing
--   trajectory           []                      1.3 MB        <- filled, but nothing reads it
--   source_trajectory_id the V1 trajectory id    null
--   agent_completed      true / false            null
--   claims_completion    true / false            null
--
-- `arms` is what the site renders: it carries the grounded and non-grounded copies of the run, the
-- per-step screenshots, and the initial/final bookends that have no column of their own. A row with
-- `arms = {}` has no trajectory to show however much is sitting in `trajectory`.
--
-- So `arms` becomes the payload this function stores, `step_count` is derived from it rather than
-- from `trajectory`, and the live-item gate counts ITS steps. `trajectory` stays for the rows that
-- already use it and for anything reading it, but it is no longer where the run has to live.
--
-- IDS. `source_trajectory_id` is the id of the capture in the recorder's own bank, and it is what
-- the existing rows are keyed to. Writing it is what lets a re-publish find the row it belongs to by
-- id instead of by matching the goal text — which is a guess, and guesses are how one task ends up
-- as two rows.

alter table public.pageguide_guide_v2_tasks
  add column if not exists arms                 jsonb not null default '{}'::jsonb,
  add column if not exists source_trajectory_id text,
  add column if not exists agent_completed      boolean,
  add column if not exists claims_completion    boolean;

-- The lookup a re-publish does. Small table, so this is about intent as much as speed: it is the
-- column that identifies a task across the bank and the project.
create index if not exists pageguide_guide_v2_tasks_source_trajectory_idx
  on public.pageguide_guide_v2_tasks (source_trajectory_id);


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
  v_arms jsonb := case when jsonb_typeof(p_task -> 'arms') = 'object'
                       then p_task -> 'arms' else '{}'::jsonb end;
  v_traj jsonb := case when jsonb_typeof(p_task -> 'trajectory') = 'array'
                       then p_task -> 'trajectory' else '[]'::jsonb end;
  v_gt jsonb := case when jsonb_typeof(p_task -> 'guide_ground_truth') = 'object'
                     then p_task -> 'guide_ground_truth' else '{}'::jsonb end;
  -- The run is the grounded arm's steps. The non-grounded arm is the same run with its grounding
  -- stripped, so counting either gives the same number and the grounded one is always present.
  v_steps jsonb := case when jsonb_typeof(v_arms -> 'grounding' -> 'steps') = 'array'
                        then v_arms -> 'grounding' -> 'steps' else '[]'::jsonb end;
  -- Falls back to `trajectory` for a caller that still sends the run that way, so this function
  -- keeps working for both shapes rather than silently zeroing one of them.
  v_step_count integer := greatest(jsonb_array_length(v_steps), jsonb_array_length(v_traj));
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
    -- Counted over the ARMS now, not over `trajectory`. The old gate refused every row that stored
    -- its run the way the site actually reads it.
    if v_step_count = 0 then
      raise exception 'A live Guide item needs a recorded trajectory with at least one step.';
    end if;
    -- Without a key there is nothing to score the taxonomy answer against, and
    -- the localization questions silently become unscored free text.
    if not (v_gt ? 'correct') then
      raise exception 'A live Guide item needs guide_ground_truth with at least a "correct" key.';
    end if;
  end if;

  insert into public.pageguide_guide_v2_tasks (
    id, source_task_id, source_trajectory_id, title, url, task_style, goal,
    answer_variants, correctness_mode, arms, trajectory, trajectory_bytes, step_count,
    guide_ground_truth, agent_completed, claims_completion, in_study, task_index, updated_at
  ) values (
    v_id,
    nullif(btrim(p_task ->> 'source_task_id'), ''),
    nullif(btrim(p_task ->> 'source_trajectory_id'), ''),
    nullif(btrim(p_task ->> 'title'), ''),
    coalesce(btrim(p_task ->> 'url'), ''),
    v_style,
    v_goal,
    v_variants,
    v_mode,
    v_arms,
    v_traj,
    -- Measures what is actually stored. Reported in the panel so a 20 MB capture is visible before
    -- it becomes a row nobody can load.
    length(convert_to(v_arms::text, 'UTF8')) + length(convert_to(v_traj::text, 'UTF8')),
    v_step_count,
    v_gt,
    -- Nullable on purpose: a task whose verdict has not been authored yet must read as "unknown"
    -- rather than as "the agent failed", which is what a `false` default would have said.
    (p_task ->> 'agent_completed')::boolean,
    (p_task ->> 'claims_completion')::boolean,
    v_in_study,
    coalesce((p_task ->> 'task_index')::integer, 0),
    now()
  )
  on conflict (id) do update set
    source_task_id = excluded.source_task_id,
    source_trajectory_id = excluded.source_trajectory_id,
    title = excluded.title,
    url = excluded.url,
    task_style = excluded.task_style,
    goal = excluded.goal,
    answer_variants = excluded.answer_variants,
    correctness_mode = excluded.correctness_mode,
    arms = excluded.arms,
    trajectory = excluded.trajectory,
    trajectory_bytes = excluded.trajectory_bytes,
    step_count = excluded.step_count,
    guide_ground_truth = excluded.guide_ground_truth,
    agent_completed = excluded.agent_completed,
    claims_completion = excluded.claims_completion,
    in_study = excluded.in_study,
    task_index = excluded.task_index,
    updated_at = now();

  return v_id;
end;
$$;

grant execute on function public.save_pageguide_guide_v2_task(text, jsonb) to anon;

-- The rows inserted by hand predate `source_trajectory_id` being written by anything, but they
-- already carry it — and their `id` is a copy of it. This makes that explicit for any row where it
-- is still missing, so every row can be found by the one column that identifies a capture.
update public.pageguide_guide_v2_tasks
   set source_trajectory_id = id
 where source_trajectory_id is null;
