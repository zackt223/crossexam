import { useMemo, useState } from 'react';
import { KIND_LABEL, KINDS, agentLabel, groupBy, headlineInsight, tally, timeAgo, type Claim, type Route } from '../data/model';
import { AgentFolder, type FolderTone } from './AgentFolder';
import { Avatar, Pct, Section, Ticks, VerdictChip } from './ui';

const TONES: Record<string, FolderTone> = { 'claude-code': 'coral', codex: 'teal', cursor: 'silver', copilot: 'sky' };
const FALLBACK_TONES: FolderTone[] = ['teal', 'silver', 'coral', 'sky'];

export function Overview({ claims, agent, onAgent, onOpen, route }: { claims: Claim[]; agent: string | null; onAgent: (a: string | null) => void; onOpen: (c: Claim) => void; route: (c: Claim) => Route }) {
  const agents = useMemo(() => [...groupBy(claims, (c) => c.agent)].sort((a, b) => b[1].length - a[1].length), [claims]);
  const scoped = agent ? claims.filter((c) => c.agent === agent) : claims;
  const t = tally(scoped);
  const autoMerged = scoped.filter((c) => route(c) === 'auto-merge').length;
  const insight = useMemo(() => headlineInsight(claims), [claims]);
  const [feed, setFeed] = useState<'flagged' | 'all'>('flagged');
  const feedItems = (feed === 'flagged' ? scoped.filter((c) => c.verdict === 'contradicted' || c.verdict === 'stale') : scoped).slice(0, 7);

  return (
    <>
      <Section title="Agents" aside={agent ? <button className="link" onClick={() => onAgent(null)}>Show all agents</button> : <span className="muted">Pick one to focus the page</span>}>
        <div className="folders">
          {agents.map(([a, cs], i) => {
            const at = tally(cs);
            const models = [...new Set(cs.map((c) => c.model))];
            // One claim that held up, one that didn't: the folder shows both sides at a glance.
            const papers = [cs.find((c) => c.verdict === 'verified'), cs.find((c) => c.verdict === 'contradicted' || c.verdict === 'stale') ?? cs[1]]
              .filter((c): c is Claim => !!c)
              .map((c) => ({ ok: c.verdict === 'verified', text: KIND_LABEL[c.kind] }));
            return (
              <button key={a} className={`folder-card${agent === a ? ' active' : ''}`} onClick={() => onAgent(agent === a ? null : a)}>
                <AgentFolder tone={TONES[a] ?? FALLBACK_TONES[i % 4]} tally={at} models={models} papers={papers} />
                <span className="folder-name">{agentLabel(a)}</span>
                <span className="folder-meta">
                  {cs.length} claims · <Pct n={at.falseDone} /> false
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <div className="kpis">
        <Kpi label="Claims cross-examined" value={t.claims.toLocaleString()} note={`${new Set(scoped.map((c) => c.repo)).size} repos · ${new Set(scoped.map((c) => c.agent)).size} agents`} />
        <Kpi label={'False “done”s caught'} value={(t.contradicted + t.stale).toLocaleString()} note={<><Pct n={t.falseDone} /> of checked claims</>} tone="bad" />
        <Kpi label="Merged without review" value={autoMerged.toLocaleString()} note={<><Pct n={t.claims ? autoMerged / t.claims : 0} digits={0} /> of claims held up</>} tone="good" />
        <Kpi label="Review hours saved" value={`${Math.round(autoMerged * 0.35)}h`} note="at 21 min per routine review" />
      </div>

      <Section title="Reliability by agent" aside={<span className="muted">Share of checked claims that were false or stale</span>}>
        {insight && !agent && (
          <div className="insight">
            <span className="insight-tag">Pattern</span>
            {insight}
          </div>
        )}
        <Matrix claims={claims} focus={agent} />
      </Section>

      <Section
        title="Recent activity"
        aside={
          <div className="mini-seg" role="group" aria-label="Activity filter">
            <button className={feed === 'flagged' ? 'on' : ''} onClick={() => setFeed('flagged')}>
              Flagged
            </button>
            <button className={feed === 'all' ? 'on' : ''} onClick={() => setFeed('all')}>
              All
            </button>
          </div>
        }
      >
        <ul className="feed">
          {feedItems.map((c) => (
            <li key={c.id}>
              <button className="feed-row" onClick={() => onOpen(c)}>
                <Avatar name={c.author ?? agentLabel(c.agent)} />
                <div className="feed-body">
                  <div className="feed-line">
                    <b>{agentLabel(c.agent)}</b> <span className="muted">claimed</span> <b>{KIND_LABEL[c.kind].toLowerCase()}</b> <span className="muted">in</span> <b>{c.repo}{c.pr ? `#${c.pr}` : ''}</b>
                    <span className="feed-time">{timeAgo(c.at)}</span>
                  </div>
                  <div className="feed-quote">
                    <span className="q">
                      “<Ticks text={c.claim} />”
                    </span>
                    <span className="feed-reason">
                      <VerdictChip v={c.verdict} small /> <Ticks text={c.reason} />
                    </span>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note: React.ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className={`kpi-value${tone ? ' ' + tone : ''}`}>{value}</span>
      <span className="kpi-note">{note}</span>
    </div>
  );
}

function Matrix({ claims, focus }: { claims: Claim[]; focus: string | null }) {
  const agents = [...groupBy(claims, (c) => c.agent)].sort((a, b) => b[1].length - a[1].length);
  const kinds = KINDS.filter((k) => k !== 'security' && claims.some((c) => c.kind === k));
  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr>
            <th />
            {kinds.map((k) => (
              <th key={k}>{KIND_LABEL[k]}</th>
            ))}
            <th>Overall</th>
          </tr>
        </thead>
        <tbody>
          {agents.map(([a, cs]) => (
            <tr key={a} className={focus && focus !== a ? 'dim' : ''}>
              <th>{agentLabel(a)}</th>
              {kinds.map((k) => {
                const sub = cs.filter((c) => c.kind === k);
                const r = tally(sub);
                const n = r.verified + r.contradicted + r.stale;
                return (
                  <td key={k} title={`${n} checked`}>
                    {n < 3 ? <span className="cell-na">–</span> : <Cell rate={r.falseDone} />}
                  </td>
                );
              })}
              <td>
                <Cell rate={tally(cs).falseDone} strong />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ rate, strong }: { rate: number; strong?: boolean }) {
  // Soft red ramp: invisible at 0, clearly warm by 20%.
  const a = Math.min(1, rate / 0.22);
  return (
    <span className={`cell${strong ? ' strong' : ''}`} style={{ background: `rgba(229, 72, 77, ${0.06 + a * 0.32})`, color: a > 0.6 ? '#9b1c22' : '#3f3f46' }}>
      <Pct n={rate} />
    </span>
  );
}
