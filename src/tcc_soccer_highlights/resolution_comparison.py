"""Avaliação pareada da regra atual no primeiro tempo, em duas resoluções."""
from __future__ import annotations

import numpy as np
import pandas as pd

from tcc_soccer_highlights.highlight_study import evaluate, scene_features, scores


def first_half_versions(items):
    groups = {}
    for key, item in sorted(items.items()):
        if 'error' in item or item.get('samples', pd.DataFrame()).empty or item.get('scenes', pd.DataFrame()).empty:
            continue
        meta = item['meta']
        if int(meta['half']) != 1:
            continue
        height = int(meta['height'])
        if height not in (224, 240, 720):
            continue
        end = min(float(meta['duration_sec']), float(item['samples'].time_sec.max())
                  + float(meta['yolo_stride']) / float(meta['fps']))
        if not np.isfinite(end) or end <= 0:
            continue
        group = tuple(str(meta[name]) for name in ('competition', 'season', 'game'))
        versions = groups.setdefault(group, {})
        if height not in versions or end > versions[height][2]:
            versions[height] = (key, item, end)
    return groups


def prepare_first_half_pairs(items, low_height=224):
    """Recorta sinais ao período comum; usa as mesmas anotações nas duas versões."""
    records = {720: {}, low_height: {}}
    pairs = []
    groups = first_half_versions(items)
    for group, versions in groups.items():
        if 720 not in versions or low_height not in versions:
            continue
        end = min(versions[720][2], versions[low_height][2])
        pair_id = '/'.join(group)
        reference = versions[720][1]['events']
        reference = reference[reference.time_sec.between(0, end)].copy()
        prepared = {}
        for height in (720, low_height):
            _, item, _ = versions[height]
            samples = item['samples'][item['samples'].time_sec.lt(end)].copy()
            scenes = item['scenes'][item['scenes'].start_sec.lt(end)].copy()
            if samples.empty or scenes.empty:
                break
            scenes['duration_sec'] = np.minimum(scenes.duration_sec, end - scenes.start_sec)
            features = scene_features(dict(samples=samples, scenes=scenes))
            prepared[height] = dict(features=features, events=reference, duration=end,
                                    game=group[2], split='pareado')
        if len(prepared) != 2:
            continue
        for height, record in prepared.items():
            records[height][pair_id] = record
        pairs.append(dict(pair_id=pair_id, competition=group[0], season=group[1], game=group[2],
                          common_sec=end, high_video=versions[720][0], low_video=versions[low_height][0]))
    return dict(records=records, pairs=pd.DataFrame(pairs), low_height=low_height,
                unmatched=sum(720 in v or low_height in v for v in groups.values()) - len(pairs))


def compare_first_halves(prepared, config, labels, event_delta=0.):
    """Totais ponderados por eventos/duração/propostas, e resultados por partida."""
    summary, by_event, by_game = [], [], []
    if prepared['pairs'].empty:
        return dict(summary=pd.DataFrame(), by_event=pd.DataFrame(), by_game=pd.DataFrame())
    for height, records in prepared['records'].items():
        evaluation, clips = evaluate(records, config, event_delta=event_delta)
        total_sec = sum(r['duration'] for r in records.values())
        value = scores(evaluation, clips, records, None, labels=labels, event_delta=event_delta)
        summary.append(dict(height=height, games=len(records), **value,
                            missed=value['events'] - value['hits'], reduction=1 - value['coverage'],
                            total_sec=total_sec, selected_sec=float(clips.duration_sec.sum())))
        grouped = evaluation[evaluation.label.isin(labels)].groupby('label')[['events', 'hits']].sum()
        for label in labels:
            events = int(grouped.loc[label, 'events']) if label in grouped.index else 0
            hits = int(grouped.loc[label, 'hits']) if label in grouped.index else 0
            by_event.append(dict(height=height, label=label, events=events, hits=hits, missed=events - hits,
                                 recall=hits / events if events else np.nan))
        for key, record in records.items():
            value = scores(evaluation[evaluation.video_id.eq(key)], clips[clips.video_id.eq(key)],
                           {key: record}, None, labels=labels, event_delta=event_delta)
            by_game.append(dict(pair_id=key, height=height, **value,
                                missed=value['events'] - value['hits'], reduction=1 - value['coverage']))
    return dict(summary=pd.DataFrame(summary), by_event=pd.DataFrame(by_event,
                columns=['height', 'label', 'events', 'hits', 'missed', 'recall']), by_game=pd.DataFrame(by_game))
