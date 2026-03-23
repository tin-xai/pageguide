"""
download_data.py
Downloads study_sessions and study_task_results from Supabase
and saves them as CSV files in the data/ folder.
Guide screenshots (base64 PNG) are extracted to screenshots/ as PNG files;
the CSV stores only the relative path so it stays small.

Usage:
    python download_data.py
"""

import requests
import pandas as pd
import base64
import os
import sys

try:
    from config import SUPABASE_URL, SUPABASE_ANON_KEY
except ImportError:
    print('ERROR: config.py not found. Copy config.py and fill in your credentials.')
    sys.exit(1)

HEADERS = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': f'Bearer {SUPABASE_ANON_KEY}',
}

BASE_DIR        = os.path.dirname(__file__)
DATA_DIR        = os.path.join(BASE_DIR, 'data')
SCREENSHOTS_DIR = os.path.join(BASE_DIR, 'screenshots')
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)


def fetch_table(table: str) -> pd.DataFrame:
    """Fetch all rows from a Supabase table (handles pagination)."""
    rows, offset, limit = [], 0, 1000
    while True:
        url = (f'{SUPABASE_URL}/rest/v1/{table}'
               f'?select=*&limit={limit}&offset={offset}&order=created_at.asc')
        resp = requests.get(url, headers=HEADERS, timeout=30)
        if resp.status_code == 401:
            print(f'ERROR 401 on {table}: anon key may lack SELECT permission.')
            print('  → Either disable RLS or add a SELECT policy, or use service-role key.')
            return pd.DataFrame()
        resp.raise_for_status()
        batch = resp.json()
        if isinstance(batch, dict) and 'message' in batch:
            print(f'ERROR from Supabase: {batch}')
            return pd.DataFrame()
        rows.extend(batch)
        print(f'  {table}: fetched {len(rows)} rows…', end='\r')
        if len(batch) < limit:
            break
        offset += limit
    print(f'  {table}: {len(rows)} rows total          ')
    return pd.DataFrame(rows)


def extract_screenshots(tasks: pd.DataFrame) -> pd.DataFrame:
    """
    Decode base64 guide_screenshot values → PNG files in screenshots/.
    Replaces the column value with a relative path (or empty string if none).
    Returns the modified DataFrame.
    """
    if 'guide_screenshot' not in tasks.columns:
        return tasks

    tasks = tasks.copy()
    saved = 0

    for idx, row in tasks.iterrows():
        b64 = row['guide_screenshot']
        if not isinstance(b64, str) or not b64.strip():
            tasks.at[idx, 'guide_screenshot'] = ''
            continue

        # Build a meaningful filename — use session_id since participant_id may be shared
        sid   = str(row.get('session_id', row.get('participant_id', 'unknown'))).replace('/', '_')
        cond  = str(row.get('condition', 'unknown'))
        qidx  = str(row.get('question_index', row.get('task_index', idx)))
        fname = f'{sid}_{cond}_guide_q{qidx}.png'
        fpath = os.path.join(SCREENSHOTS_DIR, fname)

        try:
            # Strip data-URI prefix if present
            raw = b64.split(',', 1)[-1] if ',' in b64 else b64
            with open(fpath, 'wb') as f:
                f.write(base64.b64decode(raw))
            tasks.at[idx, 'guide_screenshot'] = os.path.join('screenshots', fname)
            saved += 1
        except Exception as e:
            print(f'  ⚠️  Could not save screenshot for row {idx}: {e}')
            tasks.at[idx, 'guide_screenshot'] = ''

    if saved:
        print(f'  Saved {saved} screenshot(s) → screenshots/')
    return tasks


def main():
    print(f'Connecting to {SUPABASE_URL}')

    sessions = fetch_table('study_sessions')
    tasks    = fetch_table('study_task_results')

    if sessions.empty and tasks.empty:
        print('No data returned. Check credentials and RLS settings.')
        return

    # Extract screenshots before saving CSV
    tasks = extract_screenshots(tasks)

    sessions.to_csv(os.path.join(DATA_DIR, 'sessions.csv'), index=False)
    tasks.to_csv(os.path.join(DATA_DIR, 'tasks.csv'), index=False)

    print(f'\nSaved:')
    print(f'  data/sessions.csv        ({len(sessions)} rows)')
    print(f'  data/tasks.csv           ({len(tasks)} rows)')
    print(f'\nParticipants: {tasks["participant_id"].nunique() if not tasks.empty else 0}')
    if not tasks.empty:
        print(tasks.groupby(['task_type', 'condition']).size().unstack(fill_value=0).to_string())


if __name__ == '__main__':
    main()
