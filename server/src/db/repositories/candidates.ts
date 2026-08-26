import { createHash } from 'node:crypto';
import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toNumber, toBool } from '../rows.ts';
import type { RepoDeps, ListOptions } from './types.ts';
import type {
  Candidate,
  CandidateSource,
  Resume,
  SensitiveCategory,
  SensitiveFinding,
} from '../../domain/ats.ts';

// Candidates, their resumes, and the quarantine.
//
// The split between `reference` and `displayName` is the fairness boundary made
// structural: the reference is what the system passes around, and the name is a
// column the scorer has no reason to read. P3-D asserts that by changing the
// name and requiring the score not to move.

function mapCandidate(row: Record<string, unknown>): Candidate {
  return {
    id: toText(row.id),
    reference: toText(row.reference),
    displayName: toTextOrNull(row.display_name),
    source: toText(row.source) as CandidateSource,
    createdAt: toText(row.created_at),
  };
}

function mapResume(row: Record<string, unknown>): Resume {
  return {
    id: toText(row.id),
    candidateId: toText(row.candidate_id),
    contentText: toText(row.content_text),
    redactedText: toText(row.redacted_text),
    contentHash: toText(row.content_hash),
    charCount: toNumber(row.char_count),
    ingestedAt: toText(row.ingested_at),
  };
}

function mapFinding(row: Record<string, unknown>): SensitiveFinding {
  return {
    id: toText(row.id),
    resumeId: toText(row.resume_id),
    category: toText(row.category) as SensitiveCategory,
    charStart: toNumber(row.char_start),
    charEnd: toNumber(row.char_end),
    createdAt: toText(row.created_at),
  };
}

/** Content-derived, so the same document uploaded twice is recognised as one. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export type CreateCandidateInput = {
  reference: string;
  displayName?: string | null;
  source: CandidateSource;
};

export type CreateResumeInput = {
  candidateId: string;
  contentText: string;
  /** What the model will be shown. P3-C computes it; P3-B just stores it. */
  redactedText: string;
};

export function createCandidateRepository({ db, clock, newId }: RepoDeps) {
  return {
    async create(input: CreateCandidateInput): Promise<Candidate> {
      const id = newId();
      const { sql, params } = buildInsert('candidates', {
        id,
        reference: input.reference,
        display_name: input.displayName ?? null,
        source: input.source,
        created_at: clock.nowIso(),
      });
      await db.execute(sql, params);
      return (await this.getById(id)) as Candidate;
    },

    async getById(id: string): Promise<Candidate | null> {
      const rows = await db.query('SELECT * FROM candidates WHERE id = ?', [id]);
      return rows[0] ? mapCandidate(rows[0] as Record<string, unknown>) : null;
    },

    async findByReference(reference: string): Promise<Candidate | null> {
      const rows = await db.query('SELECT * FROM candidates WHERE reference = ?', [reference]);
      return rows[0] ? mapCandidate(rows[0] as Record<string, unknown>) : null;
    },

    /**
     * Many candidates in one query.
     *
     * Ranking needs a name for every row it is about to show. Fetching them one
     * at a time is how a list screen quietly becomes N+1 — Project 2 shipped
     * exactly that and it cost ten seconds a page.
     */
    async listByIds(ids: readonly string[]): Promise<Candidate[]> {
      if (ids.length === 0) return [];
      const rows = await db.query(
        `SELECT * FROM candidates WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY reference`,
        [...ids],
      );
      return rows.map((row) => mapCandidate(row as Record<string, unknown>));
    },

    async list(options: ListOptions = {}): Promise<Candidate[]> {
      const rows = await db.query('SELECT * FROM candidates ORDER BY reference LIMIT ? OFFSET ?', [
        Math.min(options.limit ?? 100, 500),
        options.offset ?? 0,
      ]);
      return rows.map((row) => mapCandidate(row as Record<string, unknown>));
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM candidates');
      return toNumber(rows[0]?.n ?? 0);
    },
  };
}

export function createResumeRepository({ db, clock, newId }: RepoDeps) {
  return {
    /**
     * Stores a resume, or returns the one already stored.
     *
     * Idempotent by content hash: re-uploading the same document must not
     * create a second resume, because every evidence offset is an offset into
     * one specific `content_text` and two copies would silently split the
     * evidence for one person across two records.
     */
    async insertIfNew(input: CreateResumeInput): Promise<{ resume: Resume; created: boolean }> {
      const contentHash = hashContent(input.contentText);

      const existing = await db.query(
        'SELECT * FROM resumes WHERE candidate_id = ? AND content_hash = ?',
        [input.candidateId, contentHash],
      );
      if (existing[0]) {
        return { resume: mapResume(existing[0] as Record<string, unknown>), created: false };
      }

      const id = newId();
      const { sql, params } = buildInsert('resumes', {
        id,
        candidate_id: input.candidateId,
        content_text: input.contentText,
        redacted_text: input.redactedText,
        content_hash: contentHash,
        char_count: input.contentText.length,
        ingested_at: clock.nowIso(),
      });
      await db.execute(sql, params);

      return { resume: (await this.getById(id)) as Resume, created: true };
    },

    async getById(id: string): Promise<Resume | null> {
      const rows = await db.query('SELECT * FROM resumes WHERE id = ?', [id]);
      return rows[0] ? mapResume(rows[0] as Record<string, unknown>) : null;
    },

    async latestForCandidate(candidateId: string): Promise<Resume | null> {
      const rows = await db.query(
        'SELECT * FROM resumes WHERE candidate_id = ? ORDER BY ingested_at DESC LIMIT 1',
        [candidateId],
      );
      return rows[0] ? mapResume(rows[0] as Record<string, unknown>) : null;
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM resumes');
      return toNumber(rows[0]?.n ?? 0);
    },
  };
}

export function createSensitiveFindingRepository({ db, clock, newId }: RepoDeps) {
  return {
    /**
     * Records that a protected attribute was found, and where.
     *
     * Note what this method cannot do: store the value. The category and the
     * span are enough to show a recruiter what was excluded, and keeping the
     * value would undo the exclusion.
     */
    async record(input: {
      resumeId: string;
      category: SensitiveCategory;
      charStart: number;
      charEnd: number;
    }): Promise<SensitiveFinding> {
      const id = newId();
      const { sql, params } = buildInsert('sensitive_findings', {
        id,
        resume_id: input.resumeId,
        category: input.category,
        char_start: input.charStart,
        char_end: input.charEnd,
        created_at: clock.nowIso(),
      });
      await db.execute(sql, params);

      const rows = await db.query('SELECT * FROM sensitive_findings WHERE id = ?', [id]);
      return mapFinding(rows[0] as Record<string, unknown>);
    },

    async listForResume(resumeId: string): Promise<SensitiveFinding[]> {
      const rows = await db.query(
        'SELECT * FROM sensitive_findings WHERE resume_id = ? ORDER BY char_start',
        [resumeId],
      );
      return rows.map((row) => mapFinding(row as Record<string, unknown>));
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM sensitive_findings');
      return toNumber(rows[0]?.n ?? 0);
    },
  };
}

export { mapCandidate, mapResume, mapFinding, toBool };
