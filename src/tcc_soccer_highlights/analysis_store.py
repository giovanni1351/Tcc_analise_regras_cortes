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
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if manifest['version'] == CACHE_VERSION and tuple(manifest['stamp']) == stamp:
            names = manifest['sheets']
            wanted = names if sheet_names is None else {name: names[name] for name in sheet_names}
            return {name: pd.read_parquet(folder / filename) for name, filename in wanted.items()}
    except (OSError, ValueError, KeyError):
        pass
    sheets = pd.read_excel(path, sheet_name=None)
    if fingerprint(path) != stamp:
        raise OSError(f'Arquivo ainda sendo atualizado: {path}')
    folder.mkdir(parents=True, exist_ok=True)
    # Cada geração tem nomes próprios para leitores nunca misturarem versões.
    generation = uuid4().hex
    names = {name: f'{generation}_{i}.parquet' for i, name in enumerate(sheets)}
    for name, frame in sheets.items():
        frame.to_parquet(folder / names[name], index=False)
    manifest = dict(version=CACHE_VERSION, stamp=stamp, source=str(path.resolve()), sheets=names)
    temporary = folder / f'manifest_{generation}.tmp'
    temporary.write_text(json.dumps(manifest), encoding='utf-8')
    temporary.replace(manifest_path)
    return sheets if sheet_names is None else {name: sheets[name] for name in sheet_names}
