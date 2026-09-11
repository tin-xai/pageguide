-- PageGuide — model-performance trajectories
-- ==========================================
-- Run this ENTIRE file, once, in the SQL editor of the SAME Supabase project that already holds
-- supabase_schema_v2.sql (it reuses that schema's admin password, pageguide_find_v2_require_admin),
-- so "📈 Record Model Performance" in the panel publishes with the password you already set.
--
-- ONE TABLE
--   pageguide_model_performance_trajectories — one row per captured Guide run of one MODEL on one
--     of the 12 tasks. Mirrors pageguide_annotation_trajectories column for column (id, source ids,
--     title, url, task_style, goal, arms, trajectory, trajectory_bytes, step_count, agent_answer,
--     claims_completion, task_index) and adds what the run cost: provider, model, calls, tokens,
--     dollars, wall time (read off the extension's cost ledger at capture time). Many rows may
--     share a source_task_id — that is the point: one per model tried.
--
-- WHO CAN DO WHAT (anon key only)
--   publish a run  — RPC gated by the admin password
--   read runs      — anon select, in_report = true only
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.pageguide_model_performance_trajectories (
  id                    text primary key,
  -- The task id from annotate/tasks.json the run was made for (blank if unknown).
  source_task_id        text,
  -- The capture's id in the extension's own bank; what a re-publish matches on.
  source_trajectory_id  text,
  title                 text,
  url                   text not null default '',
  task_style            text not null default 'guide_text'
                          check (task_style in ('guide_text', 'guide_visual')),
  goal                  text not null default '',
  -- The run, in the recorder's own shape: { "grounding": { steps, initial_state, final_state, answer, answer_evidence, trail } }
  arms                  jsonb not null default '{}'::jsonb,
  -- The flattened steps: [{ n, instruction, action, target_text, url, screenshot }]
  trajectory            jsonb not null default '[]'::jsonb,
  trajectory_bytes      integer,
  step_count            integer not null default 0,
  agent_answer          text not null default '',
  claims_completion     boolean,
  -- What ran it and what it cost (from the cost ledger; see _modelPerfRunMeta).
  provider              text not null default '',
  model                 text not null default '',
  calls                 integer,
  unpriced_calls        integer,
  cost_usd              numeric(12, 6),
  prompt_tokens         integer,
  completion_tokens     integer,
  duration_ms           integer,
  run_meta              jsonb not null default '{}'::jsonb,
  -- Included in the report. false = a false start kept for reference.
  in_report             boolean not null default false,
  task_index            integer not null default 0,
  captured_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists pageguide_model_performance_task_model_idx
  on public.pageguide_model_performance_trajectories (source_task_id, model, captured_at);

alter table public.pageguide_model_performance_trajectories enable row level security;

drop policy if exists "anon reads reported model runs" on public.pageguide_model_performance_trajectories;
create policy "anon reads reported model runs"
  on public.pageguide_model_performance_trajectories for select
  to anon using (in_report = true);

grant select on public.pageguide_model_performance_trajectories to anon;
-- No insert/update grants: every write goes through the function below.


-- ── Publish a run (admin) ───────────────────────────────────────────────────
-- Same contract as save_pageguide_annotation_trajectory: `p_task` is the JSON the panel builds
-- (buildModelPerformanceTask, sidepanel/model_performance_trajectories.js); upsert by id.
create or replace function public.save_pageguide_model_performance_trajectory(
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
  v_live boolean := coalesce((p_task ->> 'in_report')::boolean, false);
  v_arms jsonb := case when jsonb_typeof(p_task -> 'arms') = 'object'
                       then p_task -> 'arms' else '{}'::jsonb end;
  v_traj jsonb := case when jsonb_typeof(p_task -> 'trajectory') = 'array'
                       then p_task -> 'trajectory' else '[]'::jsonb end;
  v_meta jsonb := case when jsonb_typeof(p_task -> 'run_meta') = 'object'
                       then p_task -> 'run_meta' else '{}'::jsonb end;
begin
  perform public.pageguide_find_v2_require_admin(p_password);

  if v_id is null or v_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$' then
    raise exception 'Item id must be 2-80 characters using letters, numbers, dot, dash, or underscore.';
  end if;
  if v_style not in ('guide_text', 'guide_visual') then
    raise exception 'task_style must be guide_text or guide_visual.';
  end if;
  if v_live and jsonb_array_length(v_traj) = 0 then
    raise exception 'A reported run needs a recorded trajectory with at least one step.';
  end if;

  insert into public.pageguide_model_performance_trajectories (
    id, source_task_id, source_trajectory_id, title, url, task_style, goal, arms,
    trajectory, trajectory_bytes, step_count, agent_answer, claims_completion,
    provider, model, calls, unpriced_calls, cost_usd, prompt_tokens, completion_tokens, duration_ms,
    run_meta, in_report, task_index, captured_at, updated_at
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
    coalesce(btrim(p_task ->> 'provider'), coalesce(v_meta ->> 'provider', '')),
    coalesce(btrim(p_task ->> 'model'), coalesce(v_meta ->> 'model', '')),
    (v_meta ->> 'calls')::integer,
    (v_meta ->> 'unpriced')::integer,
    (v_meta ->> 'cost_usd')::numeric,
    (v_meta ->> 'prompt_tokens')::integer,
    (v_meta ->> 'completion_tokens')::integer,
    (v_meta ->> 'duration_ms')::integer,
    v_meta,
    v_live,
    coalesce((p_task ->> 'task_index')::integer, 0),
    nullif(btrim(p_task ->> 'captured_at'), '')::timestamptz,
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
    provider             = excluded.provider,
    model                = excluded.model,
    calls                = excluded.calls,
    unpriced_calls       = excluded.unpriced_calls,
    cost_usd             = excluded.cost_usd,
    prompt_tokens        = excluded.prompt_tokens,
    completion_tokens    = excluded.completion_tokens,
    duration_ms          = excluded.duration_ms,
    run_meta             = excluded.run_meta,
    in_report            = excluded.in_report,
    task_index           = excluded.task_index,
    captured_at          = excluded.captured_at,
    updated_at           = now();

  return v_id;
end;
$$;

revoke all on function public.save_pageguide_model_performance_trajectory(text, jsonb) from public;
grant execute on function public.save_pageguide_model_performance_trajectory(text, jsonb) to anon;
