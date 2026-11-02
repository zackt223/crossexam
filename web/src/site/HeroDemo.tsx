import { useEffect, useState } from 'react';

type Line =
  | { t: 'user'; text: string }
  | { t: 'tool'; name: string; arg: string; out?: string; tone?: 'bad' | 'good' }
  | { t: 'agent'; text: string }
  | { t: 'cx'; verdict: 'contradicted' | 'verified'; text: string; foot?: string };

// One real failure mode, replayed: the agent edits after a red run and calls it green.
const SCRIPT: { line: Line; wait: number }[] = [
  { line: { t: 'user', text: 'fix proration rounding when a plan changes mid-cycle' }, wait: 900 },
  { line: { t: 'tool', name: 'Edit', arg: 'src/billing/proration.ts' }, wait: 700 },
  { line: { t: 'tool', name: 'Bash', arg: 'pnpm test', out: 'FAIL  src/billing/proration.test.ts  ·  1 failed, 213 passed', tone: 'bad' }, wait: 1100 },
  { line: { t: 'tool', name: 'Edit', arg: 'src/billing/proration.ts' }, wait: 700 },
  { line: { t: 'agent', text: 'Fixed the off-by-one cent on upgrades. All 214 tests pass.' }, wait: 1300 },
  { line: { t: 'cx', verdict: 'contradicted', text: 'The last `pnpm test` before this claim failed: 1 failed, 213 passed.', foot: 'Turn sent back to the agent with the failing output.' }, wait: 2200 },
  { line: { t: 'tool', name: 'Bash', arg: 'pnpm test', out: 'Tests  214 passed (214)', tone: 'good' }, wait: 1000 },
  { line: { t: 'agent', text: 'Re-ran the suite after the fix: all 214 tests pass.' }, wait: 1100 },
  { line: { t: 'cx', verdict: 'verified', text: '`pnpm test` passed after the last edit.', foot: 'Routed to auto-merge.' }, wait: 3600 },
];

export function HeroDemo() {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [n, setN] = useState(reduce ? SCRIPT.length : 0);

  useEffect(() => {
    if (reduce) return;
    const wait = n === 0 ? 600 : SCRIPT[n - 1]?.wait ?? 0;
    const id = setTimeout(() => setN(n >= SCRIPT.length ? 0 : n + 1), wait);
    return () => clearTimeout(id);
  }, [n, reduce]);

  return (
    <div className="demo" aria-label="A replay of crossexam catching a false claim">
      <div className="demo-bar">
        <span className="demo-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="demo-title">~/northwind/billing-api — claude</span>
        <span className="demo-badge">crossexam hook on</span>
      </div>
      <div className="demo-body">
        {SCRIPT.slice(0, n).map(({ line }, i) => (
          <DemoLine key={i} line={line} />
        ))}
        {n < SCRIPT.length && <span className="demo-caret" />}
      </div>
    </div>
  );
}

function DemoLine({ line }: { line: Line }) {
  if (line.t === 'user') return <div className="dl dl-user">› {line.text}</div>;
  if (line.t === 'agent') return <div className="dl dl-agent">⏺ {line.text}</div>;
  if (line.t === 'tool')
    return (
      <div className="dl dl-tool">
        <span className="dl-dot">⏺</span> <b>{line.name}</b>(<span className="dl-arg">{line.arg}</span>)
        {line.out && <div className={`dl-out ${line.tone}`}>⎿ {line.out}</div>}
      </div>
    );
  return (
    <div className={`dl-cx ${line.verdict}`}>
      <div className="dl-cx-head">
        <span className="dl-cx-mark">{line.verdict === 'verified' ? '✓' : '✗'}</span>
        crossexam · {line.verdict}
      </div>
      <div className="dl-cx-text">{ticks(line.text)}</div>
      {line.foot && <div className="dl-cx-foot">{line.foot}</div>}
    </div>
  );
}

const ticks = (s: string) => s.split(/(`[^`]+`)/).map((p, i) => (p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p));
