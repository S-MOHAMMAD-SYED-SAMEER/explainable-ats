# Evaluation set

Twenty invented CVs and 68 labels, to measure the extraction and matching stages against a careful reader's passages and verdicts. **Who made the labels: drafted by ChatGPT, checked by Sameer; full review in progress.** They are not an independent human labelling.

**Status.** `labels_TODO.csv` holds the 68 labels, drafted by ChatGPT, checked by Sameer; full review in progress. A held-out set of five more CVs (`heldout/`, `labels_heldout_TODO.csv`) is labelled by Sameer alone, without AI, and is never used for tuning prompts, rules, thresholds or matching; its label columns are empty until he fills them in. `server/scripts/validate-labels.ts` checks both files.

| File | What it is |
|---|---|
| `dataset.json` | The version (`eval-set-v1`), the two roles and their requirements, and the list of CVs |
| `cvs/` | The twenty CVs, plain text, one file each |
| `labels_TODO.csv` | One row per CV and requirement (68), with `gold_passages` and `expected_verdict` (drafted by ChatGPT, checked by Sameer; full review in progress) |
| `heldout/`, `labels_heldout_TODO.csv` | Five more invented CVs and their 17 rows, labelled by Sameer alone, without AI |
| `LABELLING_GUIDE.md` | What the labels mean, with two worked examples on CVs that are not in the set |

## What is in it

- Two roles. Role 1 is the demo's *Senior Backend Engineer* (twelve CVs, three requirements). Role 2 is a *Data Platform Engineer* (eight CVs, four requirements).
- A mix: strong, weak, silent on a requirement, paraphrased skills, negation, short, long, messy formatting, and CVs that say the right thing in a different word form. The CVs run from about 320 to 5,300 characters.
- Every person, employer, address, email and phone number is invented. Emails use the reserved `.invalid` top level and phone numbers come from the range set aside for fiction.

## What it can and cannot say

- **The CVs were written by an AI**, and **the 68 labels were drafted by ChatGPT, checked by Sameer; full review in progress**, so they are not independent of AI. Twenty CVs and one set of labels of that kind will show whether the stages work on a small, varied set. They will not give a figure to quote as accuracy on real CVs.
- It measures how well the system finds the passages a person would point to, how often it quotes something that is not there, whether its verdicts agree with the labeller's, and what a run costs.
- Matching is term coverage, not comprehension, so a CV that says the right thing in other words is expected to do worse than one that echoes the requirement. The set includes such CVs on purpose.

After labelling, validate with `node server/scripts/validate-labels.ts`.
