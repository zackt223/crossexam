// Agent-driven verification: structured findings an agent can act on, and an
// independent re-check that is the only way a finding gets closed.
//
// A run with something wrong opens a session (~/.crossexam/sessions/<id>.json):
// each contradicted claim and each surviving mutant becomes a finding with a
// stable id, what to do, and how it will be re-checked. The agent fixes things
// and calls `reverify`; crossexam re-runs exactly those checks itself. Nothing
// the agent says can mark a finding resolved.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyText } from './live.js';
import { STATUS, assessStrength, severityOf } from './strength.js';

const home = () => process.env.CROSSEXAM_HOME || path.join(os.homedir(), '.crossexam');
const sessionsDir = () => path.join(home(), 'sessions');
const SESSION_ID = /^cx-[0-9a-f]{10}$/;
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Findings from a verify result and/or a mutation report. Empty when nothing is wrong. */
export function findingsFrom({ verify = null, strength = null } = {}) {
  const out = [];
  for (const r of verify?.results ?? []) {
    if (r.verdict !== 'contradicted' && r.verdict !== 'stale') continue;
    const cmd = r.evidence?.command ?? null;
    out.push({
      id: `claim-${hash(`${r.kind}\u0000${r.claim}`)}`,
      type: 'claim',
      severity: ['tests', 'build', 'types', 'migration'].includes(r.kind) ? 'high' : 'medium',
      kind: r.kind,
      claim: r.claim,
      verdict: r.verdict,
      reason: r.reason,
      command: cmd,
      excerpt: r.evidence?.excerpt ?? null,
      ask:
        r.verdict === 'stale'
          ? `Re-run ${cmd ? `\`${cmd}\`` : 'the check'} after your last edit, then report what it printed.`
          : `Fix what makes ${cmd ? `\`${cmd}\`` : 'the check'} disagree, or correct the claim to say what is true.`,
      recheck: cmd ? `crossexam re-runs \`${cmd}\`` : 'crossexam re-checks the claim',
      status: 'open',
    });
  }
  for (const m of strength?.mutants ?? []) {
    if (m.status !== STATUS.SURVIVED || !m.fingerprint) continue;
    out.push({
      id: `mutant-${m.fingerprint}`,
      type: 'mutant',
      severity: severityOf(m.operator),
      fingerprint: m.fingerprint,
      category: m.category,
      operator: m.operator,
      file: m.file,
      line: m.line,
      function: m.function,
      before: m.before ?? null,
      after: m.after ?? null,
      why: m.why,
      ask: 'Add or strengthen a test that fails when this change is made. Do not change the code under test to dodge it.',
      recheck: 'crossexam plants this exact defect again and runs your tests',
      status: 'open',
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Save a session for these findings and return it. */
export function openSession({ findings, cwd, repo, agent = 'unknown', source = 'cli', testCommand = null }) {
  const id = `cx-${randomBytes(5).toString('hex')}`;
  const session = {
    id,
    createdAt: new Date().toISOString(),
    cwd: path.resolve(cwd),
    repo: repo ?? path.basename(path.resolve(cwd)),
    agent,
    source,
    testCommand,
    findings,
    rounds: [],
  };
  save(session);
  return session;
}

export function loadSession(id) {
  if (!SESSION_ID.test(String(id))) throw new Error(`"${id}" is not a crossexam session id (they look like cx-1a2b3c4d5e)`);
  const f = path.join(sessionsDir(), `${id}.json`);
  if (!fs.existsSync(f)) throw new Error(`no session ${id} on this machine`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function save(session) {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(), `${session.id}.json`), JSON.stringify(session, null, 2));
}

/** Recent sessions, newest first. */
export function listSessions(limit = 20) {
  try {
    return fs
      .readdirSync(sessionsDir())
      .filter((f) => /^cx-[0-9a-f]{10}\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8')))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Re-check every open finding in a session, independently.
 * Claims: the original sentences are verified again from scratch.
 * Mutants: each surviving defect is planted again by fingerprint and the tests
 * re-run. A defect whose code is gone is "superseded": the code changed, so the
 * finding can't be closed or kept, and a fresh `mutate` is the way to judge it.
 */
export async function reverify(id, { cwd, isolation, allowUnsandboxed, timeoutSeconds } = {}) {
  const session = loadSession(id);
  const repoDir = path.resolve(cwd || session.cwd);
  const open = session.findings.filter((f) => f.status === 'open' || f.status === 'still-open');
  const round = session.rounds.length + 1;
  const changes = [];
  let blocker = null;

  const claims = open.filter((f) => f.type === 'claim');
  if (claims.length) {
    const r = await verifyText(claims.map((f) => f.claim).join('\n'), { cwd: repoDir, timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined });
    for (const f of claims) {
      const now = r.results.find((x) => x.kind === f.kind && x.claim === f.claim) ?? r.results.find((x) => x.kind === f.kind);
      const ok = now && (now.verdict === 'verified' || now.verdict === 'review');
      changes.push({ id: f.id, status: ok ? 'resolved' : 'still-open', evidence: now ? `${now.verdict}: ${now.reason}` : 'the claim was not found again' });
    }
  }

  const muts = open.filter((f) => f.type === 'mutant');
  if (muts.length) {
    const files = [...new Set(muts.map((f) => f.file))];
    const s = await assessStrength({ cwd: repoDir, files, fingerprints: muts.map((f) => f.fingerprint), max: muts.length, cache: false, isolation, allowUnsandboxed, testCommand: session.testCommand || undefined });
    if (s.blocker) blocker = s.blocker;
    const byFp = new Map(s.mutants.map((m) => [m.fingerprint, m]));
    for (const f of muts) {
      const m = byFp.get(f.fingerprint);
      if (s.blocker) changes.push({ id: f.id, status: 'still-open', evidence: `not re-checked: ${s.blocker}` });
      else if (!m) changes.push({ id: f.id, status: 'superseded', evidence: 'that code is no longer there; run crossexam mutate to judge the new code' });
      else if (m.status === STATUS.KILLED) changes.push({ id: f.id, status: 'resolved', evidence: `caught now: ${m.why || 'a test failed'}` });
      else if (m.status === STATUS.SURVIVED) changes.push({ id: f.id, status: 'still-open', evidence: 'the tests still pass with this defect planted' });
      else changes.push({ id: f.id, status: 'still-open', evidence: `inconclusive (${m.status.toLowerCase().replace('mutation_', '')}): ${m.why || ''}`.trim() });
    }
  }

  for (const c of changes) {
    const f = session.findings.find((x) => x.id === c.id);
    f.status = c.status;
    f.evidence = c.evidence;
    if (c.status === 'resolved' && !f.resolvedRound) f.resolvedRound = round;
  }
  const count = (st) => changes.filter((c) => c.status === st).length;
  const summary = { round, at: new Date().toISOString(), checked: changes.length, resolved: count('resolved'), stillOpen: count('still-open'), superseded: count('superseded'), blocker };
  session.rounds.push(summary);
  save(session);
  return { session, summary, changes };
}

/** A ledger record for one re-verification round, for reliability history. */
export function reverifyRecord(session, summary) {
  return {
    type: 'reverify',
    at: summary.at,
    session: session.id,
    agent: session.agent,
    repo: session.repo,
    round: summary.round,
    findings: session.findings.length,
    resolved: summary.resolved,
    stillOpen: summary.stillOpen,
    superseded: summary.superseded,
    allResolved: session.findings.every((f) => f.status === 'resolved' || f.status === 'superseded'),
  };
}

/** Plain text an agent can act on. */
export function formatFindingsForAgent(session, findings = session.findings) {
  const open = findings.filter((f) => f.status === 'open' || f.status === 'still-open');
  if (!open.length) return `Session ${session.id}: nothing open.`;
  const lines = open.slice(0, 12).map((f, i) =>
    f.type === 'claim'
      ? `${i + 1}. [${f.severity}] claim ${f.verdict}: "${f.claim}"${f.command ? `\n   evidence: \`${f.command}\`` : ''}\n   do: ${f.ask}`
      : `${i + 1}. [${f.severity}] ${f.category} gap in ${f.file}:${f.line}${f.function ? ` (${f.function})` : ''}\n   changing  ${String(f.before ?? '').split('\n')[0].trim()}\n   to        ${String(f.after ?? '').split('\n')[0].trim()}\n   still passed every test. ${f.why ?? ''}\n   do: ${f.ask}`,
  );
  return `crossexam findings, session ${session.id} (${open.length} open):\n\n${lines.join('\n\n')}\n\nWhen you have fixed them, call reverify_findings with session "${session.id}" (or run: crossexam reverify ${session.id}). Only that re-check can close a finding; do not report them as fixed before it does.`;
}
