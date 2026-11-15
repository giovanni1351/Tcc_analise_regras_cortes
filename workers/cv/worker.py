"""Persistent JSON-lines adapter around the study's reference inference."""
import contextlib
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))


def emit(message):
    print(json.dumps(message, allow_nan=False), flush=True)


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
            emit(dict(id=request["id"], kind="progress", device=device, done=0, total=total))
            started = time.monotonic()
            with contextlib.redirect_stdout(sys.stderr):
                if request["op"] == "scenes":
                    rows = run_transnet(path, fps, 0.5, device)
                    items = [dict(sceneId=int(r.scene_id), startFrame=int(r.start_frame),
                                  endFrame=int(r.end_frame), startSec=float(r.start_sec),
                                  durationSec=float(r.duration_sec)) for r in rows.itertuples()]
                elif request["op"] == "detections":
                    stride = request["stride"]
                    if not isinstance(stride, int) or stride < 1:
                        raise ValueError("stride must be a positive integer")
                    if model is None:
                        model = load_yolo(ROOT / "best.pt", 0.25, 0.45, device)
                    rows = run_yolo(path, model, fps, stride, None, batch_size=16)
                    items = [dict(frameIndex=int(r.frame), timeSec=float(r.time_sec),
                                  counts={name: int(getattr(r, name + "_count")) for name in
                                          ("player", "goalkeeper", "referee", "ball")})
                             for r in rows.itertuples()]
                else:
                    raise ValueError("Unknown operation")
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
