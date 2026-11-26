// Reliability intelligence: how reliably each agent produces working software,
// built only from evidence crossexam recorded itself (~/.crossexam/ledger.jsonl):
//   claims     verdicts on what agents said (verify, the MCP tool, the Claude Code hook)
//   strength   how many planted defects their tests caught (mutate, verify --mutate, MCP)
//   fixes      whether their corrections closed findings on independent re-checks
// The three are reported side by side and never blended into one score: an
// agent can be honest about its claims and still ship weak tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ledgerFile = () => path.join(process.env.CROSSEXAM_HOME || path.join(os.homedir(), '.crossexam'), 'ledger.jsonl');

/** Monday of the week a date falls in, as yyyy-mm-dd. */
export function weekOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function readLedger(file = ledgerFile()) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* a torn line from a crash: skip it */
    }
  }
  return out;
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);

/**
 * Per-agent reliability from ledger records.
 * @param {{ since?: number, agent?: string, repo?: string, records?: any[] }} opts
 */
export function reliability({ since = 0, agent, repo, records } = {}) {
  const recs = (records ?? readLedger()).filter((r) => {
    const at = Date.parse(r.at ?? '');
    if (since && !(at >= since)) return false;
    if (agent && r.agent !== agent) return false;
    if (repo && r.repo !== repo) return false;
    return true;
  });

  const agents = new Map();
  const get = (name) => {
    const k = name || 'unknown';
    if (!agents.has(k))
      agents.set(k, {
        agent: k,
        claims: { checked: 0, verified: 0, contradicted: 0, stale: 0, unbacked: 0, review: 0 },
        strength: { runs: 0, killed: 0, survived: 0, weakRuns: 0, behaviouralSurvivors: 0 },
        fixes: { sessions: new Map() },
        weeks: new Map(),
        last: null,
      });
    return agents.get(k);
  };
  const week = (a, at) => {
    const w = weekOf(at);
    if (!w) return null;
    if (!a.weeks.has(w)) a.weeks.set(w, { week: w, checked: 0, falseDone: 0, killed: 0, survived: 0 });
    return a.weeks.get(w);
  };

  for (const r of recs) {
    // a claim: from verify / MCP (type "verify") or the transcript hook (no type)
    if ((r.type === 'verify' || !r.type) && r.verdict) {
      const a = get(r.agent);
      a.claims.checked++;
      a.claims[r.verdict] = (a.claims[r.verdict] ?? 0) + 1;
      const w = week(a, r.at);
      if (w && r.verdict !== 'review') {
        w.checked++;
        if (r.verdict === 'contradicted' || r.verdict === 'stale') w.falseDone++;
      }
      a.last = !a.last || r.at > a.last ? r.at : a.last;
    } else if (r.type === 'mutation' && r.killed + r.survived > 0) {
      const a = get(r.agent);
      a.strength.runs++;
      a.strength.killed += r.killed;
      a.strength.survived += r.survived;
      if (r.rating === 'weak') a.strength.weakRuns++;
      a.strength.behaviouralSurvivors += (r.survivors ?? []).filter((s) => s.behavioural).length;
      const w = week(a, r.at);
      if (w) {
        w.killed += r.killed;
        w.survived += r.survived;
      }
      a.last = !a.last || r.at > a.last ? r.at : a.last;
    } else if (r.type === 'reverify') {
      const a = get(r.agent);
      // keep the latest round per session
      const prev = a.fixes.sessions.get(r.session);
      if (!prev || r.round >= prev.round) a.fixes.sessions.set(r.session, { ...r, firstRound: prev?.firstRound ?? (r.round === 1 ? r : null) });
      else if (r.round === 1) prev.firstRound = r;
      a.last = !a.last || r.at > a.last ? r.at : a.last;
    }
  }

  const rows = [...agents.values()].map((a) => {
    const judged = a.claims.checked - a.claims.review;
    const sessions = [...a.fixes.sessions.values()];
    const closed = sessions.filter((s) => s.allResolved);
    const first = sessions.filter((s) => s.firstRound);
    return {
      agent: a.agent,
      evidence: a.claims.checked + a.strength.runs + sessions.length,
      last: a.last,
      claims: { ...a.claims, falseDoneRate: pct(a.claims.contradicted + a.claims.stale, judged) },
      strength: {
        runs: a.strength.runs,
        killed: a.strength.killed,
        survived: a.strength.survived,
        weakRuns: a.strength.weakRuns,
        behaviouralSurvivors: a.strength.behaviouralSurvivors,
        score: pct(a.strength.killed, a.strength.killed + a.strength.survived),
      },
      fixes: {
        sessions: sessions.length,
        closed: closed.length,
        firstRecheckRate: pct(first.filter((s) => s.firstRound.allResolved).length, first.length),
        roundsToClose: closed.length ? Math.round((closed.reduce((n, s) => n + s.round, 0) / closed.length) * 10) / 10 : null,
        stillOpen: sessions.length - closed.length,
      },
      weeks: [...a.weeks.values()]
        .sort((x, y) => x.week.localeCompare(y.week))
        .map((w) => ({ week: w.week, falseDoneRate: pct(w.falseDone, w.checked), score: pct(w.killed, w.killed + w.survived), checked: w.checked })),
    };
  });
  rows.sort((x, y) => y.evidence - x.evidence);
  return { since: since ? new Date(since).toISOString() : null, records: recs.length, agents: rows };
}

/** One sentence per agent, in plain words, with the evidence behind it. */
export function describeAgent(a) {
  const parts = [];
  if (a.claims.falseDoneRate != null) parts.push(`${Math.round((1 - a.claims.falseDoneRate) * 100)}% of its claims held up (${a.claims.checked} checked)`);
  if (a.strength.score != null) parts.push(`its tests caught ${Math.round(a.strength.score * 100)}% of planted defects (${a.strength.runs} run${a.strength.runs === 1 ? '' : 's'})`);
  if (a.fixes.firstRecheckRate != null) parts.push(`${Math.round(a.fixes.firstRecheckRate * 100)}% of its fixes closed every finding on the first re-check`);
  return parts.length ? parts.join('; ') : 'not enough evidence yet';
}
