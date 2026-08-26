import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toNumber } from '../rows.ts';
import { NotFoundError } from '../../lib/errors.ts';
import type { RepoDeps, ListOptions } from './types.ts';
import type { Job, JobRequirement, JobStatus, RequirementKind, Seniority } from '../../domain/ats.ts';

// Jobs and their requirements.
//
// A requirement is not a keyword. It carries the sentence that decides whether
// something counts (`criterion`), which is what the model is asked and what the
// recruiter is shown — so the question behind a verdict is always visible.

function mapJob(row: Record<string, unknown>): Job {
  return {
    id: toText(row.id),
    title: toText(row.title),
    seniority: toText(row.seniority) as Seniority,
    description: toText(row.description),
    status: toText(row.status) as JobStatus,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function mapRequirement(row: Record<string, unknown>): JobRequirement {
  return {
    id: toText(row.id),
    jobId: toText(row.job_id),
    label: toText(row.label),
    criterion: toText(row.criterion),
    kind: toText(row.kind) as RequirementKind,
    weight: toNumber(row.weight),
    position: toNumber(row.position),
    createdAt: toText(row.created_at),
  };
}

export type CreateJobInput = {
  title: string;
  seniority: Seniority;
  description?: string;
  status?: JobStatus;
};

export type CreateRequirementInput = {
  jobId: string;
  label: string;
  criterion: string;
  kind: RequirementKind;
  weight: number;
  /** Omitted means "append" — the repository works out the next position. */
  position?: number;
};

export function createJobRepository({ db, clock, newId }: RepoDeps) {
  return {
    async create(input: CreateJobInput): Promise<Job> {
      const now = clock.nowIso();
      const id = newId();

      const { sql, params } = buildInsert('jobs', {
        id,
        title: input.title,
        seniority: input.seniority,
        description: input.description ?? '',
        status: input.status ?? 'draft',
        created_at: now,
        updated_at: now,
      });
      await db.execute(sql, params);

      return (await this.getById(id)) as Job;
    },

    async getById(id: string): Promise<Job | null> {
      const rows = await db.query('SELECT * FROM jobs WHERE id = ?', [id]);
      return rows[0] ? mapJob(rows[0] as Record<string, unknown>) : null;
    },

    async list(options: ListOptions & { status?: JobStatus } = {}): Promise<Job[]> {
      const params: Array<string | number> = [];
      let where = '';
      if (options.status) {
        where = ' WHERE status = ?';
        params.push(options.status);
      }
      const rows = await db.query(
        `SELECT * FROM jobs${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, Math.min(options.limit ?? 100, 500), options.offset ?? 0],
      );
      return rows.map((row) => mapJob(row as Record<string, unknown>));
    },

    async setStatus(id: string, status: JobStatus): Promise<Job | null> {
      const result = await db.execute('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?', [
        status,
        clock.nowIso(),
        id,
      ]);
      if (result.rowCount === 0) return null;
      return this.getById(id);
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM jobs');
      return toNumber(rows[0]?.n ?? 0);
    },
  };
}

export function createRequirementRepository({ db, clock, newId }: RepoDeps) {
  return {
    async create(input: CreateRequirementInput): Promise<JobRequirement> {
      const id = newId();

      // Position is derived rather than demanded from the caller: a UI that
      // has to compute display order is a UI that will eventually get it wrong.
      let position = input.position;
      if (position === undefined) {
        const rows = await db.query<{ n: number }>(
          'SELECT COUNT(*) AS n FROM job_requirements WHERE job_id = ?',
          [input.jobId],
        );
        position = toNumber(rows[0]?.n ?? 0) + 1;
      }

      const { sql, params } = buildInsert('job_requirements', {
        id,
        job_id: input.jobId,
        label: input.label,
        criterion: input.criterion,
        kind: input.kind,
        weight: input.weight,
        position,
        created_at: clock.nowIso(),
      });
      await db.execute(sql, params);

      const created = await this.getById(id);
      if (!created) throw new NotFoundError('Requirement');
      return created;
    },

    async getById(id: string): Promise<JobRequirement | null> {
      const rows = await db.query('SELECT * FROM job_requirements WHERE id = ?', [id]);
      return rows[0] ? mapRequirement(rows[0] as Record<string, unknown>) : null;
    },

    /** In display order — the order a recruiter wrote them, not insertion order. */
    async listForJob(jobId: string): Promise<JobRequirement[]> {
      const rows = await db.query(
        'SELECT * FROM job_requirements WHERE job_id = ? ORDER BY position, created_at',
        [jobId],
      );
      return rows.map((row) => mapRequirement(row as Record<string, unknown>));
    },

    /** The requirements for many jobs at once, to keep a list screen off N+1. */
    async listForJobs(jobIds: readonly string[]): Promise<Map<string, JobRequirement[]>> {
      const byJob = new Map<string, JobRequirement[]>();
      if (jobIds.length === 0) return byJob;

      const rows = await db.query(
        `SELECT * FROM job_requirements WHERE job_id IN (${jobIds.map(() => '?').join(', ')})
         ORDER BY position, created_at`,
        [...jobIds],
      );
      for (const row of rows) {
        const requirement = mapRequirement(row as Record<string, unknown>);
        const list = byJob.get(requirement.jobId) ?? [];
        list.push(requirement);
        byJob.set(requirement.jobId, list);
      }
      return byJob;
    },

    async delete(id: string): Promise<boolean> {
      const result = await db.execute('DELETE FROM job_requirements WHERE id = ?', [id]);
      return result.rowCount > 0;
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM job_requirements');
      return toNumber(rows[0]?.n ?? 0);
    },
  };
}

export { mapJob, mapRequirement, toTextOrNull };
