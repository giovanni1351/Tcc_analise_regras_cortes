"""Direct-function reference used by the CUDA parity test."""
import contextlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
with contextlib.redirect_stdout(sys.stderr):
    import cv2
    import torch
    from tcc_soccer_highlights.batch_analysis import run_transnet, load_yolo, run_yolo

    if len(sys.argv) == 1:
        result = {"cuda": torch.cuda.is_available()}
    else:
        path = Path(sys.argv[1])
        cap = cv2.VideoCapture(str(path))
        fps = cap.get(cv2.CAP_PROP_FPS)
        cap.release()
        scenes = run_transnet(path, fps, 0.5, "cuda")
        model = load_yolo(Path(__file__).resolve().parents[2] / "best.pt", 0.25, 0.45, "cuda")
        detections = run_yolo(path, model, fps, 5, None, batch_size=16)
        result = {"scenes": scenes.to_dict("records"), "detections": detections.to_dict("records")}
print(json.dumps(result), flush=True)
