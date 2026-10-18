import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isHit,
  locatePassage,
  overlapChars,
  passageMetrics,
  summarise,
  tierAgreement,
  tierOfVerdicts,
  verdictAgreement,
  verdictFromQuotes,
  type PairRecord,
} from '../scripts/evalMetrics.ts';
import type { JobRequirement } from '../src/domain/ats.ts';

// The evaluation harness's measures, on small hand-made cases. No model, no key.

const span = (start: number, end: number) => ({ start, end });

function requirement(id: string, kind: 'must_have' | 'nice_to_have', criterion: string): JobRequirement {
  return { id, jobId: 'job', label: id, criterion, kind, weight: 1, position: 0, createdAt: '' } as unknown as JobRequirement;
}

test('overlap and the two hit rules', () => {
  assert.equal(overlapChars(span(0, 10), span(5, 20)), 5);
  assert.equal(overlapChars(span(0, 5), span(5, 9)), 0);
  // half: the overlap must be at least half of the SHORTER range
  assert.equal(isHit(span(0, 100), span(40, 60), 'half'), true); // the short one is wholly inside
  assert.equal(isHit(span(0, 20), span(15, 100), 'half'), false); // 5 of 20
  assert.equal(isHit(span(0, 20), span(10, 100), 'half'), true); // 10 of 20
  assert.equal(isHit(span(0, 20), span(15, 100), 'any'), true);
  assert.equal(isHit(span(0, 5), span(5, 9), 'any'), false);
});

test('a gold passage is found exactly, across line breaks, and across look-alike punctuation', () => {
  const text = 'Led the team.\nShipped “Node.js” services — in production… every day.';
  assert.deepEqual(locatePassage('Led the team.', text), span(0, 13));
  assert.deepEqual(locatePassage('team. Shipped', text), span(8, 21));
  const found = locatePassage('Shipped "Node.js" services - in production... every day.', text);
  assert.ok(found);
  assert.equal(text.slice(found.start, found.end), 'Shipped “Node.js” services — in production… every day.');
  assert.equal(locatePassage('not in the text at all', text), null);
});

test('recall and precision count a verified passage for a requirement with no gold passage as a miss', () => {
  const pairs: PairRecord[] = [
    // one gold passage, found
    { cvId: 'a', requirementId: 'r1', goldVerdict: 'met', goldSpans: [span(0, 40)], verifiedSpans: [span(5, 35)] },
    // two gold passages, one found; plus a stray verified passage
    { cvId: 'a', requirementId: 'r2', goldVerdict: 'met', goldSpans: [span(100, 140), span(200, 240)], verifiedSpans: [span(100, 140), span(300, 340)] },
    // silent in the labels (unclear, no gold) but the system verified something
    { cvId: 'a', requirementId: 'r3', goldVerdict: 'unclear', goldSpans: [], verifiedSpans: [span(400, 440)] },
    // gold passage, nothing verified
    { cvId: 'b', requirementId: 'r1', goldVerdict: 'partial', goldSpans: [span(0, 30)], verifiedSpans: [] },
  ];
  const result = passageMetrics(pairs, 'half');
  assert.equal(result.goldPassages, 4);
  assert.equal(result.goldPassagesHit, 2);
  assert.equal(result.recall, 0.5);
  assert.equal(result.verifiedPassages, 4);
  assert.equal(result.verifiedPassagesHit, 2);
  assert.equal(result.precision, 0.5);
  assert.equal(result.requirementsWithGold, 3);
  assert.equal(result.requirementsWithGoldHit, 2);
});

test('passages for another requirement or another CV never count as hits', () => {
  const pairs: PairRecord[] = [
    { cvId: 'a', requirementId: 'r1', goldVerdict: 'met', goldSpans: [span(0, 40)], verifiedSpans: [] },
    { cvId: 'a', requirementId: 'r2', goldVerdict: 'unclear', goldSpans: [], verifiedSpans: [span(0, 40)] },
  ];
  const result = passageMetrics(pairs, 'any');
  assert.equal(result.recall, 0);
  assert.equal(result.precision, 0);
});

test('empty denominators are null, not zero or NaN', () => {
  const none = passageMetrics([{ cvId: 'a', requirementId: 'r', goldVerdict: 'unclear', goldSpans: [], verifiedSpans: [] }], 'half');
  assert.equal(none.recall, null);
  assert.equal(none.precision, null);
  assert.equal(verdictAgreement([]).rate, null);
  assert.equal(tierAgreement([]).rate, null);
});

test('verdict agreement counts exact matches and says which way the misses go', () => {
  const result = verdictAgreement([
    { gold: 'met', predicted: 'met' },
    { gold: 'met', predicted: 'not_met' }, // lower
    { gold: 'partial', predicted: 'met' }, // higher
    { gold: 'unclear', predicted: 'unclear' },
  ]);
  assert.equal(result.agree, 2);
  assert.equal(result.rate, 0.5);
  assert.equal(result.higherThanGold, 1);
  assert.equal(result.lowerThanGold, 1);
  assert.equal(result.confusion.met.not_met, 1);
  assert.equal(result.confusion.partial.met, 1);
});

test('tiers follow the application rule: all must-haves met, a failed one, or only silent ones', () => {
  const requirements = [requirement('a', 'must_have', 'Node.js'), requirement('b', 'must_have', 'PostgreSQL'), requirement('c', 'nice_to_have', 'mentoring')];
  const tier = (a: string, b: string, c: string) =>
    tierOfVerdicts(requirements, new Map([['a', a], ['b', b], ['c', c]] as Array<[string, never]>));
  assert.equal(tier('met', 'met', 'not_met'), 'qualified'); // a nice-to-have never gates
  assert.equal(tier('met', 'partial', 'met'), 'gated'); // found and not enough
  assert.equal(tier('met', 'unclear', 'met'), 'needs_review'); // the CV was silent
  assert.equal(tier('not_met', 'unclear', 'met'), 'gated'); // the stronger signal decides
  assert.deepEqual(tierAgreement([{ gold: 'gated', predicted: 'gated' }, { gold: 'qualified', predicted: 'gated' }]), { cvs: 2, agree: 1, rate: 0.5 });
});

test('a verdict from quotes uses the chosen match mode', () => {
  const node = requirement('n', 'must_have', 'Has run services');
  const quotes = ['Running services every day'];
  assert.equal(verdictFromQuotes(node, quotes, 'strict'), 'partial'); // "services" only, 1 of 2
  assert.equal(verdictFromQuotes(node, quotes, 'folded'), 'met'); // "Running" meets "run"
  assert.equal(verdictFromQuotes(node, [], 'strict'), 'unclear');
});

test('summaries of latency and cost', () => {
  assert.deepEqual(summarise([]), { count: 0, mean: null, median: null, max: null, total: 0 });
  assert.deepEqual(summarise([3, 1, 2]), { count: 3, mean: 2, median: 2, max: 3, total: 6 });
  assert.equal(summarise([1, 2, 3, 10]).median, 2.5);
});
