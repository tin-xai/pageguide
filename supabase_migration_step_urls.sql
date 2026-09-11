-- PageGuide — step URLs for page-level metrics
-- =============================================
-- Run AFTER supabase_schema_annotation.sql (and supabase_schema_model_performance.sql if present).
--
-- Model Comparison scores evidence at PAGE level (which pages the evidence came from) as well as
-- snippet level. A step's URL lives inside `trajectory` next to its screenshot, and pulling the whole
-- column for a dozen runs is ~30 MB, so these two functions return just [{n, url}] per run. Same
-- visibility as the tables' RLS: live rows only.

create or replace function public.pageguide_annotation_step_urls()
returns table (id text, source_task_id text, step_urls jsonb)
language sql
security definer
set search_path = public
stable
as $$
  select t.id, t.source_task_id,
         coalesce((select jsonb_agg(jsonb_build_object('n', s -> 'n', 'url', s -> 'url') order by (s ->> 'n')::int)
                     from jsonb_array_elements(t.trajectory) s), '[]'::jsonb)
    from public.pageguide_annotation_trajectories t
   where t.in_annotation = true;
$$;
revoke all on function public.pageguide_annotation_step_urls() from public;
grant execute on function public.pageguide_annotation_step_urls() to anon;

do $$
begin
  if to_regclass('public.pageguide_model_performance_trajectories') is not null then
    execute $f$
      create or replace function public.pageguide_model_performance_step_urls()
      returns table (id text, source_task_id text, step_urls jsonb)
      language sql
      security definer
      set search_path = public
      stable
      as $b$
        select t.id, t.source_task_id,
               coalesce((select jsonb_agg(jsonb_build_object('n', s -> 'n', 'url', s -> 'url') order by (s ->> 'n')::int)
                           from jsonb_array_elements(t.trajectory) s), '[]'::jsonb)
          from public.pageguide_model_performance_trajectories t
         where t.in_report = true;
      $b$;
      revoke all on function public.pageguide_model_performance_step_urls() from public;
      grant execute on function public.pageguide_model_performance_step_urls() to anon;
    $f$;
  end if;
end $$;
