// Aggregate claims into a reliability report and print it for humans.

export const VERDICTS = ['verified', 'contradicted', 'stale', 'unbacked', 'review'];

export function buildReport(claims, meta = {}) {
  const tally = (key) => {
    const m = {};
    for (const c of claims) {
      const k = typeof key === 'function' ? key(c) : c[key];
      m[k] ??= { claims: 0, verified: 0, contradicted: 0, stale: 0, unbacked: 0, review: 0 };
      m[k].claims++;
      m[k][c.verdict]++;
    }
    for (const v of Object.values(m)) Object.assign(v, rates(v));
    return m;
  };
  const totals = tally(() => 'all').all ?? { claims: 0, ...rates({}) };
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    ...meta,
    totals,
    byAgent: tally('agent'),
    byModel: tally('model'),
    byRepo: tally('repo'),
    byKind: tally('kind'),
    byTaskType: tally('taskType'),
    matrix: tally((c) => `${c.agent}|${c.kind}`),
    claims: claims.sort((a, b) => String(b.at).localeCompare(String(a.at))),
  };
}

function rates(v) {
  const checked = (v.verified || 0) + (v.contradicted || 0) + (v.stale || 0);
  const settled = checked + (v.unbacked || 0);
  return {
    // Of claims that had a check behind them, how many were false or out of date.
    falseDoneRate: checked ? round(((v.contradicted || 0) + (v.stale || 0)) / checked) : 0,
    // Of all settled claims, how many were backed by a passing check.
    trustRate: settled ? round((v.verified || 0) / settled) : 0,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

// ---------- terminal output ----------

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { dim: paint('2'), bold: paint('1'), red: paint('31'), green: paint('32'), yellow: paint('33'), blue: paint('34'), gray: paint('90') };

const MARK = { verified: c.green('✓ verified'), contradicted: c.red('✗ contradicted'), stale: c.yellow('◷ stale'), unbacked: c.gray('○ unbacked'), review: c.blue('◇ review') };

export function printReport(r, { limit = 8 } = {}) {
  const t = r.totals;
  const line = (s = '') => process.stdout.write(s + '\n');
  line();
  line(`  ${c.bold('crossexam')} ${c.dim('· cross-examined ' + r.sessions + ' sessions, ' + r.turns + ' turns')}`);
  line();
  if (!t.claims) {
    line(c.dim('  No completion claims found. Agents that never say "done" are hard to catch lying.'));
    line();
    return;
  }
  line(`  ${pad(t.claims, 5)} claims     ${c.green(pad(t.verified, 4))} verified   ${c.red(pad(t.contradicted, 4))} contradicted   ${c.yellow(pad(t.stale, 4))} stale   ${c.gray(pad(t.unbacked, 4))} unbacked   ${c.blue(pad(t.review, 4))} review`);
  line();
  line(`  ${c.bold(pct(t.falseDoneRate))} of checked claims were false or stale ${c.dim('(contradicted + stale) / (verified + contradicted + stale)')}`);
  if (r.ranCheckTurns) line(`  ${c.bold(r.contradictedTurns + ' of ' + r.ranCheckTurns)} turns that ran a check ended with a contradicted claim ${c.dim('(' + pct(r.contradictedTurns / r.ranCheckTurns) + ')')}`);
  line();

  const table = (title, m) => {
    const rows = Object.entries(m).sort((a, b) => b[1].claims - a[1].claims).slice(0, 6);
    if (!rows.length) return;
    line(c.dim(`  ${title.padEnd(26)} claims  trust   false-done`));
    for (const [k, v] of rows) line(`  ${k.slice(0, 26).padEnd(26)} ${pad(v.claims, 6)}  ${pad(pct(v.trustRate), 5)}   ${v.falseDoneRate > 0.1 ? c.red(pad(pct(v.falseDoneRate), 5)) : pad(pct(v.falseDoneRate), 5)}`);
    line();
  };
  table('by agent', r.byAgent);
  table('by model', r.byModel);
  table('by claim', r.byKind);
  table('by repo', r.byRepo);

  const bad = r.claims.filter((x) => x.verdict === 'contradicted' || x.verdict === 'stale').slice(0, limit);
  if (bad.length) {
    line(c.bold('  Most recent false "done"s'));
    line();
    for (const x of bad) printClaim(x, line);
  }
}

export function printClaim(x, line = (s = '') => process.stdout.write(s + '\n')) {
  line(`  ${MARK[x.verdict]}  ${c.dim(x.repo + ' · ' + x.agent + ' · ' + (x.at || '').slice(0, 10))}`);
  line(`    “${x.claim.length > 140 ? x.claim.slice(0, 137) + '…' : x.claim}”`);
  line(`    ${c.dim('→ ' + x.reason)}`);
  line();
}

const pad = (v, n) => String(v).padStart(n);
const pct = (n) => `${(n * 100).toFixed(n && n < 0.1 ? 1 : 0)}%`;
