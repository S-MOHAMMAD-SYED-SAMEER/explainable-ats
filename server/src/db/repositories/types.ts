import type { Database } from '../types.ts';
import type { Clock } from '../../lib/clock.ts';
import type { IdGenerator } from '../../lib/ids.ts';

// What every repository is handed.
//
// The clock and the id generator are injected rather than imported so a test
// can make both deterministic. That is what lets a fixture assert an exact
// timestamp or an exact id without freezing the whole process.

export type RepoDeps = {
  db: Database;
  clock: Clock;
  newId: IdGenerator;
};

export type ListOptions = { limit?: number; offset?: number };
