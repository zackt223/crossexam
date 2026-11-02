import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LogoMark } from '../components/Logo';
import { demoClaims } from '../data/demo';
import { groupBy, parseReport, tally, type Claim } from '../data/model';
import { Audit } from './Audit';
import { ClaimDrawer, Claims } from './Claims';
import { Overview } from './Overview';
import { DEFAULT_POLICY, Routing, routeWith, type Policy } from './Routing';
import { Icon } from './ui';
import './dashboard.css';

type View = 'overview' | 'claims' | 'routing' | 'audit';
const STORE = 'crossexam.report.v1';

function load(): { claims: Claim[]; source: 'demo' | 'report'; name?: string } {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const j = JSON.parse(raw);
      return { claims: j.claims, source: 'report', name: j.name };
    }
  } catch {
    /* private mode or a bad save: fall back to the demo */
  }
  return { claims: demoClaims(), source: 'demo' };
}

export default function Dashboard() {
  const [data, setData] = useState(load);
  const [view, setView] = useState<View>('overview');
  const [agent, setAgent] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [open, setOpen] = useState<Claim | null>(null);
  const [query, setQuery] = useState('');
  const [policy, setPolicy] = useState<Policy>(DEFAULT_POLICY);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'crossexam · dashboard';
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setView('claims');
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ingest = useCallback(async (file: File) => {
    try {
      const claims = parseReport(await file.text());
      if (!claims.length) throw new Error('That report has no claims in it yet.');
      claims.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const next = { claims, source: 'report' as const, name: file.name };
      setData(next);
      setAgent(null);
      setRepo(null);
      setError('');
      try {
        localStorage.setItem(STORE, JSON.stringify(next));
      } catch {
        /* too big to remember; still shown for this visit */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.');
    }
  }, []);

  const resetDemo = () => {
    setError('');
    try {
      localStorage.removeItem(STORE);
    } catch {}
    setData({ claims: demoClaims(), source: 'demo' });
    setAgent(null);
    setRepo(null);
  };

  const claims = useMemo(() => (repo ? data.claims.filter((c) => c.repo === repo) : data.claims), [data, repo]);
  const repos = useMemo(() => [...groupBy(data.claims, (c) => c.repo)].sort((a, b) => b[1].length - a[1].length), [data]);
  const agentRates = useMemo(() => new Map([...groupBy(claims, (c) => c.agent)].map(([a, cs]) => [a, tally(cs).falseDone])), [claims]);
  const route = useMemo(() => routeWith(policy, agentRates), [policy, agentRates]);
  const flagged = claims.filter((c) => c.verdict === 'contradicted' || c.verdict === 'stale').length;

  const go = (v: View) => {
    setView(v);
    setNavOpen(false);
  };
  const titles: Record<View, string> = { overview: 'Overview', claims: 'Claims', routing: 'Review routing', audit: 'Audit trail' };
  const workspace = data.source === 'demo' ? 'Northwind Labs' : 'Your agents';

  return (
    <div
      className="dash"
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f) ingest(f);
      }}
    >
      <div className="topbar">
        <button className="icon-btn" onClick={() => setNavOpen(!navOpen)} aria-label="Menu">
          <Icon name="menu" />
        </button>
        <span className="topbar-title">{titles[view]}</span>
        <LogoMark size={24} />
      </div>

      <aside className={`side${navOpen ? ' open' : ''}`}>
        <div className="ws">
          <span className="ws-tile">{data.source === 'demo' ? 'NW' : <LogoMark size={40} flat />}</span>
          <div className="ws-text">
            <span className="ws-name">{workspace}</span>
            <span className="ws-sub">{data.source === 'demo' ? '42 members · demo data' : data.name ?? 'Imported report'}</span>
          </div>
          <Icon name="updown" size={16} />
        </div>

        <label className="search">
          <Icon name="search" size={17} />
          <input ref={searchRef} placeholder="Search claims" value={query} onChange={(e) => (setQuery(e.target.value), view !== 'claims' && setView('claims'))} />
          <kbd>⌘K</kbd>
        </label>

        <nav className="nav">
          <NavItem icon="home" label="Overview" on={view === 'overview'} onClick={() => go('overview')} />
          <NavItem icon="claims" label="Claims" on={view === 'claims'} onClick={() => go('claims')} count={flagged} hot />
          <NavItem icon="route" label="Review routing" on={view === 'routing'} onClick={() => go('routing')} />
          <NavItem icon="audit" label="Audit trail" on={view === 'audit'} onClick={() => go('audit')} />
        </nav>

        <div className="side-label">
          <span>Repositories</span>
          <button className="icon-btn sm" onClick={() => fileRef.current?.click()} aria-label="Import a report">
            <Icon name="plus" size={16} />
          </button>
        </div>
        <ul className="tree">
          <li>
            <button className={`tree-row root${!repo ? ' on' : ''}`} onClick={() => setRepo(null)}>
              <Folder color="#2b2b2e" />
              <span className="tree-name">All repositories</span>
              <span className="tree-n">{data.claims.length}</span>
            </button>
          </li>
          {repos.map(([r, cs], i) => (
            <li key={r}>
              <button className={`tree-row${repo === r ? ' on' : ''}`} onClick={() => setRepo(repo === r ? null : r)}>
                <Folder color={['#8b7fd6', '#f2b23a', '#7aa7f5', '#e0623e', '#9aa0a6', '#4fb28a'][i % 6]} />
                <span className="tree-name">{r.split('/').pop()}</span>
                <span className="tree-n">{cs.length}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="side-foot">
          <div className="import" onClick={() => fileRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}>
            <Icon name="upload" size={18} />
            <div>
              <div className="import-title">{data.source === 'demo' ? 'Load your own report' : 'Load another report'}</div>
              <div className="import-note">
                <code>npx crossexam scan --json</code>, then drop the file here
              </div>
            </div>
          </div>
          {data.source === 'report' && (
            <button className="link sm" onClick={resetDemo}>
              Back to demo data
            </button>
          )}
          <Link to="/" className="link sm">
            ← crossexam.dev
          </Link>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && ingest(e.target.files[0])} />
        </div>
      </aside>
      {navOpen && <div className="side-scrim" onClick={() => setNavOpen(false)} />}

      <main className="main">
        <header className="crumbs">
          <span className="muted">{repo ? repo : workspace}</span>
          <Icon name="chev" size={14} />
          <span>{titles[view]}</span>
          {data.source === 'demo' && <span className="demo-pill">Demo data</span>}
        </header>
        {error && (
          <div className="error" role="alert">
            {error}
            <button className="icon-btn sm" onClick={() => setError('')} aria-label="Dismiss">
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
        <div className="content">
          {view === 'overview' && <Overview claims={claims} agent={agent} onAgent={setAgent} onOpen={setOpen} route={route} />}
          {view === 'claims' && (
            <>
              <h1 className="page-title">Claims</h1>
              <Claims claims={agent ? claims.filter((c) => c.agent === agent) : claims} query={query} onOpen={setOpen} />
            </>
          )}
          {view === 'routing' && (
            <>
              <h1 className="page-title">Review routing</h1>
              <Routing claims={claims} policy={policy} setPolicy={setPolicy} route={route} agentRates={agentRates} onOpen={setOpen} />
            </>
          )}
          {view === 'audit' && (
            <>
              <h1 className="page-title">Audit trail</h1>
              <Audit claims={claims} route={route} />
            </>
          )}
        </div>
      </main>

      {open && <ClaimDrawer claim={open} route={route(open)} onClose={() => setOpen(null)} />}
      {drag && (
        <div className="dropzone">
          <div>
            <LogoMark size={56} />
            <p>Drop a crossexam report to load it</p>
          </div>
        </div>
      )}
    </div>
  );
}

function NavItem({ icon, label, on, onClick, count, hot }: { icon: string; label: string; on: boolean; onClick: () => void; count?: number; hot?: boolean }) {
  return (
    <button className={`nav-item${on ? ' on' : ''}`} onClick={onClick} aria-current={on ? 'page' : undefined}>
      <Icon name={icon} />
      <span>{label}</span>
      {count ? <span className={`nav-n${hot ? ' hot' : ''}`}>{count}</span> : null}
    </button>
  );
}

function Folder({ color }: { color: string }) {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16" aria-hidden="true">
      <path d="M1 3a2 2 0 0 1 2-2h4.2l2 2H17a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2Z" fill={color} />
      <path d="M1 6h18v7a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2Z" fill="#fff" opacity=".14" />
    </svg>
  );
}
