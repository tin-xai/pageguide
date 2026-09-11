-- PageGuide — researcher edits on the annotator website
-- =====================================================
-- Run AFTER supabase_schema_annotation.sql, in the same project (it reuses the V2 admin password).
--
-- The annotator site reads pageguide_annotation_trajectories as anon, which the RLS policy limits
-- to in_annotation = true. The researcher needs more than that from the same page:
--   * see EVERY published run, hidden ones included, so a draft can be checked before it goes live;
--   * fix a run's title / goal / agent answer / visibility without re-publishing the whole capture
--     from the extension.
-- All three functions are password-gated with the existing pageguide_find_v2_require_admin, so the
-- anon key alone still sees only the live queue.

-- ── Every trajectory, summary columns only (the bodies stay lazy) ───────────
-- Dropped first: `create or replace` cannot change a `returns table` shape, and this one grew
-- created_at, so re-running the file on an older install would otherwise fail (42P13).
drop function if exists public.list_pageguide_annotation_trajectories_admin(text);
create or replace function public.list_pageguide_annotation_trajectories_admin(p_password text)
returns table (
  id text, source_task_id text, title text, url text, task_style text, goal text,
  step_count integer, agent_answer text, claims_completion boolean,
  in_annotation boolean, task_index integer, created_at timestamptz, updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.pageguide_find_v2_require_admin(p_password);
  return query
    select t.id, t.source_task_id, t.title, t.url, t.task_style, t.goal,
           t.step_count, t.agent_answer, t.claims_completion,
           t.in_annotation, t.task_index, t.created_at, t.updated_at
      from public.pageguide_annotation_trajectories t
     order by t.task_index asc, t.id asc;
end;
$$;

revoke all on function public.list_pageguide_annotation_trajectories_admin(text) from public;
grant execute on function public.list_pageguide_annotation_trajectories_admin(text) to anon;


-- ── One trajectory's body, hidden rows included ─────────────────────────────
drop function if exists public.get_pageguide_annotation_trajectory_admin(text, text);
create or replace function public.get_pageguide_annotation_trajectory_admin(p_password text, p_id text)
returns table (trajectory jsonb, arms jsonb)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.pageguide_find_v2_require_admin(p_password);
  return query
    select t.trajectory, t.arms
      from public.pageguide_annotation_trajectories t
     where t.id = p_id;
end;
$$;

revoke all on function public.get_pageguide_annotation_trajectory_admin(text, text) from public;
grant execute on function public.get_pageguide_annotation_trajectory_admin(text, text) to anon;


-- ── Patch the editable fields ───────────────────────────────────────────────
-- `p_patch` carries only the keys to change: source_task_id, title, goal, agent_answer,
-- in_annotation. The agent
-- answer is also written into arms.grounding.answer so the two copies never disagree (the site
-- shows agent_answer first and falls back to the arm). Nothing else about the run is editable —
-- the annotators grade what the agent actually did.
create or replace function public.update_pageguide_annotation_trajectory(
  p_password text,
  p_id text,
  p_patch jsonb
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_answer text := p_patch ->> 'agent_answer';
begin
  perform public.pageguide_find_v2_require_admin(p_password);
  if nullif(btrim(coalesce(p_id, '')), '') is null then
    raise exception 'update_pageguide_annotation_trajectory: id is required';
  end if;

  update public.pageguide_annotation_trajectories t
     set source_task_id = case when p_patch ? 'source_task_id' then nullif(btrim(p_patch ->> 'source_task_id'), '') else t.source_task_id end,
         title         = case when p_patch ? 'title' then nullif(btrim(p_patch ->> 'title'), '') else t.title end,
         goal          = case when p_patch ? 'goal' then coalesce(btrim(p_patch ->> 'goal'), '') else t.goal end,
         agent_answer  = case when p_patch ? 'agent_answer' then coalesce(btrim(v_answer), '') else t.agent_answer end,
         arms          = case when p_patch ? 'agent_answer' and jsonb_typeof(t.arms -> 'grounding') = 'object'
                              then jsonb_set(t.arms, '{grounding,answer}', to_jsonb(coalesce(btrim(v_answer), '')), true)
                              else t.arms end,
         in_annotation = case when p_patch ? 'in_annotation' then coalesce((p_patch ->> 'in_annotation')::boolean, t.in_annotation) else t.in_annotation end,
         updated_at    = now()
   where t.id = p_id;

  if not found then
    raise exception 'update_pageguide_annotation_trajectory: no trajectory with id %', p_id;
  end if;
  return p_id;
end;
$$;

revoke all on function public.update_pageguide_annotation_trajectory(text, text, jsonb) from public;
grant execute on function public.update_pageguide_annotation_trajectory(text, text, jsonb) to anon;
