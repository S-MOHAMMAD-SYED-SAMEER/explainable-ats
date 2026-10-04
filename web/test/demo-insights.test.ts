import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openingTags, stripComments } from './jsxScan.ts';
import { resolveApiPath } from '../src/demo/session.ts';

// The structure of the new demo sections (Phase 3C.4): the redacted resume, the
// pipeline and the timeline.
//
// NFR-9 rules out rendering components in tests, so this reads source for the
// conventions that make a screen usable — and checks that the recruiter's screens
// are the ones they were. (The logic is tested in demo-evidence.test.ts and
// demo-pipeline.test.ts; the rendered layout was checked in a real browser at 375,
// 768 and 1366px.)

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel: string): string => stripComments(read(rel));
const flat = (rel: string): string => code(rel).replace(/\s+/g, ' ');

const SECTIONS = ['components/ResumeEvidence.tsx', 'components/PipelineView.tsx', 'components/AuditTimeline.tsx'];
const ALL_NEW = [...SECTIONS, 'components/EvidenceText.ts', 'demo/evidence.ts', 'demo/pipeline.ts', 'demo/timeline.ts', 'demo/audit.ts'];
const DETAIL = () => code('screens/CandidateDetail.tsx');

const BANNED = /\bClaude\b|\bAnthropic\b|\bGemini\b|\bOpenAI\b|\bGPT\b|AI extraction|Live AI|By the model|powered by AI|AI-powered|machine learning/i;

// ============================================================ where it appears

test('the new sections are drawn only in a visitor\'s own session', () => {
  const source = DETAIL();

  for (const section of ['DemoPipelineSection', 'DemoResumeSection', 'DemoTimelineSection']) {
    const uses = [...source.matchAll(new RegExp(`<${section}\\b`, 'g'))];
    assert.equal(uses.length, 1, `${section} should be rendered exactly once`);
  }
  assert.match(source, /\{demoSession \? <DemoPipelineSection detail=\{detail\} audit=\{audit\.state\} \/> : null\}/);
  assert.match(source, /\{demoSession \? <DemoResumeSection detail=\{detail\} resume=\{resume\.state\} \/> : null\}/);
  assert.match(source, /\{demoSession \? <DemoTimelineSection detail=\{detail\} audit=\{audit\.state\} \/> : <History evaluationId=\{evaluationId\} \/>\}/);
});

test('the resume is only ever requested in a visitor\'s session, and only through the client', () => {
  const source = DETAIL();
  assert.match(source, /demoSession \? api\.evaluationResume\(evaluationId\) : Promise\.resolve\(null\)/);
  assert.equal(source.split('api.evaluationResume(').length - 1, 1, 'one call site');
  assert.doesNotMatch(source, /\bfetch\s*\(/);

  // In the demo scope the call lands on the visitor's own sandbox; in no scope does it
  // name a canonical route that serves resume text, because there is none.
  assert.equal(resolveApiPath('/evaluations/e1/resume', 'demo'), '/demo/session/evaluations/e1/resume');
  const client = code('api/client.ts');
  assert.match(client, /evaluationResume: \(evaluationId: string\): Promise<DemoResume> =>/);
});

test('the audit load is shared by the pipeline and the timeline, and reloaded when a decision lands', () => {
  const source = DETAIL();
  assert.equal(source.split('api.evaluationAudit(').length - 1, 2, 'one for the visitor\'s shared load, one for the recruiter\'s history');
  assert.match(source, /audit\.reload\(\);/);
  // Hooks stay above the first early return, in the exported component.
  const body = source.slice(source.indexOf('export function CandidateDetail'));
  const firstReturn = body.indexOf('if (state.status === \'loading\') return');
  for (const hook of ['useLoad(() => api.evaluation(', 'const audit = useLoad(', 'const resume = useLoad(']) {
    const at = body.indexOf(hook);
    assert.ok(at !== -1 && at < firstReturn, `${hook} is not above the early return`);
  }
});

test('each requirement card carries its number and its context, matching the numbers in the resume', () => {
  const source = DETAIL();
  assert.match(source, /number=\{index \+ 1\}/);
  assert.match(source, /context=\{demoSession && resumeText !== null \? contextFor\(resumeText, spans, index \+ 1\) : null\}/);
  assert.match(source, /Requirement \{number\}/);
  // The same function numbers the highlights in the full view.
  assert.match(code('components/ResumeEvidence.tsx'), /spansFromRequirements\(detail\.requirements\)/);

  // Verdict, evidence and context are all in the card, in that order.
  const card = source.slice(source.indexOf('function RequirementCard'), source.indexOf('function DecisionRecorded'));
  const order = ['<Badge wording={wording} />', 'requirement.evidence.map', 'Relevant CV context', '<Technical'].map((marker) => card.indexOf(marker));
  assert.ok(order.every((at) => at !== -1), 'a part of the card is missing');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the parts are out of order');
});

// ============================================================ honest labelling

test('the sections are labelled as the task asks, and no sentence names a vendor or claims live AI', () => {
  const text = SECTIONS.map(flat).join(' ');
  for (const label of ['Redacted resume', 'Evidence verified against the resume', 'How this result was reached', 'Timeline']) {
    assert.ok(text.includes(label), `missing label: ${label}`);
  }
  assert.ok(flat('screens/CandidateDetail.tsx').includes('Relevant CV context'));
  assert.ok(flat('demo/copy.ts').includes("evidence: 'Verified evidence'"));

  for (const rel of ALL_NEW) assert.doesNotMatch(code(rel), BANNED, `${rel} misdescribes a deterministic demo`);
});

test('the resume section says what the text is, and that it is shown exactly as stored', () => {
  const text = flat('components/ResumeEvidence.tsx');
  assert.match(text, /This is the text the pipeline worked from/);
  assert.match(text, /Personal details were masked/);
  assert.match(text, /Highlighted passages are evidence verified against the resume/);
  assert.match(text, /The text above is shown exactly as stored/);
  assert.match(text, /rejected\s+during verification and .* never highlighted/);
  assert.match(text, /not highlighted because the text at/);
});

test('the timeline tells a visitor how to read its times and its order', () => {
  const text = flat('components/AuditTimeline.tsx');
  assert.match(text, /fixed clock/);
  assert.match(text, /A decision shows the time you made it/);
  assert.match(text, /order they were recorded/);
  assert.match(text, /This is a demo recruiter decision\. It affects only your private demo session\./);
  assert.match(text, /Final event/);
  assert.match(text, /Nothing here can be edited/);
});

// ============================================================ accessibility

test('each section is a labelled region with a heading', () => {
  for (const [rel, id, heading] of [
    ['components/ResumeEvidence.tsx', 'resume-heading', 'Redacted resume'],
    ['components/PipelineView.tsx', 'pipeline-heading', 'How this result was reached'],
    ['components/AuditTimeline.tsx', 'timeline-heading', 'Timeline'],
  ] as const) {
    const source = code(rel);
    assert.ok(source.includes(`aria-labelledby="${id}"`), `${rel}: the region is not named`);
    assert.match(source, new RegExp(`<h4 id="${id}"[^>]*>\\s*${heading}\\s*</h4>`), `${rel}: the heading is missing`);
  }
});

test('every control is keyboard-focusable with a visible focus ring, and the scrollable text is reachable', () => {
  for (const rel of SECTIONS) {
    const source = code(rel);
    for (const tag of openingTags(source, 'summary')) assert.match(tag, /focus-visible:outline/, `${rel}: a summary without a focus ring`);
    for (const tag of openingTags(source, 'button')) assert.match(tag, /focus-visible:outline/, `${rel}: a button without a focus ring`);
    assert.doesNotMatch(source, /tabIndex=\{?[1-9]|<(div|span|li|p)[^>]*onClick/);
  }

  const summaries = SECTIONS.reduce((n, rel) => n + openingTags(code(rel), 'summary').length, 0);
  assert.equal(summaries, 2, 'the scan found a different number of expanders than the screens have');

  // A region that scrolls must take focus, or its overflow is unreadable without a mouse.
  const resume = openingTags(code('components/ResumeEvidence.tsx'), 'div').find((tag) => tag.includes('overflow-y-auto')) ?? '';
  assert.match(resume, /tabIndex=\{0\}/);
  assert.match(resume, /role="region"/);
  assert.match(resume, /aria-label="Redacted resume text"/);
  assert.match(resume, /focus-visible:outline/);
});

test('nothing carries meaning by colour alone', () => {
  // Highlights are underlined, labelled with a visible number and described in words.
  const marks = code('components/EvidenceText.ts');
  assert.match(marks, /underline/);
  assert.match(marks, /'aria-hidden': 'true'/, 'the visible number is decorative to a screen reader only because the words follow');
  assert.match(marks, /sr-only/);
  assert.match(marks, /verified evidence for/);

  // The pipeline's status is a word, and each stage is numbered in text.
  const pipeline = code('components/PipelineView.tsx');
  assert.match(pipeline, /\{stage\.statusLabel\}/);
  assert.match(pipeline, /Stage \{index \+ 1\}: /);

  // The resume legend pairs each number with the requirement's name and its verdict's word.
  const resume = code('components/ResumeEvidence.tsx');
  assert.match(resume, /<Badge wording=\{verdictWording\(requirement\.verdict\)\} \/>/);
  assert.match(resume, /no highlighted passage/);

  // A timeline entry says Warning/Failed/Skipped in words.
  assert.match(code('components/AuditTimeline.tsx'), /item\.outcome \? ` · \$\{item\.outcome\}`/);
});

test('times are real <time> elements and the lists are real lists', () => {
  const timeline = code('components/AuditTimeline.tsx');
  assert.match(timeline, /<time dateTime=\{item\.at\}/);
  assert.match(timeline, /<ol className/);
  assert.match(code('components/PipelineView.tsx'), /<ol className="grid/);
  assert.match(code('components/ResumeEvidence.tsx'), /<ul className="mt-3 space-y-1" aria-label="Which number is which requirement">/);
});

// ============================================================ responsive

test('the layout is fluid: nothing is a fixed width, and long text wraps', () => {
  for (const rel of SECTIONS) {
    const source = code(rel);
    assert.doesNotMatch(source, /\bw-\[\d+px\]|\bmin-w-\[|\bwidth:\s*\d+px|(?<![-\w])h-screen\b/, `${rel} fixes a width or height`);
    assert.doesNotMatch(source, /text-\[(?:[0-9]|1[01])px\]/, `${rel} uses text below the 12px floor`);
    assert.doesNotMatch(source, /whitespace-nowrap/, `${rel} stops text wrapping`);
  }

  // The resume wraps, so a long line cannot widen the page. It scrolls inside its own box
  // only from the small breakpoint up: on a phone the wrapped masks fill any cap and push
  // the highlighted evidence out of sight, so there the page itself scrolls.
  const resumeBox = code('components/ResumeEvidence.tsx');
  assert.match(resumeBox, /whitespace-pre-wrap break-words sm:max-h-96 sm:overflow-y-auto/);
  assert.doesNotMatch(resumeBox, /(?<![:\w-])max-h-96|(?<![:\w-])overflow-y-auto/, 'a height cap applies on a phone');
  // The pipeline is one column on a phone, two on a tablet, four on a desktop.
  assert.match(code('components/PipelineView.tsx'), /grid gap-2 sm:grid-cols-2 lg:grid-cols-4/);
  // Timeline details stack on a phone and sit side by side from the small breakpoint up.
  const timeline = code('components/AuditTimeline.tsx');
  assert.match(timeline, /flex flex-col gap-0\.5 sm:flex-row sm:gap-2/);
  assert.match(timeline, /break-words/);
  // The context lines wrap too.
  assert.match(DETAIL(), /whitespace-pre-wrap break-words rounded-control border border-line bg-canvas p-2/);
});

// ============================================================ no new reach

test('no new code makes a network call, opens a socket or reads the environment', () => {
  for (const rel of ALL_NEW) {
    assert.doesNotMatch(code(rel), /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\.meta\.env|process\.env|localStorage|sessionStorage|document\.cookie/, `${rel} reaches outside the page`);
    assert.doesNotMatch(code(rel), /https?:\/\//, `${rel} names an external address`);
  }
});

test('the new sections need no key and name no provider', () => {
  for (const rel of [...ALL_NEW, 'screens/CandidateDetail.tsx']) {
    assert.doesNotMatch(code(rel), /sk-ant-|api[_-]?key|ANTHROPIC|anthropic/i, `${rel} names a key or a provider`);
  }
});

// ============================================================ the recruiter

test('the recruiter\'s candidate screen is what it was: history list, original labels, no new sections', () => {
  const source = DETAIL();
  const text = flat('screens/CandidateDetail.tsx');

  assert.match(source, /<History evaluationId=\{evaluationId\} \/>/);
  for (const original of ['Evidence score', 'From the CV', 'How this requirement was judged', 'Full history', 'Requirement by requirement', 'Your decision', 'Record decision']) {
    assert.ok(text.includes(original), `the recruiter's wording lost: ${original}`);
  }

  // Every new section sits behind `demoSession`, which is false by default.
  assert.match(source, /demoSession = false,/);
  assert.match(source, /demo = false,/);
  // The card's new props all default to nothing.
  assert.match(source, /context = null,/);
  assert.match(source, /requirementNames = \[\],/);
  // And a recruiter never asks for a resume or an audit trail beyond their own history list.
  assert.match(source, /demoSession \? api\.evaluationAudit\(evaluationId\) : Promise\.resolve\(null\)/);
});

test('the recruiter API client has no route that serves resume text', () => {
  const client = code('api/client.ts');
  // The first argument of every request<...>(...) call, in either quote style.
  const calls = [...client.matchAll(/request<[^(]*>\(\s*([`'])(.*?)\1/g)].map((m) => m[2] as string);
  assert.ok(calls.length > 12, `the scan found only ${calls.length} calls — it would be vacuous`);
  assert.ok(calls.includes('/jobs') && calls.includes('/auth/login'), 'the scan is not reading the client\'s real calls');

  const resumeCalls = calls.filter((call) => call.includes('resume'));
  assert.deepEqual(resumeCalls, ['/evaluations/${encodeURIComponent(evaluationId)}/resume'], 'only the one call, which the demo scope redirects');
  assert.equal(resolveApiPath('/evaluations/e1/resume', 'recruiter'), '/evaluations/e1/resume', 'unchanged in the recruiter scope — and the server has no such route');
});
