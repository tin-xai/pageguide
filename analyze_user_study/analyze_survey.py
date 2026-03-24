"""
analyze_survey.py
Analyze post-study questionnaire results from XWebAgent user study.

Usage:
    python analyze_survey.py
    python analyze_survey.py path/to/XWebAgent_UserStudy_Questionnaire.csv
"""

import sys, os
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import seaborn as sns
from matplotlib.backends.backend_pdf import PdfPages

# ── Paths ───────────────────────────────────────────────────────────────────────
BASE      = os.path.dirname(__file__)
DATA_DIR  = os.path.join(BASE, 'data')
PLOT_DIR  = os.path.join(BASE, 'plots')
os.makedirs(PLOT_DIR, exist_ok=True)

DEFAULT_CSV = os.path.join(BASE, 'XWebAgent_UserStudy_Questionnaire.csv')

# ── Style ───────────────────────────────────────────────────────────────────────
sns.set_theme(style='whitegrid', palette='Set2')
plt.rcParams.update({'figure.figsize': (10, 5), 'font.size': 11})

TASK_COLORS = {'find': '#2196F3', 'guide': '#4CAF50', 'hide': '#FF9800'}
TASK_ORDER  = ['find', 'guide', 'hide']

# ── Column mapping ──────────────────────────────────────────────────────────────
# Maps short key → (task, dimension, original column substring)
QUESTIONS = {
    'find_difficulty': ('find',  'Difficulty\nwithout XWebAgent',
        'difficult for me to solve the FIND'),
    'find_ease':       ('find',  'Ease\nwith XWebAgent',
        'makes FIND tasks much easier'),
    'find_accuracy':   ('find',  'Accuracy',
        'correctly locate'),

    'guide_difficulty': ('guide', 'Difficulty\nwithout XWebAgent',
        'difficult for me to solve the GUIDE'),
    'guide_ease':       ('guide', 'Ease\nwith XWebAgent',
        'makes GUIDE task much easier'),
    'guide_accuracy':   ('guide', 'Accuracy',
        'correct guidance'),

    'hide_difficulty':  ('hide',  'Difficulty\nwithout XWebAgent',
        'difficult for me to solve the HIDE'),
    'hide_ease':        ('hide',  'Ease\nwith XWebAgent',
        'makes HIDE task much easier'),
}

PDF_SKIP = set()  # nothing to skip for survey


# ── Load ────────────────────────────────────────────────────────────────────────
def load_survey(path=None):
    path = path or DEFAULT_CSV
    if not os.path.exists(path):
        raise FileNotFoundError(f'Survey CSV not found: {path}')

    raw = pd.read_csv(path)
    raw.columns = raw.columns.str.strip()

    df = pd.DataFrame()
    df['timestamp'] = pd.to_datetime(raw['Timestamp'], errors='coerce')

    for key, (task, dim, substr) in QUESTIONS.items():
        col = next((c for c in raw.columns if substr.lower() in c.lower()), None)
        if col:
            df[key] = pd.to_numeric(raw[col], errors='coerce')
        else:
            print(f'  ⚠️  Column not found for: {key} (searching "{substr}")')

    df = df.dropna(subset=[k for k in QUESTIONS if k in df.columns], how='all')
    print(f'Loaded {len(df)} survey responses.')
    return df


# ── Section 1: Summary stats ────────────────────────────────────────────────────
def print_summary(df):
    print('=' * 60)
    print('SURVEY SUMMARY (1–7 Likert scale)')
    print('=' * 60)
    print(f'N = {len(df)} respondents\n')

    rows = []
    for key, (task, dim, _) in QUESTIONS.items():
        if key not in df.columns:
            continue
        s = df[key].dropna()
        rows.append({
            'Task':   task.upper(),
            'Question': dim.replace('\n', ' '),
            'N':      int(s.count()),
            'Mean':   round(s.mean(), 2),
            'Median': round(s.median(), 2),
            'SD':     round(s.std(), 2),
            'Min':    int(s.min()),
            'Max':    int(s.max()),
        })

    summary = pd.DataFrame(rows)
    print(summary.to_string(index=False))
    print()

    out = os.path.join(DATA_DIR, 'survey_summary.csv')
    summary.to_csv(out, index=False)
    print(f'Saved → data/survey_summary.csv')
    print()
    return summary


# ── Section 2: Per-question bar chart ──────────────────────────────────────────
def plot_per_task(df, pdf):
    dims = ['Difficulty\nwithout XWebAgent', 'Ease\nwith XWebAgent', 'Accuracy']

    fig, axes = plt.subplots(1, 3, figsize=(15, 5), sharey=True)
    for ax, dim in zip(axes, dims):
        means, errs, colors, labels = [], [], [], []
        for task in TASK_ORDER:
            key = next((k for k, (t, d, _) in QUESTIONS.items()
                        if t == task and d == dim), None)
            if key and key in df.columns:
                s = df[key].dropna()
                means.append(s.mean())
                errs.append(s.sem())
                colors.append(TASK_COLORS[task])
                labels.append(task.capitalize())

        x = np.arange(len(labels))
        bars = ax.bar(x, means, color=colors, edgecolor='white',
                      width=0.5, zorder=3)
        ax.errorbar(x, means, yerr=errs, fmt='none', color='#333',
                    capsize=5, linewidth=1.5, zorder=4)
        ax.set_xticks(x)
        ax.set_xticklabels(labels)
        ax.set_title(dim, fontsize=12, fontweight='bold')
        ax.set_ylim(1, 7)
        ax.set_yticks(range(1, 8))
        ax.set_xlabel('')
        if ax == axes[0]:
            ax.set_ylabel('Rating (1–7)')

    fig.suptitle('Post-Study Survey Results by Task Type (mean ± SE)',
                 fontsize=14, fontweight='bold')
    plt.tight_layout()
    _save('survey_by_task.png', pdf)


# ── Section 3: Likert distribution heatmap ─────────────────────────────────────
def plot_likert_heatmap(df, pdf):
    keys = [k for k in QUESTIONS if k in df.columns]
    labels = [f"{QUESTIONS[k][0].upper()} — {QUESTIONS[k][1].replace(chr(10), ' ')}"
              for k in keys]

    # Distribution of responses per question (1–7)
    matrix = pd.DataFrame(
        {k: df[k].value_counts().reindex(range(1, 8), fill_value=0) for k in keys},
        index=range(1, 8)
    ).T
    matrix.index = labels

    fig, ax = plt.subplots(figsize=(12, 5))
    sns.heatmap(matrix, annot=True, fmt='d', cmap='YlOrRd',
                linewidths=0.5, ax=ax, cbar_kws={'label': 'Count'})
    ax.set_xlabel('Rating')
    ax.set_ylabel('')
    ax.set_title('Response Distribution per Question', fontsize=13, fontweight='bold')
    plt.tight_layout()
    _save('survey_heatmap.png', pdf)


# ── Section 4: Per-respondent radar / spider is complex; use violin instead ─────
def plot_violins(df, pdf):
    keys  = [k for k in QUESTIONS if k in df.columns]
    short = [f"{QUESTIONS[k][0].upper()}\n{QUESTIONS[k][1].replace(chr(10), ' ')}"
             for k in keys]

    long_df = pd.melt(df[keys].rename(columns=dict(zip(keys, short))),
                      var_name='Question', value_name='Rating')

    fig, ax = plt.subplots(figsize=(14, 5))
    task_palette = {}
    for k, s in zip(keys, short):
        task_palette[s] = TASK_COLORS[QUESTIONS[k][0]]

    sns.violinplot(data=long_df, x='Question', y='Rating',
                   palette=task_palette, order=short,
                   inner='box', ax=ax, cut=0)
    ax.set_ylim(0.5, 7.5)
    ax.set_yticks(range(1, 8))
    ax.set_xlabel('')
    ax.set_ylabel('Rating (1–7)')
    ax.set_title('Rating Distributions per Question', fontsize=13, fontweight='bold')
    ax.tick_params(axis='x', labelsize=9)

    legend_handles = [mpatches.Patch(color=c, label=t.capitalize())
                      for t, c in TASK_COLORS.items()]
    ax.legend(handles=legend_handles, title='Task', loc='lower right')
    plt.tight_layout()
    _save('survey_violins.png', pdf)


# ── Section 5: Dimension comparison across tasks ────────────────────────────────
def plot_dimension_comparison(df, pdf):
    """One subplot per dimension (difficulty / ease / accuracy), all tasks overlaid."""
    dims = {
        'Difficulty\nwithout XWebAgent': [k for k, (_, d, _) in QUESTIONS.items()
                                           if d == 'Difficulty\nwithout XWebAgent' and k in df.columns],
        'Ease\nwith XWebAgent':          [k for k, (_, d, _) in QUESTIONS.items()
                                           if d == 'Ease\nwith XWebAgent' and k in df.columns],
        'Accuracy':                      [k for k, (_, d, _) in QUESTIONS.items()
                                           if d == 'Accuracy' and k in df.columns],
    }
    dims = {d: ks for d, ks in dims.items() if ks}
    if not dims:
        return

    n = len(dims)
    fig, axes = plt.subplots(1, n, figsize=(5 * n, 4), sharey=True)
    if n == 1:
        axes = [axes]

    for ax, (dim, keys) in zip(axes, dims.items()):
        for key in keys:
            task  = QUESTIONS[key][0]
            vals  = df[key].dropna()
            # strip plot
            x_jit = np.random.uniform(-0.15, 0.15, size=len(vals))
            ax.scatter(np.full(len(vals), TASK_ORDER.index(task)) + x_jit,
                       vals, color=TASK_COLORS[task], alpha=0.5, s=25, zorder=3)
            ax.errorbar(TASK_ORDER.index(task), vals.mean(), yerr=vals.sem(),
                        fmt='D', color=TASK_COLORS[task], markersize=8,
                        capsize=5, linewidth=2, zorder=4)

        ax.set_xticks(range(len(TASK_ORDER)))
        ax.set_xticklabels([t.capitalize() for t in TASK_ORDER])
        ax.set_title(dim, fontsize=12, fontweight='bold')
        ax.set_ylim(0.5, 7.5)
        ax.set_yticks(range(1, 8))
        ax.set_xlabel('Task type')
        if ax == axes[0]:
            ax.set_ylabel('Rating (1–7)')

    fig.suptitle('Survey Dimensions by Task Type (diamond = mean ± SE)',
                 fontsize=13, fontweight='bold')
    plt.tight_layout()
    _save('survey_dimensions.png', pdf)


# ── Section 6: Diverging stacked Likert chart ──────────────────────────────────
# Color scheme: dark-pink→light-pink | neutral | light-green→dark-green
LIKERT_COLORS = {
    1: '#C2185B', 2: '#F06292', 3: '#F8BBD0',
    4: '#EEEEEE',
    5: '#C5E1A5', 6: '#66BB6A', 7: '#2E7D32',
}

def plot_diverging_likert(df, pdf):
    """
    Diverging stacked bar chart — one panel per task (Find / Guide / Hide).
    Bars centered at 0%; negative ratings (1–3) go left, positive (5–7) go right,
    neutral (4) is split. % of positive responses (≥5) annotated on the right.
    """
    # Group questions by task
    task_questions = {task: [] for task in TASK_ORDER}
    for key, (task, dim, _) in QUESTIONS.items():
        if key in df.columns:
            task_questions[task].append((key, dim.replace('\n', ' ')))

    panels = [(t, qs) for t, qs in task_questions.items() if qs]
    if not panels:
        return

    n_panels = len(panels)
    fig, axes = plt.subplots(1, n_panels, figsize=(6 * n_panels, max(3, 1.1 * max(len(q) for _, q in panels))),
                             sharey=False)
    if n_panels == 1:
        axes = [axes]

    for ax, (task, qs) in zip(axes, panels):
        n = len(df)
        y_pos = np.arange(len(qs))
        row_labels = [dim for _, dim in qs]

        for i, (key, dim) in enumerate(qs):
            counts = df[key].dropna().value_counts()
            pcts   = {r: counts.get(r, 0) / n * 100 for r in range(1, 8)}

            # Left side: 3, 2, 1 (drawn right-to-left from center)
            # Neutral (4) split evenly
            neutral_half = pcts[4] / 2
            left_start   = -(neutral_half + pcts[3] + pcts[2] + pcts[1])
            right_start  = 0

            # Draw neutral half on left
            ax.barh(i, -neutral_half, left=0, color=LIKERT_COLORS[4], height=0.6)
            # Draw 3, 2, 1 stacking left
            cursor = -neutral_half
            for r in [3, 2, 1]:
                ax.barh(i, -pcts[r], left=cursor, color=LIKERT_COLORS[r], height=0.6)
                cursor -= pcts[r]
            # Draw neutral half on right
            ax.barh(i, neutral_half, left=0, color=LIKERT_COLORS[4], height=0.6)
            # Draw 5, 6, 7 stacking right
            cursor = neutral_half
            for r in [5, 6, 7]:
                ax.barh(i, pcts[r], left=cursor, color=LIKERT_COLORS[r], height=0.6)
                cursor += pcts[r]

            # Annotate % positive (≥5) on the right
            pct_pos = sum(pcts[r] for r in [5, 6, 7])
            ax.text(102, i, f'{pct_pos:.0f}%', va='center', ha='left', fontsize=9,
                    fontweight='bold', color='#2E7D32')

        ax.set_yticks(y_pos)
        ax.set_yticklabels(row_labels, fontsize=9)
        ax.axvline(0, color='#555', linewidth=0.8)
        ax.set_xlim(-100, 115)
        ax.set_xticks([-75, -50, -25, 0, 25, 50, 75, 100])
        ax.set_xticklabels(['75%', '50%', '25%', '0%', '25%', '50%', '75%', '100%'],
                           fontsize=8)
        ax.set_xlabel('← Disagree / Agree →', fontsize=9)
        ax.set_title(f'{task.upper()}', fontsize=13, fontweight='bold',
                     color=TASK_COLORS[task])
        ax.spines[['top', 'right']].set_visible(False)

    # Shared legend
    legend_handles = [mpatches.Patch(color=LIKERT_COLORS[r], label=str(r))
                      for r in range(1, 8)]
    fig.legend(handles=legend_handles, title='Rating\n(1=Strongly Disagree\n7=Strongly Agree)',
               loc='lower center', ncol=7, bbox_to_anchor=(0.5, -0.08), fontsize=9)
    fig.suptitle('Post-Study Survey — Diverging Likert Chart (% positive annotated)',
                 fontsize=13, fontweight='bold')
    plt.tight_layout()
    _save('survey_diverging_likert.png', pdf)


# ── Helpers ─────────────────────────────────────────────────────────────────────
def _save(name, pdf=None):
    path = os.path.join(PLOT_DIR, name)
    plt.savefig(path, dpi=150, bbox_inches='tight')
    if pdf is not None:
        pdf.savefig(bbox_inches='tight')
    plt.close()
    print(f'  → plots/{name}')


# ── Main ────────────────────────────────────────────────────────────────────────
def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else None
    df = load_survey(csv_path)

    pdf_path = os.path.join(PLOT_DIR, 'survey_report.pdf')
    with PdfPages(pdf_path) as pdf:
        print_summary(df)
        plot_diverging_likert(df, pdf)
        plot_per_task(df, pdf)
        plot_likert_heatmap(df, pdf)
        plot_violins(df, pdf)
        plot_dimension_comparison(df, pdf)

    print(f'\nDone. Plots in plots/, report → {pdf_path}')


if __name__ == '__main__':
    main()
