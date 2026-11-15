"""Export canonical study inputs without importing the inference runtime."""
import argparse
import gzip
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from tcc_soccer_highlights.analysis_store import read_metadata_index, read_workbook, source_signature


def records(frame, columns):
    return json.loads(frame[columns].to_json(orient='records', double_precision=15))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('analysis_output'))
    parser.add_argument('--output', type=Path, default=Path('.scratch/study'))
    args = parser.parse_args()
    root = args.root.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    index = read_metadata_index(root, source_signature(root))
    groups = {}
    errors = []
    for key, item in index.items():
        if 'error' in item:
            errors.append(dict(source=str(item['path']), error=item['error']))
            continue
        m = item['meta']
        if m.get('status') != 'ok':
            continue
        group = tuple(m.get(k) for k in ['competition', 'season', 'game', 'half'])
        groups.setdefault(group, []).append((key, item))
    files = []
    for candidates in groups.values():
        candidates.sort(key=lambda pair: -float(pair[1]['meta'].get('height', 0)))
        for key, item in candidates:
            try:
                sheets = read_workbook(item['path'], root / '.dashboard_cache', sheet_names=['metadata', 'samples', 'scenes', 'events'])
                if sheets['samples'].empty:
                    continue
                metadata = records(sheets['metadata'], list(sheets['metadata'].columns))[0]
                data = dict(video_id=key, source=str(item['path']), metadata=metadata,
                            scenes=records(sheets['scenes'], ['scene_id', 'start_sec', 'duration_sec']),
                            samples=records(sheets['samples'], ['scene_id', 'time_sec', 'player_count']),
                            events=records(sheets['events'], ['time_sec', 'label']))
                filename = f'video-{len(files):04d}.json.gz'
                with gzip.open(args.output / filename, 'wt', encoding='utf-8') as stream:
                    json.dump(data, stream, ensure_ascii=False, allow_nan=False)
                files.append(filename)
                if len(files) % 50 == 0:
                    print(f'Exported {len(files)} videos', flush=True)
                break
            except Exception as exc:
                errors.append(dict(source=str(item['path']), error=str(exc)))
    manifest = dict(source_root=str(root), source_files=len(index), files=files, errors=errors)
    (args.output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps(dict(videos=len(files), source_files=len(index), errors=errors)), flush=True)


if __name__ == '__main__':
    main()
