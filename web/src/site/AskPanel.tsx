import { useEffect, useRef, useState } from 'react';
import { LogoMark } from '../components/Logo';
import { skyTexture } from './skytex';

const REPO = 'https://github.com/zackt223/crossexam';

const MODES = [
  {
    id: 'verify',
    prompt: 'every pr my agent opened this week. check each “done”, and show me the run that disagrees with it.',
    cmd: 'npx crossexamdev verify --github',
    out: [
      ['contradicted', '“all tests pass”', 'pnpm test → 1 failed, 213 passed'],
      ['verified', '“bumped zod to 3.23.8”', 'package.json → 3.23.8'],
      ['contradicted', '“renamed everywhere”', 'git grep → 2 callers left'],
    ],
  },
  {
    id: 'mutate',
    prompt: 'the agent says the new refund logic is tested. plant a few bugs in the lines it changed and tell me which ones the tests miss.',
    cmd: 'npx crossexamdev mutate',
    out: [
      ['contradicted', 'refund.ts:48  >  →  >=', 'no test sits on day 30'],
      ['verified', 'refund.ts:52  *  →  /', 'caught by “annual plan refunds”'],
      ['review', 'test strength: moderate', '5 of 7 planted defects caught'],
    ],
  },
  {
    id: 'scan',
    prompt: 'how often have my agents been wrong this month? split it by agent and by kind of claim.',
    cmd: 'npx crossexamdev scan',
    out: [
      ['review', '1,412 claims read', 'from the transcripts on this machine'],
      ['contradicted', '7.1% didn’t hold up', 'mostly “tests pass” after more edits'],
      ['verified', 'nothing uploaded', 'the report stays on your disk'],
    ],
  },
  {
    id: 'mcp',
    prompt: 'before you tell me you’re done, call verify_claims and assess_test_strength, and fix whatever they find.',
    cmd: 'npx crossexamdev init --mcp',
    out: [
      ['verified', 'added to .mcp.json', 'claude code, codex, cursor, copilot…'],
      ['verified', 'agents.md rule written', 'every agent in the repo checks itself'],
      ['review', 'works with any mcp client', 'no vendor integration needed'],
    ],
  },
] as const;

const AGENTS = ['any agent', 'claude code', 'codex', 'cursor', 'copilot', 'gemini cli'];
const MARK = { verified: '✓', contradicted: '✗', review: '◇' } as const;

/** The ask section: a profile card for crossexam, and a prompt box on the sky. */
export function AskPanel() {
  const tex = skyTexture();
  const [mode, setMode] = useState(0);
  const [agent, setAgent] = useState(0);
  const [menu, setMenu] = useState(false);
  const [sent, setSent] = useState<number | null>(null);
  const [text, setText] = useState<string>(MODES[0].prompt);
  const segs = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState({ x: 0, w: 0 });
  useEffect(() => {
    const b = segs.current?.querySelectorAll<HTMLButtonElement>('button')[mode];
    if (b) setPill({ x: b.offsetLeft, w: b.offsetWidth });
  }, [mode]);
  useEffect(() => {
    const on = () => {
      const b = segs.current?.querySelectorAll<HTMLButtonElement>('button')[mode];
      if (b) setPill({ x: b.offsetLeft, w: b.offsetWidth });
    };
    document.fonts?.ready.then(on);
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, [mode]);
  const pick = (i: number) => {
    setMode(i);
    setText(MODES[i].prompt);
    setSent(null);
  };
  const m = MODES[mode];
  return (
    <div className="ask-wrap">
      <div className="profile">
        <div className="pf-card">
          <div className="pf-banner" style={{ backgroundImage: `url(${tex})` }} />
          <div className="pf-av" style={{ backgroundImage: `url(${tex})` }}>
            <LogoMark bare size={40} />
          </div>
          <a className="pf-follow" href={REPO} target="_blank" rel="noreferrer">
            ★ star
          </a>
          <div className="pf-name">
            crossexam
            <svg width="18" height="18" viewBox="0 0 24 24" aria-label="verified" role="img">
              <path fill="#00AAEE" d="M12 1.8l2.6 1.9 3.2-.2 1 3 2.6 1.9-1 3.1 1 3.1-2.6 1.9-1 3-3.2-.2L12 22.2l-2.6-1.9-3.2.2-1-3-2.6-1.9 1-3.1-1-3.1 2.6-1.9 1-3 3.2.2Z" />
              <path d="M8 12.2l2.6 2.6L16.2 9" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="pf-handle">@crossexamdev</div>
          <p className="pf-bio">crossexam reads what your agent said and answers with the run that backs it. tests, renames, migrations, dependencies.</p>
          <div className="pf-meta">
            <span>runs on your machine</span>
            <a href={REPO} target="_blank" rel="noreferrer">
              github.com/zackt223/crossexam
            </a>
            <span>free · mit</span>
          </div>
        </div>
        <div className="dock" aria-label="works where you work">
          <span className="dk term" title="terminal">
            <code>&gt;_</code>
          </span>
          <span className="dk editor" title="editor">
            <code>{'{ }'}</code>
          </span>
          <span className="dk ci" title="ci">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
          <span className="dk mcp" title="mcp">
            <code>mcp</code>
          </span>
          <span className="dk app" title="crossexam">
            <LogoMark size={40} />
          </span>
        </div>
      </div>

      <div className="ask-sky" style={{ backgroundImage: `url(${tex})` }}>
        <div className="seg-nav" ref={segs} role="tablist" aria-label="what to ask">
          <span className="seg-pill" style={{ transform: `translateX(${pill.x}px)`, width: pill.w }} aria-hidden="true" />
          {MODES.map((x, i) => (
            <button key={x.id} role="tab" aria-selected={mode === i} className={mode === i ? 'on' : ''} onClick={() => pick(i)}>
              {x.id}
            </button>
          ))}
        </div>
        <div className="prompt-card">
          <textarea value={text} onChange={(e) => (setText(e.target.value), setSent(null))} aria-label="what you'd ask" rows={4} />
          <div className="prompt-bar">
            <div className="dd">
              <button className="dd-btn" onClick={() => setMenu(!menu)} aria-expanded={menu}>
                {AGENTS[agent]}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M7 10l5 5 5-5" />
                </svg>
              </button>
              {menu && (
                <div className="dd-menu">
                  {AGENTS.map((a, i) => (
                    <button key={a} className={i === agent ? 'on' : ''} onClick={() => (setAgent(i), setMenu(false))}>
                      {a}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="pb-ico" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 11.5 12.3 19a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.4-7.3" />
              </svg>
            </span>
            <span className="pb-ico" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <rect x="9" y="3.5" width="6" height="11" rx="3" />
                <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
              </svg>
            </span>
            <button className="send" onClick={() => setSent(mode)} aria-label="run it">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5 21 3Z" />
              </svg>
            </button>
          </div>
        </div>
        {sent !== null && (
          <div className="ask-result">
            <code className="ask-cmd">
              <span className="p">$</span> {m.cmd}
              {agent > 0 && <span className="dim"> # for {AGENTS[agent]}</span>}
            </code>
            {m.out.map(([v, a, b], i) => (
              <div key={i} className={`ask-line ${v}`} style={{ animationDelay: `${i * 120}ms` }}>
                <b>{MARK[v]}</b>
                <span>{a}</span>
                <em>{b}</em>
              </div>
            ))}
            <span className="ask-note">example output</span>
          </div>
        )}
      </div>
    </div>
  );
}
