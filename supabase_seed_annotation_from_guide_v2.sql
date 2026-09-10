-- PageGuide — seed the annotation table from the 12 study trajectories
-- ============================================================================
-- Run AFTER supabase_schema_annotation.sql, in the same project. The 12 Guide
-- runs the annotators grade were already recorded for the user study
-- (pageguide_guide_v2_tasks), so they are copied across rather than re-run.
-- Idempotent: re-running updates the same rows.
--
-- Note the study row for Scarlett Johansson (gv2-mthq47ka-g4axhj) has
-- in_study = false; it is still included here because the annotators grade
-- every run, live-in-the-study or not.
-- ============================================================================

insert into public.pageguide_annotation_trajectories (
  id, source_task_id, source_trajectory_id, title, url, task_style, goal, arms,
  trajectory, trajectory_bytes, step_count, agent_answer, claims_completion,
  in_annotation, task_index, updated_at
)
select
  t.id,
  m.annot_id,
  coalesce(t.source_trajectory_id, t.source_task_id, t.id),
  t.title,
  coalesce(nullif(t.url, ''), t.arms -> 'grounding' -> 'initial_state' ->> 'url', ''),
  t.task_style,
  t.goal,
  jsonb_build_object('grounding', coalesce(t.arms -> 'grounding', '{}'::jsonb)),
  -- Prefer the steps in arms (the shape the site renders); fall back to the flat column.
  case when jsonb_typeof(t.arms -> 'grounding' -> 'steps') = 'array'
       then t.arms -> 'grounding' -> 'steps' else t.trajectory end,
  t.trajectory_bytes,
  case when jsonb_typeof(t.arms -> 'grounding' -> 'steps') = 'array'
       then jsonb_array_length(t.arms -> 'grounding' -> 'steps') else t.step_count end,
  coalesce(t.arms -> 'grounding' ->> 'answer', ''),
  t.claims_completion,
  true,
  m.ord,
  now()
from public.pageguide_guide_v2_tasks t
join (values
  ('gv2-ms9j3200-u0i9nm', 'annot-01', 0),
  ('gv2-msf0vpxs-qucehj', 'annot-02', 1),
  ('gv2-ed05972e-i5fi3b', 'annot-03', 2),
  ('gv2-ed05a7b6-kk24zp', 'annot-04', 3),
  ('gv2-ed35d549-ct71ub-bm', 'annot-05', 4),
  ('gv2-mthpps9o-zalawk', 'annot-06', 5),
  ('gv2-mthq47ka-g4axhj', 'annot-07', 6),
  ('gv2-mthrk3fe-is8ciy', 'annot-08', 7),
  ('gv2-mtk8cxb0-itrcxy', 'annot-09', 8),
  ('gv2-mtkdnzau-y0qghc', 'annot-10', 9),
  ('gv2-mtlo1j6u-5eo35d', 'annot-11', 10),
  ('gv2-mtufb07j-mrj4tz', 'annot-12', 11)
) as m(v2_id, annot_id, ord) on m.v2_id = t.id
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

-- Check: 12 rows, in task order.
select task_index, id, source_task_id, step_count, left(goal, 60) as goal
from public.pageguide_annotation_trajectories
order by task_index;
