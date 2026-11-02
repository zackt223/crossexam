// The dashboard works on the same claim records the CLI writes with
// `crossexam scan --json`, so a real report and the demo look identical.

export type Verdict = 'verified' | 'contradicted' | 'stale' | 'unbacked' | 'review';
export type ClaimKind = 'tests' | 'build' | 'types' | 'lint' | 'refactor' | 'migration' | 'deps' | 'security';
export type Route = 'auto-merge' | 'standard' | 'senior';

export interface Claim {
  id: string;
  agent: string;
  model: string;
  repo: string;
  session: string;
  turn: number;
  at: string;
  taskType: string;
  prompt: string;
  kind: ClaimKind;
  claim: string;
  verdict: Verdict;
  reason: string;
  evidence: { command?: string; exitCode?: number | null; excerpt?: string; rerun?: boolean } | null;
  pr?: number;
  author?: string;
}

export const VERDICTS: Verdict[] = ['verified', 'contradicted', 'stale', 'unbacked', 'review'];
export const KINDS: ClaimKind[] = ['tests', 'refactor', 'migration', 'deps', 'types', 'build', 'lint', 'security'];

export const KIND_LABEL: Record<ClaimKind, string> = {
  tests: 'Tests pass',
  build: 'Build passes',
  types: 'Types check',
  lint: 'Lint clean',
  refactor: 'All callers updated',
  migration: 'Migration applied',
  deps: 'Dependency bumped',
  security: 'Security fix',
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  verified: 'Verified',
  contradicted: 'Contradicted',
  stale: 'Stale',
  unbacked: 'Unbacked',
  review: 'Needs review',
};

export const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  gemini: 'Gemini CLI',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  'kilo-code': 'Kilo Code',
  aider: 'Aider',
  devin: 'Devin',
  jules: 'Jules',
  windsurf: 'Windsurf',
  open: 'Other agent',
};
export const agentLabel = (a: string) => AGENT_LABEL[a] ?? a;

/** Review routing policy. Cheap claims that held up skip the queue; anything false goes to a senior. */
export function routeOf(c: Claim): Route {
  if (c.kind === 'security' || c.verdict === 'contradicted' || c.verdict === 'stale') return 'senior';
  if (c.verdict === 'verified' && c.kind !== 'migration') return 'auto-merge';
  return 'standard';
}

export interface Tally {
  claims: number;
  verified: number;
  contradicted: number;
  stale: number;
  unbacked: number;
  review: number;
  falseDone: number; // (contradicted + stale) / checked
  trust: number; // verified / settled
}

export function tally(list: Claim[]): Tally {
  const t: Tally = { claims: list.length, verified: 0, contradicted: 0, stale: 0, unbacked: 0, review: 0, falseDone: 0, trust: 0 };
  for (const c of list) t[c.verdict]++;
  const checked = t.verified + t.contradicted + t.stale;
  t.falseDone = checked ? (t.contradicted + t.stale) / checked : 0;
  t.trust = checked + t.unbacked ? t.verified / (checked + t.unbacked) : 0;
  return t;
}

export function groupBy<K extends string>(list: Claim[], key: (c: Claim) => K): Map<K, Claim[]> {
  const m = new Map<K, Claim[]>();
  for (const c of list) {
    const k = key(c);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(c);
  }
  return m;
}

/** The single most lopsided agent × kind comparison, phrased the way a lead would say it. */
export function headlineInsight(list: Claim[]): string | null {
  const byKind = groupBy(list, (c) => c.kind);
  let best: { ratio: number; text: string } | null = null;
  for (const [kind, kc] of byKind) {
    const agents = [...groupBy(kc, (c) => c.agent)]
      .map(([a, cs]) => {
        const t = tally(cs);
        return { a, n: t.verified + t.contradicted + t.stale, rate: t.falseDone };
      })
      .filter((x) => x.n >= 20);
    if (agents.length < 2) continue;
    agents.sort((x, y) => y.rate - x.rate);
    const worst = agents[0];
    const bestA = agents[agents.length - 1];
    const ratio = worst.rate / Math.max(bestA.rate, 0.03);
    if (worst.rate > 0.08 && ratio > 1.5 && (!best || ratio > best.ratio)) {
      const repos = [...groupBy(kc.filter((c) => c.agent === worst.a), (c) => c.repo)].sort((x, y) => y[1].length - x[1].length);
      best = {
        ratio,
        text: `${agentLabel(worst.a)} makes false “${KIND_LABEL[kind as ClaimKind].toLowerCase()}” claims ${ratio.toFixed(1)}× as often as ${agentLabel(bestA.a)}${repos[0] ? ` in ${repos[0][0]}` : ''}.`,
      };
    }
  }
  return best?.text ?? null;
}

export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(1, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Accept a CLI report (or a bare array of claims). Throws a readable message otherwise. */
export function parseReport(text: string): Claim[] {
  const j = JSON.parse(text);
  const claims = Array.isArray(j) ? j : j?.claims;
  if (!Array.isArray(claims)) throw new Error('That file has no "claims" list. Make one with: npx crossexam scan --json');
  return claims.filter((c) => c && c.verdict && c.kind && c.agent);
}
