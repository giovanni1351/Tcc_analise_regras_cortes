"""Busca exata na grade do simulador, com restrição de recall no treino."""
from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from math import ceil
from typing import Callable

import numpy as np
import pandas as pd

from tcc_soccer_highlights.highlight_study import qualifying_mask, validate_event_delta


PARAMETERS = ('short', 'zero', 'cluster', 'preceding', 'before', 'after')
MAX_WINDOW = 600


class TrainingEvaluator:
    """Usa o mesmo núcleo de regras do simulador, sem acessar os dados de teste."""

    def __init__(self, records, labels, event_delta=0.):
        self.event_delta = validate_event_delta(event_delta)
        self.records = [r for r in records.values() if r['split'] == 'treino']
        if not self.records:
            raise ValueError('Não há vídeos de treino disponíveis para otimizar.')
        self.times = [r['events'].loc[r['events'].label.isin(labels), 'time_sec'].to_numpy(float)
                      for r in self.records]
        self.features = [tuple(r['features'][column].to_numpy(float) for column in
                               ['start_sec', 'duration_sec', 'size', 'zero_fraction', 'previous_players'])
                         for r in self.records]
        self.events = sum(map(len, self.times))
        self.duration = sum(r['duration'] for r in self.records)
        if not self.events:
            raise ValueError('Não há eventos dos tipos selecionados no conjunto de treino.')
        if not np.isfinite(self.duration) or self.duration <= 0:
            raise ValueError('O conjunto de treino precisa ter duração válida.')

    def anchors(self, rule):
        return [np.sort(features[0][qualifying_mask(*features, r['duration'], **rule)])
                for features, r in zip(self.features, self.records)]

    def evaluate(self, config):
        before, after = config['before'], config['after']
        if before < 0 or after < 0 or before + after <= 0:
            raise ValueError('A janela deve ser não negativa e somar mais de zero.')
        anchors_by_video = self.anchors({k: config[k] for k in PARAMETERS[:4]})
        hits, selected = 0, 0.
        for record, times, anchors in zip(self.records, self.times, anchors_by_video):
            if not len(anchors):
                continue
            starts = np.maximum(0., anchors - before)
            ends = np.minimum(record['duration'], anchors + after)
            selected += float(np.maximum(0., ends - np.maximum(starts, np.r_[0., ends[:-1]])).sum())
            idx = np.searchsorted(starts, times + self.event_delta, side='right') - 1
            hits += int(((idx >= 0) & (times - self.event_delta <= ends[np.maximum(idx, 0)])).sum())
        return self.metrics(hits, selected)

    def metrics(self, hits, selected):
        return dict(hits=int(hits), events=self.events, recall=hits / self.events,
                    reduction=float(np.clip(1 - selected / self.duration, 0., 1.)),
                    selected_sec=float(selected), total_sec=self.duration)

    def window_grid(self, rule, max_window):
        """Recall e duração para todos os pares inteiros antes/depois.

        Cada evento é capturado pela âncora anterior OU pela seguinte. Um
        histograma 2D das distâncias calcula a união dessas condições para toda
        a grade. A duração é o envelope dos intervalos menos os espaços vazios
        entre âncoras; dispensa gerar milhões de tabelas de candidatos.
        """
        width = max_window + 2  # Última posição: inalcançável nessa direção.
        histogram = np.zeros((width, width), dtype=np.int64)
        first, last, durations, gaps = [], [], [], []
        for record, times, anchors in zip(self.records, self.times, self.anchors(rule)):
            if not len(anchors):
                histogram[-1, -1] += len(times)
                continue
            first.append(anchors[0]); last.append(anchors[-1]); durations.append(record['duration'])
            gaps.extend(np.diff(anchors))
            right = np.searchsorted(anchors, times)
            left = np.searchsorted(anchors, times, side='right') - 1
            before = np.full(len(times), max_window + 1, dtype=int)
            after = before.copy()
            valid = right < len(anchors)
            before[valid] = np.clip(np.ceil(anchors[right[valid]] - (times[valid] + self.event_delta)),
                                    0, max_window + 1).astype(int)
            # Corrige ceil em bordas decimais (p.ex. 17,1 - 15,1 > 2 no float),
            # reproduzindo a comparação inclusiva do gerador de intervalos.
            before[valid] -= ((before[valid] > 0) &
                              (anchors[right[valid]] - (before[valid] - 1) <= times[valid] + self.event_delta))
            valid = left >= 0
            after[valid] = np.clip(np.ceil((times[valid] - self.event_delta) - anchors[left[valid]]),
                                   0, max_window + 1).astype(int)
            after[valid] -= ((after[valid] > 0) &
                             (times[valid] - self.event_delta <= anchors[left[valid]] + (after[valid] - 1)))
            np.add.at(histogram, (before, after), 1)
        cumulative = histogram.cumsum(axis=0).cumsum(axis=1)
        hits = cumulative[:-1, -1, None] + cumulative[-1, None, :-1] - cumulative[:-1, :-1]
        windows = np.arange(max_window + 1)
        if first:
            # A soma dos vãos positivos depende apenas de before + after.
            gaps = np.sort(np.asarray(gaps))
            prefix = np.r_[0., np.cumsum(gaps)]
            total_width = np.arange(2 * max_window + 1)
            idx = np.searchsorted(gaps, total_width, side='right')
            holes = prefix[-1] - prefix[idx] - (len(gaps) - idx) * total_width
            lo = np.maximum(0., np.asarray(first)[None, :] - windows[:, None]).sum(axis=1)
            hi = np.minimum(np.asarray(durations)[None, :],
                            np.asarray(last)[None, :] + windows[:, None]).sum(axis=1)
            selected = hi[None, :] - lo[:, None] - holes[windows[:, None] + windows[None, :]]
            selected = np.clip(selected, 0., self.duration)
        else:
            selected = np.zeros_like(hits, dtype=float)
        return hits, selected


@dataclass
class OptimizationResult:
    config: dict
    baseline: dict
    best: dict
    candidates: pd.DataFrame
    history: pd.DataFrame
    target_recall: float
    feasible: bool
    max_recall: float
    evaluated_combinations: int


def optimize_rules(records, labels, initial_config, *, min_recall=.9, max_window=120, event_delta=0.,
                   progress: Callable[[int, int, float], None] | None = None):
    """Maximiza redução com recall >= meta solicitada nesta execução.

    Enumera todas as 2.520 regras e todos os pares de janelas da grade finita.
    Não usa aleatoriedade, pesos ou penalidades que permitam violar o recall.
    Sem solução viável, devolve a configuração inicial com feasible=False.
    """
    if not 0 < min_recall <= 1:
        raise ValueError('O recall mínimo deve ser maior que zero e no máximo 100%.')
    if not np.isfinite(max_window) or int(max_window) != max_window or not 1 <= max_window <= MAX_WINDOW:
        raise ValueError(f'O limite das janelas deve ser um inteiro entre 1 e {MAX_WINDOW}.')
    max_window = int(max_window)
    initial = {**dict(short=8, zero=.8, cluster=1, preceding=False, before=20, after=25),
               **initial_config}
    if (not 1 <= initial['short'] <= 20 or int(initial['short']) != initial['short']
            or initial['cluster'] not in (1, 2, 3) or not 0 <= initial['zero'] <= 1
            or not np.isclose(initial['zero'] * 20, round(initial['zero'] * 20))
            or initial['preceding'] not in (True, False)):
        raise ValueError('A configuração inicial precisa respeitar os limites do simulador.')
    if any(not np.isfinite(initial[k]) or int(initial[k]) != initial[k]
           or not 0 <= initial[k] <= max_window for k in ('before', 'after')):
        raise ValueError('O limite da busca deve incluir as janelas atuais.')
    evaluator = TrainingEvaluator(records, labels, event_delta)
    baseline = {**initial, **evaluator.evaluate(initial)}
    required_hits = ceil(min_recall * evaluator.events - 1e-12)
    target_recall = min_recall
    best = baseline if baseline['hits'] >= required_hits else None
    candidates, history = [], []
    maximum_hits = baseline['hits']
    rules = list(product(range(1, 21), range(21), (1, 2, 3), (False, True)))
    for number, (short, zero, cluster, preceding) in enumerate(rules, 1):
        rule = dict(short=short, zero=zero / 20, cluster=cluster, preceding=preceding)
        hits, selected = evaluator.window_grid(rule, max_window)
        maximum_hits = max(maximum_hits, int(hits[-1, -1]))
        feasible = hits >= required_hits
        feasible[0, 0] = False
        if feasible.any():
            # Tolerância de 1 ns apenas na ordenação de durações equivalentes.
            costs = np.where(feasible, np.round(selected, 9), np.inf)
            ties = costs == costs.min()
            position = int(np.argmax(np.where(ties, hits, -1)))
            before, after = np.unravel_index(position, hits.shape)
            row = {**rule, 'before': int(before), 'after': int(after),
                   **evaluator.metrics(int(hits[before, after]), selected[before, after])}
            candidates.append(row)
            if best is None or (round(row['selected_sec'], 9), -row['hits']) < (round(best['selected_sec'], 9), -best['hits']):
                best = row
        if number % 20 == 0 or number == len(rules):
            history.append(dict(rules=number, recall=best['recall'] if best else np.nan,
                                reduction=best['reduction'] if best else np.nan))
            if progress:
                progress(number, len(rules), best['recall'] if best else maximum_hits / evaluator.events)
    feasible = best is not None
    if feasible:
        config = {k: best[k] for k in PARAMETERS}
        best = {**config, **evaluator.evaluate(config)}
        if best['hits'] < required_hits:
            raise ValueError('A verificação do recall falhou; os parâmetros atuais foram mantidos.')
    else:
        best = baseline
        config = {k: initial[k] for k in PARAMETERS}
    table = pd.DataFrame([baseline, *candidates]).drop_duplicates(subset=list(PARAMETERS))
    table['atende_meta'] = table.hits >= required_hits
    table['event_delta'] = evaluator.event_delta
    table = table.sort_values(['atende_meta', 'reduction', 'recall'], ascending=False).reset_index(drop=True)
    return OptimizationResult(config=config, baseline=baseline, best=best, candidates=table,
                              history=pd.DataFrame(history), target_recall=target_recall,
                              feasible=feasible, max_recall=maximum_hits / evaluator.events,
                              evaluated_combinations=len(rules) * ((max_window + 1) ** 2 - 1))
