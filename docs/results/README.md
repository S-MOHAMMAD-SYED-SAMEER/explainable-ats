# Recorded results

Each file here is the output of a by-hand run against the real API, saved so a number in the README or in
`docs/TESTING.md` can be traced to a run. Every file records its date, the model ID, the tool choice, the
temperature (or that none was sent, because the model does not accept one), the prompt version and the dataset.

They hold counts, kinds and token usage only. No CV text, prompt, reply or quote is stored in them, and no key.

Every file also says who made the labels it was scored against (`labelsProvenance`). For the evaluation files that is:
"Labels drafted by ChatGPT; reviewed independently by ChatGPT and Claude (agreed on 64 of 68 rows); final decisions approved by
Sameer. Not an independent human labelling." The hostile-CV files have no labels (the expected outcome is written as assertions in
`server/test/hostileCvs.ts`) and say so.

| File | What it is | Settings | Produced by |
|---|---|---|---|
| `eval-2026-10-19-claude-haiku-4-5-20251001-model-checked.json` | The 20 main CVs, one request each, model proposes verdicts (`extract-v3`, `model_checked`). Scored under a lowering rule that was removed the same day: see `supersededBy` | Haiku 4.5, forced, temperature 0, folded | `server/scripts/eval-harness.ts` |
| `rescore-2026-10-19-haiku-4-5-model-checked-no-lowering.json` | The same replies re-scored offline under the current rules (no new request). **These are the numbers to quote.** | as above | `server/scripts/rescore-saved.ts` |
| `injection-2026-10-19-claude-haiku-4-5-20251001-model-checked.json` | Eight hostile CVs through `extract-v3` / `model_checked`, one request each | as above | `server/scripts/live-injection-check.ts` |
| `eval-2026-10-15-claude-haiku-4-5-20251001.json`, `eval-2026-10-15-claude-sonnet-5-5.json` | The first evaluation: quotes only (`extract-v2`), the matcher alone judging verdicts | Haiku: forced, temperature 0. Sonnet: auto, none | `server/scripts/eval-harness.ts` |
| `rescore-matcher-2026-10-18-haiku-4-5.json` | The Haiku `extract-v2` run re-scored offline under the matcher alone (the baseline for `model_checked`) | as the Haiku run | `server/scripts/rescore-saved.ts` |
| `injection-2026-10-14-claude-haiku-4-5-20251001.json` | Eight hostile CVs through `extract-v2`, one request each | Haiku 4.5 | `server/scripts/live-injection-check.ts` |
| `injection-2026-10-14-claude-sonnet-5-5.json` | The same eight, on Sonnet 5.5 | Sonnet 5.5, auto, none | `server/scripts/live-injection-check.ts` |

One run per model, no repeats. A single run says what happened once; it does not say what usually happens, and
Sonnet 5.5 accepts no temperature, so its runs are not repeatable.
