import type { Tally } from '../data/model';
import { Pct } from './ui';

export type FolderTone = 'teal' | 'silver' | 'coral' | 'sky';

/** A glossy 3D folder per agent; the papers sticking out are its latest claims. */
export function AgentFolder({ tone, tally, models, papers }: { tone: FolderTone; tally: Tally; models: string[]; papers: { ok: boolean; text: string }[] }) {
  return (
    <div className={`folder folder-${tone}`} aria-hidden="true">
      <div className="folder-back" />
      {papers.slice(0, 2).map((p, i) => (
        <div key={i} className={`folder-paper folder-paper-${i}`}>
          <span className={`paper-mark ${p.ok ? 'ok' : 'bad'}`}>{p.ok ? '✓' : '✗'}</span>
          <span className="paper-line w80" />
          <span className="paper-line w60" />
          <span className="paper-text">{p.text}</span>
        </div>
      ))}
      <div className="folder-front">
        <div className="folder-models">
          {models.slice(0, 2).map((m) => (
            <span key={m} className="folder-model" title={m}>
              {(m.replace(/^(claude|gpt|cursor|copilot)-?/i, '').match(/[a-z]/i)?.[0] ?? m[0]).toUpperCase()}
            </span>
          ))}
        </div>
        <span className="folder-pill">
          Trust <Pct n={tally.trust} digits={0} />
        </span>
      </div>
    </div>
  );
}
