-- PageGuide — evidence-level annotation
-- ====================================
-- Run AFTER supabase_schema_annotation.sql, in the same project.
--
-- The annotation task is now about the EVIDENCE the agent saved with its answer: for every crop
-- (and every [ev:…] marker with no crop), is it correct and relevant to the task? Step labels and
-- the answer verdict are still stored when given, but completion and agreement are computed on
-- the evidence labels alone (annotate/annotate_logic.js).

alter table public.pageguide_annotation_results
  add column if not exists evidence_labels jsonb not null default '[]'::jsonb,
  -- How many evidence items the trajectory showed when this was saved; "complete" means every
  -- one of them carries a verdict.
  add column if not exists evidence_count integer not null default 0;

comment on column public.pageguide_annotation_results.evidence_labels is
  'One entry per evidence item, by [ev:key]: [{ "key": "pink_paddle", "correct": true, "problem": "", "note": "" }]. problem is one of irrelevant | unsupported | wrong_region | missing, or "".';

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
  v_evidence jsonb := case when jsonb_typeof(p_annotation -> 'evidence_labels') = 'array'
                           then p_annotation -> 'evidence_labels' else '[]'::jsonb end;
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
    trajectory_id, annotator_id, step_labels, step_count, evidence_labels, evidence_count,
    answer_correct, answer_problems, answer_note, duration_ms, updated_at
  ) values (
    v_traj,
    v_who,
    v_steps,
    jsonb_array_length(v_steps),
    v_evidence,
    coalesce((p_annotation ->> 'evidence_count')::integer, jsonb_array_length(v_evidence)),
    (p_annotation ->> 'answer_correct')::boolean,
    v_problems,
    coalesce(p_annotation ->> 'answer_note', ''),
    (p_annotation ->> 'duration_ms')::integer,
    now()
  )
  on conflict (trajectory_id, annotator_id) do update set
    step_labels     = excluded.step_labels,
    step_count      = excluded.step_count,
    evidence_labels = excluded.evidence_labels,
    evidence_count  = excluded.evidence_count,
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
