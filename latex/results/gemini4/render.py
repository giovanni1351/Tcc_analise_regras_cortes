"""Gera a tabela e a figura a partir dos escores auditados, em frações."""
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

ROOT = Path(__file__).resolve().parent
results = json.loads((ROOT / 'results.json').read_text())
observed = results['observed']
def number(value):
    return f'{100 * value:.2f}'.replace('.', ',')

rows = []
for resolution in (224, 720):
    for metric in ('tight', 'loose'):
        baseline = observed[f'gemini38-{resolution}p'][metric]['a_mAP']
        hydrogen = observed[f'hydrogen-{resolution}p'][metric]['a_mAP']
        difference = results['comparisons'][f'hydrogen-minus-gemini38-{resolution}p-{metric}']['difference']
        assert abs(hydrogen - baseline - difference) < 1e-12
        rows.append(f'{resolution}p & \\textit{{{metric}}} & {number(baseline)} & {number(hydrogen)} & +{number(difference)} ' + r'\\ \hline')
header = r"""\begin{tabular}{|c|c|c|c|c|}
\hline
\textbf{Resolução} & \textbf{Métrica} & \textbf{Gemini 3.8 Flash} & \textbf{Gemini 4 Hydrogen} & \textbf{Diferença (p.p.)} \\ \hline
"""
(ROOT / 'table.tex').write_text(header + '\n'.join(rows) + '\n' + r'\end{tabular}' + '%\n')


plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 9, 'pdf.fonttype': 42})
fig, axes = plt.subplots(1, 2, figsize=(6.7, 2.65), sharey=True)
for ax, metric in zip(axes, ('tight', 'loose')):
    for offset, model, label, color in [(-0.18, 'gemini38', 'Gemini 3.8 Flash', '#7F7F7F'), (0.18, 'hydrogen', 'Gemini 4 Hydrogen', '#0070C0')]:
        values = [100 * observed[f'{model}-{r}p'][metric]['a_mAP'] for r in (224, 720)]
        bars = ax.bar([i + offset for i in range(2)], values, width=0.34, color=color, label=label)
        ax.bar_label(bars, labels=[f'{v:.2f}'.replace('.', ',') for v in values], padding=3, fontsize=8)
    ax.set(title=metric, xticks=[0, 1], xticklabels=['224p', '720p'], ylim=(0, 70))
    ax.spines[['top', 'right']].set_visible(False)
    ax.yaxis.set_major_formatter(FuncFormatter(lambda x, pos: f'{x:g}'))
axes[0].set_ylabel('Average-mAP (%)')
handles, labels = axes[0].get_legend_handles_labels()
fig.legend(handles, labels, loc='lower center', ncol=2, frameon=False)
fig.tight_layout(rect=(0, .12, 1, 1))
fig.savefig(ROOT.parents[1] / 'figures/gemini4-map.pdf', metadata={'CreationDate': None, 'ModDate': None})
