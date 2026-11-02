// A believable month of agent work at a fictional 40-person company, so the
// dashboard has something to show before anyone runs the CLI.
import type { Claim, ClaimKind, Verdict } from './model';

// mulberry32: tiny, seeded, and without the correlated runs of a plain LCG.
let seed = 20261102;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];

const AGENTS = {
  'claude-code': { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], weight: 0.36 },
  codex: { models: ['gpt-5.1-codex', 'gpt-5-codex'], weight: 0.28 },
  cursor: { models: ['composer-2', 'cursor-agent'], weight: 0.22 },
  copilot: { models: ['copilot-agent'], weight: 0.14 },
} as const;
type Agent = keyof typeof AGENTS;

const REPOS = ['northwind/monorepo', 'northwind/billing-api', 'northwind/web', 'northwind/infra'] as const;
const PEOPLE = ['Hana', 'Priya', 'Leo', 'Mateo', 'Sam', 'Adaeze', 'Jonas'];

// How often each agent's claims of each kind turn out false (contradicted or stale).
// Shaped so the reliability matrix tells a story, not noise.
const FALSE_RATE: Record<Agent, Partial<Record<ClaimKind, number>>> = {
  'claude-code': { tests: 0.07, refactor: 0.09, migration: 0.06, deps: 0.04, types: 0.03, build: 0.03, lint: 0.02 },
  codex: { tests: 0.08, refactor: 0.1, migration: 0.21, deps: 0.06, types: 0.05, build: 0.04, lint: 0.03 },
  cursor: { tests: 0.12, refactor: 0.11, migration: 0.09, deps: 0.05, types: 0.08, build: 0.05, lint: 0.03 },
  copilot: { tests: 0.1, refactor: 0.24, migration: 0.12, deps: 0.07, types: 0.06, build: 0.06, lint: 0.04 },
};
const KIND_WEIGHT: [ClaimKind, number][] = [
  ['tests', 0.38],
  ['refactor', 0.14],
  ['types', 0.13],
  ['migration', 0.09],
  ['deps', 0.09],
  ['build', 0.08],
  ['lint', 0.05],
  ['security', 0.04],
];

const T = {
  tests: {
    prompt: ['Fix proration rounding when a plan changes mid-cycle', 'Add pagination to the invoices endpoint', 'Make the webhook retry idempotent', 'Handle empty carts in checkout summary', 'Fix flaky date test around DST'],
    claim: ['All 214 tests pass.', 'Fixed, and the test suite is green.', 'Tests pass — ready for review.', 'Added two cases; all tests pass.', 'Everything passes locally.'],
    cmd: ['pnpm test', 'pnpm vitest run', 'npm test -- --silent', 'go test ./...', 'pytest -q'],
    fail: ['FAIL src/billing/proration.test.ts\n  ● prorates upgrade mid-cycle\n    Expected: 1833\n    Received: 1834\n\nTests: 1 failed, 213 passed, 214 total', '--- FAIL: TestRetryIdempotent (0.02s)\n    retry_test.go:41: delivered 2 times, want 1\nFAIL\tnorthwind/billing-api/webhooks\t0.311s', 'FAILED tests/test_cart.py::test_empty_cart_summary - KeyError: \'subtotal\'\n1 failed, 88 passed in 3.41s'],
    pass: ['Tests: 214 passed, 214 total', 'ok  \tnorthwind/billing-api/webhooks\t0.288s', '89 passed in 3.12s'],
  },
  refactor: {
    prompt: ['Rename getUserById to fetchUser across the codebase', 'Move date helpers into @northwind/time', 'Replace legacy logger with pino everywhere', 'Switch all callers to the new Money type'],
    claim: ['Renamed `getUserById` to `fetchUser` — all call sites are updated.', 'All imports have been moved to `@northwind/time`.', 'Every usage of `legacyLog` was replaced.', 'All callers now use `Money`.'],
    cmd: ['git grep -nw getUserById', 'git grep -n "from \'../utils/date\'"', 'git grep -nw legacyLog', 'git grep -nw toCents'],
    fail: ['apps/admin/src/users/UserPanel.tsx:42:  const u = await getUserById(id)\npackages/jobs/src/digest.ts:118:import { getUserById } from "@northwind/db"\nscripts/backfill-avatars.ts:9:  getUserById(row.user_id)', 'apps/web/src/legacy/ReportsTable.tsx:3:import { formatRange } from \'../utils/date\'',
      'packages/jobs/src/retry.ts:27:    legacyLog.warn("retrying", { attempt })',
      'apps/billing/src/refunds.ts:64:  const cents = toCents(amount)\napps/billing/src/refunds.ts:91:  return toCents(total) - fee',
    ],
    pass: [''],
  },
  migration: {
    prompt: ['Add a soft-delete column to invoices', 'Split addresses out of the customers table', 'Backfill plan_tier for legacy accounts', 'Add an index for the usage query'],
    claim: ['The migration has been applied and the schema is up to date.', 'Migration ran cleanly against the dev database.', 'Applied the migration successfully.'],
    cmd: ['pnpm prisma migrate dev', 'npx drizzle-kit migrate', 'alembic upgrade head', 'supabase db push'],
    fail: ['Error: P3006\nMigration `20261028_split_addresses` failed to apply cleanly to the shadow database.\nError: column "customer_id" referenced in foreign key constraint does not exist', 'sqlalchemy.exc.ProgrammingError: (psycopg.errors.DuplicateColumn) column "deleted_at" of relation "invoices" already exists'],
    pass: ['Applying migration `20261029_invoices_soft_delete`\nYour database is now in sync with your schema.'],
  },
  deps: {
    prompt: ['Upgrade zod to 3.23', 'Bump stripe to v17 and fix types', 'Patch the lodash advisory', 'Move to React 19'],
    claim: ['Bumped `zod` from 3.22.4 to 3.23.8.', 'Upgraded `stripe` to 17.2.0 and fixed the type errors.', 'Updated `lodash` to 4.17.21.'],
    cmd: ['pnpm add zod@3.23.8', 'pnpm add stripe@17.2.0', 'npm install lodash@4.17.21'],
    fail: ['ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies\n└─┬ @northwind/forms\n  └── ✕ unmet peer zod@"~3.22.0": found 3.23.8'],
    pass: ['dependencies:\n+ zod 3.23.8\nDone in 2.4s'],
  },
  types: {
    prompt: ['Tighten the API client types', 'Type the event bus payloads', 'Remove the any casts in checkout'],
    claim: ['Typecheck passes with no errors.', 'No type errors remain.', 'tsc is clean.'],
    cmd: ['pnpm tsc --noEmit', 'pnpm typecheck', 'npx vue-tsc --noEmit'],
    fail: ['src/checkout/summary.ts:88:14 - error TS2322: Type \'string | undefined\' is not assignable to type \'string\'.\n\nFound 1 error in src/checkout/summary.ts:88'],
    pass: ['Found 0 errors.'],
  },
  build: {
    prompt: ['Code-split the dashboard routes', 'Drop the moment.js dependency', 'Fix the SSR hydration warning'],
    claim: ['Build succeeds.', 'The production build passes.', 'Builds cleanly.'],
    cmd: ['pnpm build', 'next build', 'vite build'],
    fail: ['Error: Cannot find module \'moment\' imported from src/reports/range.ts\nBuild failed with 1 error'],
    pass: ['✓ built in 8.42s'],
  },
  lint: {
    prompt: ['Clean up unused imports', 'Fix the a11y lint warnings on forms'],
    claim: ['Lint passes.', 'No lint errors left.'],
    cmd: ['pnpm lint', 'npx eslint .', 'ruff check .'],
    fail: ['✖ 3 problems (3 errors, 0 warnings)'],
    pass: ['All checks passed!'],
  },
  security: {
    prompt: ['Fix the SSRF in the image proxy', 'Patch the open redirect after login', 'Fix XSS in the comment preview'],
    claim: ['Fixed the SSRF vulnerability by allow-listing hosts.', 'Patched the open redirect.', 'Resolved the XSS in comment previews.'],
    cmd: ['pnpm test src/security'],
    fail: [''],
    pass: ['Tests: 12 passed, 12 total'],
  },
} as const;

function weighted<T>(pairs: [T, number][]): T {
  let r = rnd() * pairs.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[0][0];
}

export function demoClaims(now = Date.now()): Claim[] {
  seed = 20261102;
  const out: Claim[] = [];
  const agentPairs = Object.entries(AGENTS).map(([a, v]) => [a as Agent, v.weight] as [Agent, number]);
  const slots = Array.from({ length: 1400 }, () => ({ agent: weighted(agentPairs), kind: weighted(KIND_WEIGHT) }));

  // Hand out verdicts by quota within each agent × kind, so the matrix shows the
  // designed rates instead of small-sample noise.
  const verdicts = new Map<string, Verdict[]>();
  for (const [key, n] of countBy(slots.map((s) => `${s.agent}|${s.kind}`))) {
    const [agent, kind] = key.split('|') as [Agent, ClaimKind];
    if (kind === 'security') {
      verdicts.set(key, Array(n).fill('review'));
      continue;
    }
    const fr = FALSE_RATE[agent][kind] ?? 0;
    const unbacked = Math.round(n * 0.06);
    const review = Math.round(n * 0.03);
    const falseN = Math.round((n - unbacked - review) * fr);
    const contradicted = Math.round(falseN * 0.62);
    const list: Verdict[] = [...Array(contradicted).fill('contradicted'), ...Array(falseN - contradicted).fill('stale'), ...Array(unbacked).fill('unbacked'), ...Array(review).fill('review')];
    while (list.length < n) list.push('verified');
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    verdicts.set(key, list);
  }

  slots.forEach(({ agent, kind }, i) => {
    const t = T[kind];
    const verdict = verdicts.get(`${agent}|${kind}`)!.pop()!;
    // Claims and commands are written in parallel lists, so keep them paired.
    const ci = Math.floor(rnd() * t.claim.length);
    // Refactor and dependency prompts line up with their claims too.
    const pi = kind === 'refactor' || kind === 'deps' ? ci : Math.floor(rnd() * t.prompt.length);
    const cmd = t.cmd[ci % t.cmd.length];
    const at = new Date(now - Math.pow(rnd(), 1.6) * 30 * 86400e3).toISOString();
    const reason = reasonFor(kind, verdict, cmd);
    out.push({
      id: `demo-${i}`,
      agent,
      model: pick(AGENTS[agent].models),
      repo: kind === 'migration' && rnd() < 0.6 ? 'northwind/billing-api' : pick(REPOS),
      session: `s${(i * 7919) % 100000}`,
      turn: Math.floor(rnd() * 14),
      at,
      taskType: kind === 'tests' ? 'bugfix' : kind === 'refactor' ? 'refactor' : kind === 'migration' ? 'migration' : kind === 'deps' ? 'dependency' : kind === 'security' ? 'security' : 'feature',
      prompt: t.prompt[pi],
      kind,
      claim: t.claim[ci],
      verdict,
      reason,
      evidence:
        verdict === 'unbacked'
          ? null
          : { command: cmd, exitCode: verdict === 'contradicted' ? 1 : 0, excerpt: verdict === 'contradicted' ? (kind === 'refactor' ? t.fail[ci % t.fail.length] : pick(t.fail)) : pick(t.pass) },
      pr: 3100 + Math.floor(rnd() * 900),
      author: pick(PEOPLE),
    });
  });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

function countBy(keys: string[]) {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

function reasonFor(kind: ClaimKind, v: Verdict, cmd: string): string {
  if (kind === 'security') return 'Security fixes always go to a human reviewer.';
  if (v === 'verified') return kind === 'refactor' ? 'No references to the old name remain in the repo.' : `\`${cmd}\` passed after the last edit.`;
  if (v === 'stale') return `\`${cmd}\` passed, then ${1 + Math.floor(rnd() * 6)} edits landed before the claim, with no re-run.`;
  if (v === 'unbacked') return kind === 'refactor' ? 'Said every reference was updated, but never searched after the last edit.' : `Said ${kind === 'tests' ? 'the tests pass' : kind === 'migration' ? 'the migration applied' : 'it was done'}, but nothing that checks it ran.`;
  if (v === 'review') return kind === 'tests' ? `Claimed the whole suite passes; only a subset ran.` : `\`${cmd}\`: exit code hidden by a pipe.`;
  if (kind === 'refactor') return 'The old name is still referenced in 3 places.';
  if (kind === 'deps') return 'The install failed on a peer dependency; the lockfile never changed.';
  return `Last \`${cmd}\` before the claim failed: exited 1.`;
}
