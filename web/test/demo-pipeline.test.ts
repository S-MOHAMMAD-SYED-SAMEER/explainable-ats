import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEntry } from '../src/api/types.ts';
import { PIPELINE_STAGES, STATUS_LABEL, buildPipeline, type PipelineInput, type PipelineStage } from '../src/demo/pipeline.ts';
import { buildTimeline, sortTrail } from '../src/demo/timeline.ts';

// The pipeline and the audit timeline (Phase 3C.4), built from audit events.
//
// These tests feed the builders events shaped exactly like the ones the pipeline
// writes — the field names and payloads are taken from `agent/ingest.ts`,
// `extract.ts` and `match.ts` — and check three things above all: that every
// statement comes from an event, that a missing event is reported as missing, and
// that nothing the visitor reads is a database id. The same builders are also run
// over the REAL pipeline's output for every demo candidate, in the server's
// `demo-evidence.test.ts`.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const REQ_NODE = '11111111-1111-4111-8111-111111111111';
const REQ_PG = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';

let seq = 0;
function event(
  stage: string,
  eventType: string,
  outcome: string,
  payload: Record<string, unknown>,
  createdAt: string,
  extra: Partial<AuditEntry> = {},
): AuditEntry {
  seq += 1;
  return {
    id: `id-${seq}`,
    sequence: seq,
    stage,
    eventType,
    actor: 'system',
    actorId: null,
    outcome,
    summary: `${eventType} happened.`,
    payload,
    createdAt,
    ...extra,
  };
}

/** The events a scored candidate really has, in the shape the pipeline writes them. */
function fullTrail(): AuditEntry[] {
  return [
    event('ingest', 'resume_ingested', 'ok', { candidateReference: 'demo-001', charCount: 523 }, '2026-01-01T00:00:01.000Z', { summary: 'Stored a 523-character resume for demo-001.' }),
    event('redact', 'sensitive_attributes_masked', 'ok', { categories: ['address', 'contact', 'protected_thing'], count: 7 }, '2026-01-01T00:00:02.000Z'),
    event('extract', 'evaluation_opened', 'ok', { jobId: JOB, candidateId: JOB }, '2026-01-01T00:00:03.000Z', { actor: 'human' }),
    event('verify', 'evidence_verified', 'ok', { verified: 3, rejected: 0, malformed: 0, offsetsCorrected: 0 }, '2026-01-01T00:00:04.000Z'),
    event('extract', 'extraction_recorded', 'ok', { model: 'mock', promptVersion: 'v1', requirements: 3 }, '2026-01-01T00:00:05.000Z', { actor: 'ai', actorId: 'mock' }),
    event('match', 'requirements_matched', 'ok', {
      verdicts: [
        { requirementId: REQ_NODE, label: 'Node.js', verdict: 'met', confidence: 'high' },
        { requirementId: REQ_PG, label: 'PostgreSQL', verdict: 'not_met', confidence: 'low' },
      ],
      evidenceCounted: 3,
    }, '2026-01-01T00:00:06.000Z'),
    event('score', 'score_computed', 'ok', {
      scoreBasisPoints: 7142,
      totalWeight: 7,
      mustHavesMet: 1,
      mustHavesTotal: 2,
      mustHavesUnclear: 0,
      contributions: [
        { requirementId: REQ_NODE, weightApplied: 3, verdict: 'met', contributionBasisPoints: 4285 },
        { requirementId: REQ_PG, weightApplied: 2, verdict: 'not_met', contributionBasisPoints: 0 },
      ],
    }, '2026-01-01T00:00:07.000Z'),
  ];
}

const REQUIREMENTS = [
  { requirementId: REQ_NODE, label: 'Node.js' },
  { requirementId: REQ_PG, label: 'PostgreSQL' },
] as never;

const DETAIL = {
  model: 'mock',
  scorePercent: '71%',
  mustHavesMet: 1,
  mustHavesTotal: 2,
  decision: null,
  requirements: REQUIREMENTS,
} as const;

const RANKED = { state: 'ready', rank: 4, position: 4, rankedCount: 4, total: 5 } as const;

function pipeline(overrides: Partial<PipelineInput> = {}): PipelineStage[] {
  return buildPipeline({ events: fullTrail(), detail: DETAIL, ranking: RANKED, ...overrides });
}
const byId = (stages: PipelineStage[], id: string): PipelineStage => stages.find((s) => s.id === id) as PipelineStage;

// ================================================================ the pipeline

test('the pipeline is the eight stages, in order, with the labels the task names', () => {
  assert.deepEqual(
    PIPELINE_STAGES.map((s) => s.label),
    ['Ingest', 'Redaction', 'Extraction', 'Evidence verification', 'Matching', 'Scoring', 'Ranking', 'Recruiter decision'],
  );
  assert.deepEqual(pipeline().map((s) => s.id), PIPELINE_STAGES.map((s) => s.id));
});

test('every stage an event was recorded for is "Recorded", with that event\'s own time', () => {
  const stages = pipeline();
  const times: Record<string, string> = {
    ingest: '2026-01-01T00:00:01.000Z',
    redact: '2026-01-01T00:00:02.000Z',
    extract: '2026-01-01T00:00:05.000Z',
    verify: '2026-01-01T00:00:04.000Z',
    match: '2026-01-01T00:00:06.000Z',
    score: '2026-01-01T00:00:07.000Z',
  };
  for (const [id, at] of Object.entries(times)) {
    const stage = byId(stages, id);
    assert.equal(stage.status, 'recorded', id);
    assert.equal(stage.statusLabel, 'Recorded');
    assert.equal(stage.at, at, `${id}: the time is not the stored one`);
  }
});

test('the stage explanations say what the task says, and only that', () => {
  const stages = pipeline();
  assert.equal(byId(stages, 'ingest').explanation, 'Resume text entered the evaluation pipeline.');
  assert.equal(byId(stages, 'redact').explanation, 'Personal identifiers were masked before anything read the resume.');
  assert.equal(byId(stages, 'verify').explanation, 'Evidence was checked against the resume text.');
  assert.equal(byId(stages, 'match').explanation, 'Each job requirement was evaluated using deterministic rules.');
  assert.equal(byId(stages, 'score').explanation, 'Requirement outcomes and weights produced the candidate score.');
  assert.match(byId(stages, 'rank').explanation, /^Candidates were ordered using the deterministic ranking rules\./);
});

test('facts are read from the events, not assumed', () => {
  const stages = pipeline();
  assert.deepEqual(byId(stages, 'ingest').facts, ['523 characters stored']);
  assert.deepEqual(byId(stages, 'redact').facts, [
    '7 details masked',
    'Categories: address, contact, protected thing',
    'Only the category and position are recorded, never the value',
  ]);
  assert.deepEqual(byId(stages, 'verify').facts, ['3 passages found in the resume exactly as quoted']);
  assert.deepEqual(byId(stages, 'match').facts, ['2 requirements judged against 3 verified passages']);
  assert.deepEqual(byId(stages, 'score').facts, ['Score: 71%', 'Essential requirements met: 1 of 2']);
  assert.deepEqual(byId(stages, 'extract').facts, ['Read against 3 requirements']);
});

test('the deterministic stand-in is called what it is, and a real model is not described as one', () => {
  const standIn = byId(pipeline(), 'extract');
  assert.match(standIn.explanation, /^Deterministic demo extraction:/);
  assert.match(standIn.explanation, /fixed keyword matcher/);
  assert.match(standIn.explanation, /no language model was used/);

  const trail = fullTrail().map((e) =>
    e.eventType === 'extraction_recorded' ? { ...e, actorId: 'some-real-model', payload: { model: 'some-real-model', requirements: 3 } } : e,
  );
  const real = byId(pipeline({ events: trail, detail: { ...DETAIL, model: 'some-real-model' } }), 'extract');
  assert.doesNotMatch(real.explanation, /keyword matcher|no language model/);
  assert.equal(real.explanation, 'Candidate passages were proposed from the redacted resume.');
});

// ============================================================ missing stages

test('a stage with no event is "Not run" — never drawn as done, and given no time', () => {
  // A candidate whose assessment was queued: ingested and redacted, nothing more.
  const queued = fullTrail().filter((e) => e.stage === 'ingest' || e.stage === 'redact' || e.eventType === 'evaluation_opened');
  const stages = pipeline({ events: queued, detail: { ...DETAIL, model: null, scorePercent: null, mustHavesMet: null, mustHavesTotal: null } });

  for (const id of ['extract', 'verify', 'match', 'score']) {
    const stage = byId(stages, id);
    assert.equal(stage.status, 'not_run', id);
    assert.equal(stage.statusLabel, 'Not run');
    assert.equal(stage.at, null, `${id} was given a timestamp it never had`);
    assert.deepEqual(stage.facts, [], `${id} was given facts it never had`);
  }
  assert.equal(byId(stages, 'ingest').status, 'recorded');
  assert.equal(byId(stages, 'redact').status, 'recorded');
});

test('opening an evaluation is not extraction, even though it is filed under that stage', () => {
  const onlyOpened = [event('extract', 'evaluation_opened', 'ok', {}, '2026-01-01T00:00:01.000Z', { actor: 'human' })];
  const stage = byId(pipeline({ events: onlyOpened }), 'extract');
  assert.equal(stage.status, 'not_run');
  assert.equal(stage.at, null);
});

test('no events at all is "Unavailable" — not knowing is not the same as not having run', () => {
  const stages = pipeline({ events: null });
  for (const id of ['ingest', 'redact', 'extract', 'verify', 'match', 'score']) {
    assert.equal(byId(stages, id).status, 'unavailable', id);
    assert.equal(byId(stages, id).statusLabel, 'Unavailable');
    assert.equal(byId(stages, id).at, null);
  }
  // Ranking and the decision do not depend on the events, so they are still reported.
  assert.equal(byId(stages, 'rank').status, 'derived');
  assert.equal(byId(stages, 'decide').status, 'unavailable', 'no events and no decision: it cannot be said');
});

test('a ranking that could not be read is "Unavailable", not a guess at a position', () => {
  const rank = byId(pipeline({ ranking: { state: 'unavailable' } }), 'rank');
  assert.equal(rank.status, 'unavailable');
  assert.deepEqual(rank.facts, []);
  assert.doesNotMatch(rank.explanation, /Rank \d/);
});

test('ranking is "Derived on read": it says so, has no timestamp, and reports the live position', () => {
  const rank = byId(pipeline(), 'rank');
  assert.equal(rank.status, 'derived');
  assert.equal(rank.statusLabel, 'Derived on read');
  assert.equal(rank.at, null);
  assert.match(rank.explanation, /not stored as an event/);
  assert.deepEqual(rank.facts, ['Rank 4 of 4 ranked', '5 candidates listed in all']);

  const unranked = byId(pipeline({ ranking: { state: 'ready', rank: null, position: null, rankedCount: 4, total: 5 } }), 'rank');
  assert.deepEqual(unranked.facts, ['Not ranked: this candidate has no score yet', '5 candidates listed in all']);
});

// ============================================================ warnings and failures

test('a blocked event is a warning, in words, and says what was blocked', () => {
  const trail = [
    ...fullTrail(),
    event('verify', 'unverifiable_evidence_rejected', 'blocked', { reasons: ['not_found_in_resume', 'quotes_redacted_text', 'something_new'] }, '2026-01-01T00:00:04.500Z'),
  ].map((e) => (e.eventType === 'evidence_verified' ? { ...e, payload: { verified: 2, rejected: 3, malformed: 0, offsetsCorrected: 0 } } : e));

  const verify = byId(pipeline({ events: trail }), 'verify');
  assert.equal(verify.status, 'warning');
  assert.equal(verify.statusLabel, 'Recorded, with a warning');
  assert.ok(verify.facts.includes('3 passages rejected and never counted'));
  const why = verify.facts.find((f) => f.startsWith('Why:')) ?? '';
  assert.match(why, /not found in the resume/);
  assert.match(why, /overlapped a masked personal detail/);
  assert.match(why, /could not be verified/, 'an unknown reason is described, not echoed');
  assert.doesNotMatch(why, /something_new/);
});

test('a failed extraction is a failure, and does not claim evidence was gathered', () => {
  const trail = fullTrail()
    .filter((e) => !['extraction_recorded', 'evidence_verified', 'requirements_matched', 'score_computed'].includes(e.eventType))
    .concat(event('extract', 'extraction_failed', 'failed', { provider: 'mock' }, '2026-01-01T00:00:05.000Z'));
  const extract = byId(pipeline({ events: trail }), 'extract');
  assert.equal(extract.status, 'failed');
  assert.equal(extract.statusLabel, 'Failed');
  assert.equal(extract.explanation, 'Extraction did not complete, so no evidence was gathered.');
});

test('a skipped duplicate ingest is still a recorded stage, and says nothing was written twice', () => {
  const trail = [event('ingest', 'resume_already_present', 'skipped', { candidateReference: 'demo-001' }, '2026-01-01T00:00:01.000Z')];
  const ingest = byId(pipeline({ events: trail }), 'ingest');
  assert.equal(ingest.status, 'recorded');
  assert.ok(ingest.facts.some((f) => /nothing was written twice/.test(f)));
});

// ================================================================== the decision

test('with no decision the last stage says so; with one it is recorded, at the event\'s own time', () => {
  assert.equal(byId(pipeline(), 'decide').status, 'not_run');
  assert.equal(byId(pipeline(), 'decide').explanation, 'No decision has been recorded for this candidate yet.');

  const decision = { outcome: 'shortlist', reason: 'A synthetic reason.', decidedBy: 'demo-visitor', decidedAt: '2026-10-04T12:00:00.000Z' };
  const trail = [...fullTrail(), event('decide', 'decision_recorded', 'ok', { outcome: 'shortlist', reason: 'A synthetic reason.' }, '2026-10-04T12:00:00.500Z', { actor: 'human', actorId: 'demo-visitor' })];
  const decide = byId(pipeline({ events: trail, detail: { ...DETAIL, decision } }), 'decide');

  assert.equal(decide.status, 'recorded');
  assert.equal(decide.explanation, 'Demo recruiter decision recorded in this private demo session.');
  assert.equal(decide.at, '2026-10-04T12:00:00.500Z');
  assert.deepEqual(decide.facts, ['Outcome: Advance']);

  // If the trail is not available the decision is still known from the evaluation.
  assert.equal(byId(pipeline({ events: null, detail: { ...DETAIL, decision } }), 'decide').at, decision.decidedAt);
});

// ================================================================== robustness

test('garbage in a payload is ignored, not rendered: no NaN, no undefined, no throw', () => {
  const junk = [
    event('ingest', 'resume_ingested', 'ok', { charCount: 'lots' }, '2026-01-01T00:00:01.000Z'),
    event('redact', 'sensitive_attributes_masked', 'ok', { count: -3, categories: 'all of them' }, '2026-01-01T00:00:02.000Z'),
    event('verify', 'evidence_verified', 'ok', { verified: null, rejected: {}, malformed: [] }, '2026-01-01T00:00:03.000Z'),
    event('match', 'requirements_matched', 'ok', { verdicts: 'none', evidenceCounted: 1.5 }, '2026-01-01T00:00:04.000Z'),
    event('score', 'score_computed', 'ok', null as never, '2026-01-01T00:00:05.000Z'),
  ];
  assert.doesNotThrow(() => pipeline({ events: junk }));
  // The words a visitor would read — not the JSON, in which `null` is a legitimate "no time".
  const read = [
    ...pipeline({ events: junk }).flatMap((stage) => [stage.explanation, stage.statusLabel, ...stage.facts]),
    ...buildTimeline(junk, DETAIL).flatMap((item) => [item.title, ...item.details.flatMap((d) => [d.label, d.value])]),
  ].join('\n');
  assert.ok(read.length > 100, 'precondition: there is text to check');
  assert.doesNotMatch(read, /NaN|undefined|null|\[object|Infinity/);
  assert.doesNotThrow(() => buildTimeline(junk, DETAIL));
});

test('no stage mentions a database id, even when the payloads are full of them', () => {
  const text = JSON.stringify(pipeline());
  assert.doesNotMatch(text, UUID);
  for (const id of [REQ_NODE, REQ_PG, JOB]) assert.ok(!text.includes(id));
});

test('every status has a word, and the word is what the stage carries', () => {
  for (const [status, label] of Object.entries(STATUS_LABEL)) assert.ok(label.length > 3, status);
  for (const stage of pipeline()) assert.equal(stage.statusLabel, STATUS_LABEL[stage.status]);
});

// ================================================================== the timeline

test('the timeline is in recorded order: by stored time, then sequence, then arrival', () => {
  const a = event('ingest', 'resume_ingested', 'ok', {}, '2026-01-01T00:00:03.000Z');
  const b = event('redact', 'sensitive_attributes_masked', 'ok', {}, '2026-01-01T00:00:01.000Z');
  const c = event('match', 'requirements_matched', 'ok', {}, '2026-01-01T00:00:02.000Z');
  const sameTime1 = event('score', 'score_computed', 'ok', {}, '2026-01-01T00:00:09.000Z', { sequence: 5 });
  const sameTime2 = event('verify', 'evidence_verified', 'ok', {}, '2026-01-01T00:00:09.000Z', { sequence: 2 });
  const tieA = event('extract', 'extraction_recorded', 'ok', {}, '2026-01-01T00:00:10.000Z', { sequence: 7 });
  const tieB = event('extract', 'malformed_findings_dropped', 'blocked', {}, '2026-01-01T00:00:10.000Z', { sequence: 7 });

  const input = [a, sameTime1, b, tieA, c, tieB, sameTime2];
  const snapshot = JSON.stringify(input);
  const sorted = sortTrail(input);

  assert.deepEqual(sorted.map((e) => e.eventType), [
    'sensitive_attributes_masked',
    'requirements_matched',
    'resume_ingested',
    'evidence_verified',
    'score_computed',
    'extraction_recorded',
    'malformed_findings_dropped',
  ]);
  assert.equal(JSON.stringify(input), snapshot, 'the input was reordered in place');
  assert.deepEqual(buildTimeline(input, DETAIL).map((t) => t.key), sorted.map((_, i) => `event-${i}`));
});

test('each item keeps the stored time and the server\'s own sentence, and gains a stage name', () => {
  const items = buildTimeline(fullTrail(), DETAIL);
  assert.equal(items.length, fullTrail().length, 'an event was added or dropped');

  const ingest = items[0];
  assert.equal(ingest?.at, '2026-01-01T00:00:01.000Z');
  assert.equal(ingest?.title, 'Stored a 523-character resume for demo-001.');
  assert.equal(ingest?.stageLabel, 'Ingest');

  assert.equal(items.find((i) => i.stage === 'extract' && i.title.includes('evaluation_opened'))?.stageLabel, 'Evaluation');
  const times = items.map((i) => i.at);
  assert.deepEqual(times, [...times].sort(), 'the times are not ascending');
});

test('an actor is named only where it means something', () => {
  const items = buildTimeline(
    [
      ...fullTrail(),
      event('decide', 'decision_recorded', 'ok', { outcome: 'hold', reason: 'Synthetic reason.' }, '2026-10-04T12:00:00.000Z', { actor: 'human', actorId: 'demo-visitor' }),
    ],
    DETAIL,
  );
  const actors = items.filter((i) => i.actor !== null).map((i) => [i.title.split(' ')[0], i.actor]);
  assert.deepEqual(actors, [
    ['extraction_recorded', 'Deterministic demo extraction (no AI model)'],
    ['Demo', 'Demo recruiter'],
  ]);
});

test('anything other than a plain success says so in a word', () => {
  const items = buildTimeline(
    [
      event('verify', 'unverifiable_evidence_rejected', 'blocked', {}, '2026-01-01T00:00:01.000Z'),
      event('extract', 'extraction_failed', 'failed', {}, '2026-01-01T00:00:02.000Z'),
      event('ingest', 'resume_already_present', 'skipped', {}, '2026-01-01T00:00:03.000Z'),
      event('score', 'score_computed', 'ok', {}, '2026-01-01T00:00:04.000Z'),
    ],
    DETAIL,
  );
  assert.deepEqual(items.map((i) => i.outcome), ['Warning', 'Failed', 'Skipped', null]);
});

test('the payload\'s arithmetic is laid out for the score, with requirement names and no ids', () => {
  const score = buildTimeline(fullTrail(), DETAIL).find((i) => i.stage === 'score');
  const lines = Object.fromEntries((score?.details ?? []).map((d) => [d.label, d.value]));

  assert.equal(lines['Node.js'], 'weight 3 · met · 4,285 points');
  assert.equal(lines['PostgreSQL'], 'weight 2 · does not meet · 0 points');
  assert.equal(lines['Total weight'], '7');
  assert.equal(lines['Score'], '7,142 of 10,000 points');
  assert.equal(lines['Essential requirements met'], '1 of 2');
  assert.equal('Essential requirements not demonstrated' in lines, false, 'a zero is not worth a line');
  assert.doesNotMatch(JSON.stringify(score), UUID);
});

test('a requirement the detail does not know is numbered, never shown by id', () => {
  const stranger = event('score', 'score_computed', 'ok', {
    contributions: [{ requirementId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', weightApplied: 1, verdict: 'met', contributionBasisPoints: 10000 }],
    scoreBasisPoints: 10000,
  }, '2026-01-01T00:00:01.000Z');
  const [item] = buildTimeline([stranger], DETAIL);
  assert.equal(item?.details[0]?.label, 'Requirement 1');
  assert.doesNotMatch(JSON.stringify(item), UUID);
});

test('matching shows each verdict in the product\'s words, with its confidence', () => {
  const match = buildTimeline(fullTrail(), DETAIL).find((i) => i.stage === 'match');
  const lines = Object.fromEntries((match?.details ?? []).map((d) => [d.label, d.value]));
  assert.equal(lines['Node.js'], 'Met (confidence: high)');
  assert.equal(lines['PostgreSQL'], 'Does not meet (confidence: low)');
  assert.equal(lines['Verified passages counted'], '3');
});

test('evidence verification and redaction show their counts, and redaction records no value', () => {
  const items = buildTimeline(fullTrail(), DETAIL);
  const verify = Object.fromEntries((items.find((i) => i.stage === 'verify')?.details ?? []).map((d) => [d.label, d.value]));
  assert.deepEqual(verify, { 'Verified against the resume': '3', Rejected: '0', Malformed: '0', 'Offsets corrected': '0' });

  const redact = items.find((i) => i.stage === 'redact')?.details ?? [];
  assert.deepEqual(redact.map((d) => d.label), ['Details masked', 'Categories', 'Values recorded']);
  assert.match(redact.find((d) => d.label === 'Values recorded')?.value ?? '', /^None/);
});

test('a payload is never dumped: unknown events show no details, and unknown fields never appear', () => {
  const odd = event('system', 'something_new', 'ok', { secret: 'do-not-show', jobId: JOB, nested: { a: 1 } }, '2026-01-01T00:00:01.000Z');
  const withExtras = event('ingest', 'resume_ingested', 'ok', { charCount: 10, secret: 'do-not-show', candidateId: JOB }, '2026-01-01T00:00:02.000Z');
  const items = buildTimeline([odd, withExtras], DETAIL);

  assert.deepEqual(items[0]?.details, []);
  assert.deepEqual(items[1]?.details, [{ label: 'Characters stored', value: '10' }]);
  const text = JSON.stringify(items);
  assert.ok(!text.includes('do-not-show') && !text.includes(JOB));
});

test('a demo decision is the final event, named as one, and says it affects only this session', () => {
  const trail = [
    ...fullTrail(),
    event('decide', 'decision_recorded', 'ok', { outcome: 'shortlist', reason: 'Strong evidence on both essentials.', scoreBasisPoints: 7142 }, '2026-10-04T12:00:00.000Z', {
      actor: 'human',
      actorId: 'demo-visitor',
      summary: 'Recorded a decision of "shortlist" for this candidate.',
    }),
  ];
  const items = buildTimeline(trail, DETAIL);
  const last = items.at(-1);

  assert.equal(last?.isDecision, true, 'the decision is not the last event');
  assert.equal(items.filter((i) => i.isDecision).length, 1);
  assert.equal(last?.title, 'Demo recruiter decision: Advance', 'the raw outcome word must not reach the screen');
  assert.equal(last?.actor, 'Demo recruiter');
  assert.equal(last?.stageLabel, 'Recruiter decision');

  const lines = Object.fromEntries((last?.details ?? []).map((d) => [d.label, d.value]));
  assert.equal(lines['Outcome'], 'Advance');
  assert.equal(lines['Reason'], 'Strong evidence on both essentials.');
  assert.match(lines['Recorded by'] ?? '', /Demo recruiter \(demo-visitor\)/);
  assert.match(lines['Recorded by'] ?? '', /not a real recruiter/);
  assert.match(lines['Scope'] ?? '', /only in your private demo session/);
  assert.match(lines['Scope'] ?? '', /no real recruiter record/);
});

test('with no decision there is no decision event, and nothing is invented to stand in for one', () => {
  const items = buildTimeline(fullTrail(), DETAIL);
  assert.equal(items.some((i) => i.isDecision), false);
  assert.ok(!items.some((i) => /decision/i.test(i.title)));
});

test('timestamps are never invented: every item\'s time is the stored time of one event', () => {
  const trail = fullTrail();
  const stored = new Set(trail.map((e) => e.createdAt));
  for (const item of buildTimeline(trail, DETAIL)) assert.ok(stored.has(item.at), item.at);
  for (const stage of pipeline()) assert.ok(stage.at === null || stored.has(stage.at), String(stage.at));
});
