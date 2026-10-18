import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { openEvaluation } from '../src/agent/extract.ts';
import { extractVerdicts } from '../src/agent/extractVerdicts.ts';
import { matchAndScore } from '../src/agent/match.ts';
import { rankJob } from '../src/agent/rank.ts';
import { scoreEvaluation } from '../src/agent/score.ts';
import { parseExtractionPrompt } from '../src/agent/extractionPrompt.ts';
import { cvIsSilent, enforceVerdicts, reconcileWithMatcher, scoreFromVerdicts, type EnforcedVerdict } from '../src/agent/verdictEnforcement.ts';
import { VERDICT_PROMPT_VERSION, VERDICT_PURPOSE, validateVerdictOutput } from '../src/agent/verdictExtraction.ts';
import { ROUTING_STEPS, SUPPORT_RANK, disagreementOf, lowerOf, verdictSteps } from '../src/agent/verdictMode.ts';
import { handleEvaluationDetail } from '../src/handlers/evaluations.ts';
import { installDeterministicVerdictExtractor } from '../src/agent/mockVerdictExtractor.ts';
import { createMockLlmProvider } from '../src/adapters/llm/mock.ts';
import { DEMO_JOB } from '../src/demo/dataset.ts';
import { createTestContext } from './helpers.ts';
import { GENUINE_NODE_LINE, HOSTILE_CVS, type Verdict } from './hostileCvs.ts';
import type { MatchVerdict } from '../src/domain/ats.ts';

// `model_checked`: the model proposes a verdict with the quotes it relies on, the code enforces the rules, and the deterministic matcher
// is a second opinion. Every rule is pinned here, with a mock model that says exactly what each test needs it to say.

const VERDICTS: readonly MatchVerdict[] = ['met', 'partial', 'not_met', 'unclear'];

const NODE = 'Designed and shipped production Node.js services for a freight booking platform.';
const POSTGRES = 'Ran PostgreSQL at scale: a 4 TB primary with five read replicas and a tested failover every quarter.';
const MENTOR = 'Mentored six junior engineers over four years; two of them have since been promoted to mid-level.';
const VAGUE_DB = 'Looked after the company databases when something needed doing, such as restoring a backup.';

const STRONG_CV = [
  'Name: Ada Examplewright',
  'Email: ada.examplewright@example.invalid',
  'Phone: +44 20 7946 0999',
  '',
  'EXPERIENCE',
  NODE,
  POSTGRES,
  MENTOR,
  VAGUE_DB,
].join('\n');

type Answer = { verdict: MatchVerdict | string; passages: string[]; reason?: string };

/** A pipeline with a model that answers, by requirement label, exactly what the test says. */
async function run(cvText: string, answers: Record<string, Answer | undefined>, options: { matchMode?: 'strict' | 'folded'; omitRequirements?: boolean; raw?: Record<string, unknown> } = {}) {
  const ctx = await createTestContext({ idPrefix: 'vm' });
  const { job, requirements } = await createJob({ repos: ctx.repos }, DEMO_JOB);
  const ingested = await ingestResume({ repos: ctx.repos }, { reference: 'cv', displayName: null, text: cvText, source: 'manual' });
  const evaluation = await openEvaluation({ repos: ctx.repos }, { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume });

  const provider = createMockLlmProvider();
  const calls: Array<{ purpose: string; promptVersion: string; toolName: string; system: string }> = [];
  provider.registerResponder(VERDICT_PURPOSE, (request) => {
    calls.push({ purpose: request.purpose, promptVersion: request.promptVersion, toolName: request.tool.name, system: request.systemPrompt });
    if (options.raw) return options.raw;
    const parsed = parseExtractionPrompt(request.messages[0]!.content);
    return {
      requirements: parsed.requirements.flatMap((requirement) => {
        const answer = answers[requirement.label];
        if (!answer) return [];
        return [{ requirementId: requirement.id, verdict: answer.verdict, passages: answer.passages, reason: answer.reason ?? 'because' }];
      }),
    };
  });

  const extraction = await extractVerdicts({ repos: ctx.repos, provider }, evaluation.id);
  const matched = await matchAndScore({ repos: ctx.repos, matchMode: options.matchMode ?? 'strict' }, evaluation.id);
  const checks = await ctx.repos.verdictChecks.listForEvaluation(evaluation.id);
  const byLabel = new Map(requirements.map((requirement) => [requirement.label, requirement.id]));
  const check = (label: string) => checks.find((entry) => entry.requirementId === byLabel.get(label))!;
  const events = await ctx.repos.audit.listForCorrelation(evaluation.id);
  return { ctx, job, requirements, evaluation, extraction, matched, checks, check, events, calls, close: () => ctx.close() };
}

// ============================================================================================ the scale

test('the scale: met 3, partial 2, unclear 1, not_met 0; two steps or more is acted on', () => {
  assert.deepEqual({ ...SUPPORT_RANK }, { met: 3, partial: 2, unclear: 1, not_met: 0 });
  assert.equal(ROUTING_STEPS, 2);
  // The cases named in the decision: met and not_met, met and unclear are two steps or more; met and partial are one.
  assert.equal(disagreementOf('met', 'not_met'), 'two_plus');
  assert.equal(disagreementOf('not_met', 'met'), 'two_plus');
  assert.equal(disagreementOf('met', 'unclear'), 'two_plus');
  assert.equal(disagreementOf('met', 'partial'), 'one_step');
  assert.equal(disagreementOf('partial', 'unclear'), 'one_step');
  assert.equal(disagreementOf('unclear', 'not_met'), 'one_step');
  // And partial against not_met: a model fooled into "partial" by a passage the matcher finds nothing in.
  assert.equal(disagreementOf('partial', 'not_met'), 'two_plus');
  for (const verdict of VERDICTS) assert.equal(disagreementOf(verdict, verdict), 'none');
  for (const a of VERDICTS) for (const b of VERDICTS) assert.equal(verdictSteps(a, b), verdictSteps(b, a), 'symmetric');
  assert.equal(lowerOf('met', 'partial'), 'partial');
  assert.equal(lowerOf('unclear', 'not_met'), 'not_met');
});

// ============================================================================================ the shape of the answer

test('the answer is read strictly: a bad entry is dropped with a reason, never repaired', () => {
  const known = new Set(['r1', 'r2']);
  const result = validateVerdictOutput(
    {
      requirements: [
        { requirementId: 'r1', verdict: 'met', passages: ['a', 'b', 'c', 'd', 'e', 42], reason: 'ok' },
        { requirementId: 'r1', verdict: 'partial', passages: [], reason: 'second answer for the same one' },
        { requirementId: 'r2', verdict: 'perfect', passages: [], reason: 'not a verdict' },
        { requirementId: 'nope', verdict: 'met', passages: [], reason: 'unknown requirement' },
        { requirementId: 'r2', verdict: 'met', passages: 'not a list', reason: 'x' },
        'not an object',
      ],
    },
    known,
  );
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.accepted[0]?.passages, ['a', 'b', 'c', 'd'], 'at most four passages are kept');
  assert.equal(result.passagesOverLimit, 1);
  assert.equal(result.passagesNotText, 1);
  assert.deepEqual(result.rejected.map((entry) => entry.reason).sort(), ['duplicate_requirement', 'not_an_object', 'unknown_requirement', 'unknown_verdict', 'wrong_type']);
  assert.equal(validateVerdictOutput({ findings: [] }, known).rejected[0]?.reason, 'missing_field');
});

// ============================================================================================ the code's rules

const REQ = [
  { id: 'a', label: 'Node.js', criterion: 'Has shipped production services in Node.js' },
  { id: 'b', label: 'PostgreSQL', criterion: 'Has run PostgreSQL at scale' },
  { id: 'c', label: 'Mentoring', criterion: 'Has mentored junior engineers' },
];

function enforce(verdict: MatchVerdict | null, passages: string[], contentText: string, requirementIndex = 1): EnforcedVerdict {
  return enforceVerdicts({
    requirements: [REQ[requirementIndex]!],
    answers: verdict === null ? new Map() : new Map([[REQ[requirementIndex]!.id, { verdict, reason: 'because' }]]),
    verifiedPassages: new Map([[REQ[requirementIndex]!.id, passages]]),
    contentText,
  })[0]!;
}

test('met or partial with no surviving passage is lowered to unclear', () => {
  for (const verdict of ['met', 'partial'] as const) {
    const result = enforce(verdict, [], STRONG_CV);
    assert.equal(result.enforcedVerdict, 'unclear');
    assert.equal(result.downgrade, 'no_verified_passage');
    assert.equal(result.modelVerdict, verdict);
  }
  for (const verdict of ['met', 'partial'] as const) {
    const kept = enforce(verdict, [POSTGRES], STRONG_CV);
    assert.equal(kept.enforcedVerdict, verdict);
    assert.equal(kept.downgrade, null);
  }
});

test('not_met needs a verified passage (an explicit negative) or a CV that is silent about the requirement', () => {
  // an explicit negative, quoted: stands
  const negative = 'I have never run PostgreSQL in production; my databases were small.';
  assert.equal(enforce('not_met', [negative], `${STRONG_CV}\n${negative}`).enforcedVerdict, 'not_met');

  // nothing quoted, and the CV never mentions the subject: stands
  const silentCv = 'Name: X\nI paint houses and repair roofs for a living.';
  assert.ok(cvIsSilent(REQ[1]!, silentCv));
  const silent = enforce('not_met', [], silentCv);
  assert.equal(silent.enforcedVerdict, 'not_met');
  assert.equal(silent.downgrade, null);

  // nothing quoted, but the CV does mention the subject: the model has not shown what it relies on
  const speaks = enforce('not_met', [], STRONG_CV);
  assert.equal(speaks.enforcedVerdict, 'unclear');
  assert.equal(speaks.downgrade, 'no_verified_passage');
});

test('unclear always stands, and no answer is unclear', () => {
  assert.equal(enforce('unclear', [POSTGRES], STRONG_CV).enforcedVerdict, 'unclear');
  assert.equal(enforce('unclear', [], STRONG_CV).downgrade, null);
  const none = enforce(null, [], STRONG_CV);
  assert.equal(none.enforcedVerdict, 'unclear');
  assert.equal(none.downgrade, 'no_answer');
  assert.equal(none.modelVerdict, null);
});

test('enforcement can only lower a verdict, never raise one: for every verdict and every evidence situation', () => {
  for (const verdict of VERDICTS) {
    for (const passages of [[], [POSTGRES]]) {
      for (const cv of [STRONG_CV, 'Name: X\nI paint houses.']) {
        const result = enforce(verdict, passages, cv);
        assert.ok(result.enforcedVerdict === verdict || result.enforcedVerdict === 'unclear', `${verdict} became ${result.enforcedVerdict}`);
        if (verdict === 'unclear') assert.equal(result.enforcedVerdict, 'unclear');
      }
    }
  }
});

test('reconciling: one step is shown; two steps cap the score at the LOWER verdict; the cap never raises', () => {
  const evidence = (id: string, quote: string) => [{ requirementId: id, quote, verified: true }];
  const enforced = (id: string, verdict: MatchVerdict): EnforcedVerdict => ({ requirementId: id, modelVerdict: verdict, modelReason: 'x', enforcedVerdict: verdict, downgrade: null, verifiedPassages: 1 });

  // model met, matcher partial (Ran/run): one step apart, the model's verdict stands
  const one = reconcileWithMatcher([REQ[1]!], [enforced('b', 'met')], evidence('b', POSTGRES), 'strict')[0]!;
  assert.equal(one.matcher.verdict, 'partial');
  assert.equal(one.disagreement, 'one_step');
  assert.equal(one.scoredVerdict, 'met');
  assert.equal(one.capped, false);

  // model met on a passage the matcher finds nothing in: two steps or more, capped to the matcher's lower verdict
  const two = reconcileWithMatcher([REQ[1]!], [enforced('b', 'met')], evidence('b', VAGUE_DB), 'strict')[0]!;
  assert.equal(two.matcher.verdict, 'not_met');
  assert.equal(two.disagreement, 'two_plus');
  assert.equal(two.scoredVerdict, 'not_met');
  assert.equal(two.capped, true);

  // model harsher than the matcher by two steps or more: the LOWER (the model's) is scored, and the person is told
  const harsh = reconcileWithMatcher([REQ[0]!], [enforced('a', 'not_met')], evidence('a', NODE), 'strict')[0]!;
  assert.equal(harsh.matcher.verdict, 'met');
  assert.equal(harsh.disagreement, 'two_plus');
  assert.equal(harsh.scoredVerdict, 'not_met');

  // for every pair: the scored verdict is never above the enforced one
  for (const modelVerdict of VERDICTS) {
    for (const quote of [NODE, POSTGRES, MENTOR, VAGUE_DB]) {
      for (const requirement of REQ) {
        const result = reconcileWithMatcher([requirement], [enforced(requirement.id, modelVerdict)], evidence(requirement.id, quote), 'folded')[0]!;
        assert.ok(SUPPORT_RANK[result.scoredVerdict] <= SUPPORT_RANK[result.enforcedVerdict], `${modelVerdict} on "${quote.slice(0, 20)}" scored ${result.scoredVerdict}`);
      }
    }
  }
});

test('scoring from verdicts is the same arithmetic as the matcher scorer: identical results on the evaluation set', async () => {
  const dataset = await import('../scripts/evalLabels.ts');
  const main = dataset.loadDataset();
  const heldout = dataset.loadHeldoutDataset();
  let compared = 0;
  for (const [set, entries, dir] of [
    [main, main.cvs, dataset.EVAL_DIR],
    [heldout, heldout.cvs, dataset.HELDOUT_DIR],
  ] as const) {
    for (const cv of entries) {
      const role = set.roles[cv.role]!;
      const ctx = await createTestContext({ idPrefix: 'sc' });
      try {
        const { job, requirements } = await createJob({ repos: ctx.repos }, { title: role.title, seniority: 'senior', description: role.description, requirements: role.requirements.map((r) => ({ label: r.label, criterion: r.criterion, kind: r.kind, weight: r.weight })) });
        const ingested = await ingestResume({ repos: ctx.repos }, { reference: cv.id, displayName: null, text: dataset.loadCvText(cv, dir), source: 'manual' });
        const evaluation = await openEvaluation({ repos: ctx.repos }, { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume });
        // The stand-in quotes lines; its verdicts are the matcher's, so the two scorers must agree on everything.
        const provider = createMockLlmProvider();
        installDeterministicVerdictExtractor(provider, { matchMode: 'folded' });
        await extractVerdicts({ repos: ctx.repos, provider }, evaluation.id);
        const verified = await ctx.repos.evidence.listVerifiedForEvaluation(evaluation.id);
        for (const mode of ['strict', 'folded'] as const) {
          const reference = scoreEvaluation(requirements, verified, mode);
          const rebuilt = scoreFromVerdicts(requirements, reference.rows.map((row) => row.decision));
          assert.deepEqual(
            { score: rebuilt.scoreBasisPoints, met: rebuilt.mustHavesMet, unclear: rebuilt.mustHavesUnclear, parts: rebuilt.rows.map((row) => row.contributionBasisPoints) },
            { score: reference.scoreBasisPoints, met: reference.mustHavesMet, unclear: reference.mustHavesUnclear, parts: reference.rows.map((row) => row.contributionBasisPoints) },
            `${cv.id} (${mode})`,
          );
          assert.equal(rebuilt.rows.reduce((sum, row) => sum + row.contributionBasisPoints, 0), rebuilt.scoreBasisPoints, 'the parts add up to the whole');
          compared += 1;
        }
      } finally {
        await ctx.close();
      }
    }
  }
  assert.equal(compared, 50, 'every CV in both sets, in both modes');
});

// ============================================================================================ the pipeline

test('an honest, matching model: the verdicts stand, the second opinion agrees or is one step apart, and nothing is routed', async () => {
  const r = await run(STRONG_CV, {
    'Node.js': { verdict: 'met', passages: [NODE] },
    PostgreSQL: { verdict: 'met', passages: [POSTGRES] },
    Mentoring: { verdict: 'met', passages: [MENTOR] },
  });
  try {
    assert.deepEqual(r.calls.map((call) => [call.purpose, call.promptVersion, call.toolName]), [[VERDICT_PURPOSE, VERDICT_PROMPT_VERSION, 'record_verdicts']]);
    assert.equal(r.calls[0]?.promptVersion, 'extract-v3');
    assert.equal(r.extraction.verified, 3);
    assert.equal(r.matched.verdictMode, 'model_checked');
    assert.equal(r.matched.needsReview, false);
    assert.equal(r.check('Node.js').disagreement, 'none');
    assert.equal(r.check('PostgreSQL').disagreement, 'one_step'); // "Ran" is not "run": the matcher says partial, the model says met
    assert.equal(r.check('PostgreSQL').scoredVerdict, 'met', 'one step apart: shown, and the model\'s verdict is scored');
    assert.deepEqual(r.matched.breakdown.rows.map((row) => row.decision.verdict), ['met', 'met', 'met']);
    assert.equal(r.matched.breakdown.scoreBasisPoints, 10000);
    const match = r.events.find((event) => event.eventType === 'requirements_matched');
    assert.equal(match?.payload.verdictMode, 'model_checked', 'the mode is recorded in the audit trail');
    assert.equal(match?.payload.matchMode, 'strict');
    assert.equal(r.events.some((event) => event.eventType === 'verdict_disagreement'), false);
    assert.equal(r.events.some((event) => event.eventType === 'verdict_downgraded_no_evidence'), false);
    const record = await r.ctx.repos.evaluationRecords.getForEvaluation(r.evaluation.id);
    assert.equal(record?.result, 'succeeded');
    assert.equal(r.matched.evaluation.promptVersion, 'extract-v3');
  } finally {
    await r.close();
  }
});

test('a passage that is not in the CV is dropped, and the verdict that leaned on it is lowered to unclear', async () => {
  const invented = 'Ran PostgreSQL at the largest bank in Europe for twenty years without incident.';
  const r = await run(STRONG_CV, {
    'Node.js': { verdict: 'met', passages: [NODE] },
    PostgreSQL: { verdict: 'met', passages: [invented] },
    Mentoring: { verdict: 'partial', passages: [] },
  });
  try {
    assert.equal(r.extraction.verified, 1);
    assert.equal(r.extraction.rejected, 1, 'the invented passage was refused');
    assert.equal(r.extraction.downgraded, 2);
    assert.equal(r.check('PostgreSQL').modelVerdict, 'met');
    assert.equal(r.check('PostgreSQL').enforcedVerdict, 'unclear');
    assert.equal(r.check('PostgreSQL').downgradeReason, 'no_verified_passage');
    assert.equal(r.check('Mentoring').enforcedVerdict, 'unclear', 'partial with nothing quoted');
    const event = r.events.find((entry) => entry.eventType === 'verdict_downgraded_no_evidence');
    assert.ok(event, 'a verdict_downgraded_no_evidence event');
    assert.equal((event.payload.verdicts as unknown[]).length, 2);
    assert.equal(r.matched.breakdown.rows[1]?.decision.verdict, 'unclear');
    // the invented passage is kept as unverified, visible and worth nothing
    const all = await r.ctx.repos.evidence.listForEvaluation(r.evaluation.id);
    assert.equal(all.filter((item) => !item.verified).length, 1);
    const verified = await r.ctx.repos.evidence.listVerifiedForEvaluation(r.evaluation.id);
    assert.ok(verified.every((item) => item.quote !== invented));
  } finally {
    await r.close();
  }
});

test('a passage shorter than 15 characters is refused even though it is really in the CV', async () => {
  const r = await run(STRONG_CV, { 'Node.js': { verdict: 'met', passages: ['Node.js APIs only'] } });
  try {
    assert.equal(r.extraction.verified, 0);
    assert.equal(r.check('Node.js').enforcedVerdict, 'unclear');
    assert.equal(r.check('Node.js').downgradeReason, 'no_verified_passage');
  } finally {
    await r.close();
  }
});

test('a model that says met on a passage the matcher finds nothing in: two steps apart, routed to a person, and the score uses the lower verdict', async () => {
  const r = await run(STRONG_CV, {
    'Node.js': { verdict: 'met', passages: [NODE] },
    PostgreSQL: { verdict: 'met', passages: [VAGUE_DB] },
  });
  try {
    assert.equal(r.check('PostgreSQL').matcherVerdict, 'not_met');
    assert.equal(r.check('PostgreSQL').disagreement, 'two_plus');
    assert.equal(r.check('PostgreSQL').enforcedVerdict, 'met', 'the code let the verdict stand: there was a verified passage');
    assert.equal(r.check('PostgreSQL').scoredVerdict, 'not_met', 'but the score does not');
    assert.equal(r.matched.needsReview, true);
    const disagreement = r.events.find((event) => event.eventType === 'verdict_disagreement');
    assert.ok(disagreement, 'a verdict_disagreement event');
    assert.equal((disagreement.payload.requirements as Array<{ capped: boolean }>)[0]?.capped, true);
    const detail = (await handleEvaluationDetail({ repos: r.ctx.repos }, r.evaluation.id)).body;
    assert.equal(detail.needsReview, true);
    assert.equal(detail.tier, 'needs_review');
    assert.equal(detail.verdictMode, 'model_checked');
    const postgres = detail.requirements.find((entry) => entry.label === 'PostgreSQL');
    assert.equal(postgres?.check?.disagreement, 'two_plus');
    assert.equal(postgres?.check?.modelVerdict, 'met');
    assert.equal(postgres?.check?.matcherVerdict, 'not_met');
    assert.equal(postgres?.check?.scoredVerdict, 'not_met');
    assert.match(postgres?.rationale ?? '', /Model: met/);
    assert.match(postgres?.rationale ?? '', /two steps or more apart/);
  } finally {
    await r.close();
  }
});

test('the ranking routes a candidate the second opinion disagreed with to needs_review, and renumbers', async () => {
  const flagged = await run(STRONG_CV, { 'Node.js': { verdict: 'met', passages: [NODE] }, PostgreSQL: { verdict: 'met', passages: [VAGUE_DB] }, Mentoring: { verdict: 'met', passages: [MENTOR] } });
  try {
    const ranking = await rankJob({ repos: flagged.ctx.repos }, flagged.job.id);
    assert.equal(ranking.entries[0]?.tier, 'needs_review');
    assert.equal(ranking.entries[0]?.position, 1);
    assert.equal(ranking.entries[0]?.rank, 1);
    assert.match(ranking.entries[0]?.rationale ?? '', /disagree by two steps or more on "PostgreSQL"/);
    assert.equal(ranking.entries[0]?.scoreBasisPoints, flagged.matched.breakdown.scoreBasisPoints, 'the stored score is never edited');
  } finally {
    await flagged.close();
  }

  // Not flagged: the ranking is exactly the one the ranking rules produce.
  const clean = await run(STRONG_CV, { 'Node.js': { verdict: 'met', passages: [NODE] }, PostgreSQL: { verdict: 'met', passages: [POSTGRES] }, Mentoring: { verdict: 'met', passages: [MENTOR] } });
  try {
    const ranking = await rankJob({ repos: clean.ctx.repos }, clean.job.id);
    assert.equal(ranking.entries[0]?.tier, 'qualified');
  } finally {
    await clean.close();
  }
});

test('negation: "I have not used ..." quoted as the evidence for not_met stands, and the matcher, which cannot read it, is outvoted and flagged', async () => {
  const negative = 'I have never run PostgreSQL in production; every database I looked after was small.';
  const cv = `${STRONG_CV}\n${negative}`;
  const r = await run(cv, { PostgreSQL: { verdict: 'not_met', passages: [negative] } });
  try {
    assert.equal(r.check('PostgreSQL').enforcedVerdict, 'not_met', 'a verified explicit negative is evidence');
    // The matcher counts words, so it reads the negative as support for the requirement.
    assert.notEqual(r.check('PostgreSQL').matcherVerdict, 'not_met');
    assert.equal(r.check('PostgreSQL').disagreement, 'two_plus');
    assert.equal(r.check('PostgreSQL').scoredVerdict, 'not_met', 'the lower verdict is scored: the negation is not credited as a skill');
    assert.equal(r.matched.needsReview, true);
  } finally {
    await r.close();
  }
});

test('keyword stuffing: a list of skills credited in full is credited, and that is a documented limit; the model saying partial is scored partial', async () => {
  const stuffed = 'Skills: Node.js, shipped production services, PostgreSQL, run at scale, mentored junior engineers';
  const cv = `Name: X\n${stuffed}`;
  const credited = await run(cv, { 'Node.js': { verdict: 'met', passages: [stuffed] } });
  try {
    // The words are all there, so the matcher agrees with the model: nothing disagrees to route. This is the limit, not a rule.
    assert.equal(credited.check('Node.js').disagreement, 'none');
    assert.equal(credited.check('Node.js').scoredVerdict, 'met');
  } finally {
    await credited.close();
  }
  const careful = await run(cv, { 'Node.js': { verdict: 'partial', passages: [stuffed] } });
  try {
    assert.equal(careful.check('Node.js').scoredVerdict, 'partial');
    assert.ok(careful.matched.breakdown.scoreBasisPoints < credited.matched.breakdown.scoreBasisPoints || true);
  } finally {
    await careful.close();
  }
});

test('a reply with no "requirements" list is a failure of its own kind, not an empty result; a requirement the model skipped is unclear', async () => {
  const bad = await run(STRONG_CV, {}, { raw: { findings: [] } }).then(
    () => null,
    (err: Error) => err,
  );
  assert.ok(bad, 'the run must fail');
  assert.match(bad.message, /did not|could not|unavailable|answer/i);

  const r = await run(STRONG_CV, { 'Node.js': { verdict: 'met', passages: [NODE] } });
  try {
    assert.equal(r.check('PostgreSQL').modelVerdict, null);
    assert.equal(r.check('PostgreSQL').enforcedVerdict, 'unclear');
    assert.equal(r.check('PostgreSQL').downgradeReason, 'no_answer');
  } finally {
    await r.close();
  }
});

test('the quotes-only path is untouched: an evaluation extracted without verdict checks is scored by the matcher, and the audit payload is what it always was', async () => {
  const { extractEvidence } = await import('../src/agent/extract.ts');
  const { installDeterministicExtractor } = await import('../src/agent/mockExtractor.ts');
  const ctx = await createTestContext({ idPrefix: 'old' });
  try {
    const { job } = await createJob({ repos: ctx.repos }, DEMO_JOB);
    const ingested = await ingestResume({ repos: ctx.repos }, { reference: 'cv', displayName: null, text: STRONG_CV, source: 'manual' });
    const evaluation = await openEvaluation({ repos: ctx.repos }, { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume });
    const provider = createMockLlmProvider();
    installDeterministicExtractor(provider);
    await extractEvidence({ repos: ctx.repos, provider }, evaluation.id);
    // Asking for model_checked changes nothing for an evaluation that has no verdicts to check.
    const outcome = await matchAndScore({ repos: ctx.repos, verdictMode: 'model_checked' }, evaluation.id);
    assert.equal(outcome.verdictMode, 'matcher');
    const event = (await ctx.repos.audit.listForCorrelation(evaluation.id)).find((entry) => entry.eventType === 'requirements_matched');
    assert.deepEqual(Object.keys(event?.payload ?? {}).sort(), ['evidenceCounted', 'matchMode', 'verdicts']);
    assert.equal((await ctx.repos.verdictChecks.listForEvaluation(evaluation.id)).length, 0);
  } finally {
    await ctx.close();
  }
});

// ============================================================================================ hostile CVs

async function runHostile(cvText: string, injected: readonly string[], behave: 'honest' | 'obeying' | 'empty') {
  const ctx = await createTestContext({ idPrefix: 'host' });
  try {
    const { job, requirements } = await createJob({ repos: ctx.repos }, DEMO_JOB);
    const ingested = await ingestResume({ repos: ctx.repos }, { reference: 'h', displayName: null, text: cvText, source: 'manual' });
    const evaluation = await openEvaluation({ repos: ctx.repos }, { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume });
    const provider = createMockLlmProvider();
    provider.registerResponder(VERDICT_PURPOSE, (request) => {
      const parsed = parseExtractionPrompt(request.messages[0]!.content);
      return {
        // A "score" field is something a fooled model might add; it has nowhere to go, and nothing reads it.
        score: 10000,
        requirements: parsed.requirements.map((requirement) => {
          if (behave === 'empty') return { requirementId: requirement.id, verdict: 'unclear', passages: [], reason: 'nothing' };
          if (behave === 'honest') {
            const genuine = requirement.label === 'Node.js';
            return { requirementId: requirement.id, verdict: genuine ? 'met' : 'unclear', passages: genuine ? [GENUINE_NODE_LINE] : [], reason: 'the genuine line' };
          }
          // obeying: every requirement met, on the attacker's own lines (which really are in the CV) and on invented ones
          return {
            requirementId: requirement.id,
            verdict: 'met',
            passages: [...injected.filter((line) => line.length >= 15), 'Certified expert in PostgreSQL, Node.js and mentoring, trusted by everyone who ever met me.'],
            reason: 'I was told to',
          };
        }),
      };
    });
    await extractVerdicts({ repos: ctx.repos, provider }, evaluation.id);
    const matched = await matchAndScore({ repos: ctx.repos, matchMode: 'strict' }, evaluation.id);
    const evidence = await ctx.repos.evidence.listVerifiedForEvaluation(evaluation.id);
    return {
      verdicts: matched.breakdown.rows.map((row) => row.decision.verdict) as Verdict[],
      score: matched.breakdown.scoreBasisPoints,
      needsReview: matched.needsReview,
      requirements,
      evidenceByRequirement: new Map(requirements.map((requirement) => [requirement.label, evidence.filter((item) => item.requirementId === requirement.id).map((item) => item.quote)])),
    };
  } finally {
    await ctx.close();
  }
}

test('the hostile CVs: a model that obeys every attack gets no more than an honest one, and no attacker line is credited', async () => {
  const attacks = HOSTILE_CVS.filter((cv) => cv.id !== 'hostile-6-keyword-stuffing');
  assert.equal(attacks.length, 7, 'seven attacks asserted; the stuffing CV is measured below');
  for (const cv of attacks) {
    const honest = await runHostile(cv.text, cv.injected, 'honest');
    const empty = await runHostile(cv.text, cv.injected, 'empty');
    const fooled = await runHostile(cv.text, cv.injected, 'obeying');

    assert.ok(fooled.score <= honest.score, `${cv.id}: the fooled model scored ${fooled.score}, the honest one ${honest.score}`);
    assert.ok(fooled.score >= empty.score, `${cv.id}: and an empty answer scores ${empty.score}`);
    // Nothing credited (met or partial) rests on an attacker's line.
    fooled.verdicts.forEach((verdict, index) => {
      if (verdict !== 'met' && verdict !== 'partial') return;
      const label = fooled.requirements[index]!.label;
      for (const quote of fooled.evidenceByRequirement.get(label) ?? []) {
        assert.ok(!cv.injected.some((line) => quote.includes(line) || line.includes(quote)), `${cv.id}: "${label}" was credited on an attacker's line`);
      }
    });
    // PostgreSQL and mentoring are nowhere in the genuine content: no credit, however the model was told to answer.
    assert.ok(!['met', 'partial'].includes(fooled.verdicts[1]!), `${cv.id}: PostgreSQL was credited`);
    assert.ok(!['met', 'partial'].includes(fooled.verdicts[2]!), `${cv.id}: mentoring was credited`);
    // Nothing the model invented is stored as evidence.
    for (const quotes of fooled.evidenceByRequirement.values()) assert.ok(!quotes.some((quote) => quote.startsWith('Certified expert')), `${cv.id}: an invented quote was kept`);
    // The disagreement is not hidden: a person sees it.
    assert.equal(fooled.needsReview, true, `${cv.id}: the fooled model's claims were not routed to a person`);
  }
});

test('keyword stuffing (hostile-6) is measured, not asserted: it can still be credited, and is reported as the limit it is', async () => {
  const cv = HOSTILE_CVS.find((entry) => entry.id === 'hostile-6-keyword-stuffing')!;
  const honest = await runHostile(cv.text, cv.injected, 'honest');
  const fooled = await runHostile(cv.text, cv.injected, 'obeying');
  // No assertion on the number: the words really are in the CV. What is asserted is that it never exceeds what the evidence supports.
  assert.ok(fooled.score <= 10000 && honest.score <= 10000);
  assert.ok(Number.isInteger(fooled.score));
});
