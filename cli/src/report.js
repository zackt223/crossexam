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

  if (r.mutation) {
    const m = r.mutation;
    line(`  ${c.bold('Test strength')} ${c.dim(`· ${m.runs} mutation run${m.runs === 1 ? '' : 's'}, ${pct(m.score)} of ${m.killed + m.survived} planted defects caught · separate from the verdicts above`)}`);
    line(c.dim(`  ${'by agent'.padEnd(26)} runs   caught  weak runs`));
    for (const [k, v] of Object.entries(m.byAgent).sort((a, b) => b[1].runs - a[1].runs).slice(0, 6)) {
      line(`  ${k.slice(0, 26).padEnd(26)} ${pad(v.runs, 4)}   ${(v.score < 0.6 ? c.red : v.score < 0.8 ? c.yellow : c.green)(pad(pct(v.score), 5))}   ${pad(v.weakRuns, 4)}`);
    }
    line();
  }

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

// ---------- test strength ----------

const RATING = { strong: c.green('strong'), moderate: c.yellow('moderate'), weak: c.red('weak'), inconclusive: c.gray('inconclusive') };
const SHORT = { MUTATION_KILLED: c.green('killed'), MUTATION_SURVIVED: c.red('survived'), MUTATION_INVALID: c.gray('invalid'), MUTATION_UNRESOLVED: c.yellow('unresolved') };

export function printStrength(r, { line = (s = '') => process.stdout.write(s + '\n'), limit = 8 } = {}) {
  const s = r.summary;
  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  line();
  const iso = r.isolation || {};
  const isoLabel = !iso.method ? c.yellow('not run: no sandbox') : iso.sandboxed ? c.green(`sandboxed (${iso.method})`) : c.red(c.bold('NOT SANDBOXED'));
  line(`  ${c.bold('crossexam')} ${c.dim('· test strength · ' + r.repo + ' · ' + r.scope + ' · ')}${isoLabel}`);
  line();
  if (r.headline) {
    const tone = r.headline.tone === 'good' ? c.green : r.headline.tone === 'warn' ? c.red : c.dim;
    line(`  ${RATING[r.rating]}${s.score != null ? c.dim(`  ·  mutation score ${Math.round(s.score * 100)}%`) : ''}`);
    line(`  ${tone(r.headline.text)}`);
    line();
  }
  if (s.attempted) {
    line(`  ${pad(s.attempted, 3)} attempted   ${pad(s.valid, 3)} valid   ${c.green(pad(s.killed, 3))} killed   ${c.red(pad(s.survived, 3))} survived   ${c.gray(pad(s.invalid, 3))} invalid   ${c.yellow(pad(s.unresolved, 3))} unresolved`);
    line(c.dim(`  ${secs(s.ms)} total${r.baseline ? ` · baseline ${secs(r.baseline.ms)}` : ''}${s.cachedResults ? ` · ${s.cachedResults} from cache` : ''} · ${r.testCommand}`));
    line();
  }
  const fns = r.functions.filter((f) => f.killed + f.survived);
  if (fns.length) {
    line(c.dim('  function                          file                         caught'));
    for (const f of fns.slice(0, 10)) {
      const total = f.killed + f.survived;
      const bar = c.green('█'.repeat(f.killed)) + c.red('█'.repeat(f.survived));
      line(`  ${(f.name || '(top level)').slice(0, 32).padEnd(32)}  ${`${f.file}:${f.line}`.slice(-28).padEnd(28)} ${pad(f.killed + '/' + total, 5)} ${bar}`);
    }
    line();
  }
  const surv = r.mutants.filter((m) => m.status === 'MUTATION_SURVIVED');
  if (surv.length) {
    line(c.bold('  Defects the tests did not notice'));
    line();
    for (const m of surv.slice(0, limit)) {
      const kind = m.category && !['logic', 'arithmetic'].includes(m.category) ? `${m.category} · ` : '';
      line(`  ${SHORT[m.status]}  ${m.file}:${m.line}  ${c.dim((m.function || 'top level') + ' · ' + kind + m.operator)}`);
      if (m.before != null) line(c.dim(`    - ${m.before.split('\n')[0].slice(0, 110)}`));
      if (m.after != null) line(`    ${c.red('+ ' + m.after.split('\n')[0].slice(0, 110))}`);
      line(`    ${c.dim('→ ' + m.why)}`);
      line();
    }
    if (surv.length > limit) line(c.dim(`  …and ${surv.length - limit} more (--json for all)\n`));
  }
  const tests = r.associatedTests.map((t) => t.file);
  if (r.files.length) line(c.dim(`  Tests that touch the changed code: ${tests.length ? tests.slice(0, 6).join(', ') + (tests.length > 6 ? ` +${tests.length - 6}` : '') : 'none found'}`));
  if (r.skippedFiles.length) line(c.dim(`  Not mutated: ${r.skippedFiles.slice(0, 5).map((f) => `${f.file} (${f.reason})`).join(', ')}${r.skippedFiles.length > 5 ? ` +${r.skippedFiles.length - 5}` : ''}`));
  for (const n of r.notes) if (n !== r.headline?.text) line(c.dim(`  ${n}`));
  line();
  printExecution(r, line);
  line(c.dim('  A mutation score says how well the tests pin down the changed code, not whether the code is correct.'));
  line();
}

/** What crossexam actually did, in plain words, so nobody has to read the source to know. */
export function printExecution(r, line = (s = '') => process.stdout.write(s + '\n')) {
  const e = r.execution || {};
  const iso = r.isolation || {};
  const row = (k, v) => line(`  ${c.dim(k.padEnd(14))} ${v}`);
  line(c.bold('  What crossexam did'));
  row('repository', `${e.repository ?? r.repo}  ${c.dim(r.cwd || '')}`);
  row('compared', r.scope);
  row('files', r.files.length ? `${r.files.length} evaluated: ${r.files.slice(0, 4).map((f) => f.file).join(', ')}${r.files.length > 4 ? ` +${r.files.length - 4}` : ''}` : 'none');
  row('mutations', `${e.mutantsGenerated ?? 0} generated, ${r.summary.attempted - r.summary.cachedResults} run now, ${r.summary.cachedResults} from cache, ${r.remaining} left for later`);
  row('test runs', `${e.testRuns ?? 0}${r.testCommand ? `  ${c.dim(r.testCommand)}` : ''}`);
  if (!iso.method) row('isolation', c.yellow('none available, so nothing was executed'));
  else {
    row('isolation', iso.sandboxed ? c.green(iso.method) : c.red(c.bold('NOT SANDBOXED') + ' (you passed --unsandboxed)'));
    row('  filesystem', iso.filesystem);
    row('  network', iso.network);
    row('  environment', iso.environment);
    const l = iso.limits || {};
    row('  limits', [l.timeoutSeconds ? `${l.timeoutSeconds}s per run` : null, l.memoryMb ? `${l.memoryMb} MB memory` : null, l.cpuSeconds ? `${l.cpuSeconds}s CPU` : null, l.cpus ? `${l.cpus} CPUs` : null].filter(Boolean).join(', ') || 'timeout only');
  }
  row('duration', `${((e.durationMs ?? r.summary.ms) / 1000).toFixed(1)}s`);
  const cl = e.cleanup || {};
  row('cleanup', cl.status === 'removed' ? c.green('temporary copy removed') : cl.status === 'incomplete' ? c.yellow(`copy left at ${cl.path}`) : c.dim('nothing was created'));
  if (e.staleCopiesRemoved) row('', c.dim(`also removed ${e.staleCopiesRemoved} copy left by an interrupted earlier run`));
  if (r.workingTreeUntouched != null) row('your repo', r.workingTreeUntouched ? c.green('unchanged (every file hash, HEAD, refs, stash and status match)') : c.yellow('changed during the run, not by crossexam'));
  line();
}
