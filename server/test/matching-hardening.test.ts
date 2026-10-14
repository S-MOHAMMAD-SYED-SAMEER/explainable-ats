import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideMatch, wordsOf, type EvidenceLike } from '../src/agent/matchRules.ts';
import { MIN_QUOTE_CHARS, verifyEvidence } from '../src/agent/verifyEvidence.ts';
import { createDeterministicExtractor } from '../src/agent/mockExtractor.ts';
import { buildSystemPrompt, buildUserMessage } from '../src/agent/extractionPrompt.ts';
import { EXTRACTION_PROMPT_VERSION, EXTRACTION_TOOL, type RawFinding } from '../src/agent/extractionSchema.ts';
import { extractEvidence } from '../src/agent/extract.ts';
import { createTestContext } from './helpers.ts';
import { seedScenario } from './fixtures.ts';
import type { JobRequirement } from '../src/domain/ats.ts';

// Matching hardening: whole words, a minimum quote length, and the limits that remain.
//
// The last group of tests here PIN things the matcher does badly. They are written as
// passing tests on purpose: each states a documented limitation and fails the moment
// someone changes the behaviour, which is when the documentation needs to change with it.

function requirement(label: string, criterion: string): Pick<JobRequirement, 'id' | 'label' | 'criterion'> {
  return { id: 'req-1', label, criterion };
}

function quote(text: string): EvidenceLike {
  return { requirementId: 'req-1', quote: text, verified: true };
}

// --- whole words ------------------------------------------------------------------

test('"Java" is not found in "JavaScript"', () => {
  const java = requirement('Java', 'Has built production Java applications');

  const javascript = decideMatch(java, [quote('Built production applications in JavaScript and TypeScript.')]);
  assert.ok(!javascript.matchedTerms.includes('java'), 'substring matching would have counted java');
  assert.deepEqual(javascript.matchedTerms, ['applications', 'built', 'production']);

  const real = decideMatch(java, [quote('Built production Java applications for a bank.')]);
  assert.ok(real.matchedTerms.includes('java'));
  assert.equal(real.verdict, 'met');
});

test('"run" is not found in "running"', () => {
  const run = requirement('PostgreSQL', 'Has run PostgreSQL at scale');

  const running = decideMatch(run, [quote('Running PostgreSQL at scale for a billing system.')]);
  assert.ok(running.missingTerms.includes('run'), 'a word form is a different word');
  assert.equal(running.verdict, 'partial', '2 of 3 terms');

  const ran = decideMatch(run, [quote('Run PostgreSQL at scale for a billing system.')]);
  assert.equal(ran.verdict, 'met');
  assert.deepEqual(ran.missingTerms, []);
});

test('a term is found next to punctuation, and dotted and symbol terms are single words', () => {
  const node = requirement('Node.js', 'Has shipped Node.js services');
  const decision = decideMatch(node, [quote('Shipped services on Node.js. Also wrote C++ (and C#) tooling.')]);
  assert.deepEqual(decision.matchedTerms, ['node.js', 'services', 'shipped']);

  assert.ok(wordsOf('Wrote C++ and C# tooling.').has('c++'));
  assert.ok(wordsOf('Wrote C++ and C# tooling.').has('c#'));
  assert.ok(wordsOf('Ends a sentence with Node.js.').has('node.js'), 'the full stop is not part of the word');
  assert.ok(!wordsOf('Uses node.jsx components').has('node.js'), 'node.jsx is another word');
  assert.ok(!wordsOf('JavaScript').has('java'));
  assert.deepEqual([...wordsOf('Same same SAME')], ['same'], 'case is folded and words are unique');
});

test('words are separated by every non-word character, not only spaces', () => {
  const words = wordsOf('Node.js/Express, PostgreSQL;Redis (Kafka)\nDocker\tK8s');
  for (const expected of ['node.js', 'express', 'postgresql', 'redis', 'kafka', 'docker', 'k8s']) {
    assert.ok(words.has(expected), `missing ${expected}`);
  }
});

// --- the limits that remain, pinned -------------------------------------------------

test('KNOWN LIMITATION: a word form is a different term ("service" is not "services")', () => {
  const services = requirement('Services', 'Has shipped production services');
  const decision = decideMatch(services, [quote('Shipped a production service for a freight platform.')]);

  assert.ok(decision.missingTerms.includes('services'));
  assert.equal(decision.verdict, 'partial');
  // If this starts failing, someone added stemming. Update the README's limitations and
  // docs/ARCHITECTURE.md ("How matching decides a verdict") in the same change.
});

test('KNOWN LIMITATION: negation is not understood', () => {
  const node = requirement('Node.js', 'Has designed and shipped production Node.js services');

  const affirmed = decideMatch(node, [quote('Designed and shipped production Node.js services.')]);
  const negated = decideMatch(node, [quote('Never designed or shipped production Node.js services.')]);
  const notShipped = decideMatch(node, [quote('Has not shipped production Node.js services.')]);

  // The rules count which words appear. A sentence that says the opposite covers the
  // same words and is judged the same way.
  assert.equal(affirmed.verdict, 'met');
  assert.equal(negated.verdict, affirmed.verdict, 'negation changed nothing');
  assert.deepEqual(negated.matchedTerms, affirmed.matchedTerms);
  assert.equal(notShipped.verdict, 'met', 'four of five terms are present, and "not" is not one of them');
  assert.deepEqual(notShipped.missingTerms, ['designed']);
  assert.ok(!/never|not shipped/i.test(negated.rationale), 'the rationale says what was counted, nothing about meaning');
  // If this starts failing, someone added negation handling. Update the README's
  // limitations and docs/ARCHITECTURE.md in the same change.
});

test('KNOWN LIMITATION: a passage that lists the terms covers them', () => {
  const node = requirement('Node.js', 'Has designed and shipped production Node.js services');

  const stuffed = decideMatch(node, [quote('designed shipped production node.js services')]);
  assert.equal(stuffed.verdict, 'met');
  assert.deepEqual(stuffed.missingTerms, []);
  // What stops this being free is verification (the passage must be in the CV and long
  // enough to be a phrase), not matching. The stuffing study is part of the injection
  // tests; this pins that the matcher on its own cannot tell.
});

// --- minimum quote length ------------------------------------------------------------

function finding(quoteText: string, charStart: number): RawFinding {
  return { requirementId: 'req-1', quote: quoteText, charStart, charEnd: charStart + quoteText.length, reasoning: 'r' };
}

const CV = 'Skills: Node.js\nLed a Node.js team of five engineers through a migration.\nDocker, Kubernetes';

test('a quote shorter than the minimum is refused even though it really is in the CV', () => {
  const start = CV.indexOf('Node.js');
  const result = verifyEvidence([finding('Node.js', start)], { contentText: CV, redactionSpans: [] });

  assert.equal(result.verified.length, 0);
  assert.equal(result.rejected[0]?.reason, 'quote_too_short');
  assert.match(result.rejected[0]?.detail ?? '', /7 characters is too short/);
});

test('the minimum is exact: one character short is refused, the minimum itself is accepted', () => {
  const at = (text: string) => CV.indexOf(text);
  const exact = 'Led a Node.js t'; // 15 characters, a real stretch of the CV
  const shortOne = exact.slice(1); // 14
  assert.equal(shortOne.length, MIN_QUOTE_CHARS - 1);
  assert.equal(exact.length, MIN_QUOTE_CHARS);

  const refused = verifyEvidence([finding(shortOne, at(shortOne))], { contentText: CV, redactionSpans: [] });
  const accepted = verifyEvidence([finding(exact, at(exact))], { contentText: CV, redactionSpans: [] });

  assert.equal(refused.rejected[0]?.reason, 'quote_too_short');
  assert.equal(accepted.verified.length, 1);
});

test('length is measured after trimming and collapsing whitespace, so padding cannot buy a pass', () => {
  const padded = '   Node.js        Docker   ';
  const content = `Header\n${padded}\nFooter`;
  const result = verifyEvidence([finding(padded, content.indexOf(padded))], { contentText: content, redactionSpans: [] });

  // "Node.js Docker" is 14 characters, however much space surrounds it.
  assert.equal(result.rejected[0]?.reason, 'quote_too_short');
});

test('a short fabricated quote is reported as too short, and a long one still as not found', () => {
  const tooShort = verifyEvidence([finding('Rust', 0)], { contentText: CV, redactionSpans: [] });
  assert.equal(tooShort.rejected[0]?.reason, 'quote_too_short');

  const fabricated = verifyEvidence([finding('Designed a distributed ledger in Rust.', 0)], { contentText: CV, redactionSpans: [] });
  assert.equal(fabricated.rejected[0]?.reason, 'not_found_in_resume');
});

test('a quote of ordinary phrase length is still verified as before', () => {
  const sentence = 'Led a Node.js team of five engineers through a migration.';
  const result = verifyEvidence([finding(sentence, CV.indexOf(sentence))], { contentText: CV, redactionSpans: [] });
  assert.equal(result.verified.length, 1);
  assert.equal(result.verified[0]?.offsetsWereCorrect, true);
});

// --- the stand-in extractor agrees with both rules -------------------------------------

function promptFor(requirements: Array<{ id: string; label: string; criterion: string }>, resume: string) {
  return {
    purpose: 'extract_evidence',
    promptVersion: EXTRACTION_PROMPT_VERSION,
    systemPrompt: buildSystemPrompt(),
    messages: [{ role: 'user' as const, content: buildUserMessage(requirements as unknown as JobRequirement[], resume) }],
    tool: EXTRACTION_TOOL,
    maxTokens: 1000,
  };
}

test('the stand-in extractor never offers a quote the verifier has to turn away for length', () => {
  // The short line comes first and ties the long one on hits, so it would be chosen if length were ignored.
  const resume = ['Docker Node.js', 'Used Node.js in production for a retailer.'].join('\n');
  const respond = createDeterministicExtractor();
  const out = respond(promptFor([{ id: 'r1', label: 'Node.js', criterion: 'Has used Node.js Docker' }], resume));

  const quotes = (out.findings as Array<{ quote: string }>).map((entry) => entry.quote);
  assert.deepEqual(quotes, ['Used Node.js in production for a retailer.']);
  for (const text of quotes) assert.ok(text.length >= MIN_QUOTE_CHARS);
});

test('the stand-in extractor picks the line the matcher will credit: whole words only', () => {
  // By substring the JavaScript line (applications, java) would tie the Java line (built, java) and win
  // on position; by whole word it has one hit to the Java line's two.
  const resume = ['Wrote JavaScript applications for a media company.', 'Built Java tooling for a bank.'].join('\n');
  const respond = createDeterministicExtractor();
  const out = respond(promptFor([{ id: 'r1', label: 'Java', criterion: 'Has built Java applications' }], resume));

  const quotes = (out.findings as Array<{ quote: string }>).map((entry) => entry.quote);
  assert.deepEqual(quotes, ['Built Java tooling for a bank.']);
});

// --- through the pipeline -----------------------------------------------------------------

test('a too-short quote is stored unverified, audited with its reason, and never counted', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  const requirementId = scenario.requirements[0]?.id as string;
  const keyword = 'TypeScript';
  scenario.provider.register('extract_evidence', {
    findings: [
      { requirementId, quote: keyword, charStart: scenario.resume.contentText.indexOf(keyword), charEnd: scenario.resume.contentText.indexOf(keyword) + keyword.length, reasoning: 'keyword' },
    ],
  });

  const outcome = await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);
  assert.equal(outcome.verified, 0);
  assert.equal(outcome.rejected, 1);

  const all = await ctx.repos.evidence.listForEvaluation(scenario.evaluation.id);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.verified, false);
  assert.equal((await ctx.repos.evidence.listVerifiedForEvaluation(scenario.evaluation.id)).length, 0);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const rejection = events.find((event) => event.eventType === 'unverifiable_evidence_rejected');
  assert.deepEqual(rejection?.payload.reasons, ['quote_too_short']);
  assert.match(rejection?.summary ?? '', /too short to count/);
});
