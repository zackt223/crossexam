import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_POLICY, routeWith } from '../app/Routing';
import { LogoMark, Wordmark } from '../components/Logo';
import { demoClaims } from '../data/demo';
import { KIND_LABEL, agentLabel, groupBy, headlineInsight, tally, type ClaimKind } from '../data/model';
import { AgentSetup } from './AgentSetup';
import { Bento } from './Bento';
import { onFirstView, useReveal, useSpotlight } from './fx';
import { Ghost } from './Ghost';
import { HeroDemo } from './HeroDemo';
import { Playground } from './Playground';
import './site.css';
import './fx.css';

const REPO = 'https://github.com/zackt223/crossexam';
const SITE = 'https://zacktelsem.com';
const LINKEDIN = 'https://www.linkedin.com/in/zackariah-telsem-a8b245246/';

export default function Landing() {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  useSpotlight(root);
  useEffect(() => {
    document.title = 'crossexam — your agents say done. we check.';
  }, []);

  return (
    <div className="site" ref={root}>
      <Nav />
      <Hero />
      <AgentStrip />
      <Try />
      <WaysIn />
      <ClaimsGrid />
      <Neutral />
      <History />
      <RoutingSection />
      <Steps />
      <OpenSource />
      <Faq />
      <FinalCta />
      <Footer />
    </div>
  );
}

function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <header className={`nav-bar${scrolled ? ' scrolled' : ''}`}>
      <a href="#top" className="brand">
        <LogoMark size={26} />
        <Wordmark />
      </a>
      <nav className="nav-links">
        <a href="#try">Try it</a>
        <a href="#agents">Any agent</a>
        <a href="#checks">Checks</a>
        <a href="#teams">For teams</a>
        <a href="#open-source">Open source</a>
      </nav>
      <div className="nav-cta">
        <a className="pill-btn ghost hide-sm" href={REPO} target="_blank" rel="noreferrer">
          <GitHub /> Star
        </a>
        <a className="pill-btn blue" href="#try">
          Try it
        </a>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero" id="top">
      <FloatTile x="8%" y="26%" d={0} glyph="✓" label="tests" />
      <FloatTile x="84%" y="20%" d={1.4} glyph="⇄" label="callers" />
      <FloatTile x="11%" y="62%" d={2.2} glyph="⛁" label="migration" />
      <FloatTile x="81%" y="57%" d={0.7} glyph="⬡" label="deps" />
      <div className="hero-inner">
        <div className="mascot">
          <DotSphere />
          <Ghost size={112} />
        </div>
        <span className="counter">
          <b>7.1%</b> of agent “done”s in one dev’s real logs didn’t hold up
        </span>
        <h1>
          Your agents say done.
          <br />
          <span className="h1-accent">We check.</span>
        </h1>
        <p className="lede">
          crossexam cross-examines every claim your coding agent makes against what actually ran. Tests, refactors, migrations, dependency bumps. Claude Code, Codex, Cursor, Copilot, or whatever you run next.
        </p>
        <div className="hero-ctas">
          <CopyCmd cmd="npx crossexamdev scan" />
          <a className="pill-btn blue lg" href="#try">
            Try it on a claim ↓
          </a>
        </div>
      </div>
      <div className="hero-demo reveal">
        <HeroDemo />
      </div>
    </section>
  );
}

function AgentStrip() {
  const agents = ['Claude Code', 'Codex', 'Cursor', 'Copilot', 'Gemini CLI', 'Windsurf', 'Cline', 'Roo Code', 'Aider', 'Devin', 'Jules', 'Zed', 'Kilo Code', 'Goose', 'opencode'];
  return (
    <section className="strip">
      <span className="strip-label">Works with whatever your team runs</span>
      <div className="marquee" aria-label={agents.join(', ')}>
        <div className="marquee-track" aria-hidden="true">
          {[...agents, ...agents].map((a, i) => (
            <span key={i} className="strip-item">
              {a}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Try() {
  return (
    <section className="block" id="try">
      <div className="block-head reveal">
        <span className="eyebrow">Try it</span>
        <h2>Cross-examine an agent yourself</h2>
        <p>Edit what the agent says. Change what actually happened. This runs crossexam’s real claim detector, right in your browser.</p>
      </div>
      <div className="reveal">
        <Playground />
      </div>
    </section>
  );
}

function WaysIn() {
  return (
    <div className="band-light">
      <section className="block wide" id="agents">
        <div className="block-head reveal">
          <span className="eyebrow">Any agent</span>
          <h2>Everything it takes to trust an agent</h2>
          <p>crossexam doesn’t need an integration from your agent vendor. It checks claims against your repo, so it works wherever claims get made.</p>
        </div>
        <Bento />
        <div className="setup-wrap reveal">
          <div className="setup-head">Pick your agent</div>
          <AgentSetup />
        </div>
      </section>
    </div>
  );
}

const CARDS: { kind: string; icon: string; title: string; sub: string; claim: string; cmd: string; out: string; verdict: 'contradicted' | 'stale' | 'review' }[] = [
  { kind: 'tests', icon: '✓', title: 'Tests pass', sub: 'Matches the claim to the last test run, and its exit code', claim: 'All 214 tests pass.', cmd: 'pnpm test', out: 'Tests: 1 failed, 213 passed', verdict: 'contradicted' },
  { kind: 'refactor', icon: '⇄', title: 'All callers updated', sub: 'Greps the repo for the name the agent said it removed', claim: 'Renamed `getUserById` everywhere.', cmd: 'git grep -nw getUserById', out: 'jobs/digest.ts:118\nadmin/UserPanel.tsx:42', verdict: 'contradicted' },
  { kind: 'migration', icon: '⛁', title: 'Migration applied', sub: 'Reads what the migrate command actually printed', claim: 'The migration has been applied.', cmd: 'prisma migrate status', out: 'Error: P3006 failed to apply', verdict: 'contradicted' },
  { kind: 'deps', icon: '⬡', title: 'Dependency bumped', sub: 'Checks the manifest instead of trusting the summary', claim: 'Bumped `zod` to 3.23.8.', cmd: 'read package.json', out: '"zod": "^3.22.4"', verdict: 'contradicted' },
  { kind: 'stale', icon: '◷', title: 'Stale greens', sub: 'Tests passed, then five more edits, then “done”', claim: 'Tests are passing.', cmd: 'vitest run  ✓  →  5 edits', out: 'no re-run before the claim', verdict: 'stale' },
  { kind: 'security', icon: '⛨', title: 'Security fixes', sub: 'Never auto-approved. Always routed to a human', claim: 'Fixed the SSRF.', cmd: 'route', out: 'senior reviewer', verdict: 'review' },
];

function ClaimsGrid() {
  return (
    <section className="block" id="checks">
      <div className="block-head reveal">
        <span className="eyebrow">Hover a card to replay it</span>
        <h2>Every kind of “done”</h2>
        <p>Not just a test badge. crossexam knows what each claim would have to be backed by, and looks for it.</p>
      </div>
      <div className="cards">
        {CARDS.map((c, i) => (
          <ClaimCard key={c.kind} c={c} delay={i * 70} />
        ))}
      </div>
    </section>
  );
}

function ClaimCard({ c, delay }: { c: (typeof CARDS)[number]; delay: number }) {
  const ref = useRef<HTMLElement>(null);
  const [run, setRun] = useState(0);
  useEffect(() => onFirstView(ref.current, () => setRun((r) => r || 1)), []);
  return (
    <article ref={ref} className="card spot reveal" style={{ transitionDelay: `${delay}ms` }} onMouseEnter={() => run && setRun((r) => r + 1)}>
      <div className="card-vis">
        <div key={run} className={`mini${run ? ' play' : ''}`}>
          <div className="mini-claim">
            “<Ticks text={c.claim} />”
          </div>
          <div className="mini-cmd">
            <span className="p">$</span>{' '}
            <span className="typed" style={{ ['--n' as string]: c.cmd.length }}>
              {c.cmd}
            </span>
          </div>
          <pre className={`mini-out ${c.verdict}`}>{c.out}</pre>
          <span className={`mini-verdict ${c.verdict}`}>{c.verdict === 'review' ? '◇ needs review' : c.verdict === 'stale' ? '◷ stale' : '✗ contradicted'}</span>
        </div>
      </div>
      <div className="card-foot">
        <span className="card-icon">{c.icon}</span>
        <div>
          <div className="card-title">{c.title}</div>
          <div className="card-sub">{c.sub}</div>
        </div>
      </div>
    </article>
  );
}

function Neutral() {
  const left = [25, 75, 125, 175];
  const right = [45, 100, 155];
  return (
    <section className="block neutral" id="neutral">
      <div className="neutral-copy reveal">
        <span className="eyebrow">Why neutral matters</span>
        <h2>An auditor can’t be the company being audited.</h2>
        <p>No agent vendor will publish “our agent made false claims 7% of the time in your repo.” Each one can only grade its own work, and each has a reason to grade it kindly.</p>
        <p>crossexam sits outside all of them, reads every agent the same way, and keeps one ledger. Datadog stayed neutral across clouds. Snyk stayed neutral across registries. Agent verification needs the same.</p>
      </div>
      <div className="hub spot reveal" aria-hidden="true">
        <div className="hub-col">
          {['Claude Code', 'Codex', 'Cursor', 'Copilot'].map((a) => (
            <span key={a} className="hub-node">
              {a}
            </span>
          ))}
        </div>
        <svg className="hub-lines" viewBox="0 0 60 200" preserveAspectRatio="none">
          {left.map((y, i) => {
            const d = `M0 ${y} C 30 ${y}, 30 100, 60 100`;
            return (
              <g key={y}>
                <path d={d} />
                <circle r="2.2" className={`packet ${i === 2 ? 'bad' : ''}`}>
                  <animateMotion dur="2.6s" begin={`${i * 0.65}s`} repeatCount="indefinite" path={d} />
                </circle>
              </g>
            );
          })}
        </svg>
        <div className="hub-core">
          <LogoMark size={54} />
          <span>crossexam</span>
        </div>
        <svg className="hub-lines" viewBox="0 0 60 200" preserveAspectRatio="none">
          {right.map((y, i) => {
            const d = `M0 100 C 30 100, 30 ${y}, 60 ${y}`;
            return (
              <g key={y}>
                <path d={d} />
                <circle r="2.2" className="packet out">
                  <animateMotion dur="2.6s" begin={`${1.3 + i * 0.8}s`} repeatCount="indefinite" path={d} />
                </circle>
              </g>
            );
          })}
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
  const [hover, setHover] = useState<string | null>(null);
  return (
    <section className="block" id="teams">
      <div className="block-head reveal">
        <span className="eyebrow">Reliability history</span>
        <h2>Know which agent to trust with what</h2>
        <p>Every verdict lands in a history by agent, model, repo and task type. Patterns show up that no single PR would ever reveal.</p>
      </div>
      <div className="history spot reveal">
        <div className={`history-insight${hover ? ' hovering' : ''}`}>{hover ?? insight}</div>
        <div className="hm" onMouseLeave={() => setHover(null)}>
          <div className="hm-row hm-head">
            <span />
            {kinds.map((k) => (
              <span key={k}>{KIND_LABEL[k]}</span>
            ))}
          </div>
          {agents.map(([a, cs], row) => (
            <div key={a} className="hm-row">
              <span className="hm-agent">{agentLabel(a)}</span>
              {kinds.map((k, col) => {
                const t = tally(cs.filter((c) => c.kind === k));
                const n = t.verified + t.contradicted + t.stale;
                const r = t.falseDone;
                if (n < 5) return <span key={k} className="hm-cell na">–</span>;
                const text = `${agentLabel(a)} · “${KIND_LABEL[k].toLowerCase()}”: ${t.contradicted + t.stale} of ${n} checked claims were false or stale (${(r * 100).toFixed(1)}%).`;
                return (
                  <button
                    key={k}
                    className={`hm-cell${hover === text ? ' on' : ''}`}
                    style={{ background: `rgba(255, 92, 97, ${0.05 + Math.min(1, r / 0.22) * 0.55})`, transitionDelay: `${(row * kinds.length + col) * 25}ms` }}
                    onMouseEnter={() => setHover(text)}
                    onFocus={() => setHover(text)}
                    onClick={() => setHover(text)}
                  >
                    {(r * 100).toFixed(r < 0.1 ? 1 : 0)}%
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <p className="fine">Hover a cell. Example data from the demo workspace; your numbers come from your own transcripts.</p>
      </div>
    </section>
  );
}

function RoutingSection() {
  const claims = useMemo(() => demoClaims(), []);
  const rates = useMemo(() => new Map([...groupBy(claims, (c) => c.agent)].map(([a, cs]) => [a, tally(cs).falseDone])), [claims]);
  const [max, setMax] = useState(DEFAULT_POLICY.maxFalseDone);
  const [testsAuto, setTestsAuto] = useState(true);
  const route = useMemo(() => routeWith({ autoMergeKinds: DEFAULT_POLICY.autoMergeKinds.filter((k) => testsAuto || k !== 'tests'), maxFalseDone: max }, rates), [max, testsAuto, rates]);
  const share = (r: string) => claims.filter((c) => route(c) === r).length / claims.length;
  const lanes = [
    { id: 'auto-merge', t: 'Auto-merge', note: 'Verified claims on low-risk kinds skip the queue entirely.', tone: 'good' },
    { id: 'standard', t: 'Standard review', note: 'Unbacked or inconclusive: a normal review, with the gap called out.', tone: '' },
    { id: 'senior', t: 'Senior review', note: 'Contradicted, stale or security: the people who catch the expensive ones.', tone: 'bad' },
  ];
  const hours = Math.round(claims.filter((c) => route(c) === 'auto-merge').length * 0.35);
  return (
    <section className="block">
      <div className="block-head reveal">
        <span className="eyebrow">For engineering leads</span>
        <h2>Spend review time where agents actually lie</h2>
        <p>A pass/fail badge is a feature. Routing review effort is the job. Drag the policy and watch 1,400 agent claims re-sort.</p>
      </div>
      <div className="route-ctl spot reveal">
        <label className="route-slider">
          <span>
            Agents above <b>{Math.round(max * 100)}%</b> false “done”s lose auto-merge
          </span>
          <input type="range" min={0.03} max={0.15} step={0.005} value={max} onChange={(e) => setMax(Number(e.target.value))} />
          <span className="route-agents">
            {[...rates].map(([a, r]) => (
              <i key={a} className={r > max ? 'over' : ''}>
                {agentLabel(a)} {(r * 100).toFixed(1)}%
              </i>
            ))}
          </span>
        </label>
        <button className={`route-toggle${testsAuto ? ' on' : ''}`} onClick={() => setTestsAuto(!testsAuto)} aria-pressed={testsAuto}>
          <i /> Auto-merge verified “tests pass”
        </button>
        <div className="route-bar" aria-hidden="true">
          {lanes.map((l) => (
            <span key={l.id} className={l.tone} style={{ width: `${share(l.id) * 100}%` }} />
          ))}
        </div>
        <div className="route-saved">
          ≈ <b>{hours}h</b> of review saved this month
        </div>
      </div>
      <div className="lanes-site">
        {lanes.map((l, i) => (
          <div key={l.t} className={`lane-site spot reveal ${l.tone}`} style={{ transitionDelay: `${i * 70}ms` }}>
            <span className="lane-site-n">{Math.round(share(l.id) * 100)}%</span>
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
    { n: 1, t: 'See your own numbers', d: 'Scan the agent transcripts already on your machine. Nothing leaves it.', cmd: 'npx crossexamdev scan' },
    { n: 2, t: 'Put it in the loop', d: 'Every agent in the repo gets the AGENTS.md rule and the MCP tool, so a false “done” is caught before you read it.', cmd: 'npx crossexamdev init --mcp' },
    { n: 3, t: 'Bring the team', d: 'Export a JSON report and see reliability by agent, model and repo.', cmd: 'npx crossexamdev scan --json' },
  ];
  return (
    <section className="block">
      <div className="block-head reveal">
        <h2>Three commands. No account.</h2>
      </div>
      <div className="steps">
        {steps.map((s, i) => (
          <div key={s.n} className="step spot reveal" style={{ transitionDelay: `${i * 80}ms` }}>
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

function OpenSource() {
  return (
    <section className="block" id="open-source">
      <div className="block-head reveal">
        <span className="eyebrow">Free and open source</span>
        <h2>Free forever. MIT licensed.</h2>
        <p>No accounts, no plans, no upsell. The CLI, the MCP server and the GitHub Action are all open source. Read every line, fork it, ship it.</p>
      </div>
      <div className="plans">
        <div className="plan spot reveal">
          <div className="plan-name">Read the code</div>
          <ul>
            <li>Every check, in plain JavaScript</li>
            <li>Zero runtime dependencies</li>
            <li>Issues and pull requests welcome</li>
          </ul>
          <div className="plan-cta">
            <a className="pill-btn blue wide" href={REPO} target="_blank" rel="noreferrer">
              <GitHub /> Star it on GitHub
            </a>
          </div>
        </div>
        <div className="plan spot reveal" style={{ transitionDelay: '80ms' }}>
          <div className="plan-name">Run it locally</div>
          <ul>
            <li>Works with any agent</li>
            <li>Nothing leaves your machine</li>
            <li>Zero setup, one command</li>
          </ul>
          <div className="plan-cta">
            <CopyCmd cmd="npx crossexamdev scan" small />
          </div>
        </div>
        <div className="plan spot reveal" style={{ transitionDelay: '160ms' }}>
          <div className="plan-name">Built by Zack Telsem</div>
          <ul>
            <li>Questions, ideas or a bug to report</li>
            <li>Say hi, I read everything</li>
          </ul>
          <div className="plan-cta contact-links">
            <a className="pill-btn ghost wide" href={SITE} target="_blank" rel="noreferrer">
              zacktelsem.com
            </a>
            <a className="pill-btn ghost wide" href={LINKEDIN} target="_blank" rel="noreferrer">
              LinkedIn
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const qa = [
    ['Is it really free?', 'Yes, all of it, for everyone. crossexam is MIT-licensed open source: no accounts, no paid tier, no telemetry. Use it at work, fork it, build on it.'],
    ['Which agents does it work with?', 'Any of them. An agent that can call an MCP tool, read AGENTS.md, open a pull request or print a summary can be checked, because crossexam verifies claims against your repo instead of trusting the agent. For history, it reads Claude Code, Codex, Gemini CLI, Cline, Roo Code, Kilo Code and Aider transcripts directly, plus an open format any other tool can write.'],
    ['Does my code or transcript leave my machine?', 'Not with the CLI. It reads the transcripts your agents already write to disk, checks them locally, and prints a report.'],
    ['How does it decide a claim is false?', 'Each claim kind has its own evidence. “Tests pass” needs a test run after the last edit that exited 0 and printed no failures. “All callers updated” needs the old name to be gone from the repo. A run that hid its exit code behind a pipe is flagged as inconclusive, not trusted.'],
    ['Will it run my migrations?', 'Never on its own. It re-runs the tests, builds, typechecks and linters it finds in your repo. Migrations are only checked through a read-only status command you name in crossexam.json.'],
    ['Will it block my agent forever?', 'No. The Claude Code hook sends a turn back once. If the agent still can’t back the claim, crossexam tells you instead of looping. Through MCP, the agent asks and decides for itself.'],
    ['Why not wait for my agent vendor to build this?', 'They can only grade their own agent, and none of them will publish how often it’s wrong in your repo. A verifier is only credible if it is independent of what it verifies.'],
    ['What about false positives?', 'crossexam only judges sentences that assert a result. “I’ll make sure tests pass”, “tests don’t pass yet” and quoted claims are ignored. Anything it can’t settle is marked “needs review”, never “contradicted”.'],
  ];
  return (
    <section className="block faq">
      <div className="block-head reveal">
        <h2>FAQs</h2>
      </div>
      <div className="faq-list reveal">
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
    <section className="final reveal">
      <Ghost size={88} />
      <h2>Stop merging “done”.</h2>
      <p>Find out how often your agents are right. It takes one command.</p>
      <CopyCmd cmd="npx crossexamdev scan" />
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
        <span className="muted">
          Free and open source (MIT). Built by{' '}
          <a className="footer-me" href={SITE} target="_blank" rel="noreferrer">
            Zack Telsem
          </a>
          .
        </span>
      </div>
      <div className="footer-cols">
        <div>
          <span className="footer-h">Product</span>
          <a href="#try">Try it</a>
          <a href="#checks">Checks</a>
          <a href={REPO} target="_blank" rel="noreferrer">
            Source code
          </a>
        </div>
        <div>
          <span className="footer-h">Contact</span>
          <a href={SITE} target="_blank" rel="noreferrer">
            zacktelsem.com
          </a>
          <a href={LINKEDIN} target="_blank" rel="noreferrer">
            LinkedIn
          </a>
          <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
            Report an issue
          </a>
        </div>
      </div>
    </footer>
  );
}

// ---------- bits ----------

function Ticks({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/).map((p, i) => (p.startsWith('`') && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : p))}</>;
}

function CopyCmd({ cmd, small }: { cmd: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`cmd${small ? ' sm' : ''}${done ? ' done' : ''}`}
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
      <span className="cmd-copy">{done ? 'copied' : <CopyIcon />}</span>
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
      out.push({ x: 50 + Math.cos(t) * rad * 46, y: 50 + Math.sin(t) * rad * 46, o: 0.12 + rad * 0.45, r: 0.45 + rad * 0.35 });
    }
    return out;
  }, []);
  return (
    <svg className="sphere" viewBox="0 0 100 100" aria-hidden="true">
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="#2f6bff" opacity={d.o * 0.55} />
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
