"""
filter_hide.py
--------------
Reads selection CSVs and source data files, then produces:
  - selected_hide_data.json  (from hide_data.json  + selected_hide.csv)
  - selected_guide_data.json (from guide_data.csv  + selected_guide.csv)

Hide matching rules:
  - A page is kept if its html_file matches the 'Website' column in selected_hide.csv.
  - Within a kept page, only annotations whose hide_query matches a 'Hide Query' row
    for that website are retained.
  - Pages with no matching annotations are dropped.

Guide matching rules:
  - A row is kept if its 'Website URL' + 'Task' pair appears in selected_guide.csv.
  - Output keys are normalised to lowercase to match study.js field names.
"""

import csv
import json
import pathlib

BASE = pathlib.Path(__file__).parent

# ── Hide ──────────────────────────────────────────────────────────────────────

def load_selected_hide(csv_path):
    """Return {html_file: set_of_hide_queries} from selected_hide.csv."""
    selected = {}
    with open(csv_path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            website = row['Website'].strip()
            query   = row['Hide Query'].strip()
            selected.setdefault(website, set()).add(query)
    return selected


def filter_hide_data(json_path, selected):
    """Return filtered list keeping only selected pages and their matching annotations."""
    with open(json_path, encoding='utf-8') as f:
        data = json.load(f)

    result = []
    for page in data:
        html_file = page.get('html_file', '').strip()
        if html_file not in selected:
            continue
        allowed_queries = selected[html_file]
        kept = [
            ann for ann in page.get('annotations', [])
            if ann.get('hide_query', '').strip() in allowed_queries
        ]
        if kept:
            result.append({**page, 'annotations': kept})
    return result


# ── Guide ─────────────────────────────────────────────────────────────────────

def load_selected_guide(csv_path):
    """Return set of (website_url, task) pairs from selected_guide.csv."""
    selected = set()
    with open(csv_path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            url  = row['Website URL'].strip()
            task = row['Task'].strip()
            selected.add((url, task))
    return selected


def filter_guide_data(csv_path, selected):
    """Return list of guide task dicts with normalised lowercase keys."""
    result = []
    with open(csv_path, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            url  = row['Website URL'].strip()
            task = row['Task'].strip()
            if (url, task) not in selected:
                continue
            result.append({
                'name':             row['Name'].strip(),
                'level':            row['Level'].strip(),
                'task':             task,
                'website_url':      url,
                'ground_truth':     row['Ground Truth'].strip(),
                'reference_length': row['Reference Length'].strip(),
            })
    return result


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # --- Hide ---
    hide_selected = load_selected_hide(BASE / 'selected_hide.csv')
    print(f"[hide] {sum(len(v) for v in hide_selected.values())} queries across "
          f"{len(hide_selected)} website(s): {list(hide_selected.keys())}")

    hide_filtered = filter_hide_data(BASE / 'hide_data.json', hide_selected)
    hide_ann_count = sum(len(p['annotations']) for p in hide_filtered)
    print(f"[hide] → {len(hide_filtered)} page(s), {hide_ann_count} annotation(s)")

    hide_out = BASE / 'selected_hide_data.json'
    with open(hide_out, 'w', encoding='utf-8') as f:
        json.dump(hide_filtered, f, indent=2, ensure_ascii=False)
    print(f"[hide] Written to {hide_out}")

    # --- Guide ---
    guide_selected = load_selected_guide(BASE / 'selected_guide.csv')
    print(f"\n[guide] {len(guide_selected)} selected (website_url, task) pairs")

    guide_filtered = filter_guide_data(BASE / 'guide_data.csv', guide_selected)
    print(f"[guide] → {len(guide_filtered)} task(s)")

    guide_out = BASE / 'selected_guide_data.json'
    with open(guide_out, 'w', encoding='utf-8') as f:
        json.dump(guide_filtered, f, indent=2, ensure_ascii=False)
    print(f"[guide] Written to {guide_out}")


if __name__ == '__main__':
    main()
