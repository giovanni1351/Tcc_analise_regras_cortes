# Job evaluation

These commands use the running server's generated HTTP client. They do not open
its database or load credentials. Labels come from TCC_SOCCERNET_ROOT, which
defaults to /home/pedro/tcc/benchmark/downloads.

## V9

Inspect the train plan without submitting jobs:

```sh
node apps/server/src/eval/tune-cli.ts --halves 5 --model nvidia/nemotron-3.5-super-vl:free --grid "40/5,30/5,20/4" --port 3000 --max-usd 0 --dry-run
```

Run that plan and write the report:

```sh
node apps/server/src/eval/tune-cli.ts --halves 5 --model nvidia/nemotron-3.5-super-vl:free --grid "40/5,30/5,20/4" --port 3000 --max-usd 0 --out v9.json
```

Train grids require the 40/5 baseline. Sampling and the 10,000 paired bootstrap
resamples use seed 42. F1 is computed from summed TP, FP and FN, including within
each bootstrap resample. The interval is the percentile 95% interval of each
configuration's F1 minus baseline F1. Partial jobs remain in the results with
their coverage counts.

Paid models require an explicit --model. Pricing uses the API's highest recorded
cost per video second, or an explicit --usd-per-call. Unknown paid pricing is
refused. Both dry runs and real runs refuse estimates above --max-usd.

Segment estimates use the study exports in --study-dir, defaulting to
.scratch/study. Generate them with `uv run python scripts/export_study.py`.
The planner runs the default TypeScript rule and the server's segment planner
for each half and grid point. Pricing uses --usd-per-call per segment or the
recorded per-second rate multiplied by each segment's actual duration.

If a half's export is missing, its estimate is labelled "upper bound" and uses
ceil(study duration / (maxSec - overlapSec)) + study scene count, priced at
maxSec per segment for per-second rates. Invalid exports fail planning.
Study estimates are not guarantees for different CV outputs or provider pricing.
The resulting per-job admission caps sum to at most --max-usd.
The server's own budget and free quota still apply.

The report checkpoints pending job IDs and completed scores to --out. Rerunning
uses the server's job and stage caches.

## V12

Freeze the grid point selected on train, then use one point on test:

```sh
node apps/server/src/eval/tune-cli.ts --split test --halves 334 --model google/gemini-3.1-flash-lite --grid "40/5" --port 3000 --usd-per-call 0.002 --max-usd 0.50 --dry-run
```

Replace 40/5 with the frozen point. Set the pricing bound and budget deliberately.
Remove --dry-run and add --out v12.json to execute an admitted plan. Held-out
reports omit bootstrap comparisons against train or an unfrozen baseline.

Score one completed or partial job:

```sh
node apps/server/src/eval/score-job-cli.ts --job JOB_ID --port 3000
```

Scoring uses same-class one-to-one nearest matches at five seconds, in confidence
order, as in rescore.ts. Visible labels are the default. Add --include-not-shown
to either command to include hidden labels. Window share uses the union of
windows divided by probed half duration. The ceiling counts target labels inside
windows without tolerance expansion. Invalid rate is invalid / segments;
ambiguous and notSent remain separate in each score's coverage.

## Study split

Print membership with tune-cli.ts --print-split or split-cli.ts. The checked-in
catalog has 666 train halves and 334 test halves across 500 games. It reflects
the current workbooks, which exceed the older 497-half research snapshot.

The exporter reads workbooks without changing them, excludes empty sample
sheets and chooses the highest resolution per competition, season, game and
half. Equal resolutions keep the first sorted workbook. Split membership sorts
distinct game names, assigns every third game starting at index zero to test
when at least six games exist, and assigns all others to train. Both halves of
a game always share a split.

Regenerate the catalog after an intentional dataset change:

```sh
python apps/server/src/eval/export-study-split.py analysis_output > apps/server/src/eval/study-halves.json
pnpm exec oxfmt apps/server/src/eval/study-halves.json
```

Keep the catalog frozen throughout tuning and held-out evaluation.
