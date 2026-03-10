# XWebAgent User Study — Supabase Setup

## 1. Create a Supabase Project

1. Go to [https://supabase.com](https://supabase.com) and sign in.
2. Click **New project**, fill in the name and password, then click **Create new project**.
3. Once ready, go to **Project Settings → API** and copy:
   - **Project URL** → paste into `SUPABASE_URL` in `sidepanel/supabase_config.js`
   - **anon / public** key (starts with `eyJ...`) → paste into `SUPABASE_ANON_KEY`

> ⚠️ Use the **anon key**, NOT the service role key and NOT a Personal Access Token (`sbp_...`).

---

## 2. Create the Tables

Open **SQL Editor → New Query**, paste each block below, and click **Run**.

### 2a. `study_sessions`

Stores one row per participant study run.

```sql
CREATE TABLE study_sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL    DEFAULT now(),
  participant_id   text        NOT NULL,
  condition_order  text        NOT NULL    -- e.g. 'control_then_extension'
);
```

### 2b. `study_task_results`

Stores one row per completed task (6 rows per full study run).

```sql
CREATE TABLE study_task_results (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL    DEFAULT now(),

  -- Participant & session
  participant_id     text        NOT NULL,
  session_id         uuid        REFERENCES study_sessions(id),

  -- Task metadata
  block_index        integer     NOT NULL,   -- 0 or 1
  task_index         integer     NOT NULL,   -- 0, 1, or 2
  question_index     integer     DEFAULT 0,  -- 0–2 within the task type
  task_type          text        NOT NULL,   -- 'find' | 'guide' | 'hide'
  condition          text        NOT NULL,   -- 'control' | 'extension'
  question_or_task   text,

  -- Performance
  time_ms            bigint,                 -- milliseconds taken
  answer             text,                   -- selected answer / completion status
  answer_correct     boolean,               -- null for non-find tasks
  hidden_count            integer     DEFAULT 0,   -- items hidden (hide tasks only)
  hide_recall             float,                   -- TP / ground-truth total (hide tasks)
  user_hidden_selectors   jsonb       DEFAULT '[]'::jsonb,
                                                   -- CSS selectors of elements user manually hid
                                                   -- (control condition only; use with hidden_count
                                                   --  and task_data.hidden_elements to compute P/R/F1)

  -- Post-task ratings
  confidence         text,                   -- 'very' | 'somewhat' | 'notsure' | 'guessed'
  helpfulness        text,                   -- 'very' | 'somewhat' | 'not' | 'unused' | null

  -- Chat (extension condition)
  chat_turn_count    integer     DEFAULT 0,  -- number of user messages sent
  chat_transcript    jsonb       DEFAULT '[]'::jsonb,
                                             -- [{role, content, ts}, ...]

  -- Behavior tracking
  scroll_count       integer     DEFAULT 0,  -- distinct scroll gestures
  ctrl_f_count       integer     DEFAULT 0,  -- Ctrl/Cmd+F presses
  text_select_count  integer     DEFAULT 0,  -- drag-to-select actions (>2 chars)
  page_visit_count   integer     DEFAULT 0,  -- number of URL navigations
  page_visit_urls    jsonb       DEFAULT '[]'::jsonb,
                                             -- ["https://...", ...]

  -- Guide screenshot
  guide_screenshot   text,                   -- base64 PNG of last guide step (guide tasks, with consent)

  -- Raw task object
  task_data          jsonb                   -- full task row from dataset
);
```

---

## 3. Disable Row-Level Security (or add INSERT policies)

By default Supabase enables RLS which blocks anonymous inserts. Either:

**Option A — disable RLS (simplest for a closed study):**
```sql
ALTER TABLE study_sessions     DISABLE ROW LEVEL SECURITY;
ALTER TABLE study_task_results DISABLE ROW LEVEL SECURITY;
```

**Option B — add permissive INSERT policies (keeps RLS on):**
```sql
CREATE POLICY "anon insert" ON study_sessions
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon insert" ON study_task_results
  FOR INSERT TO anon WITH CHECK (true);
```

---

## 4. Add Missing Columns to an Existing Table

If you created the tables before the behavior-tracking update, run:

```sql
ALTER TABLE study_task_results
  ADD COLUMN IF NOT EXISTS chat_turn_count    integer     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chat_transcript    jsonb       DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS scroll_count       integer     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ctrl_f_count             integer     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS text_select_count        integer     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS page_visit_count         integer     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS page_visit_urls          jsonb       DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS hide_recall              float,
  ADD COLUMN IF NOT EXISTS user_hidden_selectors    jsonb       DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS question_index           integer     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS guide_screenshot         text;
```

---

## 5. Verify

After running the study, check:

- **Table Editor → study_sessions** — one row per participant per run
- **Table Editor → study_task_results** — six rows per complete run (2 blocks × 3 tasks)

Each `study_task_results` row links back to `study_sessions` via `session_id`.

---

## 6. Data Dictionary

| Column | Type | Description |
|---|---|---|
| `participant_id` | text | e.g. `P01`, `P02` |
| `session_id` | uuid | FK to `study_sessions.id` |
| `block_index` | int | 0 = Block 1, 1 = Block 2 |
| `task_index` | int | 0 = Find, 1 = Guide, 2 = Hide |
| `task_type` | text | `find` / `guide` / `hide` |
| `condition` | text | `control` / `extension` |
| `time_ms` | bigint | Task completion time in ms |
| `answer` | text | Selected answer or `completed` / `partial` / `failed` |
| `answer_correct` | bool | `true`/`false` for find tasks; `null` otherwise |
| `confidence` | text | `very` / `somewhat` / `notsure` / `guessed` |
| `helpfulness` | text | `very` / `somewhat` / `not` / `unused` / null (control) |
| `chat_turn_count` | int | Number of messages the user sent to the AI |
| `chat_transcript` | jsonb | Full chat: `[{role, content, ts}]` |
| `scroll_count` | int | Distinct scroll gestures on the task page |
| `ctrl_f_count` | int | Ctrl/Cmd+F presses |
| `text_select_count` | int | Drag-to-select actions (selection > 2 chars) |
| `page_visit_count` | int | Number of URL navigations during the task |
| `page_visit_urls` | jsonb | List of visited URLs `["https://..."]` |
| `hidden_count` | int | Elements hidden (hide tasks only) |
| `hide_recall` | float | TP / ground-truth total — recall score for hide tasks |
| `user_hidden_selectors` | jsonb | CSS selectors of elements user manually hid (`["#id > tag", ...]`); control condition only |
| `question_index` | int | 0–2 — which of the 3 questions within this task type |
| `guide_screenshot` | text | Base64 PNG of the last guide step (guide tasks only, captured with user consent) |
| `task_data` | jsonb | Full raw task object from the dataset |
| `question_or_task` | text | The task question / instruction shown to participant |
