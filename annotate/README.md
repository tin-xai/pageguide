# PageGuide annotator website

Two annotators grade each recorded Guide run — every step (correct / incorrect + error type) and
the final answer (correct / incorrect + problem type) — and the **Agreement** tab compares them
(percent agreement and Cohen's κ, at step level and at answer level).

## Recording trajectories (extension, debug mode on)
1. Run one of the tasks in `tasks.json` with Guide.
2. On the journey card press **📝** (next to 🎬) — the run is copied into the annotation bank.
3. ⋯ → **Record Annotation Trajectories** → tick the runs → **⬆ Publish → Supabase**
   (or **⬇ Export JSON** when Supabase is not configured).

## Supabase
Run `supabase_schema_annotation.sql` in the same project as `supabase_schema_v2.sql` (it reuses
that admin password). Then copy `supabase_config.example.js` to `supabase_config.js` and fill it in.

## Running the site
It is static: `npx serve annotate` (or any static host — GitHub Pages, Netlify). Open it, enter an
annotator ID, and work through the queue. Without Supabase, load the exported JSON with
**⬇ Load exported JSON** and download annotations from the Agreement tab.
