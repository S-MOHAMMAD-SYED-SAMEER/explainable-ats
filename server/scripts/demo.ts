import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `npm run demo` (from the repository root, or from `server/` once the
// dashboard has been built)
//
// Starts the app in demo mode — `APP_MODE=demo` — which is the way to try it
// with nothing set up: no sign-in, no database, no migrations, no API key. Each
// browser session gets a private in-memory copy of five invented candidates
// (Section 5 of the README). The server also serves the built dashboard from the
// same origin, so there is nothing else to start.
//
// It is a wrapper over `npm start` with the environment pinned; it adds no
// behaviour of its own to the application.
//
// WHY IT SETS THE ENVIRONMENT, AND WHY TO EMPTY STRINGS
//
// Demo mode refuses to start if DATABASE_URL, OPERATOR_PASSWORD_HASH or
// ANTHROPIC_API_KEY is set, or if LLM_PROVIDER or SQLITE_PATH is anything but
// the mock / in-memory values (Section 14) — deliberately, so a demo created
// from the real application's settings fails where it is seen. That is the
// right behaviour for a deployment and an annoying one on a laptop that has a
// key in its environment or a `.env` from other work. A variable that is already
// set — even to an empty string — is never overridden by `.env` (Node's
// `loadEnvFile`), so blanking them here is enough, and the app's own checks stay
// exactly as they were.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT?.trim() || '3200';

const env: NodeJS.ProcessEnv = {
  ...process.env,
  APP_MODE: 'demo',
  PORT: port,
  DATABASE_URL: '',
  OPERATOR_PASSWORD_HASH: '',
  ANTHROPIC_API_KEY: '',
  LLM_PROVIDER: 'mock',
  SQLITE_PATH: '',
  // The demo has no sessions to protect, but the app reports a Secure-cookie
  // setting at boot; over http://localhost browsers refuse Secure cookies.
  COOKIE_SECURE: 'false',
};

console.log(`[demo] Open http://localhost:${port}/#/demo\n`);

const child = spawn(process.execPath, ['src/index.ts'], { cwd: SERVER_ROOT, env, stdio: 'inherit' });
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
