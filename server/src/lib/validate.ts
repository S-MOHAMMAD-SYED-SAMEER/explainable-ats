import { ValidationError } from './errors.ts';

// Hand-written validation, no schema library.
//
// sales-recovery-agent made this call for its eval dataset and the reasoning holds here:
// for shapes this small and this stable, a validation library is a dependency,
// a bundle, and a DSL to learn, in exchange for something forty lines of
// TypeScript already do — while a hand-written validator can produce error
// messages written for the person reading them.
//
// The collector pattern (accumulate every problem, then throw once) is the part
// that matters. A validator that throws on the first problem makes fixing a
// malformed request an N-round-trip conversation.

export class ProblemCollector {
  private readonly problems: string[] = [];

  add(problem: string): void {
    this.problems.push(problem);
  }

  get count(): number {
    return this.problems.length;
  }

  list(): readonly string[] {
    return [...this.problems];
  }

  throwIfAny(message?: string): void {
    if (this.problems.length > 0) {
      throw message ? new ValidationError(this.problems, message) : new ValidationError(this.problems);
    }
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function requireObject(value: unknown, field: string, problems: ProblemCollector): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.add(`"${field}" must be an object (received ${typeOf(value)})`);
    return {};
  }
  return value as Record<string, unknown>;
}

export function requireString(
  value: unknown,
  field: string,
  problems: ProblemCollector,
  options: { maxLength?: number; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    problems.add(`"${field}" is required and must be a string (received ${typeOf(value)})`);
    return '';
  }
  if (!options.allowEmpty && value.trim() === '') {
    problems.add(`"${field}" must not be empty`);
    return '';
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    problems.add(`"${field}" must be at most ${options.maxLength} characters (received ${value.length})`);
  }
  return value;
}

export function requireOneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  problems: ProblemCollector,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    problems.add(`"${field}" must be one of: ${allowed.join(', ')} (received ${JSON.stringify(value)})`);
    return allowed[0] as T;
  }
  return value as T;
}
