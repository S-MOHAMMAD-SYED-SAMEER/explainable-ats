import type { ReactNode } from 'react';
import { CONTROL_HELP, GUIDE_STEPS } from '../demo/copy.ts';

// "How this demo works", reachable from the demo's header banner.
//
// A native `<details>`, like `Technical` in Bits.tsx: keyboard accessible,
// announced by screen readers and printable with no JavaScript, and — because it
// holds no state of its own — free of the hook-order question. It is deliberately
// not an onboarding framework: five lines, and what the two header controls do.

export function DemoGuide(): ReactNode {
  return (
    <details className="mt-3 rounded-control border border-line bg-canvas p-3">
      <summary className="cursor-pointer text-small font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
        How this demo works
      </summary>

      <ol className="mt-3 space-y-2">
        {GUIDE_STEPS.map((step, index) => (
          <li key={step.label} className="flex items-start gap-2 text-small">
            <span
              aria-hidden="true"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border border-line-strong text-meta font-semibold text-ink"
            >
              {index + 1}
            </span>
            <span>
              <span className="font-semibold text-ink">{step.label}.</span>{' '}
              <span className="text-ink-muted">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      <ul className="mt-3 space-y-1 text-meta text-ink-muted">
        <li>{CONTROL_HELP.reset}</li>
        <li>{CONTROL_HELP.exit}</li>
      </ul>
    </details>
  );
}
