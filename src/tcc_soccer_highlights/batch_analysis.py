"""Extração em lote de TransNetV2, YOLO e rótulos SoccerNet para Excel."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pandas as pd

VIDEO_EXTENSIONS = {".mkv", ".mp4", ".avi", ".mov", ".webm"}
EXPECTED_CLASSES = ("player", "ball", "referee", "goalkeeper")


@dataclass(frozen=True)
class VideoInfo:
    path: Path
    game_dir: Path
    half: int
    video_id: str


def discover_videos(root: Path, pattern: str = "*") -> list[VideoInfo]:
    videos = []
    for path in sorted(root.rglob(pattern)):
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS:
            match = re.match(r"([12])(?:_|\b)", path.stem)
            half = int(match.group(1)) if match else 1
            rel = path.relative_to(root).with_suffix("")
            videos.append(VideoInfo(path, path.parent, half, rel.as_posix()))
    return videos


def video_metadata(info: VideoInfo, videos_root: Path) -> dict:
    cap = cv2.VideoCapture(str(info.path))
    if not cap.isOpened():
        raise OSError(f"Não foi possível abrir: {info.path}")
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    metadata = {
        "video_id": info.video_id,
        "video_path": str(info.path.resolve()),
        "game": info.game_dir.name,
        "competition": info.path.relative_to(videos_root).parts[0] if len(info.path.relative_to(videos_root).parts) > 2 else "",
        "season": info.path.relative_to(videos_root).parts[1] if len(info.path.relative_to(videos_root).parts) > 2 else "",
        "half": info.half,
        "fps": fps,
        "total_frames": frames,
        "duration_sec": frames / fps if fps else 0,
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "file_size_mb": info.path.stat().st_size / 1024**2,
    }
    cap.release()
    return metadata


def load_events(labels_path: Path, half: int, duration_sec: float) -> pd.DataFrame:
    columns = ["half", "time_sec", "game_time", "label", "team", "visibility", "position_ms"]
    if not labels_path.exists():
        return pd.DataFrame(columns=columns)
    data = json.loads(labels_path.read_text(encoding="utf-8"))
    rows = []
    for item in data.get("annotations", []):
        match = re.match(r"(\d+)\s*-\s*(\d+):(\d+)", str(item.get("gameTime", "")))
        if not match or int(match.group(1)) != half:
            continue
        position_ms = pd.to_numeric(item.get("position"), errors="coerce")
        time_sec = float(position_ms) / 1000 if pd.notna(position_ms) else int(match.group(2)) * 60 + int(match.group(3))
        if time_sec <= duration_sec + 1:
            rows.append({"half": half, "time_sec": time_sec, "game_time": item.get("gameTime"),
                         "label": item.get("label"), "team": item.get("team"),
                         "visibility": item.get("visibility"), "position_ms": position_ms})
    return pd.DataFrame(rows, columns=columns).sort_values("time_sec").reset_index(drop=True)


def run_transnet(video_path: Path, fps: float, threshold: float, device: str) -> pd.DataFrame:
    import torch
    from transnetv2_pytorch import TransNetV2

    cap = cv2.VideoCapture(str(video_path))
    tiny_frames = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        tiny_frames.append(cv2.resize(rgb, (48, 27), interpolation=cv2.INTER_AREA))
    cap.release()
    if not tiny_frames:
        return pd.DataFrame(columns=["scene_id", "start_frame", "end_frame", "start_sec", "end_sec", "duration_sec"])
    model = TransNetV2()
    tensor = torch.from_numpy(np.asarray(tiny_frames, dtype=np.uint8))
    if device == "cuda":
        model, tensor = model.cuda(), tensor.cuda()
    prediction, _ = model.predict_frames(tensor, quiet=True)
    scenes = model.predictions_to_scenes_with_data(prediction.detach().cpu().numpy(), fps=fps, threshold=threshold)
    rows = []
    for scene in scenes:
        start, end = int(scene["start_frame"]), int(scene["end_frame"])
        rows.append({"scene_id": int(scene["shot_id"]), "start_frame": start, "end_frame": end,
                     "start_sec": start / fps, "end_sec": end / fps, "duration_sec": (end - start + 1) / fps})
    return pd.DataFrame(rows)


def load_yolo(model_path: Path | None, conf: float, iou: float, device: str):
    if model_path is None:
        return None
    import torch
    from functools import partial
    original_load = torch.load
    torch.load = partial(original_load, weights_only=False)
    try:
        from ultralytics import YOLO
        model = YOLO(str(model_path))
    finally:
        torch.load = original_load
    model.overrides.update({"conf": conf, "iou": iou, "max_det": 1000})
    model.to(device)
    return model


def run_yolo(video_path: Path, model, fps: float, stride: int, max_seconds: float | None,
             batch_size: int = 16) -> pd.DataFrame:
    columns = ["frame", "time_sec", "player_count", "ball_count", "ball_conf_max",
               "referee_count", "goalkeeper_count", "detection_count"]
    if model is None:
        return pd.DataFrame(columns=columns)
    cap, rows, frame_idx = cv2.VideoCapture(str(video_path)), [], 0
    batch_frames: list[np.ndarray] = []
    batch_indices: list[int] = []
    max_frame = int(max_seconds * fps) if max_seconds else None

    def process_batch() -> None:
        if not batch_frames:
            return
        results = model.predict(batch_frames, verbose=False, batch=len(batch_frames))
        for sampled_frame, result in zip(batch_indices, results):
            counts = {name: 0 for name in EXPECTED_CLASSES}
            ball_conf = 0.0
            if result.boxes is not None:
                for conf, cls_id in zip(result.boxes.conf.cpu().numpy(), result.boxes.cls.cpu().numpy().astype(int)):
                    name = str(model.names.get(int(cls_id), cls_id)).lower()
                    counts[name] = counts.get(name, 0) + 1
                    if name == "ball":
                        ball_conf = max(ball_conf, float(conf))
            rows.append({"frame": sampled_frame, "time_sec": sampled_frame / fps,
                         **{f"{name}_count": counts[name] for name in EXPECTED_CLASSES},
                         "ball_conf_max": ball_conf, "detection_count": sum(counts.values())})
        batch_frames.clear()
        batch_indices.clear()

    while True:
        ok, frame = cap.read()
        if not ok or (max_frame is not None and frame_idx > max_frame):
            break
        if frame_idx % stride:
            frame_idx += 1
            continue
        batch_frames.append(frame)
        batch_indices.append(frame_idx)
        if len(batch_frames) >= batch_size:
            process_batch()
        frame_idx += 1
    process_batch()
    cap.release()
    return pd.DataFrame(rows, columns=columns)


def enrich_samples(samples: pd.DataFrame, scenes: pd.DataFrame, events: pd.DataFrame, window_sec: float) -> pd.DataFrame:
    if samples.empty:
        return samples
    result = samples.sort_values("time_sec").copy()
    result["scene_id"] = pd.NA
    result["scene_duration_sec"] = np.nan
    for scene in scenes.itertuples():
        mask = result["time_sec"].between(scene.start_sec, scene.end_sec)
        result.loc[mask, ["scene_id", "scene_duration_sec"]] = [scene.scene_id, scene.duration_sec]
    result["near_event"] = False
    result["nearest_event_label"] = ""
    result["distance_to_event_sec"] = np.nan
    if not events.empty:
        event_times = events["time_sec"].to_numpy(float)
        sample_times = result["time_sec"].to_numpy(float)
        nearest = np.abs(sample_times[:, None] - event_times).argmin(axis=1)
        distances = sample_times - event_times[nearest]
        result["distance_to_event_sec"] = distances
        result["near_event"] = np.abs(distances) <= window_sec
        result["nearest_event_label"] = events.iloc[nearest]["label"].fillna("").to_numpy()
    return result


def make_event_windows(samples: pd.DataFrame, events: pd.DataFrame, window_sec: float) -> pd.DataFrame:
    if samples.empty or events.empty:
        return pd.DataFrame()
    metrics = [c for c in samples.columns if c.endswith("_count")] + ["ball_conf_max", "scene_duration_sec"]
    rows = []
    for event in events.itertuples():
        window = samples[samples["time_sec"].between(event.time_sec - window_sec, event.time_sec + window_sec)]
        row = {"event_time_sec": event.time_sec, "label": event.label, "team": event.team,
               "visibility": event.visibility, "window_sec": window_sec, "sample_count": len(window)}
        for metric in metrics:
            row[f"{metric}_mean"] = window[metric].mean() if metric in window else np.nan
            row[f"{metric}_max"] = window[metric].max() if metric in window else np.nan
        rows.append(row)
    return pd.DataFrame(rows)


def make_scene_summary(samples: pd.DataFrame, scenes: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    if scenes.empty:
        return pd.DataFrame()
    summary = scenes.copy()
    if not samples.empty:
        metrics = [c for c in samples.columns if c.endswith("_count")] + ["ball_conf_max"]
        agg = samples.groupby("scene_id", dropna=True)[metrics].agg(["mean", "max", "std"])
        agg.columns = [f"{a}_{b}" for a, b in agg.columns]
        summary = summary.merge(agg, left_on="scene_id", right_index=True, how="left")
    summary["event_count"] = [events["time_sec"].between(r.start_sec, r.end_sec).sum() for r in summary.itertuples()]
    summary["event_labels"] = [", ".join(events.loc[events["time_sec"].between(r.start_sec, r.end_sec), "label"].astype(str)) for r in summary.itertuples()]
    return summary


def write_excel(path: Path, metadata: dict, samples: pd.DataFrame, scenes: pd.DataFrame,
                events: pd.DataFrame, event_windows: pd.DataFrame, scene_summary: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        pd.DataFrame([metadata]).to_excel(writer, sheet_name="metadata", index=False)
        samples.to_excel(writer, sheet_name="samples", index=False)
        scenes.to_excel(writer, sheet_name="scenes", index=False)
        events.to_excel(writer, sheet_name="events", index=False)
        event_windows.to_excel(writer, sheet_name="event_windows", index=False)
        scene_summary.to_excel(writer, sheet_name="scene_summary", index=False)
        for sheet in writer.book.worksheets:
            sheet.freeze_panes = "A2"
            sheet.auto_filter.ref = sheet.dimensions


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--videos-root", type=Path, default=Path("videos"))
    parser.add_argument("--output-root", type=Path, default=Path("analysis_output"))
    parser.add_argument("--model", type=Path, help="Arquivo .pt do YOLO treinado")
    parser.add_argument("--pattern", default="*", help="Filtro de arquivo (ex.: 1_224p.mkv)")
    parser.add_argument("--stride", type=int, default=5, help="Executar YOLO a cada N frames")
    parser.add_argument("--batch-size", type=int, default=16, help="Frames YOLO por lote na GPU")
    parser.add_argument("--event-window", type=float, default=10.0)
    parser.add_argument("--transnet-threshold", type=float, default=0.5)
    parser.add_argument("--max-seconds", type=float, help="Limite por vídeo para testes")
    parser.add_argument("--skip-transnet", action="store_true")
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument("--limit", type=int, help="Limitar quantidade de vídeos")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.stride < 1:
        raise SystemExit("--stride deve ser >= 1")
    videos = discover_videos(args.videos_root, args.pattern)
    if args.limit:
        videos = videos[: args.limit]
    if not videos:
        raise SystemExit("Nenhum vídeo encontrado.")
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = load_yolo(args.model, 0.25, 0.45, device)
    args.output_root.mkdir(parents=True, exist_ok=True)
    manifest = []
    for index, info in enumerate(videos, 1):
        relative = info.path.relative_to(args.videos_root).with_suffix("")
        output = args.output_root / relative.parent / f"{relative.name}_analysis.xlsx"
        if args.skip_existing and output.exists():
            print(f"[{index}/{len(videos)}] existente: {output}")
            continue
        started = time.time()
        print(f"[{index}/{len(videos)}] processando: {info.path}", flush=True)
        try:
            metadata = video_metadata(info, args.videos_root)
            if args.max_seconds:
                metadata["analyzed_duration_sec"] = min(args.max_seconds, metadata["duration_sec"])
            scenes = pd.DataFrame() if args.skip_transnet else run_transnet(info.path, metadata["fps"], args.transnet_threshold, device)
            if args.max_seconds and not scenes.empty:
                scenes = scenes[scenes["start_sec"] <= args.max_seconds].copy()
                scenes["end_sec"] = scenes["end_sec"].clip(upper=args.max_seconds)
                scenes["duration_sec"] = scenes["end_sec"] - scenes["start_sec"]
            events = load_events(info.game_dir / "Labels-v2.json", info.half, args.max_seconds or metadata["duration_sec"])
            samples = enrich_samples(run_yolo(info.path, model, metadata["fps"], args.stride,
                                               args.max_seconds, args.batch_size), scenes, events, args.event_window)
            windows = make_event_windows(samples, events, args.event_window)
            scene_summary = make_scene_summary(samples, scenes, events)
            metadata.update({"yolo_model": str(args.model or "não executado"), "yolo_stride": args.stride,
                             "yolo_batch_size": args.batch_size, "transnet_executed": not args.skip_transnet,
                             "event_window_sec": args.event_window,
                             "processing_seconds": time.time() - started, "status": "ok"})
            write_excel(output, metadata, samples, scenes, events, windows, scene_summary)
            manifest.append({**metadata, "excel_path": str(output.resolve())})
        except Exception as exc:
            print(f"ERRO em {info.path}: {exc}", file=sys.stderr)
            traceback.print_exc()
            manifest.append({"video_id": info.video_id, "video_path": str(info.path.resolve()),
                             "excel_path": str(output.resolve()), "status": "error", "error": repr(exc)})
        pd.DataFrame(manifest).to_csv(args.output_root / "manifest.csv", index=False, encoding="utf-8-sig")
    print(f"Concluído: {sum(r['status'] == 'ok' for r in manifest)}/{len(videos)} vídeos.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
