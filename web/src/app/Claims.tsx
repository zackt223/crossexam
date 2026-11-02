import { useMemo, useState } from 'react';
import { KIND_LABEL, KINDS, VERDICT_LABEL, VERDICTS, agentLabel, timeAgo, type Claim, type ClaimKind, type Verdict } from '../data/model';
import { Icon, Ticks, VerdictChip } from './ui';

export function Claims({ claims, query, onOpen }: { claims: Claim[]; query: string; onOpen: (c: Claim) => void }) {
  const [verdicts, setVerdicts] = useState<Set<Verdict>>(new Set(['contradicted', 'stale']));
  const [kind, setKind] = useState<ClaimKind | ''>('');
  const [limit, setLimit] = useState(60);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return claims.filter(
      (c) =>
        (!verdicts.size || verdicts.has(c.verdict)) &&
        (!kind || c.kind === kind) &&
        (!q || `${c.claim} ${c.reason} ${c.repo} ${c.agent} ${c.model} ${c.prompt}`.toLowerCase().includes(q)),
    );
  }, [claims, verdicts, kind, query]);

  const toggle = (v: Verdict) => {
    const next = new Set(verdicts);
    next.has(v) ? next.delete(v) : next.add(v);
    setVerdicts(next);
  };

  return (
    <>
      <div className="filters">
        <div className="seg" role="group" aria-label="Verdicts">
          {VERDICTS.map((v) => (
            <button key={v} className={`seg-btn${verdicts.has(v) ? ' on' : ''}`} onClick={() => toggle(v)} aria-pressed={verdicts.has(v)}>
              <i className={`dot dot-${v}`} />
              {VERDICT_LABEL[v]}
              <span className="seg-n">{claims.filter((c) => c.verdict === v).length}</span>
            </button>
          ))}
        </div>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as ClaimKind | '')} aria-label="Claim type">
          <option value="">Every claim type</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Claim</th>
              <th>Verdict</th>
              <th className="hide-sm">Agent</th>
              <th className="hide-sm">Repo</th>
              <th className="r">When</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((c) => (
              <tr key={c.id} onClick={() => onOpen(c)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(c)}>
                <td>
                  <div className="cl-kind">{KIND_LABEL[c.kind]}</div>
                  <div className="cl-text">
                    “<Ticks text={c.claim} />”
                  </div>
                </td>
                <td>
                  <VerdictChip v={c.verdict} small />
                </td>
                <td className="hide-sm">
                  <div>{agentLabel(c.agent)}</div>
                  <div className="muted mono sm">{c.model}</div>
                </td>
                <td className="hide-sm mono sm">{c.repo}</td>
                <td className="r muted">{timeAgo(c.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty">Nothing matches. Loosen a filter, or celebrate.</div>}
        {rows.length > limit && (
          <button className="more" onClick={() => setLimit(limit + 60)}>
            Show more <span className="muted">({rows.length - limit} left)</span>
          </button>
        )}
      </div>
    </>
  );
}

export function ClaimDrawer({ claim, route, onClose }: { claim: Claim; route: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const sendBack = `You said: "${claim.claim}"\ncrossexam: ${claim.reason.replace(/`/g, '')}\n${claim.evidence?.excerpt ? `\nOutput:\n${claim.evidence.excerpt}\n` : ''}\nFix it and re-run the check, or correct your summary.`;
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Claim details">
        <header className="drawer-head">
          <VerdictChip v={claim.verdict} />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="drawer-kind">{KIND_LABEL[claim.kind]}</div>
        <blockquote className="drawer-claim">
          “<Ticks text={claim.claim} />”
        </blockquote>
        <p className="drawer-reason">
          <Ticks text={claim.reason} />
        </p>

        {claim.evidence?.command && (
          <div className="term">
            <div className="term-bar">
              <span>{claim.evidence.rerun ? 're-run by crossexam' : 'last relevant run'}</span>
              {claim.evidence.exitCode != null && <span className={claim.evidence.exitCode ? 'bad' : 'good'}>exit {claim.evidence.exitCode}</span>}
            </div>
            <pre>
              <span className="term-prompt">$ </span>
              {claim.evidence.command}
              {claim.evidence.excerpt ? '\n' + claim.evidence.excerpt : ''}
            </pre>
          </div>
        )}

        <dl className="facts">
          <dt>Agent</dt>
          <dd>
            {agentLabel(claim.agent)} <span className="muted mono sm">{claim.model}</span>
          </dd>
          <dt>Repo</dt>
          <dd className="mono sm">
            {claim.repo}
            {claim.pr ? ` #${claim.pr}` : ''}
          </dd>
          <dt>Task</dt>
          <dd>{claim.prompt || <span className="muted">—</span>}</dd>
          <dt>Routed to</dt>
          <dd>
            <span className={`route route-${route}`}>{route === 'auto-merge' ? 'Auto-merge' : route === 'senior' ? 'Senior review' : 'Standard review'}</span>
          </dd>
          <dt>When</dt>
          <dd>{new Date(claim.at).toLocaleString()}</dd>
        </dl>

        {(claim.verdict === 'contradicted' || claim.verdict === 'stale' || claim.verdict === 'unbacked') && (
          <button
            className="btn btn-dark wide"
            onClick={() => {
              navigator.clipboard?.writeText(sendBack).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
          >
            <Icon name="copy" size={16} /> {copied ? 'Copied — paste it to the agent' : 'Copy a send-back for the agent'}
          </button>
        )}
      </aside>
    </div>
  );
}

