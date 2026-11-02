import { KIND_LABEL, KINDS, agentLabel, type Claim, type ClaimKind, type Route } from '../data/model';
import { Icon, Section, VerdictChip } from './ui';

export interface Policy {
  autoMergeKinds: ClaimKind[];
  maxFalseDone: number; // agents above this rate never auto-merge
}

export const DEFAULT_POLICY: Policy = { autoMergeKinds: ['tests', 'types', 'lint', 'build', 'deps'], maxFalseDone: 0.12 };

export function routeWith(policy: Policy, agentRates: Map<string, number>) {
  return (c: Claim): Route => {
    if (c.kind === 'security' || c.verdict === 'contradicted' || c.verdict === 'stale') return 'senior';
    if (c.verdict === 'verified' && policy.autoMergeKinds.includes(c.kind) && (agentRates.get(c.agent) ?? 0) <= policy.maxFalseDone) return 'auto-merge';
    return 'standard';
  };
}

const LANES: { id: Route; title: string; note: string }[] = [
  { id: 'auto-merge', title: 'Auto-merge', note: 'Claims that held up, on low-risk kinds' },
  { id: 'standard', title: 'Standard review', note: 'Unbacked or inconclusive' },
  { id: 'senior', title: 'Senior review', note: 'Contradicted, stale, or security' },
];

export function Routing({ claims, policy, setPolicy, route, agentRates, onOpen }: { claims: Claim[]; policy: Policy; setPolicy: (p: Policy) => void; route: (c: Claim) => Route; agentRates: Map<string, number>; onOpen: (c: Claim) => void }) {
  const toggleKind = (k: ClaimKind) => {
    const has = policy.autoMergeKinds.includes(k);
    setPolicy({ ...policy, autoMergeKinds: has ? policy.autoMergeKinds.filter((x) => x !== k) : [...policy.autoMergeKinds, k] });
  };
  return (
    <>
      <div className="lanes">
        {LANES.map((l) => {
          const list = claims.filter((c) => route(c) === l.id);
          return (
            <div key={l.id} className={`lane lane-${l.id}`}>
              <div className="lane-head">
                <span className="lane-title">{l.title}</span>
                <span className="lane-n">{list.length}</span>
              </div>
              <span className="lane-note">{l.note}</span>
              <ul>
                {list.slice(0, 5).map((c) => (
                  <li key={c.id}>
                    <button onClick={() => onOpen(c)}>
                      <span className="lane-claim">{c.repo.split('/').pop()}{c.pr ? `#${c.pr}` : ''} · {KIND_LABEL[c.kind]}</span>
                      <VerdictChip v={c.verdict} small />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <Section title="Policy" aside={<span className="muted">Changes re-route the queue above instantly</span>}>
        <div className="policy">
          <div className="policy-row">
            <div>
              <div className="policy-title">Auto-merge verified claims of these kinds</div>
              <div className="policy-note">A passing check after the last edit is required. Migrations always get a human.</div>
            </div>
            <div className="toggles">
              {KINDS.filter((k) => k !== 'security' && k !== 'migration').map((k) => (
                <button key={k} className={`tog${policy.autoMergeKinds.includes(k) ? ' on' : ''}`} onClick={() => toggleKind(k)} aria-pressed={policy.autoMergeKinds.includes(k)}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
          <div className="policy-row">
            <div>
              <div className="policy-title">Agents that lose auto-merge</div>
              <div className="policy-note">
                An agent whose false “done” rate tops <b>{Math.round(policy.maxFalseDone * 100)}%</b> goes back to standard review.
              </div>
            </div>
            <div className="slider-wrap">
              <input type="range" min={0.02} max={0.3} step={0.01} value={policy.maxFalseDone} onChange={(e) => setPolicy({ ...policy, maxFalseDone: Number(e.target.value) })} aria-label="False done threshold" />
              <div className="agent-rates">
                {[...agentRates].map(([a, r]) => (
                  <span key={a} className={r > policy.maxFalseDone ? 'over' : ''}>
                    {agentLabel(a)} {(r * 100).toFixed(1)}%
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="policy-row locked">
            <div>
              <div className="policy-title">
                <Icon name="lock" size={14} /> Security fixes go to a senior reviewer
              </div>
              <div className="policy-note">Not configurable. A verifier should never wave a security claim through.</div>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
