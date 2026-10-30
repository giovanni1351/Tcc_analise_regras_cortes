"""Cache incremental Parquet dos Excels completos, sem alterar as fontes."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

import pandas as pd

CACHE_VERSION = 1


def fingerprint(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_mtime_ns, stat.st_size


def source_signature(root: Path) -> tuple:
    return tuple((str(path.resolve()), *fingerprint(path))
                 for path in sorted(root.rglob('*_analysis.xlsx')))


def read_workbook(path: Path, cache_root: Path, sheet_names=None) -> dict:
    """Valida por tamanho e mtime; publica o manifest após todos os Parquets."""
    stamp = fingerprint(path)
    identity = hashlib.sha256(str(path.resolve()).encode()).hexdigest()
    folder = cache_root / identity
    manifest_path = folder / 'manifest.json'
    names = {}
    complete = False
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if manifest['version'] == CACHE_VERSION and tuple(manifest['stamp']) == stamp:
            names = manifest['sheets']
            complete = manifest.get('complete', True)  # Caches antigos contêm todas as abas.
            if (sheet_names is None and complete) or (sheet_names is not None and all(name in names for name in sheet_names)):
                wanted = names if sheet_names is None else {name: names[name] for name in sheet_names}
                return {name: pd.read_parquet(folder / filename) for name, filename in wanted.items()}
    except (OSError, ValueError, KeyError):
        names, complete = {}, False
    missing = None if sheet_names is None else [name for name in sheet_names if name not in names]
    sheets = pd.read_excel(path, sheet_name=missing)
    if fingerprint(path) != stamp:
        raise OSError(f'Arquivo ainda sendo atualizado: {path}')
    folder.mkdir(parents=True, exist_ok=True)
    # Cada geração tem nomes próprios para leitores nunca misturarem versões.
    generation = uuid4().hex
    new_names = {name: f'{generation}_{i}.parquet' for i, name in enumerate(sheets)}
    for name, frame in sheets.items():
        frame.to_parquet(folder / new_names[name], index=False)
    names = {**names, **new_names}
    manifest = dict(version=CACHE_VERSION, stamp=stamp, source=str(path.resolve()), sheets=names,
                    complete=complete or sheet_names is None)
    temporary = folder / f'manifest_{generation}.tmp'
    temporary.write_text(json.dumps(manifest), encoding='utf-8')
    temporary.replace(manifest_path)
    return sheets if sheet_names is None else {
        name: sheets[name] if name in sheets else pd.read_parquet(folder / names[name]) for name in sheet_names}


def read_metadata_index(root: Path, signature: tuple) -> dict:
    """Índice persistente pequeno; alterações só relêem os metadados dos novos XLSX."""
    cache_root = root / '.dashboard_cache'
    index_path = cache_root / 'metadata_index.json'
    try:
        saved = json.loads(index_path.read_text(encoding='utf-8'))
        previous = saved['entries'] if saved.get('version') == CACHE_VERSION else {}
    except (OSError, ValueError, KeyError):
        previous = {}
    entries, items = {}, {}
    for path_text, mtime, size in signature:
        entry = previous.get(path_text, {})
        if entry.get('stamp') != [mtime, size]:
            try:
                frame = read_workbook(Path(path_text), cache_root, sheet_names=['metadata'])['metadata']
                metadata = json.loads(frame.to_json(orient='records', date_format='iso', double_precision=15))[0]
                entry = dict(stamp=[mtime, size], metadata=metadata)
            except Exception as exc:
                entry = dict(stamp=[mtime, size], error=str(exc))
        entries[path_text] = entry
        path = Path(path_text)
        if 'error' in entry:
            items[path_text] = dict(path=path, error=entry['error'])
        else:
            metadata = entry['metadata']
            key = str(metadata.get('video_id') or path.relative_to(root.resolve()))
            items[key] = dict(path=path, meta=metadata)
    if entries != previous:
        cache_root.mkdir(parents=True, exist_ok=True)
        temporary = cache_root / f'metadata_index_{uuid4().hex}.tmp'
        temporary.write_text(json.dumps(dict(version=CACHE_VERSION, entries=entries), ensure_ascii=False), encoding='utf-8')
        temporary.replace(index_path)
    return items
