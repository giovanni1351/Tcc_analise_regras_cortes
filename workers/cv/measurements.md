# S3 verification on November 14, 2026

Hardware was the RTX 3070 Laptop GPU, driver 550.163.01. Torch was 2.11.0+cu126. The root uv environment was installed with symlinks into the existing cache. No download retry was needed.

## Full-half throughput

One cold worker run used `2_224p.mkv` from Sunderland versus Liverpool, January 2, 2017, under `/home/pedro/tcc/benchmark/downloads/england_epl/2016-2017`. The half contains 67,500 frames at 25 fps. No optimization was made.

```sh
uv run --no-sync python workers/cv/benchmark.py '/home/pedro/tcc/benchmark/downloads/england_epl/2016-2017/2017-01-02 - 18-00 Sunderland 2 - 2 Liverpool/2_224p.mkv'
```

| Stage | Device | Input frames | Output items | Stage seconds | Input frames/s |
| --- | --- | --- | --- | --- | --- |
| Scenes | cuda | 67,500 | 174 scenes | 95.0355 | 710.26 |
| Detections | cuda | 67,500 | 13,500 samples | 204.2077 | 330.55 |

Detection runs the model on every fifth frame, giving 66.11 sampled frames/s. All expected samples were present. Stage timing includes decoding, model loading, inference, normalization and CUDA synchronization. It excludes Python imports and JSON serialization. Request wall times were 97.6842 s for scenes and 204.2440 s for detections, giving 691.00 and 330.49 input frames/s respectively. These are single-run observations with no measured range, not comparative performance claims.

Before the run, load average was 1.29 on 20 logical CPUs and the GPU was idle. Other streams subsequently ran CPU tests and a study export. GPU observations during scenes showed 99% utilization at 45.16 W. During detections they showed 84% at about 45 W. No other GPU compute process was listed.

A separate cProfile run used a re-encoded 1,500-frame clip and is excluded from the throughput figures. Across both stages, OpenCV reads consumed 0.361 s and resize consumed 0.660 s. CUDA synchronization consumed 3.255 s and Tensor.cpu consumed 1.290 s. Its scene stage took 3.712 s and detection took 6.090 s. The full-run GPU observations and this diagnostic profile suggest GPU inference and synchronization limit both stages. YOLO also pays resize, NMS and host-transfer costs. This is an inference from those observations, not a kernel-level attribution. TransNet retains its full-video frame buffer. The Python reference remains the intended baseline.

## Timestamp deviation

The benchmark encoding options remain, with `-vf showinfo` added. The output MP4 rebases timestamps. Its ffprobe `start_time` alone cannot recover the first source frame. The encoder reads that frame's source-relative PTS from showinfo, adds the requested seek offset and probes the encoded duration. A 25 fps fixture cut at 0.417 s yielded clipStart 0.4399687 s, matching the first source frame at 0.440 s within one frame. The encoded file's first PTS was 0.040 s. Full VFR and second-half V6 fixtures remain for later phases.

## Verification

The CUDA parity test creates its clip in a scoped temporary directory. It compares all scene fields and all four per-sample counts with direct calls to the unmodified study functions. The interruption test checks both a real worker PID and its child PID disappear from `/proc`. Protocol tests also cover malformed JSON, explicit errors, mismatched IDs, EOF, lazy startup and scope cleanup. Media tests cover source mutation during hashing, repeated publication and temporary-file cleanup.

Required checks passed with `pnpm lint && pnpm fmt:check && pnpm typecheck && pnpm test`. The complete suite passed 17 tests in five files. A final verbose CUDA parity rerun produced:

```text
CUDA parity PASS. 1500 frames, 3 scenes, 300 samples. Boundaries and all four counts identical.
✓ apps/server/src/cv/parity.test.ts > CUDA worker matches direct Python on a generated 60 second clip 25711ms
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    26.36s
```
