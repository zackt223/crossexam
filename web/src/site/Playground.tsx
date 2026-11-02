import { useMemo, useState } from 'react';
// The same detector the CLI runs, so what you see here is what crossexam does.
import { detectClaims } from '../../../cli/src/claims.js';

type Kind = 'tests' | 'build' | 'types' | 'lint' | 'refactor' | 'migration' | 'deps' | 'security';
type Verdict = 'verified' | 'contradicted' | 'stale' | 'unbacked' | 'review';
type Run = 'pass' | 'fail' | 'none';
interface World {
  tests: Run;
  editedAfter: boolean;
  build: Run;
  refs: number;
  depsUpdated: boolean;
}
interface Claim {
  kind: Kind;
  sentence: string;
  subject?: { from?: string; to?: string; pkg?: string; version?: string };
}

const PRESETS: { name: string; text: string; world: World }[] = [
  { name: 'the classic', text: 'Fixed the off-by-one cent on plan upgrades. All 214 tests pass and the build is clean.', world: { tests: 'fail', editedAfter: false, build: 'pass', refs: 0, depsUpdated: true } },
  { name: 'stale green', text: 'Added pagination to the invoices list. Tests are passing, ready for review.', world: { tests: 'pass', editedAfter: true, build: 'pass', refs: 0, depsUpdated: true } },
  { name: 'the rename', text: 'Renamed `getUserById` to `fetchUser` — all call sites have been updated.', world: { tests: 'pass', editedAfter: false, build: 'pass', refs: 3, depsUpdated: true } },
  { name: 'the bump', text: 'Bumped zod from 3.22.4 to 3.23.8 and fixed the schema types. Typecheck passes.', world: { tests: 'none', editedAfter: false, build: 'pass', refs: 0, depsUpdated: false } },
  { name: 'never checked', text: 'Done! The migration has been applied and all tests pass.', world: { tests: 'none', editedAfter: false, build: 'none', refs: 0, depsUpdated: true } },
  { name: 'honest one', text: 'Fixed the DST bug in the scheduler. All tests pass.', world: { tests: 'pass', editedAfter: false, build: 'pass', refs: 0, depsUpdated: true } },
];

function judge(c: Claim, w: World): { verdict: Verdict; reason: string; cmd?: string; out?: string } {
  const run = (r: Run, cmd: string, failOut: string, passOut: string, label: string) => {
    if (r === 'none') return { verdict: 'unbacked' as const, reason: `nothing ran that could back it. no ${label} after the last edit.` };
    if (r === 'fail') return { verdict: 'contradicted' as const, reason: `the last ${cmd} before this claim failed.`, cmd, out: failOut };
    if (w.editedAfter && label === 'test run') return { verdict: 'stale' as const, reason: `${cmd} passed, then code changed, and it never re-ran.`, cmd, out: passOut + '\n…then 4 edits, no re-run' };
    return { verdict: 'verified' as const, reason: `${cmd} passed after the last edit.`, cmd, out: passOut };
  };
  switch (c.kind) {
    case 'tests':
      return run(w.tests, 'pnpm test', 'FAIL  src/billing/proration.test.ts\nTests: 1 failed, 213 passed, 214 total', 'Tests: 214 passed, 214 total', 'test run');
    case 'build':
    case 'types':
    case 'lint':
      return run(w.build, c.kind === 'types' ? 'tsc --noEmit' : c.kind === 'lint' ? 'eslint .' : 'pnpm build', c.kind === 'types' ? "src/schema.ts:41:7 - error TS2322: Type 'string' is not assignable to type 'number'." : 'Build failed with 1 error', c.kind === 'types' ? 'Found 0 errors.' : '✓ built in 8.4s', 'build or typecheck');
    case 'refactor': {
      const sym = c.subject?.from;
      if (!sym) return { verdict: 'review', reason: 'no name in `backticks`, so there is nothing to search for.' };
      const hits = ['apps/admin/UserPanel.tsx:42', 'packages/jobs/digest.ts:118', 'scripts/backfill.ts:9', 'apps/web/Profile.tsx:17', 'packages/api/auth.ts:63'].slice(0, w.refs);
      return w.refs
        ? { verdict: 'contradicted', reason: `${sym} is still referenced in ${w.refs} place${w.refs === 1 ? '' : 's'}.`, cmd: `git grep -nw ${sym}`, out: hits.map((h) => `${h}:  ${sym}(…)`).join('\n') }
        : { verdict: 'verified', reason: `no references to ${sym} remain.`, cmd: `git grep -nw ${sym}`, out: '(no matches)' };
    }
    case 'deps': {
      const { pkg = 'the package', version = '?' } = c.subject || {};
      return w.depsUpdated
        ? { verdict: 'verified', reason: `package.json has ${pkg} at ^${version}.`, cmd: 'read package.json', out: `"${pkg}": "^${version}"` }
        : { verdict: 'contradicted', reason: `package.json still says ${pkg} ^3.22.4.`, cmd: 'read package.json', out: `"${pkg}": "^3.22.4"` };
    }
    case 'migration':
      return { verdict: 'review', reason: 'crossexam never touches your database. a human, or a read-only status command, signs this off.' };
    default:
      return { verdict: 'review', reason: 'security fixes always go to a human reviewer.' };
  }
}

const LABEL: Record<Verdict, string> = { verified: '✓ verified', contradicted: '✗ contradicted', stale: '◷ stale', unbacked: '○ unbacked', review: '◇ needs review' };

export function Playground() {
  const [preset, setPreset] = useState(0);
  const [text, setText] = useState(PRESETS[0].text);
  const [world, setWorld] = useState<World>(PRESETS[0].world);

  const claims = useMemo(() => {
    const seen = new Map<string, Claim>();
    for (const c of detectClaims(text) as Claim[]) seen.set(c.kind + (c.subject?.from || c.subject?.pkg || ''), c);
    return [...seen.values()].map((c) => ({ ...c, ...judge(c, world) }));
  }, [text, world]);

  const kinds = new Set(claims.map((c) => c.kind));
  const sym = claims.find((c) => c.kind === 'refactor')?.subject?.from;
  const pkg = claims.find((c) => c.kind === 'deps')?.subject?.pkg;
  // An unbacked "done" goes back too: the agent can just go and run the check.
  const bad = claims.some((c) => c.verdict === 'contradicted' || c.verdict === 'stale' || c.verdict === 'unbacked');
  const stamp = !claims.length ? 'none' : bad ? 'bad' : claims.every((c) => c.verdict === 'verified') ? 'good' : 'mixed';

  const set = <K extends keyof World>(k: K, v: World[K]) => setWorld((w) => ({ ...w, [k]: v }));
  const pick = (i: number) => {
    setPreset(i);
    setText(PRESETS[i].text);
    setWorld(PRESETS[i].world);
  };

  return (
    <div className="pg spot">
      <div className="pg-presets" role="group" aria-label="Examples">
        {PRESETS.map((p, i) => (
          <button key={p.name} className={i === preset ? 'on' : ''} onClick={() => pick(i)}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="pg-grid">
        <div className="pg-col">
          <label className="pg-label" htmlFor="pg-text">
            the agent says <span>edit it</span>
          </label>
          <div className="pg-bubble">
            <textarea id="pg-text" value={text} onChange={(e) => setText(e.target.value)} rows={4} spellCheck={false} />
          </div>

          <div className="pg-label">what actually happened</div>
          <div className="pg-world">
            <Row label="test run">
              <Seg value={world.tests} onChange={(v) => set('tests', v)} options={[['pass', 'passed'], ['fail', 'failed'], ['none', 'never ran']]} />
            </Row>
            <Row label="code edited after the tests ran">
              <Switch on={world.editedAfter} onChange={(v) => set('editedAfter', v)} />
            </Row>
            <Row label="build & typecheck">
              <Seg value={world.build} onChange={(v) => set('build', v)} options={[['pass', 'passed'], ['fail', 'failed'], ['none', 'never ran']]} />
            </Row>
            <Row label={<>places still using <code>{sym ?? 'the old name'}</code></>} dim={!kinds.has('refactor')}>
              <div className="pg-step">
                <button onClick={() => set('refs', Math.max(0, world.refs - 1))} aria-label="Fewer">
                  −
                </button>
                <span>{world.refs}</span>
                <button onClick={() => set('refs', Math.min(5, world.refs + 1))} aria-label="More">
                  +
                </button>
              </div>
            </Row>
            <Row label={<>package.json really has the new <code>{pkg ?? 'version'}</code></>} dim={!kinds.has('deps')}>
              <Switch on={world.depsUpdated} onChange={(v) => set('depsUpdated', v)} />
            </Row>
          </div>
        </div>

        <div className="pg-col">
          <div className="pg-label">crossexam’s read</div>
          <ul className="pg-verdicts" aria-live="polite">
            {!claims.length && <li className="pg-empty">no checkable claims yet. try “all tests pass”, “build succeeds”, or “renamed `foo` to `bar` everywhere”.</li>}
            {claims.map((c) => (
              <li key={c.kind + c.sentence + c.verdict} className={`pg-v ${c.verdict}`}>
                <div className="pg-v-head">
                  <span className={`pg-chip ${c.verdict}`}>{LABEL[c.verdict]}</span>
                  <span className="pg-kind">{c.kind}</span>
                </div>
                <div className="pg-claim">“{c.sentence}”</div>
                <div className="pg-reason">{c.reason}</div>
                {c.cmd && (
                  <pre className="pg-term">
                    <span className="p">$ </span>
                    {c.cmd}
                    {'\n'}
                    <span className={c.verdict === 'contradicted' ? 'bad' : c.verdict === 'stale' ? 'warn' : 'ok'}>{c.out}</span>
                  </pre>
                )}
              </li>
            ))}
          </ul>
          <div key={stamp + claims.length} className={`pg-stamp ${stamp}`}>
            {stamp === 'none' ? 'waiting for a claim…' : stamp === 'bad' ? '✗ sent back to the agent' : stamp === 'good' ? '✓ safe to merge' : '◇ a human takes a look'}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children, dim }: { label: React.ReactNode; children: React.ReactNode; dim?: boolean }) {
  return (
    <div className={`pg-row${dim ? ' dim' : ''}`}>
      <span>{label}</span>
      {children}
    </div>
  );
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="pg-seg" role="radiogroup">
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} className={`${value === v ? 'on' : ''} ${v}`} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`pg-switch${on ? ' on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}
