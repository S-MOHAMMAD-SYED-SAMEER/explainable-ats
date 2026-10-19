import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MATCH_MODE,
  MATCH_MODES,
  containsTerm,
  decideMatch,
  foldWord,
  significantTerms,
  wordsOf,
  type EvidenceLike,
} from '../src/agent/matchRules.ts';
import { scoreEvaluation } from '../src/agent/score.ts';
import { createDeterministicExtractor } from '../src/agent/mockExtractor.ts';
import { buildSystemPrompt, buildUserMessage } from '../src/agent/extractionPrompt.ts';
import { EXTRACTION_PROMPT_VERSION, EXTRACTION_TOOL } from '../src/agent/extractionSchema.ts';
import { loadConfig } from '../src/config/env.ts';
import { loadDataset, loadCvText } from '../scripts/evalLabels.ts';
import type { JobRequirement } from '../src/domain/ats.ts';

// The two ways of comparing words, side by side.
//
//   strict   the default: a term counts only as a whole word.
//   folded   plural -s/-es, -ing and -ed endings are folded first.
//
// Neither is "right". They trade precision for recall, and the evaluation set is what
// decides which should be the default. These tests pin what each one DOES, so that the
// choice is made on the evaluation rather than by accident, and so that a change to
// either is a decision.

function requirement(label: string, criterion: string): Pick<JobRequirement, 'id' | 'label' | 'criterion'> {
  return { id: 'req-1', label, criterion };
}

function quote(text: string): EvidenceLike {
  return { requirementId: 'req-1', quote: text, verified: true };
}

// --- the fold --------------------------------------------------------------------------------

test('words that should meet fold to the same thing', () => {
  const families = [
    ['run', 'running', 'runs'],
    ['service', 'services'],
    ['mentor', 'mentors', 'mentored', 'mentoring'],
    ['ship', 'ships', 'shipped', 'shipping'],
    ['design', 'designs', 'designed', 'designing'],
    ['scale', 'scales', 'scaled', 'scaling'],
    ['query', 'queries'],
    ['engineer', 'engineers'],
    ['pipeline', 'pipelines'],
    ['cache', 'caches', 'cached', 'caching'],
    ['database', 'databases'],
    ['process', 'processes'],
    ['migration', 'migrations'],
    ['build', 'builds'],
  ];
  for (const family of families) {
    const folded = new Set(family.map(foldWord));
    assert.equal(folded.size, 1, `${family.join(', ')} folded to ${[...folded].join(' / ')}`);
  }
});

test('words that are different words stay different', () => {
  const apart = [
    ['java', 'javascript'],
    ['mentor', 'mentorship'],
    ['process', 'processor'],
    ['data', 'database'],
    ['postgres', 'postgresql'],
    ['node', 'node.js'],
    ['analysis', 'analyst'],
    ['business', 'busines'],
  ];
  for (const [a, b] of apart) assert.notEqual(foldWord(a as string), foldWord(b as string), `${a} and ${b} must not meet`);
});

test('KNOWN COST OF -ing FOLDING: a noun ending in -ing meets its stem', () => {
  // "engineering" folds to "engineer", "marketing" to "market", "building" to "build". It is the price of
  // folding the verb form, and it is why folding is a setting that the evaluation has to justify.
  for (const [noun, stem] of [['engineering', 'engineer'], ['marketing', 'market'], ['building', 'build'], ['reporting', 'report']]) {
    assert.equal(foldWord(noun as string), foldWord(stem as string), `${noun} and ${stem}`);
  }
});

test('anything with a digit, dot, plus or hash, and anything under four letters, is left exactly as it is', () => {
  for (const word of ['node.js', 'c++', 'c#', 'k8s', 'es2022', 'a', 'run', 'ran', 'bus', 'css', 'aws', 'sql', 'us', 'gos']) {
    assert.equal(foldWord(word), word);
  }
  // Endings that look like plurals but are not.
  for (const word of ['address', 'class', 'status', 'analysis', 'process']) assert.equal(foldWord(word), foldWord(foldWord(word)));
  assert.equal(foldWord('address'), 'address');
  assert.equal(foldWord('status'), 'status');
});

test('folding is deterministic, and folding twice is folding once for the words that matter', () => {
  for (const word of ['running', 'services', 'mentored', 'designing', 'queries', 'shipped', 'scaling']) {
    assert.equal(foldWord(word), foldWord(word));
    assert.equal(foldWord(foldWord(word)), foldWord(word), word);
  }
});

// --- the words of a text ------------------------------------------------------------------------

test('strict is the default everywhere a mode can be omitted', () => {
  assert.equal(DEFAULT_MATCH_MODE, 'strict');
  assert.deepEqual([...MATCH_MODES], ['strict', 'folded']);
  assert.ok(wordsOf('Running services').has('running'));
  assert.ok(!wordsOf('Running services').has('run'));
  assert.ok(wordsOf('Running services', 'folded').has('run'));
  assert.ok(containsTerm(wordsOf('Running services'), 'running'));
  assert.ok(!containsTerm(wordsOf('Running services'), 'run'));
  assert.ok(containsTerm(wordsOf('Running services', 'folded'), 'run', 'folded'));
  assert.ok(containsTerm(wordsOf('Runs a service', 'folded'), 'services', 'folded'), 'the term is folded too');
});

test('every term strict finds, folded finds too: folding can only add matches', () => {
  const dataset = loadDataset();
  const terms = new Set<string>();
  for (const role of Object.values(dataset.roles)) {
    for (const item of role.requirements) for (const term of significantTerms(`${item.label} ${item.criterion}`)) terms.add(term);
  }
  assert.ok(terms.size > 15, 'precondition: the evaluation roles have terms to test with');

  let strictHits = 0;
  let foldedOnly = 0;
  for (const cv of dataset.cvs) {
    const text = loadCvText(cv);
    const strict = wordsOf(text, 'strict');
    const folded = wordsOf(text, 'folded');
    for (const term of terms) {
      const inStrict = containsTerm(strict, term, 'strict');
      const inFolded = containsTerm(folded, term, 'folded');
      if (inStrict) {
        strictHits += 1;
        assert.ok(inFolded, `${cv.id}: "${term}" is a whole word but is lost when folded`);
      } else if (inFolded) foldedOnly += 1;
    }
  }
  // And folding does something on real text, so the comparison above is not vacuous.
  assert.ok(strictHits > 20);
  assert.ok(foldedOnly > 5, `folded found only ${foldedOnly} terms strict missed`);
});

// --- verdicts in each mode ---------------------------------------------------------------------------

test('"Running PostgreSQL at scale" against "Has run PostgreSQL at scale": partial when strict, met when folded', () => {
  const postgres = requirement('PostgreSQL', 'Has run PostgreSQL at scale');
  const evidence = [quote('Running PostgreSQL at scale for a multi-tenant billing system.')];

  const strict = decideMatch(postgres, evidence);
  assert.equal(strict.verdict, 'partial');
  assert.deepEqual(strict.missingTerms, ['run']);
  assert.deepEqual(decideMatch(postgres, evidence, 'strict'), strict, 'strict is what you get by omitting the mode');

  const folded = decideMatch(postgres, evidence, 'folded');
  assert.equal(folded.verdict, 'met');
  assert.deepEqual(folded.missingTerms, []);
  assert.deepEqual(folded.matchedTerms, ['postgresql', 'run', 'scale'], 'the terms reported are the requirement\'s own words');
});

test('"service" against "services": a gap when strict, closed when folded', () => {
  const services = requirement('Services', 'Has shipped production services');
  const evidence = [quote('Shipped a production service for a freight platform.')];

  assert.deepEqual(decideMatch(services, evidence).missingTerms, ['services']);
  assert.deepEqual(decideMatch(services, evidence, 'folded').missingTerms, []);
});

test('folding does not turn Java into JavaScript, and does not understand negation or synonyms either', () => {
  const java = requirement('Java', 'Has built production Java applications');
  assert.ok(!decideMatch(java, [quote('Built production applications in JavaScript.')], 'folded').matchedTerms.includes('java'));

  const node = requirement('Node.js', 'Has designed and shipped production Node.js services');
  const affirmed = decideMatch(node, [quote('Designed and shipped production Node.js services.')], 'folded');
  const negated = decideMatch(node, [quote('Never designed or shipped production Node.js services.')], 'folded');
  assert.equal(negated.verdict, affirmed.verdict, 'negation is still not understood');

  const postgres = requirement('PostgreSQL', 'Has run PostgreSQL at scale');
  assert.ok(decideMatch(postgres, [quote('Ran the Postgres fleet at scale.')], 'folded').missingTerms.includes('postgresql'), 'Postgres is not PostgreSQL');
  assert.ok(decideMatch(postgres, [quote('Ran the Postgres fleet at scale.')], 'folded').missingTerms.includes('run'), '"ran" is not "run"');
});

test('KNOWN COST OF FOLDING: a shared stem can turn silence into a relevant-looking line', () => {
  // A job title, "Backend Engineer", shares a folded word with "engineers". The stand-in
  // extractor, which picks the line with the most matching words, quotes it for the
  // mentoring requirement, so a CV that says nothing about mentoring reads not_met instead
  // of unclear. Strict matching does not make this mistake. Whether folding is worth it
  // is decided by the evaluation, not by this example.
  const resume = ['Backend Engineer, Corvid Systems', 'Designed and shipped production Node.js services behind a payments API.'].join('\n');
  const message = buildUserMessage([{ id: 'r-m', label: 'Mentoring', criterion: 'Has mentored junior engineers' }] as unknown as JobRequirement[], resume);
  const request = {
    purpose: 'extract_evidence',
    promptVersion: EXTRACTION_PROMPT_VERSION,
    systemPrompt: buildSystemPrompt(),
    messages: [{ role: 'user' as const, content: message }],
    tool: EXTRACTION_TOOL,
    maxTokens: 1000,
  };

  const strictQuotes = (createDeterministicExtractor({ matchMode: 'strict' })(request).findings as unknown[]).length;
  const foldedQuotes = (createDeterministicExtractor({ matchMode: 'folded' })(request).findings as Array<{ quote: string }>);
  assert.equal(strictQuotes, 0);
  assert.equal(foldedQuotes.length, 1);
  assert.equal(foldedQuotes[0]?.quote, 'Backend Engineer, Corvid Systems');

  const mentoring = requirement('Mentoring', 'Has mentored junior engineers');
  assert.equal(decideMatch(mentoring, [quote('Backend Engineer, Corvid Systems')], 'folded').verdict, 'not_met');
});

// --- scoring ----------------------------------------------------------------------------------------

test('the score follows the mode, and omitting the mode is strict', () => {
  const requirements = [
    { id: 'a', jobId: 'j', label: 'PostgreSQL', criterion: 'Has run PostgreSQL at scale', kind: 'must_have', weight: 2, position: 0, createdAt: '' },
    { id: 'b', jobId: 'j', label: 'Mentoring', criterion: 'Has mentored junior engineers', kind: 'nice_to_have', weight: 2, position: 1, createdAt: '' },
  ] as unknown as JobRequirement[];
  const evidence: EvidenceLike[] = [
    { requirementId: 'a', quote: 'Running PostgreSQL at scale for a billing system.', verified: true },
    { requirementId: 'b', quote: 'Mentored a junior developer during onboarding.', verified: true },
  ];

  const byDefault = scoreEvaluation(requirements, evidence);
  const strict = scoreEvaluation(requirements, evidence, 'strict');
  const folded = scoreEvaluation(requirements, evidence, 'folded');

  assert.deepEqual(byDefault, strict);
  assert.deepEqual(strict.rows.map((row) => row.decision.verdict), ['partial', 'partial']);
  assert.deepEqual(folded.rows.map((row) => row.decision.verdict), ['met', 'met']);
  assert.ok(folded.scoreBasisPoints > strict.scoreBasisPoints);
  assert.equal(folded.scoreBasisPoints, 10000);
  // Either way the contributions add up to the score exactly.
  for (const breakdown of [strict, folded]) {
    assert.equal(breakdown.rows.reduce((sum, row) => sum + row.contributionBasisPoints, 0), breakdown.scoreBasisPoints);
  }
});

// --- the setting ------------------------------------------------------------------------------------------

test('MATCH_MODE is folded by default (the measured setup), strict on request, strict in the demo, and a bad value is reported and ignored', () => {
  assert.equal(loadConfig({}).config.matchMode, 'folded');
  assert.equal(loadConfig({ MATCH_MODE: 'folded' }).config.matchMode, 'folded');
  assert.equal(loadConfig({ MATCH_MODE: 'strict' }).config.matchMode, 'strict');
  // The demo's fixtures (and their copies in the portfolio sites) were recorded with the library default, so the demo keeps it.
  assert.equal(loadConfig({ APP_MODE: 'demo' }).config.matchMode, 'strict');

  const bad = loadConfig({ MATCH_MODE: 'fuzzy' });
  assert.equal(bad.config.matchMode, 'folded', 'a bad value falls back to the default');
  assert.ok(bad.problems.some((problem) => problem.includes('MATCH_MODE')));
});
