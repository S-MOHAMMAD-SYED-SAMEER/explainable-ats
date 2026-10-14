# Recorded results

Each file here is the output of a by-hand run against the real API, saved so a number in the README or in
`docs/TESTING.md` can be traced to a run. Every file records its date, the model ID, the tool choice, the
temperature (or that none was sent, because the model does not accept one), the prompt version and the dataset.

They hold counts, kinds and token usage only. No CV text, prompt, reply or quote is stored in them, and no key.

| File | What it is | Produced by |
|---|---|---|
| `injection-2026-10-14-claude-haiku-4-5-20251001.json` | Eight hostile CVs, one request each | `server/scripts/live-injection-check.ts` |
| `injection-2026-10-14-claude-sonnet-5-5.json` | The same eight, on the final model | `server/scripts/live-injection-check.ts` |

One run per model, no repeats. A single run says what happened once; it does not say what usually happens, and
Sonnet 5.5 accepts no temperature, so its runs are not repeatable.
