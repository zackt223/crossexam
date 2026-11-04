import { useEffect, useRef, useState } from 'react';
import { LogoMark } from '../components/Logo';
import './bento.css';

/**
 * The feature grid: each tile is a title, one line with a bold phrase, and a
 * small working piece of UI that shows the idea instead of describing it.
 */
export function Bento() {
  return (
    <div className="bento">
      <Tile className="span2" title="One verifier, every agent" sub={<>Claude Code, Codex, Cursor, Copilot, Gemini and the rest <b>all answer to the same checks</b>, so their numbers finally compare.</>}>
        <AgentFan />
      </Tile>
      <Tile title="The agent asks first" sub={<>Through MCP, the agent calls <b>verify_claims before it says done</b>, and fixes what comes back false.</>}>
        <AskFirst />
      </Tile>
      <Tile title="Review by trust" sub={<>Leads set the bar once. <b>Claims that hold up skip the queue</b>; false ones go to a senior.</>}>
        <RoutePills />
      </Tile>
      <Tile title="A check on every PR" sub={<>Cloud agents’ pull requests get <b>re-checked on the branch</b>, not just read.</>}>
        <RunCheck />
      </Tile>
      <Tile title="Every repo, one view" sub={<>See <b>which repo, which agent, which claim</b> from a single dashboard.</>}>
        <RepoSwitch />
      </Tile>
      <Tile className="span2" title="Fits the stack you already have" sub={<>It runs <b>your own tests, builds and linters</b>. Nothing to rewrite, nothing to host.</>}>
        <StackGrid />
      </Tile>
      <Tile title="Audit-ready" sub={<>Every claim, its evidence and its route, <b>exported for SOC 2</b> in one click.</>}>
        <AuditExport />
      </Tile>
    </div>
  );
}

function Tile({ title, sub, children, className = '' }: { title: string; sub: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <article className={`tile spot reveal ${className}`}>
      <div className="tile-text">
        <h3>{title}</h3>
        <p>{sub}</p>
      </div>
      <div className="tile-vis">{children}</div>
    </article>
  );
}

// ---------------------------------------------------------------- tiles

const FAN = ['Claude Code', 'Codex', 'Cursor', 'Copilot', 'Gemini CLI', 'Windsurf', 'Cline', 'Aider', 'Devin'];

function AgentFan() {
  const [hot, setHot] = useState<number | null>(null);
  // Chips sit on an arc above the mascot, like spokes into one hub.
  return (
    <div className="fan" onMouseLeave={() => setHot(null)}>
      <svg className="fan-lines" viewBox="0 0 600 220" preserveAspectRatio="none" aria-hidden="true">
        {FAN.map((_, i) => {
          const a = Math.PI * (0.08 + (0.84 * i) / (FAN.length - 1));
          const x = 300 - Math.cos(a) * 250;
          const y = 200 - Math.sin(a) * 160;
          return <path key={i} d={`M300 200 L${x} ${y}`} className={hot === i ? 'on' : ''} />;
        })}
      </svg>
      {FAN.map((a, i) => {
        const ang = Math.PI * (0.08 + (0.84 * i) / (FAN.length - 1));
        return (
          <button
            key={a}
            className={`fan-chip${hot === i ? ' on' : ''}`}
            style={{ left: `${50 - Math.cos(ang) * 41.6}%`, top: `${91 - Math.sin(ang) * 72.7}%` }}
            onMouseEnter={() => setHot(i)}
            onFocus={() => setHot(i)}
          >
            {a}
          </button>
        );
      })}
      <div className="fan-hub">
        <LogoMark size={46} />
      </div>
      <div className="fan-read">{hot === null ? 'hover an agent' : `${FAN[hot]} → crossexam → one ledger`}</div>
    </div>
  );
}

const ASKS: { claim: string; verdict: 'contradicted' | 'verified'; reply: string }[] = [
  { claim: 'All 214 tests pass.', verdict: 'contradicted', reply: 'pnpm test exited 1 · 1 failed' },
  { claim: 'Renamed `getUserById` everywhere.', verdict: 'contradicted', reply: '3 references still in the repo' },
  { claim: 'Build succeeds.', verdict: 'verified', reply: 'pnpm build passed just now' },
];

function AskFirst() {
  const [i, setI] = useState(0);
  const a = ASKS[i];
  return (
    <div className="ask">
      <div className="ask-call">
        <span className="ask-tool">verify_claims</span>
        <span className="ask-claim">“{a.claim.split('`').map((p, k) => (k % 2 ? <code key={k}>{p}</code> : p))}”</span>
      </div>
      <div key={i} className={`ask-reply ${a.verdict}`}>
        <b>{a.verdict === 'verified' ? '✓ verified' : '✗ contradicted'}</b> {a.reply}
      </div>
      <button className="ask-next" onClick={() => setI((i + 1) % ASKS.length)}>
        try another claim <span>↻</span>
      </button>
    </div>
  );
}

const ROUTES = [
  { id: 'auto', label: 'auto-merge', n: '62%', tone: 'good' },
  { id: 'std', label: 'standard review', n: '28%', tone: '' },
  { id: 'sr', label: 'senior review', n: '11%', tone: 'bad' },
];

function RoutePills() {
  const [hot, setHot] = useState(0);
  return (
    <div className="pills">
      {ROUTES.map((r, i) => (
        <button key={r.id} className={`pill pill-${i} ${r.tone}${hot === i ? ' on' : ''}`} onMouseEnter={() => setHot(i)} onFocus={() => setHot(i)} onClick={() => setHot(i)}>
          {r.label}
          <span>{r.n}</span>
        </button>
      ))}
    </div>
  );
}

function RunCheck() {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const t = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(t.current), []);
  const run = () => {
    if (state === 'running') return;
    if (state === 'done') return setState('idle');
    setState('running');
    t.current = setTimeout(() => setState('done'), 1300);
  };
  return (
    <div className="run">
      <div className="run-pr">
        <span className="run-dot" /> copilot opened <b>#3412</b> fix proration rounding
      </div>
      <button className={`run-btn ${state}`} onClick={run}>
        {state === 'idle' && 'Run crossexam'}
        {state === 'running' && (
          <>
            <i className="spin" /> checking 3 claims…
          </>
        )}
        {state === 'done' && '↻ run again'}
      </button>
      <div className={`run-result${state === 'done' ? ' show' : ''}`}>
        <span className="bad">✗ 1 false</span>
        <span className="good">✓ 2 verified</span>
        <span className="muted">→ senior review</span>
      </div>
      {state === 'idle' && <span className="run-cursor" aria-hidden="true">👆</span>}
    </div>
  );
}

const REPOS = [
  { name: 'billing-api', flagged: 4 },
  { name: 'web', flagged: 1 },
  { name: 'monorepo', flagged: 2 },
  { name: 'infra', flagged: 0 },
];

function RepoSwitch() {
  const [open, setOpen] = useState(true);
  const [pick, setPick] = useState(0);
  return (
    <div className="repo">
      <button className="repo-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="repo-org">nw</span>
        northwind / {REPOS[pick].name}
        <span className={`repo-chev${open ? ' up' : ''}`}>⌄</span>
      </button>
      {open && (
        <ul className="repo-list">
          {REPOS.map((r, i) => (
            <li key={r.name}>
              <button
                className={i === pick ? 'on' : ''}
                onClick={() => {
                  setPick(i);
                  setOpen(false);
                }}
              >
                <i className={r.flagged ? 'bad' : 'good'} />
                {r.name}
                <span>{r.flagged ? `${r.flagged} flagged` : 'all clear'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STACK = [
  ['npm', '#c33'],
  ['pnpm', '#f5a623'],
  ['yarn', '#2c8ebb'],
  ['bun', '#e8d8b6'],
  ['vitest', '#6da13f'],
  ['jest', '#99425b'],
  ['pytest', '#0a9edc'],
  ['go test', '#00add8'],
  ['cargo', '#dea584'],
  ['gradle', '#5fa8a0'],
  ['maven', '#c71a36'],
  ['rspec', '#cc342d'],
  ['tsc', '#3178c6'],
  ['eslint', '#7c6cf0'],
  ['ruff', '#d7ff64'],
  ['mypy', '#2a6db2'],
  ['prisma', '#8fa1b3'],
] as const;

function StackGrid() {
  return (
    <div className="stack">
      {STACK.map(([name, c], i) => (
        <span key={name} className="stack-tile" style={{ ['--c' as string]: c, animationDelay: `${(i % 6) * 0.25}s` }}>
          <i>{name[0]}</i>
          {name}
        </span>
      ))}
    </div>
  );
}

function AuditExport() {
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="audit">
      <svg className="audit-chart" viewBox="0 0 200 70" aria-hidden="true">
        <path d="M0 58 C 20 52, 30 40, 50 44 S 80 30, 100 34 S 140 14, 160 20 S 190 10, 200 8" />
        <path className="area" d="M0 58 C 20 52, 30 40, 50 44 S 80 30, 100 34 S 140 14, 160 20 S 190 10, 200 8 L200 70 L0 70 Z" />
      </svg>
      <div className="audit-menu">
        <div className="audit-menu-h">export evidence</div>
        {['CSV · for auditors', 'JSON · for pipelines'].map((x) => (
          <button key={x} onClick={() => setDone(x)} className={done === x ? 'on' : ''}>
            <span>{done === x ? '✓' : '↓'}</span>
            {x}
          </button>
        ))}
      </div>
    </div>
  );
}
