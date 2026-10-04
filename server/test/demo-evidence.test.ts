import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { rateLimit, RATE_LIMITS } from '../src/http/rateLimit.ts';
import { MASK_CHAR } from '../src/agent/redact.ts';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { openEvaluation } from '../src/agent/extract.ts';
import { DEMO_CANDIDATES, DEMO_JOB, demoCandidateNames, demoPersonalDetails } from '../src/demo/dataset.ts';
import type { DemoSessionStore, VisitorSandbox } from '../src/demo/sessions.ts';
import { DEMO_ACTOR } from '../src/handlers/demoSession.ts';
import { DEMO_SESSION_COOKIE } from '../src/routes/demoSession.ts';
import { highlightEvidence, spansFromRequirements, normaliseSpace } from '../../web/src/demo/evidence.ts';
import { buildPipeline, type PipelineStage } from '../../web/src/demo/pipeline.ts';
import { buildTimeline } from '../../web/src/demo/timeline.ts';
import {
  FIXTURE_NAME,
  PASSWORD,
  SECRET_API_KEY,
  canonicalSnapshot,
  flip,
  withHarness,
  type EvaluationBody,
  type Harness,
  type Json,
  type RankingBody,
} from './demoHarness.ts';
import { createTestContext } from './helpers.ts';

// Evidence in context, the pipeline and the audit timeline (Phase 3C.4) — checked
// against the REAL pipeline.
//
// Two jobs. The first is security: the one new endpoint returns a resume's
// redacted text and nothing else, only from the caller's own sandbox, and neither
// it nor the audit data reaches canonical records. The second is honesty: the
// web's evidence, pipeline and timeline builders are run over what the pipeline
// actually recorded for every demo candidate, so "does not invent audit events"
// is checked on the real trail rather than on a fixture written to agree with the
// code.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type AuditBody = {
  events: Array<{
    id: string;
    sequence: number;
    stage: string;
    eventType: string;
    actor: string;
    actorId: string | null;
    outcome: string;
    summary: string;
    payload: Json;
    createdAt: string;
  }>;
};

type DetailBody = Omit<EvaluationBody, 'requirements'> & {
  evidenceRejectedCount: number;
  requirements: Array<{ requirementId: string; label: string; evidence: Array<{ quote: string; charStart: number; charEnd: number }> }>;
};
type LiveRanking = {
  rankedCount: number;
  entries: Array<{ reference: string; evaluationId: string | null; rank: number | null; position: number }>;
};

type Visitor = { token: string; jobId: string };

async function visitor(h: Harness): Promise<Visitor> {
  const { token, reply } = await h.start();
  return { token, jobId: reply.body.jobId as string };
}

async function evaluationOf(h: Harness, v: Visitor, reference: string): Promise<string> {
  const ranking = await h.call<RankingBody>('GET', `/api/demo/session/jobs/${v.jobId}/ranking`, { token: v.token });
  const id = ranking.body.entries.find((e) => e.reference === reference)?.evaluationId;
  assert.ok(id, `${reference} has no evaluation`);
  return id;
}

/** Everything the screen is given for one candidate, from the real endpoints. */
async function fetchAll(h: Harness, v: Visitor, evaluationId: string) {
  const [detail, audit, resume, ranking] = await Promise.all([
    h.call<DetailBody>('GET', `/api/demo/session/evaluations/${evaluationId}`, { token: v.token }),
    h.call<AuditBody>('GET', `/api/demo/session/evaluations/${evaluationId}/audit`, { token: v.token }),
    h.call<{ text: string }>('GET', `/api/demo/session/evaluations/${evaluationId}/resume`, { token: v.token }),
    h.call<LiveRanking>('GET', `/api/demo/session/jobs/${v.jobId}/ranking`, { token: v.token }),
  ]);
  assert.equal(detail.status, 200);
  assert.equal(audit.status, 200);
  assert.equal(resume.status, 200);
  assert.equal(ranking.status, 200);
  return { detail: detail.body, events: audit.body.events, text: resume.body.text, ranking: ranking.body };
}

function pipelineFor(all: Awaited<ReturnType<typeof fetchAll>>, evaluationId: string): PipelineStage[] {
  const entry = all.ranking.entries.find((e) => e.evaluationId === evaluationId);
  return buildPipeline({
    events: all.events as never,
    detail: all.detail as never,
    ranking: { state: 'ready', rank: entry?.rank ?? null, position: entry?.position ?? null, rankedCount: all.ranking.rankedCount, total: all.ranking.entries.length },
  });
}

/** Every string anything the visitor reads is made of, for scanning. */
function everythingRead(stages: PipelineStage[], timeline: ReturnType<typeof buildTimeline>): string {
  return JSON.stringify([stages, timeline]);
}

// ============================================================ the resume endpoint

test('the resume endpoint returns the redacted text, character for character, and nothing else', async () => {
  await withHarness(async (h) => {
    const v = await visitor(h);
    const sandbox = h.store.resolve(v.token);
    assert.ok(sandbox);

    for (const candidate of DEMO_CANDIDATES) {
      const id = await evaluationOf(h, v, candidate.reference);
      const reply = await h.call<{ text: string }>('GET', `/api/demo/session/evaluations/${id}/resume`, { token: v.token });

      assert.equal(reply.status, 200, candidate.reference);
      assert.deepEqual(Object.keys(reply.body), ['text'], 'the response carries something besides the text');

      // It is the stored redacted text — and not the original.
      const evaluation = await sandbox.repos.evaluations.getById(id);
      const stored = await sandbox.repos.resumes.getById(evaluation?.resumeId ?? '');
      assert.ok(stored);
      assert.equal(reply.body.text, stored.redactedText);
      assert.notEqual(reply.body.text, stored.contentText);

      // Same length as the original, which is what makes the evidence offsets line up.
      assert.equal(reply.body.text.length, stored.contentText.length);
      assert.ok(reply.body.text.includes(MASK_CHAR), 'nothing was masked');
    }
  });
});

test('no personal detail from any demo resume is in any response: not a value, not a name', async () => {
  await withHarness(async (h) => {
    const v = await visitor(h);
    const sensitive = [...demoPersonalDetails(), ...demoCandidateNames()];
    assert.ok(sensitive.length > 20, 'precondition: there are details to look for');

    for (const candidate of DEMO_CANDIDATES) {
      const id = await evaluationOf(h, v, candidate.reference);
      const all = await fetchAll(h, v, id);
      const text = all.text;

      for (const value of sensitive) {
        // The candidate's own name is shown by the dashboard's headline, not the resume.
        assert.ok(!text.includes(value), `${candidate.reference}: the redacted resume contains "${value}"`);
      }
      assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.-]+/, 'an email address survived');
      assert.doesNotMatch(text, /\+?\d[\d\s()-]{8,}\d/, 'a phone number survived');
      assert.doesNotMatch(text, /\b(19|20)\d{2}\b.*\b(born|birth)|\bborn\b.*\b(19|20)\d{2}\b/i);

      // And not in the audit trail either, which the timeline is built from.
      const trail = JSON.stringify(all.events);
      for (const value of demoPersonalDetails()) assert.ok(!trail.includes(value), `${candidate.reference}: the audit trail contains "${value}"`);
    }
  });
});

test('the original text is unreachable from the endpoint: the server code never reads it', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const strip = (rel: string) => fs.readFileSync(path.join(here, rel), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  for (const rel of ['../src/handlers/demoSession.ts', '../src/routes/demoSession.ts']) {
    assert.doesNotMatch(strip(rel), /contentText|content_text/, `${rel} can read the original resume`);
  }
  assert.match(strip('../src/handlers/demoSession.ts'), /body: \{ text: resume\.redactedText \}/);

  // No canonical router or handler reads a resume's text, in either form, or defines
  // a route for one. (They do mention a resume's id — an evaluation points at one —
  // and its masked-attribute findings; neither is the text.)
  for (const rel of ['../src/routes/recruiter.ts', '../src/handlers/evaluations.ts', '../src/handlers/jobs.ts']) {
    const source = strip(rel);
    assert.doesNotMatch(source, /redactedText|contentText|redacted_text|content_text|resumes\.getById|resumes\.latestForCandidate/, `${rel} reads resume text`);
    assert.doesNotMatch(source, /\/resume['"`/]/, `${rel} defines a resume route`);
  }
});

test('the resume endpoint needs the demo cookie, and nothing else stands in for it', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const id = await evaluationOf(h, a, 'demo-001');
    const url = `${h.base}/api/demo/session/evaluations/${id}/resume`;

    assert.equal((await h.call('GET', `/api/demo/session/evaluations/${id}/resume`)).status, 401, 'no cookie');
    for (const token of [flip(a.token), a.token.slice(0, 42), `${a.token}A`, 'A'.repeat(43), 'garbage']) {
      assert.equal((await h.call('GET', `/api/demo/session/evaluations/${id}/resume`, { rawCookie: `${DEMO_SESSION_COOKIE}=${token}` })).status, 401);
    }
    for (const attempt of [
      fetch(`${url}?token=${a.token}&${DEMO_SESSION_COOKIE}=${a.token}`),
      fetch(url, { headers: { 'x-demo-session': a.token, authorization: `Bearer ${a.token}` } }),
    ]) {
      assert.equal((await attempt).status, 401);
    }

    // The operator's session is not a demo identity.
    const op = await h.operator();
    assert.equal((await fetch(url, { headers: { cookie: op.cookie } })).status, 401);
  });
});

test('canonical evaluations cannot be reached through the resume endpoint, and no canonical route serves a resume', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const before = await canonicalSnapshot(h.ctx);

    for (const canonicalId of h.canonicalEvaluations.values()) {
      assert.equal((await h.call('GET', `/api/demo/session/evaluations/${canonicalId}/resume`, { token: a.token })).status, 404);
      assert.equal((await h.call('GET', `/api/demo/session/evaluations/${canonicalId}/audit`, { token: a.token })).status, 404);
    }
    assert.equal((await h.call('GET', `/api/demo/session/evaluations/${'x'.repeat(200)}/resume`, { token: a.token })).status, 400);
    assert.equal((await h.call('GET', '/api/demo/session/evaluations/nope/resume', { token: a.token })).status, 404);

    // There is no canonical resume route: anonymous is refused, and an operator finds nothing.
    const canonicalId = h.canonicalEvaluations.get('demo-001') as string;
    assert.equal((await h.call('GET', `/api/evaluations/${canonicalId}/resume`)).status, 401);
    const op = await h.operator();
    assert.equal((await fetch(`${h.base}/api/evaluations/${canonicalId}/resume`, { headers: { cookie: op.cookie } })).status, 404);

    assert.equal(await canonicalSnapshot(h.ctx), before);
  });

  // And with the read-only window open, the canonical surface still serves no resume.
  await withHarness(
    async (h) => {
      const canonicalId = h.canonicalEvaluations.get('demo-001') as string;
      assert.equal((await h.call('GET', `/api/evaluations/${canonicalId}/resume`)).status, 401);
      assert.equal((await h.call('GET', `/api/evaluations/${canonicalId}`)).status, 200, 'precondition: the window is open');
    },
    { overrides: { demoPublicReadonly: true } },
  );
});

test('the response is JSON, uncacheable, and carries nosniff', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const id = await evaluationOf(h, a, 'demo-001');
    const reply = await h.call('GET', `/api/demo/session/evaluations/${id}/resume`, { token: a.token });

    assert.match(reply.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
    assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
    assert.match(reply.headers.get('vary') ?? '', /cookie/i);
  });
});

test('no key or credential appears in any new response, with or without a key configured', async () => {
  for (const overrides of [{ anthropicApiKey: SECRET_API_KEY }, { anthropicApiKey: null }]) {
    await withHarness(
      async (h) => {
        const a = await visitor(h);
        const id = await evaluationOf(h, a, 'demo-002');
        const all = await fetchAll(h, a, id);
        const text = JSON.stringify([all.text, all.events, all.detail]);
        for (const needle of [SECRET_API_KEY, PASSWORD, 'scrypt$', 'ANTHROPIC', FIXTURE_NAME, 'real-0001']) {
          assert.ok(!text.includes(needle), `a response contained ${JSON.stringify(needle)}`);
        }
      },
      { overrides },
    );
  }
});

// ============================================================ hostile resume text

test('resume text containing markup, scripts and secrets is returned as inert text, with the secrets masked', async () => {
  const ctx = await createTestContext({ idPrefix: 'hostile' });
  try {
    const { job } = await createJob({ repos: ctx.repos }, DEMO_JOB);
    const hostile = [
      'Name: Hostile Person',
      'Email: evil@example.invalid',
      'Phone: +44 20 7946 0999',
      'Address: 1 Injection Street, Scriptville',
      '',
      '<script>alert("pwned")</script>',
      '<img src=x onerror="alert(2)">',
      '"><svg onload=alert(3)>',
      '</pre><iframe src="javascript:alert(4)"></iframe>',
      'Designed and shipped production Node.js services.',
    ].join('\n');

    const ingested = await ingestResume({ repos: ctx.repos }, { reference: 'hostile-1', displayName: 'Hostile Person', text: hostile, source: 'demo' });
    const evaluation = await openEvaluation({ repos: ctx.repos }, { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume });

    // A store holding that one sandbox, so the real route serves it over real HTTP.
    const sandbox = { repos: ctx.repos, jobId: job.id, jobTitle: job.title, expiresAt: '2099-01-01T00:00:00.000Z', evaluationFor: () => evaluation.id } as VisitorSandbox;
    const token = 'H'.repeat(43);
    const store: DemoSessionStore = {
      create: async () => { throw new Error('not used'); },
      resolve: (t) => (t === token ? sandbox : null),
      reset: async () => null,
      end: async () => false,
      size: 1,
      close: async () => {},
    };

    const config: AppConfig = { ...loadConfig({}).config, cookieSecure: false, demoPublicReadonly: false };
    const app = createApp({ db: ctx.db, config, logger: createMemoryLogger().logger, demoSessions: store, rateLimiter: rateLimit({ limits: { ...RATE_LIMITS } }) });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const response = await fetch(`${base}/api/demo/session/evaluations/${evaluation.id}/resume`, { headers: { cookie: `${DEMO_SESSION_COOKIE}=${token}` } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/, 'resume text must never be served as HTML');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

      const { text } = (await response.json()) as { text: string };

      // The hostile markup is there, verbatim — as characters, for the screen to escape.
      for (const markup of ['<script>alert("pwned")</script>', '<img src=x onerror="alert(2)">', '"><svg onload=alert(3)>', '<iframe src="javascript:alert(4)"></iframe>']) {
        assert.ok(text.includes(markup), `the text was altered: ${markup}`);
      }
      // The secrets are not.
      for (const secret of ['evil@example.invalid', '7946 0999', 'Injection Street', 'Scriptville', 'Hostile Person']) {
        assert.ok(!text.includes(secret), `a personal detail survived: ${secret}`);
      }
      assert.ok(text.includes(MASK_CHAR));
      assert.equal(text.length, hostile.length, 'redaction must preserve length');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await ctx.close();
  }
});

// ================================================== evidence over the real pipeline

test('every demo candidate\'s verified evidence is highlighted in its redacted resume, exactly, with nothing skipped', async () => {
  await withHarness(async (h) => {
    const v = await visitor(h);

    for (const candidate of DEMO_CANDIDATES) {
      const id = await evaluationOf(h, v, candidate.reference);
      const { detail, text } = await fetchAll(h, v, id);

      const spans = spansFromRequirements(detail.requirements);
      const result = highlightEvidence(text, spans);

      assert.equal(result.skipped.length, 0, `${candidate.reference}: ${JSON.stringify(result.skipped)}`);
      assert.equal(result.used.length, spans.length, 'a verified passage was not highlighted');
      assert.equal(result.segments.map((s) => s.text).join(''), text, 'the text was altered');

      for (const span of result.used) {
        assert.ok(span.start >= 0 && span.end <= text.length, 'an offset left the text');
        assert.equal(normaliseSpace(text.slice(span.start, span.end)), normaliseSpace(span.quote), 'the highlighted words are not the quote');
        assert.ok(!text.slice(span.start, span.end).includes(MASK_CHAR), 'a highlight touches a mask');
      }

      const expectedEvidence = candidate.assess === 'queued' ? 0 : spans.length;
      assert.equal(spans.length, expectedEvidence);
      if (candidate.assess === 'scored') assert.ok(spans.length >= 2, `${candidate.reference} has no evidence to highlight`);
    }
  });
});

test('evidence the pipeline rejected is never sent, so it can never be highlighted', async () => {
  await withHarness(async (h) => {
    const v = await visitor(h);
    const sandbox = h.store.resolve(v.token);
    assert.ok(sandbox);
    const id = await evaluationOf(h, v, 'demo-001');
    const evaluation = await sandbox.repos.evaluations.getById(id);

    // Plant an UNVERIFIED row, as a rejected fabrication is stored.
    const resume = await sandbox.repos.resumes.getById(evaluation?.resumeId ?? '');
    const requirements = await sandbox.repos.requirements.listForJob(sandbox.jobId);
    await sandbox.repos.evidence.record({
      evaluationId: id,
      resumeId: resume?.id ?? '',
      requirementId: requirements[0]?.id ?? null,
      quote: 'Led a team of fifty engineers across three continents',
      charStart: 100,
      charEnd: 150,
      verified: false,
    });

    const { detail, text } = await fetchAll(h, v, id);
    assert.ok(!JSON.stringify(detail).includes('fifty engineers'), 'a rejected quote was sent to the screen');
    assert.equal(detail.evidenceRejectedCount, 1, 'the rejection is reported as a count');

    const result = highlightEvidence(text, spansFromRequirements(detail.requirements));
    assert.equal(result.skipped.length, 0);
    assert.ok(result.segments.every((s) => !s.text.includes('fifty engineers')));
  });
});

// ============================================== pipeline and timeline over the real trail

test('the pipeline is drawn from the real trail: scored candidates ran every stage, the queued one did not', async () => {
  await withHarness(async (h) => {
    const v = await visitor(h);

    for (const candidate of DEMO_CANDIDATES) {
      const id = await evaluationOf(h, v, candidate.reference);
      const all = await fetchAll(h, v, id);
      const stages = pipelineFor(all, id);
      const byId = Object.fromEntries(stages.map((s) => [s.id, s]));
      const stored = new Set(all.events.map((e) => e.createdAt));

      assert.deepEqual(stages.map((s) => s.id), ['ingest', 'redact', 'extract', 'verify', 'match', 'score', 'rank', 'decide']);
      assert.equal(byId.ingest?.status, 'recorded', candidate.reference);
      assert.equal(byId.redact?.status, 'recorded', candidate.reference);
      assert.equal(byId.rank?.status, 'derived');
      assert.equal(byId.rank?.at, null);
      assert.equal(byId.decide?.status, 'not_run');

      if (candidate.assess === 'scored') {
        for (const id of ['extract', 'verify', 'match', 'score']) assert.equal(byId[id]?.status, 'recorded', `${candidate.reference} ${id}`);
        assert.match(byId.extract?.explanation ?? '', /no language model was used/);
        assert.ok(byId.score?.facts.some((f) => f.startsWith('Score: ')));
      } else {
        for (const id of ['extract', 'verify', 'match', 'score']) {
          assert.equal(byId[id]?.status, 'not_run', `${candidate.reference} ${id}`);
          assert.equal(byId[id]?.at, null, `${id} was given a time it never had`);
          assert.deepEqual(byId[id]?.facts, []);
        }
        assert.ok(byId.rank?.facts[0]?.startsWith('Not ranked'));
      }

      // Every time shown is the stored time of a real event.
      for (const stage of stages) assert.ok(stage.at === null || stored.has(stage.at), `${candidate.reference} ${stage.id}: ${stage.at}`);

      // The ranking fact is the live ranking's own answer.
      const entry = all.ranking.entries.find((e) => e.evaluationId === id);
      if (entry?.rank != null) assert.equal(byId.rank?.facts[0], `Rank ${entry.rank} of ${all.ranking.rankedCount} ranked`);
    }
  });
});

test('the timeline is the real trail, in recorded order, one item per event, with no invented events', async () => {
  await withHarness(async (h) => {
    const v = await visitor(h);

    for (const candidate of DEMO_CANDIDATES) {
      const id = await evaluationOf(h, v, candidate.reference);
      const all = await fetchAll(h, v, id);
      const items = buildTimeline(all.events as never, all.detail as never);

      assert.equal(items.length, all.events.length, `${candidate.reference}: an event was added or dropped`);
      const times = items.map((i) => i.at);
      assert.deepEqual(times, all.events.map((e) => e.createdAt), 'the order differs from the server\'s');
      assert.deepEqual(times, [...times].sort(), 'the times are not ascending');
      assert.equal(items[0]?.stage, 'ingest', 'the trail should begin where the resume entered');
      assert.equal(items.some((i) => i.isDecision), false);
    }
  });
});

test('the real order of recording is shown as it is: verification is written before the extraction summary', async () => {
  // The timeline's intro tells visitors this, so it must stay true. If the pipeline
  // ever changes the order, that sentence in AuditTimeline.tsx needs to change too.
  await withHarness(async (h) => {
    const v = await visitor(h);
    const all = await fetchAll(h, v, await evaluationOf(h, v, 'demo-003'));
    const order = buildTimeline(all.events as never, all.detail as never).map((i) => i.stage);
    assert.ok(order.indexOf('verify') < order.indexOf('extract', order.indexOf('verify')), 'extraction is no longer summarised after verification');
    assert.match(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src/components/AuditTimeline.tsx'), 'utf8'), /extraction.s summary is written after its evidence is verified/);
  });
});

test('the score\'s arithmetic in the timeline is the real score, and every part adds up to it', async () => {
  await withHarness(async (h) => {
    const v = await visitor(h);

    for (const candidate of DEMO_CANDIDATES.filter((c) => c.assess === 'scored')) {
      const id = await evaluationOf(h, v, candidate.reference);
      const all = await fetchAll(h, v, id);
      const score = buildTimeline(all.events as never, all.detail as never).find((i) => i.stage === 'score');
      assert.ok(score, `${candidate.reference} has no score event`);

      const lines = Object.fromEntries(score.details.map((d) => [d.label, d.value]));
      assert.equal(lines['Score'], `${all.detail.scoreBasisPoints?.toLocaleString('en-US')} of 10,000 points`);

      // Each requirement's points, read back from the lines, sum to the score.
      const points = all.detail.requirements.map((r) => Number((lines[r.label] ?? '').match(/([\d,]+) points/)?.[1]?.replace(/,/g, '')));
      assert.ok(points.every(Number.isInteger), `${candidate.reference}: a requirement has no points line`);
      assert.equal(points.reduce((a, b) => a + b, 0), all.detail.scoreBasisPoints, `${candidate.reference}: the parts do not add up`);
    }
  });
});

test('nothing the visitor reads from the pipeline or timeline is an id, a name or a personal detail', async () => {
  await withHarness(async (h) => {
    const v = await visitor(h);
    const sensitive = [...demoPersonalDetails(), ...demoCandidateNames()];

    for (const candidate of DEMO_CANDIDATES) {
      const id = await evaluationOf(h, v, candidate.reference);
      const all = await fetchAll(h, v, id);
      const read = everythingRead(pipelineFor(all, id), buildTimeline(all.events as never, all.detail as never));

      assert.doesNotMatch(read, UUID, `${candidate.reference}: an id reached the screen text`);
      for (const value of sensitive) assert.ok(!read.includes(value), `${candidate.reference}: "${value}" reached the screen text`);
      assert.doesNotMatch(read, /NaN|undefined|\[object/);
    }
  });
});

// ================================================== decision, reset, isolation, canonical

test('a demo decision becomes the timeline\'s final event, and the pipeline\'s last stage', async () => {
  await withHarness(async (h) => {
    const v = await visitor(h);
    const id = await evaluationOf(h, v, 'demo-001');
    const pristine = await fetchAll(h, v, id);
    const decidedAfter = Date.now() - 1000;

    const reason = 'Synthetic demo reason: both essentials are evidenced.';
    const decided = await h.call('POST', `/api/demo/session/evaluations/${id}/decision`, { token: v.token, body: { outcome: 'shortlist', reason } });
    assert.equal(decided.status, 201);

    const after = await fetchAll(h, v, id);
    const items = buildTimeline(after.events as never, after.detail as never);
    const last = items.at(-1);

    assert.equal(items.length, pristine.events.length + 1);
    assert.equal(last?.isDecision, true);
    assert.equal(last?.title, 'Demo recruiter decision: Advance');
    assert.equal(last?.actor, 'Demo recruiter');
    assert.ok(Date.parse(last?.at ?? '') >= decidedAfter, 'the decision does not carry the time it was made');
    assert.deepEqual(items.slice(0, -1).map((i) => i.at), buildTimeline(pristine.events as never, pristine.detail as never).map((i) => i.at), 'earlier events changed');

    const lines = Object.fromEntries((last?.details ?? []).map((d) => [d.label, d.value]));
    assert.equal(lines['Reason'], reason);
    assert.match(lines['Recorded by'] ?? '', new RegExp(`Demo recruiter \\(${DEMO_ACTOR}\\)`));
    assert.match(lines['Scope'] ?? '', /only in your private demo session/);

    const decide = pipelineFor(after, id).find((s) => s.id === 'decide');
    assert.equal(decide?.status, 'recorded');
    assert.equal(decide?.explanation, 'Demo recruiter decision recorded in this private demo session.');
    assert.equal(decide?.at, last?.at);
    assert.doesNotMatch(JSON.stringify(items), UUID);
  });
});

test('another visitor\'s timeline, pipeline and resume are unchanged by a decision', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const b = await visitor(h);
    const id = await evaluationOf(h, b, 'demo-002');

    const view = async (v: Visitor) => {
      const all = await fetchAll(h, v, id);
      return JSON.stringify([all.text, pipelineFor(all, id), buildTimeline(all.events as never, all.detail as never)]);
    };
    const before = await view(b);

    assert.equal((await h.call('POST', `/api/demo/session/evaluations/${id}/decision`, { token: a.token, body: { outcome: 'reject', reason: 'Visitor A deciding in their own copy.' } })).status, 201);

    assert.equal(await view(b), before, 'a decision by A changed what B can see');
    assert.notEqual(await view(a), before, 'precondition: A\'s own view did change');
  });
});

test('demo audit data comes only from the visitor\'s own sandbox', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const id = await evaluationOf(h, a, 'demo-001');
    const { events } = await fetchAll(h, a, id);

    // None of the visitor's event ids exist in the canonical audit trail.
    const canonicalIds = new Set((await h.ctx.db.query<{ id: string }>('SELECT id FROM audit_events')).map((r) => r.id));
    assert.ok(canonicalIds.size > 20, 'precondition: the canonical trail is populated');
    for (const event of events) assert.ok(!canonicalIds.has(event.id), 'a canonical event is in the visitor\'s trail');

    // And the canonical recruiter's decision, recorded in the harness, never appears.
    assert.ok(!events.some((e) => e.eventType === 'decision_recorded'), 'the canonical decision leaked into a session');
    assert.ok(!JSON.stringify(events).includes('Recorded by the recruiter, canonically.'));
  });
});

test('reset removes the visitor\'s decision from the timeline and the pipeline, and touches no one else', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const b = await visitor(h);
    const id = await evaluationOf(h, a, 'demo-001');

    const render = async (v: Visitor) => {
      const all = await fetchAll(h, v, id);
      return JSON.stringify([all.text, pipelineFor(all, id), buildTimeline(all.events as never, all.detail as never)]);
    };
    const pristine = await render(a);
    const canonicalBefore = await canonicalSnapshot(h.ctx);

    for (const who of [a, b]) {
      assert.equal((await h.call('POST', `/api/demo/session/evaluations/${id}/decision`, { token: who.token, body: { outcome: 'hold', reason: 'Synthetic reason to be cleared by reset.' } })).status, 201);
    }
    const bDecided = await render(b);
    assert.notEqual(await render(a), pristine);

    assert.equal((await h.call('POST', '/api/demo/session/reset', { token: a.token })).status, 200);

    assert.equal(await render(a), pristine, 'reset did not restore the original timeline and pipeline');
    const after = await fetchAll(h, a, id);
    assert.equal(buildTimeline(after.events as never, after.detail as never).some((i) => i.isDecision), false);
    assert.equal(pipelineFor(after, id).find((s) => s.id === 'decide')?.status, 'not_run');

    assert.equal(await render(b), bDecided, 'A\'s reset changed B\'s timeline');
    assert.equal(await canonicalSnapshot(h.ctx), canonicalBefore);
  });
});

test('ending a session makes its timeline and resume unreachable', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const id = await evaluationOf(h, a, 'demo-001');
    assert.equal((await h.call('GET', `/api/demo/session/evaluations/${id}/resume`, { token: a.token })).status, 200);

    assert.equal((await h.call('DELETE', '/api/demo/session', { token: a.token })).status, 200);

    for (const suffix of ['', '/audit', '/resume']) {
      assert.equal((await h.call('GET', `/api/demo/session/evaluations/${id}${suffix}`, { token: a.token })).status, 401, suffix || 'detail');
    }
  });
});

test('nothing in any of this touches the canonical database', async () => {
  await withHarness(async (h) => {
    const before = await canonicalSnapshot(h.ctx);

    const a = await visitor(h);
    const b = await visitor(h);
    for (const who of [a, b]) {
      for (const candidate of DEMO_CANDIDATES) {
        const id = await evaluationOf(h, who, candidate.reference);
        await fetchAll(h, who, id);
        await h.call('POST', `/api/demo/session/evaluations/${id}/decision`, { token: who.token, body: { outcome: 'hold', reason: 'Synthetic reason for the snapshot test.' } });
      }
    }
    await h.call('POST', '/api/demo/session/reset', { token: a.token });
    await h.call('GET', `/api/demo/session/evaluations/${h.canonicalEvaluations.get('demo-001')}/resume`, { token: a.token });
    await h.call('DELETE', '/api/demo/session', { token: b.token });

    assert.equal(await canonicalSnapshot(h.ctx), before, 'a canonical row changed');
  });
});
