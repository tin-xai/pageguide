# XWebAgent User Study — Analysis

## Setup

```bash
cd analyze_user_study
pip install -r requirements.txt
```

## Usage

### Step 1 — Download data from Supabase
```bash
python download_data.py
```
This creates `data/sessions.csv` and `data/tasks.csv`.

> If you get a **401 error**, RLS is blocking anonymous SELECT.
> Either run the SQL below in Supabase, or put your service-role key in `config.py`:
> ```sql
> CREATE POLICY "anon select" ON study_sessions FOR SELECT TO anon USING (true);
> CREATE POLICY "anon select" ON study_task_results FOR SELECT TO anon USING (true);
> ```

### Step 2 — Run analysis

**Option A — Script (generates all plots + CSVs non-interactively):**
```bash
python analyze.py
```

**Option B — Jupyter notebook (interactive):**
```bash
jupyter notebook analyze.ipynb
```

## Output

| File | Description |
|---|---|
| `plots/time_by_condition.png` | Box plots: completion time per task type |
| `plots/paired_times.png` | Paired slope chart per participant |
| `plots/completion_rates.png` | Guide/hide outcome stacked bars |
| `plots/find_accuracy.png` | Find task accuracy |
| `plots/behavioral_overview.png` | Scroll, Ctrl+F, selection, page visit means |
| `plots/behavioral_by_task.png` | Behavioral metrics broken down by task type |
| `plots/top_domains.png` | Top visited domains in control condition |
| `plots/chat_usage.png` | AI query counts + helpfulness ratings |
| `data/summary.csv` | Clean flat export of all task results |
| `data/stats_results.csv` | Wilcoxon + t-test results per task type |
| `data/paired_times.csv` | Per-participant paired time comparison |

## What is analysed

1. **Completion time** — control vs extension, per task type; paired slopes
2. **Task success** — find accuracy; guide/hide completion rates
3. **Behavioral metrics** — scroll gestures, Ctrl+F, text selections, page visits
4. **Top domains** — what external sites participants visited in the control condition
5. **Chat usage** — query count distribution, helpfulness ratings, correlation with time
6. **Statistics** — Wilcoxon signed-rank test + paired t-test + Cohen's d per task type
