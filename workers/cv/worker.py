"""Persistent JSON-lines adapter around the study's reference inference."""
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))


def emit(message):
    print(json.dumps(message, allow_nan=False), file=sys.__stdout__, flush=True)


def frame_timeline(path, fps):
    data = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames",
        "-show_entries", "frame=best_effort_timestamp_time,duration_time,pkt_duration_time",
        "-of", "json", str(path),
    ]))
    frames = data["frames"]
    pts = [float(frame["best_effort_timestamp_time"]) for frame in frames]
    origin = pts[0]
    pts = [value - origin for value in pts]
    if all(abs(value - index / fps) < 0.0001 for index, value in enumerate(pts)):
        return None
    last = frames[-1]
    duration = float(last.get("duration_time", last.get("pkt_duration_time", 0)))
    if duration <= 0:
        duration = pts[-1] - pts[-2] if len(pts) > 1 else 1 / fps
    return pts + [pts[-1] + duration]


def map_times(operation, items, timeline):
    if timeline is None:
        return
    for item in items:
        if operation == "scenes":
            item["startSec"] = timeline[item["startFrame"]]
            item["durationSec"] = timeline[item["endFrame"] + 1] - item["startSec"]
        else:
            item["timeSec"] = timeline[item["frameIndex"]]


def run():
    with contextlib.redirect_stdout(sys.stderr):
        import cv2
        import torch
        from tcc_soccer_highlights.batch_analysis import run_transnet, load_yolo, run_yolo
    requested = os.environ.get("CV_DEVICE", "auto")
    device = "cuda" if requested == "auto" and torch.cuda.is_available() else requested
    if device == "auto":
        device = "cpu"
    model = None
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if device not in ("cuda", "cpu"):
                raise ValueError("CV_DEVICE must be auto, cuda or cpu")
            if device == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("CUDA requested but unavailable")
            path = Path(request["path"])
            cap = cv2.VideoCapture(str(path))
            if not cap.isOpened():
                raise OSError(f"Cannot open {path}")
            fps = float(cap.get(cv2.CAP_PROP_FPS))
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            cap.release()
            timeline = frame_timeline(path, fps)
            emit(dict(id=request["id"], kind="progress", device=device, done=0, total=total))
            started = time.monotonic()
            with contextlib.redirect_stdout(sys.stderr):
                if request["op"] == "scenes":
                    rows = run_transnet(path, fps, request["threshold"], device)
                    items = [dict(sceneId=int(r.scene_id), startFrame=int(r.start_frame),
                                  endFrame=int(r.end_frame), startSec=float(r.start_sec),
                                  durationSec=float(r.duration_sec)) for r in rows.itertuples()]
                elif request["op"] == "detections":
                    stride = request["stride"]
                    if not isinstance(stride, int) or stride < 1:
                        raise ValueError("stride must be a positive integer")
                    if model is None:
                        model = load_yolo(ROOT / "best.pt", request["conf"], request["iou"], device)
                    class ProgressModel:
                        def __init__(self):
                            self.done = 0
                            self.reported = 0

                        def __getattr__(self, name):
                            return getattr(model, name)

                        def predict(self, frames, **kwargs):
                            results = model.predict(frames, **kwargs)
                            self.done = min(total, self.done + len(frames) * stride)
                            if self.done - self.reported >= max(1, total * 0.02):
                                emit(dict(id=request["id"], kind="progress", device=device,
                                          done=self.done, total=total))
                                self.reported = self.done
                            return results

                    rows = run_yolo(path, ProgressModel(), fps, stride, None, batch_size=request["batch"])
                    items = [dict(frameIndex=int(r.frame), timeSec=float(r.time_sec),
                                  counts={name: int(getattr(r, name + "_count")) for name in
                                          ("player", "goalkeeper", "referee", "ball")})
                             for r in rows.itertuples()]
                else:
                    raise ValueError("Unknown operation")
                map_times(request["op"], items, timeline)
                if device == "cuda":
                    torch.cuda.synchronize()
            emit(dict(id=request["id"], kind="progress", device=device, done=total, total=total))
            emit(dict(id=request["id"], kind="result", device=device, op=request["op"],
                      items=items, elapsedSec=time.monotonic() - started, frames=total))
        except Exception as error:
            emit(dict(id=request.get("id", ""), kind="error", device=device,
                      message=f"{type(error).__name__}: {error}"))


if __name__ == "__main__":
    run()
