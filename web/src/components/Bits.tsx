import type { ReactNode } from 'react';
import { toneClass, type Wording } from '../copy.ts';

// Small shared pieces. No hooks in this file at all, which keeps it outside the
// hook-order question entirely.

export function Loading({ what }: { what: string }): ReactNode {
  return <p className="text-small text-ink-muted">Loading {what}…</p>;
}

export function Problem({ message }: { message: string }): ReactNode {
  return (
    <div className="rounded-control border border-line bg-danger-tint p-4">
      <p className="text-small font-semibold text-danger">That did not load</p>
      <p className="mt-1 text-small text-ink-muted">{message}</p>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="rounded-control border border-dashed border-line-strong p-6 text-center">
      <p className="text-small text-ink-muted">{children}</p>
    </div>
  );
}

/**
 * A status word.
 *
 * The tone is carried by the word as well as the colour. Status communicated by
 * colour alone excludes anyone who cannot distinguish the two, and on this
 * screen the status is the whole message.
 */
export function Badge({ wording }: { wording: Wording }): ReactNode {
  return (
    <span
      className={`inline-flex items-center rounded-control border border-line-strong px-2 py-1 text-meta font-semibold ${toneClass(
        wording.tone,
      )}`}
    >
      {wording.label}
    </span>
  );
}

/**
 * The optional technical area.
 *
 * A native `<details>`: it is keyboard accessible, screen-reader announced and
 * printable without a line of JavaScript, and it keeps model names, prompt
 * versions and basis points out of the primary reading path — where they are
 * noise to a recruiter and reassurance to nobody.
 */
export function Technical({ summary, children }: { summary: string; children: ReactNode }): ReactNode {
  return (
    <details className="mt-3 rounded-control border border-line bg-canvas p-3">
      <summary className="cursor-pointer text-meta font-semibold text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
        {summary}
      </summary>
      <div className="mt-2 space-y-1 text-meta text-ink-muted">{children}</div>
    </details>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return (
    <a
      href={href}
      className="text-small font-semibold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      ← {children}
    </a>
  );
}
