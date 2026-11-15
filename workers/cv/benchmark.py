"""One cold full-half throughput run, or an untimed profile of the same protocol."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("video")
parser.add_argument("--profile")
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
command = [str(root / ".venv/bin/python"), "-u"]
if args.profile:
    command += ["-m", "cProfile", "-o", args.profile]
command += [str(root / "workers/cv/worker.py")]
with tempfile.TemporaryFile(mode="w+") as errors:
    worker = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=errors, text=True, env={**os.environ, "CV_DEVICE": "cuda"})
    try:
        for op in ("scenes", "detections"):
            started = time.monotonic()
            worker.stdin.write(json.dumps(dict(id=op, op=op, path=args.video, stride=5)) + "\n")
            worker.stdin.flush()
            for line in worker.stdout:
                result = json.loads(line)
                if result["kind"] == "error":
                    raise RuntimeError(result)
                if result["kind"] == "result":
                    elapsed = time.monotonic() - started
                    print(json.dumps(dict(op=op, device=result["device"], frames=result["frames"],
                                          items=len(result["items"]), requestSec=elapsed,
                                          stageSec=result["elapsedSec"],
                                          stageFps=result["frames"] / result["elapsedSec"],
                                          requestFps=result["frames"] / elapsed)), flush=True)
                    if op == "scenes":
                        assert result["items"][0]["startFrame"] == 0
                    else:
                        assert len(result["items"]) == (result["frames"] + 4) // 5
                    break
            else:
                errors.seek(0)
                raise RuntimeError(errors.read())
        worker.stdin.close()
        if worker.wait() != 0:
            raise RuntimeError("Worker exited unsuccessfully")
    finally:
        if worker.poll() is None:
            worker.kill()
            worker.wait()
