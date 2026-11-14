**Verdict: ISSUES.** Pedro wants up-to-date, reproducible measurements of Gemini 4 Hydrogen against Gemini 3.8 Flash on exactly matched SoccerNet inputs, with total spend at or under $4.88. The execution, accounting, inputs and point scores all hold up under independent checks. The report's statistical wording and its account of the gate amendment need correcting before publication. I edited nothing, made no network or paid calls, and kept my scripts in the session scratchpad.

## What I checked myself

**Ledger.** I wrote my own fold of `ledger.jsonl` (1,593 rows: 793 reservations, 793 settlements, 7 reconciliations). It gives $3.54041775 total, peak exposure $4.87909200, no row over $4.88, no holds, at most 4 unsettled, and at most 2 attempts per cell. That is 779 cells with one attempt and 7 with two. Every reservation is $1.00 on config `fbb0a5a5`. The 20 preflight attempts cost $0.08878125. There are no attempts on the third match (t002).

**Billing.** Key and account counter deltas are both exactly $3.54041775 from `billing-before.json` to `billing-final-stable.json`. Since the two counters agree, there was no other spending on the account in that window. Each reconciliation checkpoint delta also matches the ledger at that moment (0.22866, 0.722907, 0.92829525, 2.721174).
- 787 generation-metadata records returned 200. Together they sum to $3.54041775, and each one equals its ledger charge.
- Every record shows the dated model `google/gemini-4-hydrogen-20261112` on Google AI Studio, with `is_byok` false, no cancellations and `finish_reason` stop.
- Every charge recomputes exactly as native prompt × $0.75/M + completion × $3.75/M. Those are Flex rates; Standard is double (`provider-endpoints.json`). All 786 bodies also say `service_tier` flex.
- Three failures returned 404 on metadata lookup. One lookup timed out (408) and was later rechecked to $0.00453675. Both cases are retained.

**Bodies and requests.**
- All 786 accepted provider bodies match their saved hashes, report the expected model, provider and stop reason, and have one choice. Completion tokens peak at 1,064 against the 4,096 cap. Raw text matches the body content byte for byte.
- I rebuilt 12 random request bodies with my own base64 and JSON encoding. All 12 hashes matched, with Flex-only routing, 4,096 max tokens, low reasoning, static processing and no temperature.
- I also re-ran `verify.py` with its write disabled. It passed, and the only difference from the saved file is the timestamp.

**Matched inputs.** I compared all 786 cells against the accepted Gemini 3.8 attempts. Prompt text, schema, video processing, transport path and SHA, max_tokens, reasoning and seed are identical in every cell. The only difference is temperature 1.0 in the baseline. Segment counts are 198 + 195 = 393. Pinned hashes all match: protocol, config, bound, gate, freeze, inputs and code.

**Chronology.** The gate, the amendment, commit `db1f94eb` and the first post-gate session all fall at 00:25:53Z. Analysis came later. The prior reviewer's B1 finding (the narrowed gate scope couldn't be resumed on the same ledger) is actually fixed:
- All five post-gate sessions carry gate SHA `c1489797` and code `a2a4a1e8`, and plan 786 cells.
- The 13 tests in `hydrogen_campaign_test` pass offline, including `test_scope_gate_resumes_same_ledger_without_sending_outside_prefix`.

**Scoring.** I called `SoccerNet.Evaluation.ActionSpotting.evaluate` directly on `analysis/staged` (version 0.1.62, hash pinned). All 8 pooled a_mAP values equal `results.json` exactly.
- The staged labels match `benchmark/downloads`, and the staged predictions match their sources.
- Tolerances are 1 to 5 s (tight) and 5 to 60 s (loose), at 2 fps, with visible and not-shown annotations combined. The average is over all 17 classes, including Yellow->red card with zero positives, which scores 0.
- Results and the CSV store fractions. The README and chart show percent. I found no conversion mistakes.
- My own ownership filter reproduces the prediction counts: 418 at 224p and 421 at 720p.
- Bootstrap indices regenerate exactly from seed 20261113.

## Findings

**1. The "paired 95% interval" is really a three-value range (mandatory correction).** With 2 matches, every draw is A+A, A+B or B+B, in my count 2,464, 5,060 and 2,476 times. So `bootstrap-scores.npz` contains exactly 3 distinct values per series, and each interval is just the min and max of {match A alone, match B alone, pooled}. For example, 720p tight is [+5.34, +6.02] with the point estimate sitting on the lower bound.
- This is not a calibrated 95% confidence interval. Rewrite the table header and the "All four paired intervals are above zero" sentence (README.md:9 and :13).
- Suggested wording: Hydrogen is higher on each match alone and pooled, in all 8 match × resolution × metric comparisons; with 2 clusters the whole-match bootstrap has only 3 possible values and gives no calibrated interval.
- The `verdict: higher` labels in results.json, written by analyze.py:94-95, should carry the same caveat.

**2. The gate amendment changed the selection from 1 match to 2, and the README doesn't say so (mandatory disclosure).** The protocol's formula (PROTOCOL.md:7) gives 0.08878125 + 1.1 × 0.0044390625 × 786 + 1 = $4.927, which is over $4.88, so it selects 1 match. The amended formula gives $4.829, so 2 matches.
- The prior reviewer had already predicted a one-match outcome with no interval (hydrogen-runner-review.md:22, N2). The amendment followed, before any Hydrogen scoring.
- The correction itself is arithmetically sound, because it removes a double count of paid preflight cost. README.md:5 should still say that the literal protocol would have selected 1 match, and when the change was made.

**3. The resolution claims are understated (correction).** README.md:53 says only the preflight showed 3,829 input tokens. In fact, the full 787-record metadata shows 3,829 native prompt tokens in 387 of 393 cells at 720p and 388 of 393 at 224p, with matching values for the short segments.
- Hydrogen's input token count therefore does not change with resolution, and its 720p-minus-224p contrast is not the same measurement as Gemini 3.8's.
- For loose metrics, both matches individually show 720p lower (−0.23 and −0.74 pp), while the pooled figure is +0.13. README.md:20 should report "no resolution difference established" and mention this sign inconsistency.

**4. Minor wording and provenance items.**
- README.md:26 says "pilots"; it means preflight.
- PROTOCOL.md:3 still says "Status: preflight". It is hash-pinned and must stay as is, so the README should note that it is the frozen pre-run text.
- `interrupted-analysis.log` was written at 03:18Z for a run around 00:47Z. The code version for that run is not preserved, because `code/original-analyze.py` would have asserted before scoring. Since scope was already locked by code, the impact is low, but the gap should be stated.

**5. Archive readiness.**
- Exclude `__pycache__/` (7 .pyc files) and the empty `campaign.lock`.
- I found no credentials and no media.
- Response headers contain no secrets.
- `package_results.py` appeared while I was reviewing. I assume it is the parent's; I did not review it.
- Publish per AGENTS.md: a tarball in `docs/research/data/`, plus SHA256SUMS, the README index entry and an `experiments.json` entry.
- `analyze.py` rewrites `analysis/` in place, so the reproduction steps should say to run it on a copy.
- `verify.py` needs the external transport MP4s.
- The staged files include real SoccerNet `Labels-v2.json`. I did not establish whether redistributing those labels is allowed.

## Disclosed limitations (accurate as written)

- Only two previously explored matches, not an untouched holdout.
- Baseline scores for 2 and 3 matches were seen (`baseline-preflight.json`, 00:15Z) before the gate. The gate used no scores.
- One accepted generation per cell.
- Flex versus Standard tier, and temperature omitted versus 1.0.
- Singleton classes (Penalty, Red card) score AP 1.0 for both models. This inflates the absolute scores but cancels in the differences.

## Recommended conclusion

"On two previously explored SoccerNet test matches with byte-identical inputs, Gemini 4 Hydrogen (Flex, low reasoning) scored higher than Gemini 3.8 Flash on tight average-mAP: +7.27 pp at 224p and +5.34 pp at 720p. Loose average-mAP was +5.53 and +4.29 pp. Hydrogen was higher on each match alone in all eight comparisons. Two clusters allow no calibrated interval, so this is consistent directional evidence, not a generalizable estimate. No resolution effect was established for Hydrogen, whose input token count did not depend on resolution. Total spend was $3.54041775 of $4.88, fully reconciled against both counters and per-generation metadata."

Principles applied:
- **Prove It Works.** I re-folded the ledger, rebuilt requests and called the official evaluator myself instead of trusting `verification.json`.
- **Explain the Number.** Asking what the interval actually measured exposed that the bootstrap has only three possible values.

Dispatch ledger: in-thread, since I am a leaf and delegated nothing.
