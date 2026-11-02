import { KIND_LABEL, agentLabel, tally, type Claim, type Route } from '../data/model';
import { Icon, VerdictChip } from './ui';

export function Audit({ claims, route }: { claims: Claim[]; route: (c: Claim) => Route }) {
  const t = tally(claims);
  const range = claims.length ? `${claims[claims.length - 1].at.slice(0, 10)} → ${claims[0].at.slice(0, 10)}` : '—';

  const exportCsv = () => {
    const head = ['claim_id', 'timestamp', 'agent', 'model', 'repo', 'pr', 'claim_type', 'claim', 'verdict', 'reason', 'evidence_command', 'evidence_exit_code', 'routed_to'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    const rows = claims.map((c) => [c.id, c.at, c.agent, c.model, c.repo, c.pr ?? '', c.kind, c.claim, c.verdict, c.reason, c.evidence?.command ?? '', c.evidence?.exitCode ?? '', route(c)].map(esc).join(','));
    download(`crossexam-evidence-${new Date().toISOString().slice(0, 10)}.csv`, [head.join(','), ...rows].join('\n'), 'text/csv');
  };
  const exportJson = () => {
    const doc = {
      kind: 'crossexam.evidence/v1',
      generatedAt: new Date().toISOString(),
      control: 'Change management: AI-authored changes are verified against executed checks before merge',
      period: range,
      summary: t,
      records: claims.map((c) => ({ ...c, routedTo: route(c) })),
    };
    download(`crossexam-evidence-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(doc, null, 2), 'application/json');
  };

  return (
    <>
      <div className="evidence">
        <div>
          <div className="evidence-title">SOC 2 evidence export</div>
          <p className="evidence-note">
            Every agent claim in this period, the check that backed or contradicted it, and where it was routed. Hand it to your auditor as evidence for change-management controls.
          </p>
          <div className="evidence-meta">
            <span>{claims.length.toLocaleString()} records</span>
            <span>{range}</span>
            <span>{(t.contradicted + t.stale).toLocaleString()} exceptions</span>
          </div>
        </div>
        <div className="evidence-actions">
          <button className="btn btn-dark" onClick={exportCsv}>
            <Icon name="download" size={16} /> CSV
          </button>
          <button className="btn btn-ghost" onClick={exportJson}>
            <Icon name="download" size={16} /> JSON
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table audit">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Verdict</th>
              <th className="hide-sm">Routed</th>
            </tr>
          </thead>
          <tbody>
            {claims.slice(0, 40).map((c) => (
              <tr key={c.id}>
                <td className="mono sm muted nowrap">{c.at.replace('T', ' ').slice(0, 16)}</td>
                <td>
                  <b>{agentLabel(c.agent)}</b> claimed <b>{KIND_LABEL[c.kind].toLowerCase()}</b> in <span className="mono sm">{c.repo}</span>
                  {c.author && <span className="muted"> · run by {c.author}</span>}
                </td>
                <td>
                  <VerdictChip v={c.verdict} small />
                </td>
                <td className="hide-sm">
                  <span className={`route route-${route(c)}`}>{route(c)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
