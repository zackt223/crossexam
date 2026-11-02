import type { ReactNode } from 'react';
import { VERDICT_LABEL, type Verdict } from '../data/model';

export function VerdictChip({ v, small }: { v: Verdict; small?: boolean }) {
  return (
    <span className={`chip chip-${v}${small ? ' chip-sm' : ''}`}>
      <i className="chip-dot" />
      {VERDICT_LABEL[v]}
    </span>
  );
}

export function Avatar({ name, tone }: { name: string; tone?: string }) {
  const tones = ['#ece8fb:#5b4bc4', '#e7f3ec:#2f7a4d', '#f6ece3:#8a5a2b', '#e4f1f4:#1d6b7a', '#fbe9ec:#a33a50', '#eef0f3:#4b5563'];
  const [bg, fg] = (tone ?? tones[name.charCodeAt(0) % tones.length]).split(':');
  return (
    <span className="avatar" style={{ background: bg, color: fg }}>
      {name[0]?.toUpperCase()}
    </span>
  );
}

export function Pct({ n, digits }: { n: number; digits?: number }) {
  const d = digits ?? (n > 0 && n < 0.1 ? 1 : 0);
  return <>{(n * 100).toFixed(d)}%</>;
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="sec">
      <div className="sec-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const p: Record<string, ReactNode> = {
    home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z" />,
    claims: (
      <>
        <path d="M5 4h14v16H5z" />
        <path d="m8.5 12 2.2 2.2L15.5 9.5" />
      </>
    ),
    route: (
      <>
        <path d="M6 3v6a4 4 0 0 0 4 4h8" />
        <path d="m15 10 3 3-3 3" />
        <path d="M6 21v-8" />
      </>
    ),
    audit: (
      <>
        <path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6Z" />
        <path d="M9 12h6M9 15.5h4" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m20 20-4.2-4.2" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V4M7 9l5-5 5 5" />
        <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
      </>
    ),
    download: (
      <>
        <path d="M12 4v12M7 11l5 5 5-5" />
        <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
      </>
    ),
    x: <path d="M6 6l12 12M18 6 6 18" />,
    chev: <path d="m9 6 6 6-6 6" />,
    updown: <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />,
    plus: <path d="M12 5v14M5 12h14" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
      </>
    ),
    arrow: <path d="M7 17 17 7M8 7h9v9" />,
    lock: (
      <>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {p[name]}
    </svg>
  );
}

/** Render `code` spans the way agents write them. */
export function Ticks({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/).map((p, i) => (p.startsWith('`') && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : p))}</>;
}
