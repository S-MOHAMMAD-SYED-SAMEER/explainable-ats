// The demo's fixed scenarios.
//
// The five candidates a visitor's session is seeded with, named by a literal list.
//
// A literal array, not `DEMO_CANDIDATES.map(c => c.reference)`. Deriving the
// allow-list from the dataset would mean a candidate added to `dataset.ts` for an
// unrelated reason — a future evaluation fixture, say — became part of the public
// demo the moment it was added. Naming the five ids here means a sixth one stays
// private until somebody edits this array on purpose. A test asserts the list and
// the dataset agree.

export const DEMO_SCENARIO_IDS = ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005'] as const;
export type DemoScenarioId = (typeof DEMO_SCENARIO_IDS)[number];

/** Whether a value is one of the fixed scenario ids. */
export function isDemoScenarioId(value: unknown): value is DemoScenarioId {
  return typeof value === 'string' && (DEMO_SCENARIO_IDS as readonly string[]).includes(value);
}
