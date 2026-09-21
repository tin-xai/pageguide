# PageGuide annotator website

Two annotators grade the **evidence** of each recorded Guide run: for every crop the agent saved
with its answer (and every `[ev:…]` marker it cited without a crop), is it correct and relevant
to the task — and if not, what is wrong with it (irrelevant / does not support the claim / wrong
region / missing). Step labels and the answer verdict can still be given but are optional; a run
counts as **done** only when all of its evidence is graded. The **Agreement** tab compares the two
annotators on the evidence labels (percent agreement and Cohen's κ, plus problem-type agreement
where both said "not correct"); step/answer agreement is kept in the CSV only.

Run `supabase_migration_annotation_evidence.sql` once (adds `evidence_labels` / `evidence_count`
to the results table and updates `save_pageguide_annotation`).

## Recording trajectories (extension, debug mode on)
1. Run one of the tasks in `tasks.json` with Guide.
2. On the journey card press **📝** (next to 🎬) — the run is copied into the annotation bank.
3. ⋯ → **Record Annotation Trajectories** → tick the runs → **⬆ Publish → Supabase**
   (or **⬇ Export JSON** when Supabase is not configured).

## Supabase
The 12 runs are already recorded for the user study — run
`supabase_seed_annotation_from_guide_v2.sql` after the schema to copy them into the annotation
table instead of re-recording them.

Run `supabase_schema_annotation.sql` in the same project as `supabase_schema_v2.sql` (it reuses
that admin password). Then copy `supabase_config.example.js` to `supabase_config.js` and fill it in.

## Running the site
It is static. Locally: `npm run annotate:serve` from the repo root, then open
http://localhost:5173 (leave that terminal running; ctrl-C stops the site). For annotators
elsewhere, drop the `annotate/` folder on any static host (Netlify drop, GitHub Pages, Vercel) —
remember `supabase_config.js` is gitignored, so copy it up by hand or the site runs local-only.
Open it, pick **Annotator A or B** in the header, and work through the queue — the progress count, ✓ done marks and saved grades are per annotator. Without Supabase, load the exported
JSON with **⬇ Load exported JSON** and download annotations from the Agreement tab.

## Edit tab (fix runs on the site)
Run `supabase_migration_annotation_edit.sql` once (after the annotation schema). Press
**🔑 Researcher** in the header and enter the V2 admin password: the **✎ Edit** tab appears
(and opens). It lists **every**
published run (hidden ones tagged), each with a form for the task name (from `tasks.json`),
title, task text, agent answer and visibility. **Save** writes straight to Supabase (the answer
goes to both `agent_answer` and `arms.grounding.answer`). The password lives in sessionStorage
for that tab only. In local-only mode edits apply to the loaded bundle and stay in this browser.
