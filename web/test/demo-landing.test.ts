import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_DEFAULT_ROUTE, DEMO_ROUTES, parseRoute } from '../src/router.ts';
import { landingView, type DemoState } from '../src/demo/session.ts';
import {
  CONTROL_HELP,
  CTA_LABEL,
  DEMO_DISCLOSURE,
  DEMO_LABELS,
  DEMO_TITLE,
  EXPLORE_ITEMS,
  GUIDE_STEPS,
  PROJECT_LEAD,
  PROJECT_LIMITS,
  PROJECT_SECTIONS,
  WORKFLOW_STAGES,
  historyActorLabel,
} from '../src/demo/copy.ts';
import { TIERS, TIER_WORDING } from '../src/copy.ts';
import { openingTags } from './jsxScan.ts';

// The public demo's landing and guided experience (Phase 3C.3).
//
// NFR-9 rules out jsdom and Playwright, so nothing here renders a component. What
// can be proved without a browser is what a visitor is TOLD and what they are
// OFFERED: every sentence of demo copy is data a test can read, the landing's
// behaviour is a pure function, and the structural conventions that make a screen
// usable on a phone and from a keyboard are checkable in source. (The rendered
// layout was separately checked in a real browser at 375, 768 and 1366px.)

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const SERVER = path.resolve(SRC, '../../server/src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
/** Strips comments, so a scan matches code rather than the note explaining it. */
const code = (source: string): string => source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = (source: string): string => code(source).replace(/\s+/g, ' ');

const LANDING = () => code(read('screens/DemoEntry.tsx'));

const NEW_COMPONENTS = ['screens/DemoEntry.tsx', 'components/DemoGuide.tsx', 'components/DemoOverview.tsx'];

/** Everything the demo says about itself, as one string. */
function allDemoCopy(): string {
  return JSON.stringify({ DEMO_TITLE, CTA_LABEL, PROJECT_LEAD, DEMO_DISCLOSURE, PROJECT_SECTIONS, PROJECT_LIMITS, EXPLORE_ITEMS, WORKFLOW_STAGES, GUIDE_STEPS, CONTROL_HELP, DEMO_LABELS });
}

// =============================================================== direct entry

test('/#/demo reaches the front page directly, with no sign-in anywhere in the demo deployment', () => {
  assert.deepEqual(parseRoute('#/demo', { allowed: DEMO_ROUTES, fallback: DEMO_DEFAULT_ROUTE }), { name: 'demo', id: null });

  const app = code(read('DemoApp.tsx'));
  assert.match(app, /<DemoEntry demo=\{demoSession\} redirect=\{route\.name === 'demo'\} \/>/);
  assert.doesNotMatch(app, /Login|useSession|api\.login/, 'the demo deployment draws a sign-in');
  // The app waits for the server's answer before drawing anything, so the page
  // cannot flash the call to action at a visitor who already has a live session.
  assert.match(app, /demoSession\.state\.status === 'checking'/);
});

// =============================================================== page content

test('the front page carries the positioning the demo promises, word for word', () => {
  assert.equal(DEMO_TITLE, 'Interactive ATS Demo');
  assert.equal(CTA_LABEL, 'Explore the Interactive Demo');
  assert.equal(DEMO_DISCLOSURE, 'Deterministic and explainable demo — no external AI/API call is required.');
  assert.match(PROJECT_LEAD, /evidence-first resume screening system/);

  const source = LANDING();
  for (const used of ['PROJECT_LEAD', 'DEMO_DISCLOSURE', 'PROJECT_SECTIONS', 'PROJECT_LIMITS', 'EXPLORE_ITEMS', 'WORKFLOW_STAGES', 'CONTROL_HELP']) {
    assert.match(source, new RegExp(`\\b${used}\\b`), `the front page does not render ${used}`);
  }
});

test('the front page explains the project in twelve short topics, in the order a reviewer asks about them', () => {
  assert.deepEqual(
    PROJECT_SECTIONS.map((section) => section.id),
    ['what', 'problem', 'workflow', 'evidence', 'scoring', 'privacy', 'verification', 'decision', 'architecture', 'security', 'testing', 'stack'],
  );
  assert.deepEqual(
    PROJECT_SECTIONS.map((section) => section.heading),
    [
      'What it is',
      'The problem it addresses',
      'The seven-stage workflow',
      'Evidence-first matching',
      'Deterministic scoring and ranking',
      'Redaction and privacy',
      'Verifying model-produced evidence',
      'Recruiter decision and audit trail',
      'Architecture',
      'Security boundaries',
      'How it is tested',
      'Tech stack',
    ],
  );

  // Concise: no section is an essay, and none is empty.
  for (const section of PROJECT_SECTIONS) {
    const words = [...section.body, ...(section.points ?? [])].join(' ').split(/\s+/).length;
    assert.ok(words >= 8 && words <= 130, `${section.heading} is ${words} words`);
  }
  const total = PROJECT_SECTIONS.flatMap((s) => [...s.body, ...(s.points ?? [])]).concat(PROJECT_LIMITS).join(' ').split(/\s+/).length;
  assert.ok(total < 900, `the page is ${total} words, which is not concise`);

  // The page draws every one of them, plus the explicit limits and what to explore.
  const source = LANDING();
  assert.match(source, /others\.slice\(0, 2\)\.map/);
  assert.match(source, /others\.slice\(2\)\.map/);
  assert.match(source, /PROJECT_SECTIONS\.filter\(\(section\) => section\.id !== 'workflow'\)/);
  assert.match(source, /What this demo is not/);
  assert.match(source, /What you can explore/);

  const explore = EXPLORE_ITEMS.join(' ');
  for (const topic of [/role/i, /five candidates/i, /passages quoted/i, /match breakdown/i, /demo recruiter decision/i]) {
    assert.match(explore, topic);
  }
});

test('the page says what it does for each of the topics it was asked to cover', () => {
  const byId = Object.fromEntries(PROJECT_SECTIONS.map((section) => [section.id, [...section.body, ...(section.points ?? [])].join(' ')]));

  assert.match(byId.what ?? '', /ranks candidates/);
  assert.match(byId.what ?? '', /quoted from the candidate/);
  assert.match(byId.problem ?? '', /hard to trust/);
  assert.match(byId.evidence ?? '', /No quote, no credit/);
  assert.match(byId.evidence ?? '', /not demonstrated/);
  assert.match(byId.scoring ?? '', /same input always gives the same score/);
  assert.match(byId.scoring ?? '', /ties are shown as ties/);
  assert.match(byId.privacy ?? '', /masked in place/);
  assert.match(byId.privacy ?? '', /never the value/);
  assert.match(byId.verification ?? '', /word for word/);
  assert.match(byId.verification ?? '', /rejected/);
  assert.match(byId.decision ?? '', /written reason/);
  assert.match(byId.decision ?? '', /append-only audit trail/);
  assert.match(byId.architecture ?? '', /two separate services/);
  assert.match(byId.testing ?? '', /No test calls a paid API/);
  assert.match(byId.stack ?? '', /React 19/);
});

test('the security boundary is stated as this deployment\'s own: no sign-in, no real records, no key, and no recruiter routes', () => {
  const security = PROJECT_SECTIONS.find((section) => section.id === 'security');
  const text = [...(security?.body ?? []), ...(security?.points ?? [])].join(' ');

  assert.match(text, /no sign-in, no database of real records, no credentials and no API key/);
  assert.match(text, /refuses to start if given any/);
  assert.match(text, /recruiter application’s routes do not exist here/);
  assert.match(text, /private in-memory copy/);
  assert.match(text, /HttpOnly/);
  assert.match(text, /rate limited/);
  assert.match(DEMO_DISCLOSURE, /no external AI\/API call is required/);
});

test('what the demo is not is said plainly: no upload or PDF/DOCX, no live model, not a multi-user production system', () => {
  const limits = PROJECT_LIMITS.join(' ');
  assert.equal(PROJECT_LIMITS.length, 3);
  assert.match(limits, /No CV upload/);
  assert.match(limits, /no PDF or DOCX parsing/);
  assert.match(limits, /No language model runs here/);
  assert.match(limits, /not been run against a live service/);
  assert.match(limits, /Not a multi-user production system/);
});

test('no sentence on the page claims what the system cannot do', () => {
  // Strip the sentences that DENY a capability, then look for any claim of one.
  const claims = allDemoCopy().replace(/no PDF or DOCX parsing|No CV upload|not been run against a live service|No language model runs here|Not a multi-user production system/g, '');
  for (const pattern of [
    /\b(?:upload|drag and drop)\b.{0,40}\b(?:your|a) (?:CV|resume|document)/i,
    /\bPDF\b|\bDOCX\b|\bWord document/i,
    /\bverified (?:against|with) (?:the )?live\b|\bproduction-ready\b|\bmulti-tenant\b|\bmany (?:recruiters|users)\b|\bteam accounts\b/i,
    /\bparses? (?:a |the )?job descriptions?/i,
    /\b(?:real-time|live) (?:model|AI|LLM)\b/i,
  ]) {
    assert.doesNotMatch(claims, pattern, `the page claims something it cannot do: ${pattern}`);
  }
});

test('the front page exposes no identifier of any kind', () => {
  const source = LANDING();
  assert.doesNotMatch(source, /evaluationId|candidateId|session\.(id|token)|token|expiresAt|jobTitle/i, 'the front page renders or handles an identifier');
  // The one place the job id is used is navigation — the URL bar is the router's
  // business — and it is never put in the page's text. (`stage.id` is the static
  // key of a line of copy, not a record.)
  assert.equal(source.split('jobId').length - 1, 1);
  assert.match(source, /navigate\(\{ name: 'jobs', id: session\.jobId \}\)/);
});

// =============================================================== the workflow

test('the guided workflow is exactly the seven stages the system has, in order', () => {
  assert.deepEqual(
    WORKFLOW_STAGES.map((s) => s.label),
    ['Ingest', 'Redaction', 'Evidence verification', 'Matching', 'Scoring', 'Ranking', 'Recruiter decision'],
  );
  assert.deepEqual(WORKFLOW_STAGES.map((s) => s.id), ['ingest', 'redact', 'verify', 'match', 'score', 'rank', 'decide']);

  for (const stage of WORKFLOW_STAGES) {
    assert.ok(stage.summary.length > 40 && stage.summary.length < 320, `${stage.label} is not a concise explanation`);
  }
});

test('every stage is one the server actually has — nothing is invented', () => {
  // The audit stages the pipeline records, read from the server's own source.
  const domain = fs.readFileSync(path.join(SERVER, 'domain/ats.ts'), 'utf8');
  const block = /AUDIT_STAGES = \[([\s\S]*?)\] as const/.exec(domain)?.[1] ?? '';
  const auditStages = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1] as string);
  assert.ok(auditStages.includes('ingest'), 'could not read the server stages — this check would be vacuous');

  for (const stage of WORKFLOW_STAGES) {
    if (stage.id === 'rank') {
      // Ranking is derived on read, not recorded as an event — it is real code, though.
      assert.ok(fs.existsSync(path.join(SERVER, 'agent/rank.ts')) && fs.existsSync(path.join(SERVER, 'agent/rankRules.ts')));
    } else {
      assert.ok(auditStages.includes(stage.id), `"${stage.id}" is not a stage the server has`);
    }
  }

  // And a stage the demo does not perform is not claimed.
  const labels = WORKFLOW_STAGES.map((s) => s.label.toLowerCase()).join(' ');
  assert.doesNotMatch(labels, /llm|language model|ai |model|extraction|embedding/);
});

test('the workflow never claims a language model reads the CV', () => {
  const verify = WORKFLOW_STAGES.find((s) => s.id === 'verify');
  assert.match(verify?.summary ?? '', /fixed keyword matcher — not a language model/);
  assert.match(verify?.summary ?? '', /checked against the original/);
  assert.match(verify?.summary ?? '', /rejected and never counted/);

  for (const stage of WORKFLOW_STAGES) {
    assert.doesNotMatch(stage.summary, /the model (reads|extracts|decides|scores)|AI (reads|extracts|decides|scores)|machine learning|neural/i, stage.label);
  }
});

test('the workflow is drawn as an ordered, numbered list a screen reader can follow', () => {
  const source = LANDING();
  assert.match(source, /<ol className=/);
  assert.match(source, /WORKFLOW_STAGES\.map\(\(stage, index\) =>/);
  // The number is text and each step has a heading — order never depends on colour.
  assert.match(source, /\{index \+ 1\}/);
  assert.match(source, /<h3[^>]*>\s*<span className="sr-only">Stage \{index \+ 1\}: <\/span>/);
});

// =============================================================== the call to action

const SESSION = { jobId: 'job', jobTitle: 'Senior Backend Engineer', expiresAt: '2026-01-01T00:00:00.000Z' };

test('a first-time visitor is offered the one call to action and nothing else', () => {
  const view = landingView({ status: 'inactive' }, false);
  assert.deepEqual(view, { primary: 'Explore the Interactive Demo', busy: false, canStartOver: false, notice: null });
});

test('a visitor with a live session is offered the same button, which picks it up, and may start over explicitly', () => {
  const returning = landingView({ status: 'active', session: SESSION }, false);
  assert.equal(returning.primary, CTA_LABEL);
  assert.equal(returning.canStartOver, true);
  assert.equal(returning.busy, false);

  // Back on this page from inside the demo.
  const inside = landingView({ status: 'active', session: SESSION }, true);
  assert.equal(inside.primary, CTA_LABEL);
  assert.equal(inside.canStartOver, true);
});

test('a session that ended is said to have ended, and starting again is offered', () => {
  const view = landingView({ status: 'inactive' }, true);
  assert.equal(view.primary, CTA_LABEL);
  assert.match(view.notice ?? '', /ended or expired/);
  assert.match(view.notice ?? '', /fresh private copy/);
});

test('while starting the button is busy, and a failure is shown and can be retried', () => {
  assert.deepEqual(landingView({ status: 'starting' }, false), { primary: 'Starting…', busy: true, canStartOver: false, notice: null });

  const failed = landingView({ status: 'error', message: 'Too many requests. Wait a moment and try again.' }, false);
  assert.equal(failed.primary, 'Try again');
  assert.equal(failed.busy, false);
  assert.equal(failed.notice, 'Too many requests. Wait a moment and try again.');

  // The check in flight never offers a button that would race it.
  assert.equal(landingView({ status: 'checking' }, false).busy, true);
});

test('every state a visitor can be in gets an answer, and none offers "start over" without a session', () => {
  const states: DemoState[] = [
    { status: 'checking' }, { status: 'inactive' }, { status: 'starting' }, { status: 'active', session: SESSION }, { status: 'error', message: 'x' },
  ];
  for (const state of states) {
    for (const entered of [false, true]) {
      const view = landingView(state, entered);
      assert.ok(view.primary.length > 0);
      assert.equal(view.canStartOver, state.status === 'active', `${state.status}/${entered}`);
    }
  }
});

test('the call to action goes through the existing session call and then to the job; start-over resets only the caller\'s own session first', () => {
  const source = LANDING();

  assert.match(source, /const session = await start\(\);/);
  assert.match(source, /if \(session && redirect\) navigate\(\{ name: 'jobs', id: session\.jobId \}\);/);
  assert.match(source, /if \(\(await reset\(\)\) !== null\) await begin\(\);/);

  // No call to the API of its own: it uses what the hook already does.
  assert.doesNotMatch(source, /\bapi\./);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.match(source, /Start over with a fresh copy/);
});

test('there is ONE call to action: the pure view\'s label, on one button, and nothing else leads into the demo', () => {
  const source = LANDING();
  assert.equal(source.split('{view.primary}').length - 1, 1);
  assert.equal(source.split('onClick={() => void begin()}').length - 1, 1);
  assert.equal(source.split('disabled={disabled}').length - 1, 2, 'the call to action and start-over');
  // And it is the first thing on the page after the heading and the lead, not a footer.
  assert.ok(source.indexOf('{view.primary}') < source.indexOf('others.slice(0, 2)'), 'the call to action comes after the content, where a visitor may never scroll to');
  assert.deepEqual(openingTags(source, 'a'), [], 'the front page links nowhere else');
});

// =============================================================== the overview

test('the first screen after Start Demo shows the role, its requirements with kind and weight, the count and the tier meanings', () => {
  const overview = code(read('components/DemoOverview.tsx'));

  assert.match(overview, /job\.requirements\.map/);
  assert.match(overview, /kindLabel\(requirement\.kind\)/);
  assert.match(overview, /Weight \{requirement\.weight\}/);
  assert.match(overview, /ranking === null \? '—' : ranking\.entries\.length/);
  assert.match(overview, /requirement\.criterion/);

  // The legend is the product's own wording for every tier, not a second copy.
  assert.match(overview, /TIERS\.map\(\(tier\)/);
  assert.match(overview, /TIER_WORDING\[tier\]\.detail/);
  assert.match(overview, /<Badge wording=\{TIER_WORDING\[tier\]\} \/>/);
  assert.equal(TIERS.length, 4);
  for (const tier of TIERS) assert.ok(TIER_WORDING[tier].detail.length > 20, tier);
});

test('the overview adds no dataset of its own and does no scoring, sorting or ranking', () => {
  const overview = code(read('components/DemoOverview.tsx'));

  for (const literal of ['Senior Backend Engineer', 'Node.js', 'PostgreSQL', 'Mentoring', 'Rowan', 'Devi', 'Marcus', 'Ines', 'Toby', 'demo-00']) {
    assert.ok(!overview.includes(literal), `the overview hard-codes "${literal}"`);
  }
  assert.doesNotMatch(overview, /\.sort\s*\(|Math\.(round|floor|ceil)|scoreBasisPoints|contributionBasisPoints|reduce\s*\(/);
  assert.doesNotMatch(overview, /\bapi\.|fetch\s*\(/, 'it must draw from what it is given');
});

test('JobDetail hands the overview the server\'s own job and ranking, only in a visitor\'s session', () => {
  const detail = code(read('screens/JobDetail.tsx'));

  assert.match(detail, /demoSession \? \(\s*<DemoOverview job=\{job\.state\.data\} ranking=\{ranking\.state\.status === 'ready' \? ranking\.state\.data : null\} \/>\s*\) : \(\s*<Requirements job=\{job\.state\.data\} \/>\s*\)/);
  assert.match(detail, /demoSession = false,/);
  // The recruiter's requirements card is still drawn for everyone else.
  assert.match(detail, /<Requirements job=\{job\.state\.data\} \/>/);
});

// =============================================================== the guide

test('"How this demo works" is reachable from the demo shell and gives the five steps', () => {
  assert.deepEqual(
    GUIDE_STEPS.map((s) => s.label),
    ['Open a candidate', 'Inspect the evidence', 'Inspect the match breakdown', 'Review the score', 'Make a demo decision'],
  );

  const guide = code(read('components/DemoGuide.tsx'));
  assert.match(guide, /<details/);
  assert.match(guide, /<summary[^>]*>\s*How this demo works\s*<\/summary>/);
  assert.match(guide, /GUIDE_STEPS\.map/);
  assert.match(guide, /CONTROL_HELP\.reset/);
  assert.match(guide, /CONTROL_HELP\.exit/);

  // Offered in the shell, in a visitor's session only.
  const shell = code(read('components/AppShell.tsx'));
  const at = shell.indexOf('<DemoGuide />');
  assert.notEqual(at, -1);
  assert.match(shell.slice(Math.max(0, at - 900), at), /\{demoSession \? \(/);
});

test('the candidate screen points a visitor along the same path', () => {
  const detail = code(read('screens/CandidateDetail.tsx'));
  assert.match(detail, /Demo walkthrough:/);
  assert.match(detail, /GUIDE_STEPS\.slice\(1\)/);
});

// =============================================================== honest wording

const BANNED = /\bClaude\b|\bAnthropic\b|\bGemini\b|\bOpenAI\b|\bGPT\b|AI extraction|Live AI|By the model|powered by AI|AI-powered|machine learning/i;

test('no sentence the demo says about itself names a vendor or claims live AI', () => {
  assert.doesNotMatch(allDemoCopy(), BANNED);
});

test('the visitor-facing components and the demo shell never use the banned wording', () => {
  for (const rel of [...NEW_COMPONENTS, 'demo/copy.ts', 'demo/session.ts', 'demo/useDemoSession.ts', 'components/AppShell.tsx']) {
    const source = code(read(rel));
    // The one legitimate "By the model" is the real-model branch of the history label.
    const scanned = rel === 'demo/copy.ts' ? source.replace(/return actorId === 'mock'[^;]*;/, '') : source;
    assert.doesNotMatch(scanned, BANNED, `${rel} uses wording that misdescribes a deterministic demo`);
  }
});

test('the demo\'s own labels say what the implementation does', () => {
  assert.deepEqual({ ...DEMO_LABELS }, {
    extraction: 'Deterministic demo extraction',
    evidence: 'Verified evidence',
    match: 'Rule-based match',
    score: 'Deterministic score',
    decision: 'Demo recruiter decision',
  });

  const detail = flat(read('screens/CandidateDetail.tsx'));
  assert.ok(detail.includes('{demo ? DEMO_LABELS.score : \'Evidence score\'}'), 'the score label');
  assert.ok(detail.includes('DEMO_LABELS.evidence'), 'the evidence label');
  assert.ok(detail.includes('DEMO_LABELS.match'), 'the match label');
  assert.ok(detail.includes('DEMO_LABELS.extraction'), 'the extraction label');
  assert.ok(detail.includes('Demo recruiter decision'), 'the decision label');
});

test('the stand-in extractor is described as what it is, wherever it is described', () => {
  const detail = code(read('screens/CandidateDetail.tsx'));

  // The technical note keys on the model the evaluation records, so it is right
  // for the read-only window too, and says outright that no model was used.
  assert.match(detail, /detail\.model === 'mock'/);
  assert.match(flat(read('screens/CandidateDetail.tsx')), /fixed keyword matcher .{0,80}no language model was used/);
  // "By the model" is not in the screen at all: the history label owns it.
  assert.doesNotMatch(detail, /By the model/);

  assert.equal(historyActorLabel('ai', 'mock'), 'Deterministic demo extraction (no AI model)');
  assert.equal(historyActorLabel('ai', 'some-real-model'), 'By the model', 'a real model must still be described as one');
  assert.equal(historyActorLabel('human', 'demo-visitor'), 'By a person');
  assert.equal(historyActorLabel('system', null), 'Automatic');

  // The status page no longer says a model is replaying recordings.
  const status = flat(read('screens/Overview.tsx'));
  assert.doesNotMatch(status, /recorded responses/);
  assert.match(status, /fixed keyword matcher stands in for a language model/);
});

// =============================================================== reset and exit

test('Reset demo and Exit demo are in the shell, explained, and wired to the caller\'s own session', () => {
  assert.match(CONTROL_HELP.reset, /restores your own copy/);
  assert.match(CONTROL_HELP.reset, /affects only you/);
  assert.match(CONTROL_HELP.exit, /ends your session/);

  const shell = code(read('components/AppShell.tsx'));
  assert.match(shell, /title=\{CONTROL_HELP\.reset\}/);
  assert.match(shell, /title=\{CONTROL_HELP\.exit\}/);
  assert.match(shell, /Reset demo/);
  assert.match(shell, /Exit demo/);
  assert.match(shell, /disabled=\{demoSession\.busy\}/);

  const app = code(read('DemoApp.tsx'));
  assert.match(app, /void demoSession\.reset\(\)\.then\(\(view\) => \{\s*if \(view\) navigate\(\{ name: 'jobs', id: view\.jobId \}\);/);
  // Leaving returns to the project explanation, not to the dashboard's list.
  assert.match(app, /void demoSession\.end\(\)\.then\(\(\) => navigate\(DEMO_DEFAULT_ROUTE\)\)/);
  assert.deepEqual(DEMO_DEFAULT_ROUTE, { name: 'demo', id: null });
  // No identifier is passed: the session is whichever the cookie names.
  assert.doesNotMatch(app, /reset\([^)]/);
});

test('the landing explains both controls before the visitor enters', () => {
  assert.match(LANDING(), /Inside, the header has two controls\. \{CONTROL_HELP\.reset\} \{CONTROL_HELP\.exit\}/);
});

// =============================================================== accessibility, responsive

test('the new screens have one h1, labelled sections, and a heading for every card', () => {
  const landing = LANDING();
  assert.equal(landing.split('<h1').length - 1, 1);
  assert.equal(landing.split('<section').length - 1, 4);
  assert.equal(landing.split('aria-labelledby=').length - 1, 4, 'every section is named by its heading');
  assert.match(landing, /aria-labelledby=\{headingId\}/);
  assert.match(landing, /<h2 id=\{headingId\}/);
  for (const id of ['project-workflow', 'project-limits', 'project-inside']) {
    assert.ok(landing.includes(`aria-labelledby="${id}"`) && landing.includes(`id="${id}"`), id);
  }
  // Every topic's heading id is unique, so a label never points at two things.
  const ids = PROJECT_SECTIONS.map((section) => `project-${section.id}`);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('project-workflow'));
  // The overview is a labelled region too, and its sub-headings follow the shell's h3/h4.
  const overview = code(read('components/DemoOverview.tsx'));
  assert.match(overview, /aria-labelledby="demo-overview-heading"/);
  assert.match(overview, /<h4 id="demo-overview-heading"/);
});

test('every control in the new components is a real, labelled, keyboard-focusable element with a visible focus ring', () => {
  for (const rel of NEW_COMPONENTS) {
    const source = code(read(rel));

    const buttons = openingTags(source, 'button');
    if (rel === 'screens/DemoEntry.tsx') assert.equal(buttons.length, 2, 'the scan found a different set of buttons than the screen has');
    for (const tag of buttons) {
      assert.match(tag, /type="button"/, `${rel}: a button without a type`);
      assert.match(tag, /focus-visible:outline/, `${rel}: a button with no visible focus ring`);
    }
    const summaries = openingTags(source, 'summary');
    if (rel === 'components/DemoGuide.tsx') assert.equal(summaries.length, 1);
    for (const tag of summaries) {
      assert.match(tag, /focus-visible:outline/, `${rel}: a summary with no visible focus ring`);
    }
    // No positive tabindex, no click handlers on non-interactive elements.
    assert.doesNotMatch(source, /tabIndex=\{?[1-9]/);
    assert.doesNotMatch(source, /<(div|span|li|p)[^>]*onClick/);
  }

  // The buttons say what they do, in words.
  const landing = LANDING();
  assert.match(landing, /Start over with a fresh copy/);
  assert.doesNotMatch(landing, /<button[^>]*>\s*(×|✕|…|\.\.\.)\s*<\/button>/);
});

test('nothing important is carried by colour alone', () => {
  const overview = code(read('components/DemoOverview.tsx'));
  // Kind and weight are words; tier meaning is the badge's own text plus a sentence.
  assert.match(overview, /kindLabel\(requirement\.kind\)\} · Weight/);
  assert.match(overview, /<Badge wording=/);

  // Decorative numerals are hidden from assistive tech only because the heading
  // beside them says the same thing in words.
  const landing = LANDING();
  assert.match(landing, /aria-hidden="true"/);
  assert.match(landing, /Stage \{index \+ 1\}: /);

  // The disclosure is text on a tinted panel with a border, not a colour-coded state.
  assert.match(landing, /border border-line-strong bg-brand-tint[^"]*font-semibold/);
});

test('the layout is fluid: one column on a phone, more on wider screens, never a fixed width', () => {
  const landing = LANDING();

  assert.match(landing, /mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12/);
  assert.match(landing, /grid gap-4 md:grid-cols-2/, 'the topics: one column on a phone, two beside each other from a tablet');
  assert.match(landing, /grid gap-3 sm:grid-cols-2 lg:grid-cols-4/, 'the seven stages');
  assert.match(landing, /flex flex-col gap-3 sm:flex-row/, 'the buttons stack on a phone');
  assert.equal(landing.split('w-full').length - 1 >= 2, true, 'the buttons fill the width on a phone');
  assert.match(landing, /sm:w-auto/);

  const overview = code(read('components/DemoOverview.tsx'));
  assert.match(overview, /grid gap-3 sm:grid-cols-3/);
  assert.match(overview, /grid gap-2 sm:grid-cols-2/);

  for (const rel of NEW_COMPONENTS) {
    const source = code(read(rel));
    assert.doesNotMatch(source, /\bw-\[\d+px\]|\bmin-w-\[|\bwidth:\s*\d+px|(?<![-\w])h-screen\b/, `${rel} fixes a width or height`);
    // 12px is the design system's floor; nothing below it.
    assert.doesNotMatch(source, /text-\[(?:[0-9]|1[01])px\]/, `${rel} uses text below the 12px floor`);
  }
});

// =============================================================== the recruiter flow

test('the recruiter\'s sign-in is exactly what it was, minus the demo entry that no longer belongs on it', () => {
  const login = code(read('screens/Login.tsx'));

  for (const original of [
    'Operator password',
    'type="password"',
    'autoComplete="current-password"',
    "{submitting ? 'Signing in…' : 'Sign in'}",
    'That did not match. Check the password and try again.',
    'The password is checked on the server and never stored in this browser.',
  ]) {
    assert.ok(login.includes(original), `the sign-in screen lost: ${original}`);
  }
  assert.equal(login.split('api.login(').length - 1, 1);
  assert.equal(login.split('await api.login(password)').length - 1, 1);

  // Nothing about the demo is on it: no link, no card, no wording, no import.
  assert.deepEqual(openingTags(login, 'a'), []);
  assert.doesNotMatch(login, /[Dd]emo|DemoEntry|useDemoSession|routeToHash/);
});

test('the signed-in recruiter\'s screens are the recruiter\'s: no demo copy, no demo gate, no demo controls', () => {
  const app = code(read('RecruiterApp.tsx'));
  // The sign-in gate is the whole gate: anonymous means the sign-in screen.
  assert.match(app, /if \(session\.state\.status === 'anonymous'\) \{\s*return <Login onSignedIn=\{\(\) => void session\.refresh\(\)\} \/>;/);
  assert.match(app, /operator=\{session\.state\.operator\}/);
  assert.doesNotMatch(app, /[Dd]emo/);

  const shell = code(read('components/AppShell.tsx'));
  assert.match(shell, /\{operator\}/);
  assert.match(shell, /Sign out/);
  assert.doesNotMatch(shell, /Read-only demo|onExitDemo|Sign in/);

  // The recruiter still gets the requirements card, and never the runner.
  const detail = code(read('screens/JobDetail.tsx'));
  assert.match(detail, /\) : \(\s*<Requirements job=\{job\.state\.data\} \/>\s*\)/);
  assert.doesNotMatch(detail, /DemoRunner/);

  // The recruiter's candidate screen: original labels remain the default.
  const candidate = flat(read('screens/CandidateDetail.tsx'));
  assert.ok(candidate.includes("demo = false"), 'the demo flag defaults off');
  assert.ok(candidate.includes("'Evidence score'") && candidate.includes("'From the CV'") && candidate.includes("'How this requirement was judged'"));
});

test('the recruiter\'s API calls are not redirected by anything this phase added', () => {
  const client = code(read('api/client.ts'));
  assert.match(client, /let apiScope: ApiScope = 'recruiter';/, 'the default scope must stay the recruiter\'s');
  assert.doesNotMatch(client, /landing|DEMO_|copy\.ts/);
});

test('NEGATIVE CONTROL — the tag scanner reads past an arrow function and would catch a button with no focus ring', () => {
  const bad = `<button type="button" onClick={() => void go()} className="rounded px-4">Go</button>`;
  const good = `<button type="button" onClick={() => void go()} className="rounded focus-visible:outline">Go</button>`;

  const [badTag] = openingTags(bad, 'button');
  const [goodTag] = openingTags(good, 'button');

  // The whole tag, past the `=>`, not the fragment up to it.
  assert.ok(badTag?.endsWith('px-4">'), `the scanner stopped early: ${badTag}`);
  assert.doesNotMatch(badTag ?? '', /focus-visible:outline/);
  assert.match(goodTag ?? '', /focus-visible:outline/);

  // And it does not mistake a different element for a button.
  assert.deepEqual(openingTags('<buttonlike a="1"></buttonlike>', 'button'), []);
});
