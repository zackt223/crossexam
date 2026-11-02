import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LogoMark, Wordmark } from '../components/Logo';
import { demoClaims } from '../data/demo';
import { KIND_LABEL, agentLabel, groupBy, headlineInsight, routeOf, tally, type ClaimKind } from '../data/model';
import { HeroDemo } from './HeroDemo';
import './site.css';

const WAITLIST = 'mailto:hello@crossexam.dev?subject=crossexam%20for%20teams';

export default function Landing() {
  useEffect(() => {
    document.title = 'crossexam — your agents say done. we check.';
  }, []);

  return (
    <div className="site">
      <Nav />
      <Hero />
      <AgentStrip />
      <ClaimsGrid />
      <Neutral />
      <History />
      <RoutingSection />
      <Steps />
      <Pricing />
      <Faq />
      <FinalCta />
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className="nav-bar">
      <a href="#top" className="brand">
        <LogoMark size={26} />
        <Wordmark />
      </a>
      <nav className="nav-links">
        <a href="#checks">Checks</a>
        <a href="#neutral">Why neutral</a>
        <a href="#teams">For teams</a>
        <a href="#pricing">Pricing</a>
      </nav>
      <div className="nav-cta">
        <a className="pill-btn ghost hide-sm" href="https://github.com/" target="_blank" rel="noreferrer">
          <GitHub /> Star
        </a>
        <Link className="pill-btn blue" to="/app">
          Open dashboard
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero" id="top">
      <DotSphere />
      <FloatTile x="8%" y="22%" d={0} glyph="✓" label="tests" />
      <FloatTile x="84%" y="16%" d={1.4} glyph="⇄" label="callers" />
      <FloatTile x="12%" y="64%" d={2.2} glyph="⛁" label="migration" />
      <FloatTile x="80%" y="58%" d={0.7} glyph="⬡" label="deps" />
      <div className="hero-inner">
        <span className="counter">
          <b>7.1%</b> of agent “done”s in one dev’s real logs didn’t hold up
        </span>
        <h1>
          Your agents say done.
          <br />
          We check.
        </h1>
        <p className="lede">
          crossexam cross-examines every claim your coding agent makes against what actually ran. Tests, refactors, migrations, dependency bumps. Neutral across every agent.
        </p>
        <div className="hero-ctas">
          <CopyCmd cmd="npx crossexam scan" />
          <Link className="pill-btn blue lg" to="/app">
            See the dashboard
          </Link>
        </div>
      </div>
      <div className="hero-demo">
        <HeroDemo />
      </div>
    </section>
  );
}

function AgentStrip() {
  return (
    <section className="strip">
      <span className="strip-label">Reads transcripts from</span>
      <div className="strip-row">
        {['Claude Code', 'Codex', 'Cursor', 'Copilot', 'Gemini CLI', 'Devin'].map((a, i) => (
          <span key={a} className={`strip-item${i > 1 ? ' soon' : ''}`}>
            {a}
            {i > 1 && <em>soon</em>}
          </span>
        ))}
      </div>
    </section>
  );
}

const CARDS: { kind: string; title: string; sub: string; claim: string; cmd: string; out: string; verdict: 'contradicted' | 'stale' | 'review' }[] = [
  { kind: 'tests', title: 'Tests pass', sub: 'Matches the claim to the last test run, and its exit code', claim: 'All 214 tests pass.', cmd: 'pnpm test', out: 'Tests: 1 failed, 213 passed', verdict: 'contradicted' },
  { kind: 'refactor', title: 'All callers updated', sub: 'Greps the repo for the name the agent said it removed', claim: 'Renamed getUserById everywhere.', cmd: 'git grep -nw getUserById', out: 'jobs/digest.ts:118\nadmin/UserPanel.tsx:42', verdict: 'contradicted' },
  { kind: 'migration', title: 'Migration applied', sub: 'Reads what the migrate command actually printed', claim: 'The migration has been applied.', cmd: 'prisma migrate dev', out: 'Error: P3006 failed to apply', verdict: 'contradicted' },
  { kind: 'deps', title: 'Dependency bumped', sub: 'Checks the manifest instead of trusting the summary', claim: 'Bumped zod to 3.23.8.', cmd: 'read package.json', out: '"zod": "^3.22.4"', verdict: 'contradicted' },
  { kind: 'stale', title: 'Stale greens', sub: 'Tests passed, then five more edits, then “done”', claim: 'Tests are passing.', cmd: 'vitest run  ✓  →  5 edits', out: 'no re-run before the claim', verdict: 'stale' },
  { kind: 'security', title: 'Security fixes', sub: 'Never auto-approved. Always routed to a human', claim: 'Fixed the SSRF.', cmd: 'route', out: 'senior reviewer', verdict: 'review' },
];

function ClaimsGrid() {
  return (
    <section className="block" id="checks">
      <div className="block-head">
        <h2>Every kind of “done”</h2>
        <p>Not just a test badge. crossexam knows what each claim would have to be backed by, and looks for it.</p>
      </div>
      <div className="cards">
        {CARDS.map((c) => (
          <article key={c.kind} className="card">
            <div className="card-vis">
              <div className="mini">
                <div className="mini-claim">“{c.claim}”</div>
                <div className="mini-cmd">
                  <span className="p">$</span> {c.cmd}
                </div>
                <pre className={`mini-out ${c.verdict}`}>{c.out}</pre>
                <span className={`mini-verdict ${c.verdict}`}>{c.verdict === 'review' ? '◇ needs review' : c.verdict === 'stale' ? '◷ stale' : '✗ contradicted'}</span>
              </div>
            </div>
            <div className="card-foot">
              <span className="card-icon">{ICONS[c.kind]}</span>
              <div>
                <div className="card-title">{c.title}</div>
                <div className="card-sub">{c.sub}</div>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

const ICONS: Record<string, ReactNode> = {
  tests: '✓',
  refactor: '⇄',
  migration: '⛁',
  deps: '⬡',
  stale: '◷',
  security: '⛨',
};

function Neutral() {
  return (
    <section className="block neutral" id="neutral">
      <div className="neutral-copy">
        <span className="eyebrow">Why neutral matters</span>
        <h2>An auditor can’t be the company being audited.</h2>
        <p>
          No agent vendor will publish “our agent made false claims 7% of the time in your repo.” Each one can only grade its own work, and each has a reason to grade it kindly.
        </p>
        <p>
          crossexam sits outside all of them, reads every agent the same way, and keeps one ledger. Datadog stayed neutral across clouds. Snyk stayed neutral across registries. Agent verification needs the same.
        </p>
      </div>
      <div className="hub" aria-hidden="true">
        <div className="hub-col">
          {['Claude Code', 'Codex', 'Cursor', 'Copilot'].map((a) => (
            <span key={a} className="hub-node">
              {a}
            </span>
          ))}
        </div>
        <svg className="hub-lines" viewBox="0 0 100 200" preserveAspectRatio="none">
          {[25, 75, 125, 175].map((y) => (
            <path key={y} d={`M0 ${y} C 50 ${y}, 50 100, 100 100`} />
          ))}
        </svg>
        <div className="hub-core">
          <LogoMark size={54} />
          <span>crossexam</span>
        </div>
        <svg className="hub-lines" viewBox="0 0 100 200" preserveAspectRatio="none">
          {[45, 100, 155].map((y) => (
            <path key={y} d={`M0 100 C 50 100, 50 ${y}, 100 ${y}`} />
          ))}
        </svg>
        <div className="hub-col">
          <span className="hub-node out">One ledger</span>
          <span className="hub-node out">Review routing</span>
          <span className="hub-node out">Audit evidence</span>
        </div>
      </div>
    </section>
  );
}

function History() {
  const claims = useMemo(() => demoClaims(), []);
  const insight = useMemo(() => headlineInsight(claims), [claims]);
  const agents = [...groupBy(claims, (c) => c.agent)].sort((a, b) => b[1].length - a[1].length);
  const kinds: ClaimKind[] = ['tests', 'refactor', 'migration', 'deps', 'types'];
  return (
    <section className="block" id="teams">
      <div className="block-head">
        <span className="eyebrow">Reliability history</span>
        <h2>Know which agent to trust with what</h2>
        <p>Every verdict lands in a history by agent, model, repo and task type. Patterns show up that no single PR would ever reveal.</p>
      </div>
      <div className="history">
        {insight && <div className="history-insight">{insight}</div>}
        <div className="hm">
          <div className="hm-row hm-head">
            <span />
            {kinds.map((k) => (
              <span key={k}>{KIND_LABEL[k]}</span>
            ))}
          </div>
          {agents.map(([a, cs]) => (
            <div key={a} className="hm-row">
              <span className="hm-agent">{agentLabel(a)}</span>
              {kinds.map((k) => {
                const t = tally(cs.filter((c) => c.kind === k));
                const r = t.falseDone;
                if (t.verified + t.contradicted + t.stale < 5) return <span key={k} className="hm-cell na">–</span>;
                return (
                  <span key={k} className="hm-cell" style={{ background: `rgba(255, 92, 97, ${0.05 + Math.min(1, r / 0.22) * 0.55})` }}>
                    {(r * 100).toFixed(r < 0.1 ? 1 : 0)}%
                  </span>
                );
              })}
            </div>
          ))}
        </div>
        <p className="fine">Example data from the demo workspace. Your numbers come from your own transcripts.</p>
      </div>
    </section>
  );
}

function RoutingSection() {
  const share = useMemo(() => {
    const cs = demoClaims();
    return (r: string) => `${Math.round((cs.filter((c) => routeOf(c) === r).length / cs.length) * 100)}%`;
  }, []);
  const lanes = [
    { t: 'Auto-merge', n: share('auto-merge'), note: 'Verified claims on low-risk kinds skip the queue entirely.', tone: 'good' },
    { t: 'Standard review', n: share('standard'), note: 'Unbacked or inconclusive: a normal review, with the gap called out.', tone: '' },
    { t: 'Senior review', n: share('senior'), note: 'Contradicted, stale or security: the people who catch the expensive ones.', tone: 'bad' },
  ];
  return (
    <section className="block">
      <div className="block-head">
        <span className="eyebrow">For engineering leads</span>
        <h2>Spend review time where agents actually lie</h2>
        <p>A pass/fail badge is a feature. Routing review effort is the job. Set the policy once and crossexam sorts every agent PR.</p>
      </div>
      <div className="lanes-site">
        {lanes.map((l) => (
          <div key={l.t} className={`lane-site ${l.tone}`}>
            <span className="lane-site-n">{l.n}</span>
            <span className="lane-site-t">{l.t}</span>
            <span className="lane-site-note">{l.note}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Steps() {
  const steps = [
    { n: 1, t: 'See your own numbers', d: 'Scan the agent transcripts already on your machine. Nothing leaves it.', cmd: 'npx crossexam scan' },
    { n: 2, t: 'Put it in the loop', d: 'Install the Claude Code Stop hook. A false “done” sends the turn back with the failing output.', cmd: 'npx crossexam install' },
    { n: 3, t: 'Bring the team', d: 'Export a report, drop it on the dashboard, and see reliability by agent, model and repo.', cmd: 'npx crossexam scan --json' },
  ];
  return (
    <section className="block">
      <div className="block-head">
        <h2>Three commands. No account.</h2>
      </div>
      <div className="steps">
        {steps.map((s) => (
          <div key={s.n} className="step">
            <span className="step-n">{s.n}</span>
            <div className="step-t">{s.t}</div>
            <div className="step-d">{s.d}</div>
            <CopyCmd cmd={s.cmd} small />
          </div>
        ))}
      </div>
    </section>
  );
}

function Pricing() {
  const plans = [
    { name: 'Free', price: '$0', per: 'forever', items: ['CLI and Claude Code hook', 'Claude Code and Codex transcripts', 'Runs locally, nothing uploaded', 'Unlimited scans'], cta: <CopyCmd cmd="npx crossexam scan" small />, hi: false },
    { name: 'Team', price: '$24', per: 'per developer / month', items: ['Shared reliability history', 'Review routing and auto-merge policy', 'GitHub checks on agent PRs', 'Every agent, one ledger'], cta: <a className="pill-btn blue wide" href={WAITLIST}>Join the early access list</a>, hi: true },
    { name: 'Enterprise', price: 'Custom', per: '', items: ['Audit trail and policy controls', 'SOC 2 evidence export', 'SSO and data residency', 'Self-hosted verifier'], cta: <a className="pill-btn ghost wide" href={WAITLIST}>Talk to us</a>, hi: false },
  ];
  return (
    <section className="block" id="pricing">
      <div className="block-head">
        <h2>Pricing</h2>
        <p>The verifier is free for every developer. Teams pay for history, routing and the audit trail.</p>
      </div>
      <div className="plans">
        {plans.map((p) => (
          <div key={p.name} className={`plan${p.hi ? ' hi' : ''}`}>
            <div className="plan-name">
              {p.name}
              {p.hi && <span className="plan-tag">Early access</span>}
            </div>
            <div className="plan-price">
              {p.price} <span>{p.per}</span>
            </div>
            <ul>
              {p.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
            <div className="plan-cta">{p.cta}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Faq() {
  const qa = [
    ['Does my code or transcript leave my machine?', 'Not with the CLI. It reads the transcripts your agents already write to disk (~/.claude/projects, ~/.codex/sessions), checks them locally, and prints a report. The dashboard loads that report in your browser.'],
    ['How does it decide a claim is false?', 'Each claim kind has its own evidence. “Tests pass” needs a test run after the last edit that exited 0 and printed no failures. “All callers updated” needs the old name to be gone from the repo. A run that hid its exit code behind a pipe is flagged as inconclusive, not trusted.'],
    ['Will it block my agent forever?', 'No. The hook sends a turn back once. If the agent still can’t back the claim, crossexam tells you instead of looping.'],
    ['Why not wait for my agent vendor to build this?', 'They can only grade their own agent, and none of them will publish how often it’s wrong in your repo. A verifier is only credible if it is independent of what it verifies.'],
    ['What about false positives?', 'crossexam only judges sentences that assert a result. “I’ll make sure tests pass” or “tests don’t pass yet” are ignored. Anything it can’t settle is marked “needs review”, never “contradicted”.'],
  ];
  return (
    <section className="block faq">
      <div className="block-head">
        <h2>FAQs</h2>
      </div>
      <div className="faq-list">
        {qa.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="final">
      <LogoMark size={72} />
      <h2>Stop merging “done”.</h2>
      <p>Find out how often your agents are right. It takes one command.</p>
      <CopyCmd cmd="npx crossexam scan" />
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-brand">
        <span className="brand">
          <LogoMark size={22} />
          <Wordmark />
        </span>
        <span className="muted">The neutral verifier for coding agents.</span>
      </div>
      <div className="footer-cols">
        <div>
          <span className="footer-h">Product</span>
          <a href="#checks">Checks</a>
          <Link to="/app">Dashboard</Link>
          <a href="#pricing">Pricing</a>
        </div>
        <div>
          <span className="footer-h">Company</span>
          <a href={WAITLIST}>Contact</a>
          <a href="#neutral">Why neutral</a>
        </div>
      </div>
    </footer>
  );
}

// ---------- bits ----------

function CopyCmd({ cmd, small }: { cmd: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`cmd${small ? ' sm' : ''}`}
      onClick={() =>
        navigator.clipboard?.writeText(cmd).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        })
      }
      aria-label={`Copy ${cmd}`}
    >
      <span className="cmd-p">$</span>
      <span className="cmd-t">{cmd}</span>
      <span className="cmd-copy">{done ? 'Copied' : <CopyIcon />}</span>
    </button>
  );
}

function FloatTile({ x, y, d, glyph, label }: { x: string; y: string; d: number; glyph: string; label: string }) {
  return (
    <div className="float" style={{ left: x, top: y, animationDelay: `${-d}s` }} aria-hidden="true">
      <div className="float-in">
        <span className="float-g">{glyph}</span>
        <span className="float-l">{label}</span>
      </div>
    </div>
  );
}

function DotSphere() {
  // A loose sphere of dots, like a halo seen from above.
  const dots = useMemo(() => {
    const out: { x: number; y: number; o: number; r: number }[] = [];
    for (let i = 0; i < 220; i++) {
      const t = i * 2.399963;
      const rad = Math.sqrt(i / 220);
      const x = Math.cos(t) * rad;
      const y = Math.sin(t) * rad;
      out.push({ x: 50 + x * 46, y: 50 + y * 46, o: 0.15 + (1 - rad) * 0.55, r: 0.55 + (1 - rad) * 0.5 });
    }
    return out;
  }, []);
  return (
    <svg className="sphere" viewBox="0 0 100 100" aria-hidden="true">
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="#fff" opacity={d.o} />
      ))}
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </svg>
  );
}

function GitHub() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}
