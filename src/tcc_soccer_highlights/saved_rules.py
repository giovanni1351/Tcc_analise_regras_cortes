"""Configurações e fotografias das avaliações, persistidas fora dos caches."""
from datetime import datetime, timezone
from hashlib import sha256
import json
import math
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import RLock
from uuid import uuid4

import pandas as pd


PRESETS_PATH = Path('saved_rules/configurations.json')
_LOCK = RLock()


def json_value(value):
    if isinstance(value, dict):
        return {str(k): json_value(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [json_value(v) for v in value]
    if hasattr(value, 'item'):
        return json_value(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def dataset_snapshot(records, token):
    signature = json.dumps(json_value(token), sort_keys=True, ensure_ascii=False)
    return dict(fingerprint=sha256(signature.encode()).hexdigest(), videos=len(records),
                games=len({r['game'] for r in records.values()}),
                duration_sec=sum(float(r['duration']) for r in records.values()))


def read_presets(path=None):
    path = Path(path) if path is not None else PRESETS_PATH
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        if data['version'] != 1 or not isinstance(data['configurations'], list):
            raise ValueError('Formato desconhecido.')
        for entry in data['configurations']:
            for key in ('id', 'name', 'notes', 'created_at', 'config', 'labels', 'event_delta',
                        'goals', 'dataset', 'summary', 'by_event'):
                if key not in entry:
                    raise ValueError(f'Campo ausente: {key}.')
        return data['configurations']
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError(f'Não foi possível ler {path}: {exc}') from exc


def save_preset(name, config, labels, event_delta, goals, records, token,
                summary, by_event, notes='', path=None):
    if not name.strip():
        raise ValueError('Informe um nome para a configuração.')
    if not labels:
        raise ValueError('Selecione ao menos um tipo de evento antes de salvar.')
    if config['before'] + config['after'] <= 0:
        raise ValueError('A janela precisa ser maior que zero.')
    entry = json_value(dict(id=uuid4().hex, name=name.strip(), notes=notes.strip(),
        created_at=datetime.now(timezone.utc).isoformat(), config=dict(config),
        labels=sorted(labels), event_delta=float(event_delta), goals=dict(goals),
        dataset=dataset_snapshot(records, token), summary=summary.to_dict('records'),
        by_event=by_event.to_dict('records')))
    path = Path(path) if path is not None else PRESETS_PATH
    with _LOCK:
        entries = read_presets(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                    suffix='.tmp', delete=False) as handle:
                temporary = Path(handle.name)
                json.dump(dict(version=1, configurations=[*entries, entry]), handle,
                          ensure_ascii=False, indent=2, allow_nan=False)
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return entry


def comparison_table(entries):
    rows = []
    for entry in entries:
        for metrics in entry['summary']:
            recall, reduction = metrics['recall'], metrics['reducao_temporal']
            met = (recall is not None and reduction is not None
                   and recall + 1e-12 >= entry['goals']['recall']
                   and reduction + 1e-12 >= entry['goals']['reduction'])
            rows.append(dict(id=entry['id'], name=entry['name'], rule=entry['config']['rule'],
                created_at=entry['created_at'], **metrics, missed=metrics['events'] - metrics['hits'],
                target_recall=entry['goals']['recall'], target_reduction=entry['goals']['reduction'],
                goal_met=met, event_delta=entry['event_delta'], labels='; '.join(entry['labels']),
                videos=entry['dataset']['videos'], games=entry['dataset']['games'],
                dataset=entry['dataset']['fingerprint']))
    return pd.DataFrame(rows)


def comparable(entries):
    return len({(p['dataset']['fingerprint'], tuple(p['labels']), p['event_delta'])
                for p in entries}) <= 1


def widget_values(entry):
    config = entry['config']
    values = {f'simulator_{k}': config[k] for k in
              ('rule', 'short', 'zero', 'cluster', 'preceding', 'before', 'after')}
    values.update(context_min_previous=int(config['min_previous']),
                  context_drop=round(config['drop_fraction'] * 100),
                  simulator_events=list(entry['labels']), simulator_event_delta=entry['event_delta'],
                  preset_goal_recall=round(entry['goals']['recall'] * 100),
                  preset_goal_reduction=round(entry['goals']['reduction'] * 100),
                  optimizer_min_recall=max(1, round(entry['goals']['recall'] * 100)))
    return values
