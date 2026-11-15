# Local CV worker

Install the root uv environment before starting the API.

```sh
UV_HTTP_TIMEOUT=600 UV_LINK_MODE=symlink UV_CONCURRENT_DOWNLOADS=2 uv sync --no-install-project
```

`cvLayer(repoRoot)` supplies both detector services. Provide `processLayer` and the Node services to it. It starts one persistent worker on the first request and serializes both detectors with one permit. Interrupting a request closes the worker's process scope. The next request starts a new worker.

`CV_DEVICE=auto|cuda|cpu` selects the device. Auto chooses CUDA when torch reports it available. Explicit CUDA fails if unavailable. Every protocol response includes the selected runtime device. Python imports the unmodified study functions. TransNetV2 uses threshold 0.5. YOLO uses root `best.pt`, batch 16, confidence 0.25 and IoU 0.45. The caller supplies stride, with 5 used by the reference test and benchmark.

Requests and responses use JSON lines. Requests contain `id`, `op`, `path` and `stride`. Responses have `kind` set to `progress`, `result` or `error`. Result messages also contain `op` and normalized `items`. Progress currently reports stage start and completion. Model output and library messages go to stderr. The adapter retains the last 8 KiB for unexpected-exit errors.

Run the reference parity check on CUDA.

```sh
pnpm exec vitest run apps/server/src/cv/parity.test.ts
```

`TCC_CV_TEST_VIDEO` overrides the default SoccerNet half. The test creates a temporary 1,500-frame clip. It skips when that half, the uv environment or CUDA is absent. It compares every scene field and every sampled count against separate direct calls to the study functions.

Measure one full half.

```sh
uv run --no-sync python workers/cv/benchmark.py /absolute/path/to/half.mkv
```

The benchmark requires CUDA and verifies the sample count. It reports input frames/s, including decoding and model initialization. Detection input frames/s includes the frames skipped by stride. Divide by 5 for sampled frames/s. The first request also pays Python import time. `--profile /absolute/path/to/profile.pstats` profiles a separate run. Do not report its timings as throughput.

The reference TransNet implementation buffers the entire downsampled video. This worker preserves that behavior. It also reloads TransNet for each scene request and caches YOLO between detection requests. Python, the uv cache and the model weights remain runtime dependencies.
