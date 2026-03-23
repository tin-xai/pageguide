"""
analyze.py
Full analysis of XWebAgent user study data.
Reads from data/tasks.csv and data/sessions.csv (run download_data.py first).
Saves plots to plots/ and a summary table to data/summary.csv.

Usage:
    python analyze.py
"""

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import seaborn as sns
from scipy.stats import wilcoxon, ttest_rel
from statsmodels.stats.contingency_tables import mcnemar
from urllib.parse import urlparse
from PIL import Image
import json, os, warnings
from matplotlib.backends.backend_pdf import PdfPages

warnings.filterwarnings('ignore')

# ── Paths ──────────────────────────────────────────────────────────────────────
BASE     = os.path.dirname(__file__)
DATA_DIR = os.path.join(BASE, 'data')
PLOT_DIR = os.path.join(BASE, 'plots')
os.makedirs(PLOT_DIR, exist_ok=True)

# ── Style ──────────────────────────────────────────────────────────────────────
sns.set_theme(style='whitegrid', palette='Set2')
plt.rcParams.update({'figure.figsize': (12, 5), 'font.size': 11})
COND_COLORS  = {'control': '#E57373', 'extension': '#64B5F6'}
TASK_ORDER   = ['find', 'guide', 'hide']
TASK_LABELS  = {'find': 'Find', 'guide': 'Guide', 'hide': 'Hide'}

# ── PDF report state ────────────────────────────────────────────────────────────
_pdf_pages = None   # set to PdfPages context in main()

_PDF_SKIP = {       # filenames that should NOT be added to the PDF
    'guide_screenshots.png',
    'paired_times.png',
    'paired_times_adjusted.png',
}


# ── Load & preprocess ──────────────────────────────────────────────────────────
def load_data():
    sessions_path = os.path.join(DATA_DIR, 'sessions.csv')
    tasks_path    = os.path.join(DATA_DIR, 'tasks.csv')

    if not os.path.exists(tasks_path):
        raise FileNotFoundError(
            'data/tasks.csv not found. Run download_data.py first.')

    sessions = pd.read_csv(sessions_path) if os.path.exists(sessions_path) else pd.DataFrame()
    tasks    = pd.read_csv(tasks_path)

    # Parse JSONB columns stored as strings
    for col in ['chat_transcript', 'page_visit_urls', 'task_data', 'user_hidden_selectors']:
        if col in tasks.columns:
            tasks[col] = tasks[col].apply(_safe_json)

    # Normalise boolean
    tasks['answer_correct'] = tasks['answer_correct'].map(
        {True: True, False: False, 'true': True, 'false': False,
         't': True, 'f': False, 1: True, 0: False})

    # Time conversions
    tasks['time_s']   = tasks['time_ms'].astype(float) / 1000
    tasks['time_min'] = tasks['time_s'] / 60

    # Adjusted time: deduct total model thinking time (extension condition only).
    # agent_think_ms is a JSON array of per-call durations in ms.
    if 'agent_think_ms' in tasks.columns:
        tasks['agent_think_ms'] = tasks['agent_think_ms'].apply(_safe_json)
        tasks['agent_think_total_s'] = tasks['agent_think_ms'].apply(
            lambda v: sum(v) / 1000 if isinstance(v, list) else 0)
    else:
        tasks['agent_think_total_s'] = 0.0
    # Only deduct for extension rows; control rows are unaffected.
    tasks['time_s_adjusted'] = tasks.apply(
        lambda r: max(0, r['time_s'] - r['agent_think_total_s'])
        if r.get('condition') == 'extension' else r['time_s'],
        axis=1,
    )

    # Numeric behaviour columns
    for col in ['scroll_count', 'ctrl_f_count', 'text_select_count',
                'page_visit_count', 'chat_turn_count', 'hidden_count',
                'click_count', 'mouse_move_px']:
        if col in tasks.columns:
            tasks[col] = pd.to_numeric(tasks[col], errors='coerce').fillna(0).astype(int)

    # Compute hide_recall from user_hidden_selectors vs task_data.hidden_elements
    # when the column is absent or all-null (older data)
    if 'hide_recall' not in tasks.columns:
        tasks['hide_recall'] = np.nan
    tasks['hide_recall'] = pd.to_numeric(tasks['hide_recall'], errors='coerce')

    hide_missing = tasks['task_type'].eq('hide') & tasks['hide_recall'].isna()
    if hide_missing.any() and 'user_hidden_selectors' in tasks.columns:
        tasks.loc[hide_missing, 'hide_recall'] = tasks.loc[hide_missing].apply(
            _compute_hide_recall, axis=1)

    # Exclude specific participants
    # EXCLUDE_PARTICIPANTS = {'Tina', 'luna', 'Brian', 'Alice2', 'logan bolton', 'Reza', 'Hung'}
    EXCLUDE_PARTICIPANTS = {'Tina'}
    tasks = tasks[~tasks['participant_id'].isin(EXCLUDE_PARTICIPANTS)].reset_index(drop=True)
    if not sessions.empty and 'participant_id' in sessions.columns:
        sessions = sessions[~sessions['participant_id'].isin(EXCLUDE_PARTICIPANTS)].reset_index(drop=True)

    # participant_id may be a shared username; use session_id for unique participant identity
    # (each participant completes exactly 6 tasks in one session)
    if 'session_id' in tasks.columns:
        tasks['participant_id'] = tasks['session_id'].astype(str)
    if not sessions.empty and 'session_id' in sessions.columns:
        sessions['participant_id'] = sessions['session_id'].astype(str)

    return sessions, tasks


def _safe_json(x):
    if isinstance(x, (list, dict)):
        return x
    try:
        return json.loads(x) if pd.notna(x) else []
    except Exception:
        return []


def _compute_hide_recall(row):
    """Recall = |user ∩ ground_truth| / |ground_truth|, based on CSS selectors."""
    td = row.get('task_data') if isinstance(row.get('task_data'), dict) else {}
    gt = set(td.get('hidden_elements', []))
    user_sel = row.get('user_hidden_selectors', [])
    if not isinstance(user_sel, list):
        user_sel = []
    user = set(user_sel)
    if not gt:
        return np.nan
    return len(gt & user) / len(gt)


# ── Section 1: Overview ────────────────────────────────────────────────────────
def print_overview(sessions, tasks):
    print('=' * 60)
    print('OVERVIEW')
    print('=' * 60)
    print(f'Sessions:          {len(sessions)}')
    print(f'Task results:      {len(tasks)}')
    print(f'Participants:      {tasks["participant_id"].nunique()}')
    print()
    print('Task results per type × condition:')
    print(tasks.groupby(['task_type', 'condition']).size().unstack(fill_value=0).to_string())
    print()

    # Per-participant completion
    per_p = (tasks.groupby('participant_id')
             .agg(n_tasks=('id', 'count'),
                  conditions=('condition', lambda x: ' | '.join(sorted(x.unique()))))
             .reset_index())
    print('Per-participant task counts:')
    print(per_p.to_string(index=False))
    print()


# ── Section 2: Completion time ─────────────────────────────────────────────────
def plot_time_analysis(tasks):
    print('─' * 40)
    print('TASK COMPLETION TIME')
    print('─' * 40)

    time_summary = (tasks.groupby(['task_type', 'condition'])['time_s']
                    .agg(mean='mean', median='median', std='std', n='count')
                    .round(1))
    print(time_summary.to_string())
    print()

    # Box + strip per task type
    fig, axes = plt.subplots(1, 3, figsize=(15, 5), sharey=False)
    for ax, ttype in zip(axes, TASK_ORDER):
        sub = tasks[tasks['task_type'] == ttype]
        sns.boxplot(data=sub, x='condition', y='time_s', palette=COND_COLORS,
                    order=['control', 'extension'], ax=ax, width=0.5, fliersize=0)
        sns.stripplot(data=sub, x='condition', y='time_s',
                      order=['control', 'extension'],
                      color='#333', alpha=0.5, size=5, ax=ax, jitter=True)
        ax.set_title(TASK_LABELS[ttype], fontsize=13, fontweight='bold')
        ax.set_xlabel('')
        ax.set_ylabel('Time (s)' if ttype == 'find' else '')
    fig.suptitle('Task Completion Time — Control vs Extension', fontsize=14, fontweight='bold')
    plt.tight_layout()
    _save('time_by_condition.png')

    # Paired slope chart
    paired = (tasks.pivot_table(index=['participant_id', 'task_type'],
                                columns='condition', values='time_s',
                                aggfunc='mean')
              .reset_index()
              .dropna(subset=['control', 'extension'] if 'control' in tasks['condition'].values else []))

    if not paired.empty and 'control' in paired.columns and 'extension' in paired.columns:
        paired['diff_s']      = paired['control'] - paired['extension']
        paired['speedup_pct'] = (paired['diff_s'] / paired['control'] * 100).round(1)

        print('Mean improvement with extension (positive = faster):')
        print(paired.groupby('task_type')[['diff_s', 'speedup_pct']].mean().round(2).to_string())
        print()

        fig, ax = plt.subplots(figsize=(8, 5))
        task_colors = {'find': '#2196F3', 'guide': '#4CAF50', 'hide': '#FF9800'}
        for _, row in paired.iterrows():
            c = task_colors.get(row['task_type'], '#888')
            ax.plot(['Control', 'Extension'], [row['control'], row['extension']],
                    'o-', color=c, alpha=0.6, linewidth=1.5, markersize=6)
        legend_handles = [mpatches.Patch(color=c, label=t.capitalize())
                          for t, c in task_colors.items()]
        ax.legend(handles=legend_handles, title='Task type')
        ax.set_ylabel('Time (s)')
        ax.set_title('Paired Completion Times per Participant', fontsize=13, fontweight='bold')
        plt.tight_layout()
        _save('paired_times.png')

        paired.to_csv(os.path.join(DATA_DIR, 'paired_times.csv'), index=False)


# ── Section 3: Task success ────────────────────────────────────────────────────
def plot_success_rates(tasks):
    print('─' * 40)
    print('TASK SUCCESS RATES')
    print('─' * 40)

    # ── Find accuracy ──────────────────────────────────────────────────────────
    find_t = tasks[tasks['task_type'] == 'find'].copy()
    if not find_t.empty and 'answer_correct' in find_t.columns:
        acc = find_t.groupby('condition')['answer_correct'].mean().mul(100).round(1)
        print('Find task accuracy (%):')
        print(acc.to_string())
        print()

        # Per-participant accuracy (paired view)
        p_acc = (find_t.groupby(['participant_id', 'condition'])['answer_correct']
                 .mean().mul(100).round(1)
                 .unstack(fill_value=np.nan))
        print('Per-participant Find accuracy (%):')
        print(p_acc.to_string())
        print()

        fig, ax = plt.subplots(figsize=(6, 4))
        acc.plot(kind='bar', color=[COND_COLORS[c] for c in acc.index],
                 edgecolor='white', ax=ax)
        ax.set_title('Find Task Accuracy', fontsize=13, fontweight='bold')
        ax.set_ylabel('% correct')
        ax.set_ylim(0, 100)
        ax.set_xticklabels(ax.get_xticklabels(), rotation=0)
        plt.tight_layout()
        _save('find_accuracy.png')

        # Confidence × accuracy breakdown (find only)
        if 'confidence' in find_t.columns:
            ca = (find_t.groupby(['condition', 'confidence'])['answer_correct']
                  .agg(n='count', correct='sum')
                  .assign(pct=lambda d: (d['correct'].astype(float) / d['n'] * 100).round(1))
                  .reset_index())
            print('Find: accuracy by confidence level:')
            print(ca.to_string(index=False))
            print()

    # ── Guide / Hide completion ────────────────────────────────────────────────
    for ttype in ['guide', 'hide']:
        sub = tasks[tasks['task_type'] == ttype]
        if sub.empty:
            continue
        ct = sub.groupby(['condition', 'answer']).size().unstack(fill_value=0)
        ct_pct = ct.div(ct.sum(axis=1), axis=0).mul(100).round(1)
        print(f'{ttype.capitalize()} completion (%):')
        print(ct_pct.to_string())
        print()

    # ── Hide accuracy (recall) ─────────────────────────────────────────────────
    hide_t = tasks[tasks['task_type'] == 'hide'].copy()
    if not hide_t.empty and 'hide_recall' in hide_t.columns:
        has_recall = hide_t['hide_recall'].notna()
        if has_recall.any():
            recall_summary = (hide_t[has_recall]
                              .groupby('condition')['hide_recall']
                              .agg(mean='mean', median='median', std='std', n='count')
                              .mul(100).round(1))
            print('Hide task accuracy — recall (%) of annotated items hidden:')
            print(recall_summary.to_string())
            print()

            fig, ax = plt.subplots(figsize=(6, 4))
            sns.barplot(data=hide_t[has_recall], x='condition', y='hide_recall',
                        order=['control', 'extension'], palette=COND_COLORS,
                        ax=ax, errorbar='se', capsize=0.12)
            ax.set_title('Hide Task Accuracy (Recall)', fontsize=13, fontweight='bold')
            ax.set_ylabel('Recall (0–1)')
            ax.set_ylim(0, 1)
            ax.set_xlabel('')
            ax.set_xticklabels(['Control', 'Extension'])
            plt.tight_layout()
            _save('hide_accuracy.png')

    # ── Stacked outcome chart for guide + hide ─────────────────────────────────
    other = tasks[tasks['task_type'].isin(['guide', 'hide'])]
    if not other.empty:
        answer_order  = ['completed', 'partial', 'failed']
        answer_colors = {'completed': '#4CAF50', 'partial': '#FFC107', 'failed': '#F44336'}

        fig, axes = plt.subplots(1, 2, figsize=(12, 4))
        for ax, ttype in zip(axes, ['guide', 'hide']):
            sub = other[other['task_type'] == ttype]
            ct = sub.groupby(['condition', 'answer']).size().unstack(fill_value=0)
            ct_pct = ct.div(ct.sum(axis=1), axis=0).mul(100)
            valid = [a for a in answer_order if a in ct_pct.columns]
            ct_pct[valid].plot(kind='bar', ax=ax, stacked=True,
                               color=[answer_colors[a] for a in valid],
                               edgecolor='white', rot=0)
            ax.set_title(f'{ttype.capitalize()} Task Outcome', fontsize=12, fontweight='bold')
            ax.set_xlabel('')
            ax.set_ylabel('% participants')
            ax.set_ylim(0, 100)
            ax.legend(title='Outcome', bbox_to_anchor=(1, 1), loc='upper left')
        plt.tight_layout()
        _save('completion_rates.png')


# ── Section 4: Behavioural metrics ────────────────────────────────────────────
def plot_behavioral_metrics(tasks):
    beh_cols = {
        'scroll_count':      'Scroll gestures',
        'ctrl_f_count':      'Ctrl+F presses',
        'text_select_count': 'Text selections',
        'click_count':       'Mouse clicks',
        'mouse_move_px':     'Mouse distance (px)',
        'page_visit_count':  'Page visits',
    }
    available = {k: v for k, v in beh_cols.items() if k in tasks.columns}
    if not available:
        return

    print('─' * 40)
    print('BEHAVIORAL METRICS')
    print('─' * 40)

    means = tasks.groupby('condition')[list(available.keys())].mean().round(2)
    print(means.rename(columns=available).to_string())
    print()

    # Bar chart: mean ± SE by condition
    n = len(available)
    fig, axes = plt.subplots(1, n, figsize=(4 * n, 4))
    if n == 1:
        axes = [axes]
    for ax, (col, label) in zip(axes, available.items()):
        sns.barplot(data=tasks, x='condition', y=col, order=['control', 'extension'],
                    palette=COND_COLORS, ax=ax, errorbar='se', capsize=0.12)
        ax.set_title(label, fontsize=11)
        ax.set_xlabel('')
        ax.set_ylabel('Mean count')
    fig.suptitle('Behavioral Metrics by Condition (mean ± SE)',
                 fontsize=13, fontweight='bold')
    plt.tight_layout()
    _save('behavioral_overview.png')

    # Grouped bar: per task type
    fig, axes = plt.subplots(1, n, figsize=(4 * n, 4))
    if n == 1:
        axes = [axes]
    for ax, (col, label) in zip(axes, available.items()):
        sns.barplot(data=tasks, x='task_type', y=col, hue='condition',
                    order=TASK_ORDER, hue_order=['control', 'extension'],
                    palette=COND_COLORS, ax=ax, errorbar='se', capsize=0.08)
        ax.set_title(label, fontsize=11)
        ax.set_xlabel('')
        ax.set_ylabel('Mean count')
        ax.legend(title='', fontsize=9)
    fig.suptitle('Behavioral Metrics by Task Type',
                 fontsize=13, fontweight='bold')
    plt.tight_layout()
    _save('behavioral_by_task.png')

    # Top visited domains (control condition — "searching on their own")
    if 'page_visit_urls' in tasks.columns:
        ctrl_urls = []
        for urls in tasks[tasks['condition'] == 'control']['page_visit_urls']:
            if isinstance(urls, list):
                ctrl_urls.extend(urls)
        if ctrl_urls:
            domains = [urlparse(u).netloc.replace('www.', '') for u in ctrl_urls if u]
            top_domains = pd.Series(domains).value_counts().head(15)
            fig, ax = plt.subplots(figsize=(10, 4))
            top_domains.plot(kind='barh', ax=ax, color='#78909C')
            ax.invert_yaxis()
            ax.set_title('Top Visited Domains (Control Condition)', fontsize=13, fontweight='bold')
            ax.set_xlabel('Visit count')
            plt.tight_layout()
            _save('top_domains_control.png')
            print('Top visited domains (control):')
            print(top_domains.to_string())
            print()


# ── Section 5: Chat usage ──────────────────────────────────────────────────────
def plot_chat_usage(tasks):
    ext = tasks[tasks['condition'] == 'extension'].copy()
    if ext.empty or 'chat_turn_count' not in ext.columns:
        return

    print('─' * 40)
    print('CHAT USAGE (extension condition)')
    print('─' * 40)

    print('Mean queries per task type:')
    print(ext.groupby('task_type')['chat_turn_count'].mean().round(2).to_string())
    print()

    fig, axes = plt.subplots(1, 2, figsize=(13, 4))

    # Query count histogram
    max_turns = int(ext['chat_turn_count'].max()) if ext['chat_turn_count'].max() > 0 else 5
    sns.histplot(data=ext, x='chat_turn_count',
                 bins=range(0, max_turns + 2),
                 hue='task_type', multiple='stack',
                 hue_order=TASK_ORDER,
                 ax=axes[0], palette='Set2')
    axes[0].set_title('Number of AI Queries per Task', fontsize=12, fontweight='bold')
    axes[0].set_xlabel('Query count')
    axes[0].set_ylabel('Tasks')

    # Helpfulness ratings
    if 'helpfulness' in ext.columns:
        help_order  = ['very', 'somewhat', 'not', 'unused']
        help_colors = {'very': '#4CAF50', 'somewhat': '#8BC34A',
                       'not': '#F44336', 'unused': '#9E9E9E'}
        ct = ext.groupby(['task_type', 'helpfulness']).size().unstack(fill_value=0)
        ct_pct = ct.div(ct.sum(axis=1), axis=0).mul(100)
        valid = [c for c in help_order if c in ct_pct.columns]
        if valid:
            ct_pct[valid].plot(kind='bar', ax=axes[1], stacked=True,
                               color=[help_colors[c] for c in valid],
                               edgecolor='white', rot=0)
            axes[1].set_title('Helpfulness Ratings by Task Type', fontsize=12, fontweight='bold')
            axes[1].set_xlabel('')
            axes[1].set_ylabel('% participants')
            axes[1].set_ylim(0, 100)
            axes[1].legend(title='Rating', bbox_to_anchor=(1, 1))

    plt.tight_layout()
    _save('chat_usage.png')

    # Correlation: more queries → faster or slower?
    if 'time_s' in ext.columns:
        corr = ext[['chat_turn_count', 'time_s']].corr().iloc[0, 1]
        print(f'Correlation (queries vs time, extension): r = {corr:.3f}')
        print()


# ── Section 6: Statistical tests ──────────────────────────────────────────────
def run_stats(tasks):
    print('─' * 40)
    print('STATISTICAL TESTS (paired, within-subject)')
    print('─' * 40)

    n_participants = tasks['participant_id'].nunique()
    if n_participants < 5:
        print(f'⚠️  Only {n_participants} participants — results are illustrative, not conclusive.\n')

    records = []

    # ── Completion time: Wilcoxon + paired t-test ──────────────────────────────
    print('[ Completion Time ]')
    for ttype in TASK_ORDER:
        sub    = tasks[tasks['task_type'] == ttype]
        paired = (sub.pivot_table(index='participant_id', columns='condition',
                                  values='time_s', aggfunc='mean')
                  .dropna(subset=['control', 'extension']
                          if 'control' in sub['condition'].values else []))

        if len(paired) < 3 or 'control' not in paired.columns or 'extension' not in paired.columns:
            print(f'  {ttype:6s}  n={len(paired)} — not enough paired data')
            continue

        ctrl = paired['control'].values
        ext  = paired['extension'].values
        diff = ctrl - ext

        try:
            _, p_w = wilcoxon(ctrl, ext)
        except Exception:
            p_w = float('nan')
        _, p_t = ttest_rel(ctrl, ext)
        cohen_d = diff.mean() / diff.std() if diff.std() > 0 else float('nan')

        sig = '**' if p_w < 0.05 else ('†' if p_w < 0.1 else 'ns')
        print(f'  {ttype:6s}  n={len(paired):2d}  '
              f'ctrl={ctrl.mean():6.1f}s  ext={ext.mean():6.1f}s  '
              f'diff={diff.mean():+5.1f}s  '
              f'Wilcoxon p={p_w:.4f} {sig}  t-test p={p_t:.4f}  d={cohen_d:.2f}')

        records.append({
            'metric':       'time_s',
            'task_type':    ttype,
            'n':            len(paired),
            'mean_ctrl':    round(float(ctrl.mean()), 2),
            'mean_ext':     round(float(ext.mean()), 2),
            'mean_diff':    round(float(diff.mean()), 2),
            'wilcoxon_p':   round(float(p_w), 4),
            'ttest_p':      round(float(p_t), 4),
            'cohens_d':     round(float(cohen_d), 3),
        })

    print('  ** p<0.05  † p<0.10  ns not significant')
    print()

    # ── Find accuracy: McNemar's test (within-subject binary) ─────────────────
    find_t = tasks[tasks['task_type'] == 'find'].copy()
    if not find_t.empty and 'answer_correct' in find_t.columns:
        print('[ Find Accuracy — McNemar\'s test ]')
        paired_acc = (find_t.pivot_table(index='participant_id', columns='condition',
                                         values='answer_correct', aggfunc='mean')
                      .dropna(subset=['control', 'extension']
                              if 'control' in find_t['condition'].values else []))
        if not paired_acc.empty and 'control' in paired_acc.columns and 'extension' in paired_acc.columns:
            ctrl_acc = paired_acc['control'].mean() * 100
            ext_acc  = paired_acc['extension'].mean() * 100
            print(f'  control accuracy: {ctrl_acc:.1f}%  |  extension accuracy: {ext_acc:.1f}%')
            # Build 2×2 contingency for McNemar (needs per-item, not per-participant means)
            mc_data = find_t[['participant_id', 'condition', 'answer_correct']].dropna()
            piv = mc_data.pivot_table(index='participant_id', columns='condition',
                                      values='answer_correct', aggfunc='first')
            if 'control' in piv.columns and 'extension' in piv.columns:
                piv = piv.dropna()
                n_00 = ((piv['control'] == False) & (piv['extension'] == False)).sum()
                n_01 = ((piv['control'] == False) & (piv['extension'] == True)).sum()
                n_10 = ((piv['control'] == True)  & (piv['extension'] == False)).sum()
                n_11 = ((piv['control'] == True)  & (piv['extension'] == True)).sum()
                table = [[n_11, n_10], [n_01, n_00]]
                try:
                    result = mcnemar(table, exact=True)
                    print(f'  McNemar exact p = {result.pvalue:.4f}')
                except Exception as e:
                    print(f'  McNemar test skipped: {e}')
                print(f'  Contingency: both_correct={n_11}  ctrl_only={n_10}  '
                      f'ext_only={n_01}  both_wrong={n_00}')
        print()

    # ── Hide recall ────────────────────────────────────────────────────────────
    hide_t = tasks[tasks['task_type'] == 'hide']
    if not hide_t.empty and 'hide_recall' in hide_t.columns:
        has_recall = hide_t['hide_recall'].notna()
        if has_recall.sum() >= 2:
            print('[ Hide Recall ]')
            paired_r = (hide_t[has_recall]
                        .pivot_table(index='participant_id', columns='condition',
                                     values='hide_recall', aggfunc='mean')
                        .dropna(subset=['control', 'extension']
                                if 'control' in hide_t['condition'].values else []))
            if len(paired_r) >= 2 and 'control' in paired_r.columns and 'extension' in paired_r.columns:
                c_r = paired_r['control'].values
                e_r = paired_r['extension'].values
                diff_r = c_r - e_r
                try:
                    _, p_w_r = wilcoxon(c_r, e_r)
                except Exception:
                    p_w_r = float('nan')
                print(f'  ctrl recall={c_r.mean():.3f}  ext recall={e_r.mean():.3f}  '
                      f'diff={diff_r.mean():+.3f}  Wilcoxon p={p_w_r:.4f}')
            print()

    if records:
        stats_df = pd.DataFrame(records)
        stats_df.to_csv(os.path.join(DATA_DIR, 'stats_results.csv'), index=False)
        print('Saved → data/stats_results.csv')
        print()


# ── Section 7: Adjusted time (deduct model thinking) ──────────────────────────
def plot_adjusted_time_analysis(tasks):
    """Re-run time analysis using time_s_adjusted (thinking time deducted for extension)."""
    if 'time_s_adjusted' not in tasks.columns:
        return

    think_summary = (tasks[tasks['condition'] == 'extension']
                     .groupby('task_type')['agent_think_total_s']
                     .agg(mean='mean', median='median', total='sum', n='count')
                     .round(1))
    print('─' * 40)
    print('MODEL THINKING TIME (extension condition, seconds)')
    print('─' * 40)
    print(think_summary.to_string())
    print()

    print('─' * 40)
    print('ADJUSTED COMPLETION TIME (thinking time deducted from extension)')
    print('─' * 40)

    adj_summary = (tasks.groupby(['task_type', 'condition'])['time_s_adjusted']
                   .agg(mean='mean', median='median', std='std', n='count')
                   .round(1))
    print(adj_summary.to_string())
    print()

    # Side-by-side: raw vs adjusted for extension only
    ext = tasks[tasks['condition'] == 'extension'].copy()
    if not ext.empty:
        print('Extension — raw vs adjusted mean time (s):')
        comp = ext.groupby('task_type')[['time_s', 'time_s_adjusted']].mean().round(1)
        comp['thinking_deducted_s'] = (comp['time_s'] - comp['time_s_adjusted']).round(1)
        print(comp.to_string())
        print()

    # Paired slope chart (within-subjects) or bar chart fallback (between-subjects)
    paired = (tasks.pivot_table(index=['participant_id', 'task_type'],
                                columns='condition', values='time_s_adjusted',
                                aggfunc='mean')
              .reset_index()
              .dropna(subset=['control', 'extension']
                      if 'control' in tasks['condition'].values else []))

    if not paired.empty and 'control' in paired.columns and 'extension' in paired.columns:
        paired['diff_s']      = paired['control'] - paired['extension']
        paired['speedup_pct'] = (paired['diff_s'] / paired['control'] * 100).round(1)

        print('Mean improvement with extension — adjusted (positive = faster):')
        print(paired.groupby('task_type')[['diff_s', 'speedup_pct']].mean().round(2).to_string())
        print()

        fig, ax = plt.subplots(figsize=(8, 5))
        task_colors = {'find': '#2196F3', 'guide': '#4CAF50', 'hide': '#FF9800'}
        for _, row in paired.iterrows():
            c = task_colors.get(row['task_type'], '#888')
            ax.plot(['Control', 'Extension\n(adjusted)'],
                    [row['control'], row['extension']],
                    'o-', color=c, alpha=0.6, linewidth=1.5, markersize=6)
        legend_handles = [mpatches.Patch(color=c, label=t.capitalize())
                          for t, c in task_colors.items()]
        ax.legend(handles=legend_handles, title='Task type')
        ax.set_ylabel('Time (s)')
        ax.set_title('Paired Completion Times — Thinking Time Deducted',
                     fontsize=13, fontweight='bold')
        plt.tight_layout()
        _save('paired_times_adjusted.png')
    else:
        # Between-subjects fallback: bar chart comparing conditions side by side
        print('  (No within-subjects paired data — showing group bar chart instead)')
        fig, axes = plt.subplots(1, 3, figsize=(15, 5), sharey=False)
        for ax, ttype in zip(axes, TASK_ORDER):
            sub = tasks[tasks['task_type'] == ttype]
            sns.barplot(data=sub, x='condition', y='time_s_adjusted',
                        order=['control', 'extension'], palette=COND_COLORS,
                        ax=ax, errorbar='se', capsize=0.12)
            ax.set_title(TASK_LABELS[ttype], fontsize=13, fontweight='bold')
            ax.set_xlabel('')
            ax.set_ylabel('Time (s, adjusted)' if ttype == 'find' else '')
        fig.suptitle('Adjusted Completion Time — Control vs Extension (thinking time deducted)',
                     fontsize=13, fontweight='bold')
        plt.tight_layout()
        _save('paired_times_adjusted.png')

    # Statistical tests on adjusted time
    print('[ Adjusted Completion Time — Wilcoxon + paired t-test ]')
    for ttype in TASK_ORDER:
        sub    = tasks[tasks['task_type'] == ttype]
        paired_s = (sub.pivot_table(index='participant_id', columns='condition',
                                    values='time_s_adjusted', aggfunc='mean')
                    .dropna(subset=['control', 'extension']
                            if 'control' in sub['condition'].values else []))
        if len(paired_s) < 3 or 'control' not in paired_s.columns or 'extension' not in paired_s.columns:
            print(f'  {ttype:6s}  n={len(paired_s)} — not enough paired data')
            continue
        ctrl = paired_s['control'].values
        ext  = paired_s['extension'].values
        diff = ctrl - ext
        try:
            _, p_w = wilcoxon(ctrl, ext)
        except Exception:
            p_w = float('nan')
        _, p_t = ttest_rel(ctrl, ext)
        cohen_d = diff.mean() / diff.std() if diff.std() > 0 else float('nan')
        sig = '**' if p_w < 0.05 else ('†' if p_w < 0.1 else 'ns')
        print(f'  {ttype:6s}  n={len(paired_s):2d}  '
              f'ctrl={ctrl.mean():6.1f}s  ext_adj={ext.mean():6.1f}s  '
              f'diff={diff.mean():+5.1f}s  '
              f'Wilcoxon p={p_w:.4f} {sig}  t-test p={p_t:.4f}  d={cohen_d:.2f}')
    print('  ** p<0.05  † p<0.10  ns not significant')
    print()


# ── Section 9: Guide screenshots ──────────────────────────────────────────────
def show_guide_screenshots(tasks):
    """
    Display guide screenshots in a grid (one per guide task row that has a screenshot).
    Screenshots are either PNG file paths (set by download_data.py) or raw base64 strings.
    Saves a grid image to plots/guide_screenshots.png.
    """
    import base64
    from io import BytesIO

    if 'guide_screenshot' not in tasks.columns:
        print('No guide_screenshot column found.')
        return

    guide_rows = tasks[
        tasks['task_type'].eq('guide') & tasks['guide_screenshot'].notna() &
        tasks['guide_screenshot'].ne('')
    ].reset_index(drop=True)

    if guide_rows.empty:
        print('No guide screenshots available.')
        return

    print('─' * 40)
    print(f'GUIDE SCREENSHOTS ({len(guide_rows)} found)')
    print('─' * 40)

    images, titles = [], []
    for _, row in guide_rows.iterrows():
        val = row['guide_screenshot']
        try:
            if os.path.isfile(os.path.join(BASE, val)):
                # File path saved by download_data.py
                img = Image.open(os.path.join(BASE, val))
            else:
                # Raw base64 string (fallback)
                raw = val.split(',', 1)[-1] if ',' in val else val
                img = Image.open(BytesIO(base64.b64decode(raw)))
            images.append(img)
            pid  = row.get('participant_id', '?')
            cond = row.get('condition', '?')
            qi   = row.get('question_index', row.get('task_index', '?'))
            task = str(row.get('question_or_task', ''))[:40]
            titles.append(f'{pid} | {cond} | q{qi}\n{task}')
        except Exception as e:
            print(f'  ⚠️  Could not load screenshot for row {row.name}: {e}')

    if not images:
        return

    cols = min(4, len(images))
    rows = (len(images) + cols - 1) // cols
    fig, axes = plt.subplots(rows, cols, figsize=(5 * cols, 4 * rows))
    axes = np.array(axes).reshape(-1) if rows * cols > 1 else [axes]

    for ax, img, title in zip(axes, images, titles):
        ax.imshow(img)
        ax.set_title(title, fontsize=8)
        ax.axis('off')

    # Hide unused subplots
    for ax in axes[len(images):]:
        ax.axis('off')

    fig.suptitle('Guide Task Screenshots', fontsize=13, fontweight='bold')
    plt.tight_layout()
    _save('guide_screenshots.png')
    print(f'  Grid saved → plots/guide_screenshots.png')


# ── Section 10: Summary export ──────────────────────────────────────────────────
def export_summary(tasks):
    keep = ['participant_id', 'session_id', 'block_index', 'task_index',
            'question_index', 'task_type', 'condition', 'time_s',
            'answer', 'answer_correct', 'confidence', 'helpfulness',
            'chat_turn_count', 'hidden_count', 'hide_recall',
            'scroll_count', 'ctrl_f_count', 'text_select_count',
            'click_count', 'mouse_move_px',
            'page_visit_count', 'question_or_task']
    cols = [c for c in keep if c in tasks.columns]
    out  = tasks[cols].copy()
    out.to_csv(os.path.join(DATA_DIR, 'summary.csv'), index=False)
    print(f'Saved → data/summary.csv  ({len(out)} rows × {len(cols)} cols)')


# ── Helpers ────────────────────────────────────────────────────────────────────
def _save(name):
    path = os.path.join(PLOT_DIR, name)
    fig = plt.gcf()
    fig.savefig(path, dpi=150, bbox_inches='tight')
    if _pdf_pages is not None and name not in _PDF_SKIP:
        _pdf_pages.savefig(fig, bbox_inches='tight')
    plt.close(fig)
    print(f'  → plots/{name}')


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    global _pdf_pages

    sessions, tasks = load_data()

    pdf_path = os.path.join(BASE, 'report.pdf')
    with PdfPages(pdf_path) as pdf:
        _pdf_pages = pdf

        print_overview(sessions, tasks)
        plot_time_analysis(tasks)
        plot_success_rates(tasks)
        plot_behavioral_metrics(tasks)
        plot_chat_usage(tasks)
        run_stats(tasks)
        plot_adjusted_time_analysis(tasks)
        show_guide_screenshots(tasks)
        export_summary(tasks)

        _pdf_pages = None

    print(f'\nDone. Plots saved in plots/, tables in data/')
    print(f'PDF report → {pdf_path}')


if __name__ == '__main__':
    main()
