# Labelling guide

You are writing down, for each CV and each requirement, **what a careful human reader would conclude**, and **where in the CV they would point to show it**. Those answers are the yardstick. Later the system is run on the same CVs and compared with them: did it find the passages you would point to, did it quote anything you would not, and did it reach the verdict you reached.

So label what you actually think. Do not try to predict what the system will do, and do not make your answers match its wording. If you read "ran the Postgres fleet" as meeting "has run PostgreSQL at scale", say so, even though the words differ. How well the system copes with that is the thing being measured.

*This paragraph was written before the first run on the main set. It still holds for the held-out CVs (see the last section), which nothing has ever been run on: they are unlabelled and excluded from every run, so keep it that way.*

There are 68 rows (20 CVs, 3 or 4 requirements each). Plan on two to three hours.

## The files

| File | What it is |
|---|---|
| `eval/labels_TODO.csv` | The file you fill in. One row per CV and requirement. |
| `eval/cvs/cv-01.txt` … `cv-20.txt` | The CVs, as plain text. cv-01 to cv-12 are for the first role, cv-13 to cv-20 for the second. |
| `eval/dataset.json` | The two roles and their requirements, with the ids used in the CSV. |

The CSV has five columns. Fill in the third and fourth; the fifth is optional. Do not change the first two, add rows, remove rows or reorder them.

| Column | You write |
|---|---|
| `cv_id` | (given) |
| `requirement_id` | (given) |
| `gold_passages` | The passage or passages in the CV that speak to the requirement. Empty only when the CV says nothing. |
| `expected_verdict` | `met`, `partial`, `not_met` or `unclear` |
| `notes` | Optional. Why you were torn, or anything the other columns cannot say. |

## The two roles

**Role 1: Senior Backend Engineer** (cv-01 to cv-12)

| `requirement_id` | Requirement | Kind | Weight |
|---|---|---|---|
| `demo-node` | Has shipped production services in Node.js | essential | 3 |
| `demo-postgres` | Has run PostgreSQL at scale | essential | 2 |
| `demo-mentoring` | Has mentored junior engineers | desirable | 2 |

**Role 2: Data Platform Engineer** (cv-13 to cv-20)

| `requirement_id` | Requirement | Kind | Weight |
|---|---|---|---|
| `data-python` | Has built and operated production data pipelines in Python | essential | 3 |
| `data-sql` | Has written complex SQL against a data warehouse | essential | 2 |
| `data-orchestration` | Has used a workflow orchestrator such as Airflow or Dagster | desirable | 2 |
| `data-stakeholders` | Has worked with analysts or business stakeholders to define data requirements | desirable | 1 |

Judge against the requirement **as written**. "At scale", "production" and "complex" are part of it.

## The four verdicts

These are the product's own meanings, so the comparison is like for like.

| Verdict | It means | The CV… |
|---|---|---|
| `met` | The CV shows the requirement, in full. | …says it, clearly, in a way you would accept from a candidate in an interview screen. |
| `partial` | The CV shows some of it, not all. | …shows the area but stops short on part of the wording: the right technology at the wrong scale, the right activity done informally, one half of a two-part requirement. |
| `not_met` | The CV speaks to the requirement and what it says does not show it. | …addresses it and falls short, or says outright that the candidate has not done it ("I have no experience of…"), or shows the opposite. |
| `unclear` | The CV is silent. | …says nothing about it either way. This is not a mark against the candidate: it is the answer when there is nothing to judge. |

The line between `not_met` and `unclear` is the one that matters most. **`not_met` is "I looked, there was something, and it does not show it." `unclear` is "I looked and there was nothing."** A candidate who says they have never used PostgreSQL has told you something; a candidate whose CV never mentions a database has not.

Some rules of thumb. Where the guide is silent, use your own judgement, and say so in `notes` if you were torn.

- **Meaning counts, wording does not.** A synonym, a different word form, or a different name for the same thing is fine ("Postgres" for PostgreSQL, "coached" for mentored).
- **A claim counts as a claim.** If the CV says it, it is something you can point to. You are not checking whether it is true.
- **A bare name in a skills list** tells you the candidate has heard of the thing, not what they did. Point to it if it is the only place the CV mentions the requirement, and think hard before calling it more than `partial`.
- **If you are torn between two verdicts, choose the lower one and write why in `notes`.** "Lower" runs `met`, `partial`, `not_met`; `unclear` is separate and is only for silence.
- **Essential and desirable do not change the verdict.** They matter later, in the ranking. Label every requirement the same way.

## Gold passages

A gold passage is the part of the CV you would point at if someone asked, "Where does this CV speak to this requirement?"

- **Copy it exactly, character for character.** The validator checks that each passage really is in the CV. If a sentence wraps over two lines in the CV, join them with a single space: spaces and line breaks are not compared. Curly quotes and dashes that a spreadsheet changes are tolerated.
- **Make it as short as it can be and still show the thing.** A sentence, a bullet, or the phrase inside one. Not a heading, not a whole section, no ellipses.
- **Include every place that a careful reader would cite**, usually one to three. If the strongest evidence is in one bullet, that bullet is enough.
- **Include a passage that shows a shortfall.** For `not_met` and `partial` the gold passage is the text that shows the CV falling short or covering only part.
- **Separate several passages with ` || `** (a space, two bars, a space).
- **Leave it empty when the CV is silent**, and only then. `unclear` has no passage, and every other verdict needs at least one.

If a passage contains a comma or a quotation mark, a spreadsheet will quote it correctly when you save as CSV. If you edit the file as text, wrap that cell in double quotes and write any double quote inside as two.

## Two worked examples

Both use CVs that are **not** in the set.

### Example 1: Role 1

```
Senior Developer, Harbourlight Retail (2019 - present)
- Built the order API in Node.js. It handled about 2,000 requests a second at peak and has been live since 2020.
- Looked after the reporting team's PostgreSQL database, a single 30 GB instance. I never worked with replication or partitioning.
- Reviewed pull requests and wrote the team's deployment checklist.

Developer, Cresswell Digital (2016 - 2019)
- Maintained the company website, written in PHP.
- Used MySQL for the customer database.
```

| `requirement_id` | `gold_passages` | `expected_verdict` | Why |
|---|---|---|---|
| `demo-node` | `Built the order API in Node.js. It handled about 2,000 requests a second at peak and has been live since 2020.` | `met` | A real service, in Node.js, live for years under load. That is shipped and in production. |
| `demo-postgres` | `Looked after the reporting team's PostgreSQL database, a single 30 GB instance. I never worked with replication or partitioning.` | `partial` | It shows PostgreSQL was run, and the CV itself says it was one small instance. "At scale" is not shown. If the CV had said "I have only used PostgreSQL through an ORM and never administered it", that would be `not_met`. |
| `demo-mentoring` | (empty) | `unclear` | Reviewing pull requests is not mentoring a junior, and the CV says nothing else. Silent, so `unclear`, with no passage. |

### Example 2: Role 2

```
Data Analyst, Fordham Mutual (2020 - present)
- Wrote SQL against the Snowflake warehouse for the finance team: joins, aggregates and a few window functions.
- Agreed the definition of "active customer" with the marketing and finance analysts, and documented it.
- I have not built or run data pipelines; the loads are run by the data engineering team.
- Used Excel for the monthly board pack.
```

| `requirement_id` | `gold_passages` | `expected_verdict` | Why |
|---|---|---|---|
| `data-python` | `I have not built or run data pipelines; the loads are run by the data engineering team.` | `not_met` | The CV addresses this and says outright that the candidate has not done it. Not silence: a statement. |
| `data-sql` | `Wrote SQL against the Snowflake warehouse for the finance team: joins, aggregates and a few window functions.` | `partial` | It is SQL against a warehouse, and window functions are some way past the basics, but "complex" is not clearly shown. A reader could say `met`; if torn, take the lower one and write why in `notes`. |
| `data-orchestration` | (empty) | `unclear` | Nothing about scheduling or any orchestrator. |
| `data-stakeholders` | `Agreed the definition of "active customer" with the marketing and finance analysts, and documented it.` | `met` | Working with analysts to define a data requirement, said plainly. |

In the CSV, the `data-stakeholders` row would read:

```
cv-XX,data-stakeholders,"Agreed the definition of ""active customer"" with the marketing and finance analysts, and documented it.",met,
```

(The quotation marks are doubled because the passage contains some.)

## Filling in the file

1. Open `eval/labels_TODO.csv` in a spreadsheet or a text editor. Keep the header line.
2. For each row, read the CV in `eval/cvs/`, then fill in `gold_passages` and `expected_verdict`.
3. Save as **CSV (UTF-8)**, in place, with the same name and the same five columns.
4. Check your work any time: `node server/scripts/validate-labels.ts`. It reports a missing verdict, a verdict that is not one of the four, a passage that is not in the CV, an `unclear` that has a passage, and a row that needs a passage and has none. Run it until it says `OK`.
5. Tell Claude the labels are done. Nothing else happens until you do.

You may edit `notes` as much as you like. It is never scored, and it is the place to record a judgement call.

## Who made which labels

| Set | Labels | Provenance |
|---|---|---|
| Main set (20 CVs, 68 rows, `eval/labels_TODO.csv`) | passages and verdicts | **Labels drafted by ChatGPT; reviewed independently by ChatGPT and Claude (agreed on 64 of 68 rows); final decisions approved by Sameer. Not an independent human labelling.** |
| Held-out set (5 CVs, 17 rows, `eval/labels_heldout_TODO.csv`) | none | **Unlabelled. Sameer is not labelling these; they are excluded from every run.** |

Say exactly that wherever the labels are used. Every results file records it as `labelsProvenance`, and a test fails if it is missing.

## The five held-out CVs (unlabelled, excluded from every run)

`eval/heldout/cv-h1.txt` to `cv-h5.txt` are five more invented CVs for the same two roles, with a realistic mix, and `eval/labels_heldout_TODO.csv` has one row per CV and requirement (17), with **the three label columns empty: nothing is suggested**. Sameer has decided not to label them, so they are left as they are: the files are kept, no run uses them, and no result is scored against them.

- **Nobody is labelling these.** No assistant drafts, suggests, checks or comments on them. If they are ever labelled, the rules above (the four verdicts, the passages, torn between two choose the lower) apply unchanged.
- **They are never used for tuning**: not prompts, not rules, not thresholds, not matching modes, not wording. If a result on them looks wrong, the fix is not to change the system until they look right; it is to report them as they are.
- **Nothing has been run on them.** Do not run the app or the scripts on them.
- Check the file with `node server/scripts/validate-labels.ts --heldout`. An empty file is reported as empty and fine; a half-filled one is an error.
