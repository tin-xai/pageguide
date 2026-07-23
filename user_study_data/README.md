# User Study Task Data

`tasks.json` is the task queue for the built-in user study (Settings menu → 📋 User Study). It
has two arrays: `find` and `guide`. These are placeholder tasks — replace them with your real
study content before running an actual session. The study always runs every task **with the
PageGuide extension** (there is no built-in control/no-extension condition — if you need a
without-extension or without-PageGuide comparison, that is intended to happen outside this
extension, e.g. with a separate tool, using this same task list).

## Format

### `find` entries
A "find" task shows the participant a question and a webpage; they use PageGuide to locate the
answer, then pick it from a multiple-choice list (their answer plus the `distractors`, shuffled).

```json
{
  "id": "find-1",
  "url": "https://example.com/page",
  "question": "The question shown to the participant.",
  "answer": "The correct answer (also used to grade answer_correct).",
  "distractors": ["Wrong option 1", "Wrong option 2", "Wrong option 3"]
}
```

### `guide` entries
A "guide" task shows an instruction describing something to accomplish on a website; the
participant uses PageGuide to do it, then self-reports whether they completed it.

```json
{
  "id": "guide-1",
  "name": "Site display name (used in button/labels)",
  "url": "https://example.com",
  "task": "The instruction shown to the participant."
}
```

`id` must be unique across both arrays — it's what shows up in exported results, so keep it
stable if you rerun a study with the same task list.

## Adding/replacing tasks

Just edit `tasks.json` directly — there's no build step. The study loads it fresh each time the
side panel opens (`chrome.runtime.getURL('user_study_data/tasks.json')`), so changes take effect
after reloading the extension.

## Where results go

Every completed task is:
1. Always kept in memory for the session and downloadable as CSV from the study's final screen.
2. Always saved to `chrome.storage.local` (survives closing the side panel) under
   `pageguide_study_results`.
3. Optionally inserted into Supabase in real time, if `sidepanel/supabase_config.js` is filled in
   with real project credentials (see `supabase_schema.sql` at the repo root for the table to
   create). This file is gitignored — copy it from a teammate or fill in your own project's URL
   and anon key. Without it, steps 1 and 2 still work fine.
