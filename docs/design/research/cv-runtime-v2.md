# CV runtime investigation, second attempt

Status: in progress. No inference or parity results have been established yet. The throwaway workspace is `cv-proto/` beside this report. The previous attempt is documented in `cv-runtime.md`.

## Step 1: Python reference

Command: `UV_HTTP_TIMEOUT=600 UV_CONCURRENT_DOWNLOADS=2 timeout 900 uv sync --no-install-project > uv-sync.log 2>&1`. The initial output resolves 108 packages and starts downloading torch and nvidia-cudnn-cu12. Full output is in `cv-proto/uv-sync.log`.

[Measured] Created `clip60.mp4` from `/home/pedro/tcc/benchmark/downloads/england_epl/2016-2017/2017-01-02 - 18-00 Sunderland 2 - 2 Liverpool/2_224p.mkv` using `ffmpeg -i <source> -frames:v 1500 -an -c:v libx264 -preset fast -crf 18 clip60.mp4`. `ffprobe -count_frames` reports 398x224, 25 fps, 60.000000 seconds, 1500 frames. It is a re-encode, so all comparisons must use this exact clip.

[Measured] `reference.py` invokes the worktree's unmodified `run_transnet`, `load_yolo`, and `run_yolo`, with CUDA required, and writes `scenes.json` and `detections.json` after the respective stages. It has not yet run.

[Measured] The first sync failed on cuDNN connection resets. Direct `curl --retry 10 --retry-all-errors --continue-at -` downloads of the lockfile cuDNN and cuBLAS URLs produced SHA-256 hashes matching `uv.lock`. Copy installation then exhausted the 7.7 GiB `/tmp` filesystem. A fresh `UV_HTTP_TIMEOUT=600 UV_CONCURRENT_DOWNLOADS=2 UV_LINK_MODE=symlink timeout 600 uv sync --no-install-project` succeeded, including a new successful cuDNN download. The environment depends on the uv cache remaining intact. Logs are `uv-sync.log` and `uv-sync-symlink.log`.

[Measured] `XDG_CACHE_HOME=$PWD/cache XDG_CONFIG_HOME=$PWD/config MPLCONFIGDIR=$PWD/config YOLO_CONFIG_DIR=$PWD/config timeout 600 .venv/bin/python -u reference.py` reported `torch 2.11.0+cu126 cuda True`, three scenes and 300 YOLO samples. Results are `scenes.json`, `detections.json`, and `reference.log`. TransNet elapsed 5.502 s includes decoding, model initialization and inference. YOLO elapsed 4.533 s includes decoding and inference but excludes model loading. These are single cold runs, not isolated inference benchmarks and not comparable as throughput.

## Step 2: exports

[Measured] `export.py` completed using Ultralytics 8.4.123 and torch 2.11.0. YOLO `best.onnx` uses opset 17, dynamic shape including batch, export image size 640, batch example 16, `simplify=False`, and `nms=False`. Its reported example output is `(16, 8, 8400)`; postprocessing must supply NMS. `transnet.onnx` uses opset 17 with fixed uint8 input `(1,100,27,48,3)` and two outputs. Full output and exporter warnings are in `export.log`. Neither export has been checked for parity.

## Step 3: Node runtime probe, incomplete

[Measured] `npm_config_cache=$PWD/npm-cache timeout 180 npm install onnxruntime-node` installed 1.31.1. npm warned that its postinstall was not approved. `node node_modules/onnxruntime-node/script/install` exited silently. The existing CUDA provider file was present, but `ldd node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so` reports `libcublasLt.so.13`, `libcublas.so.13`, `libcurand.so.10`, and `libcudart.so.13` not found. `ONNXRUNTIME_NODE_INSTALL=cuda12 node node_modules/onnxruntime-node/script/install.js` also exited silently and did not change that observation. The origin of the already present provider is unverified.

[Measured] `timeout 180 node smoke.cjs` ran one synthetic input through each graph on CPU. The CUDA session creation failed for each with `Failed to load shared library` and the loader named `libcublasLt.so.13`. `smoke.log` includes graph placement and full errors. These smoke inputs are not the requested video pipeline or a throughput measurement. No real frame decoder, postprocessing, parity test, CUDA inference, or isolated throughput benchmark was completed.

## Steps 4 and 5: outstanding

[Not measured] Scene and detection parity, decode throughput, Node CPU/CUDA video throughput, isolated Python CUDA throughput, and the limiting stages remain unknown. The reference elapsed times above include different initialization and decoding costs and cannot answer those questions. Do not infer that Node CUDA is impossible from the missing shared libraries.

## Step 6: Apple Silicon, partial

[Cited] ONNX Runtime's Node README lists CoreML support in its prebuilt macOS arm64 binding: https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md . Its CoreML provider documentation is https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html . [Not measured] Package contents and operator coverage of these particular exported graphs have not been checked. CoreML availability does not establish full graph placement or speed.

## Remaining work

Implement ffmpeg frame decoding, precise YOLO letterbox and NMS, and TransNet window and scene conversion; run real video CPU parity; install a provider and dependencies compatible with the NVIDIA driver; verify actual CUDA placement; benchmark separately with warmup and repeat runs; inspect graph operators against CoreML constraints and verify macOS packaging. All scripts here are throwaway research artifacts.
