// Smarter mutation intelligence, agent-driven re-verification and reliability.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findingsFrom, loadSession, openSession, reverify } from '../src/findings.js';
import { BEHAVIOURS, CATEGORY, explain, generateMutants, isBehavioural, mutantFingerprint, prioritize } from '../src/mutate.js';
import { reliability, weekOf } from '../src/reliability.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'crossexam.js');
const ops = (src, file = 'src/x.ts') => generateMutants(file, src, null);
const has = (ms, op, line) => ms.some((m) => m.operator === op && (line === undefined || m.line === line));

test('transactions: commit becomes rollback, and a rollback can disappear', () => {
  const ms = ops(['async function pay(db) {', '  const tx = await db.begin();', '  try {', '    await tx.commit();', '  } catch (e) {', '    await tx.rollback();', '    throw e;', '  }', '}'].join('\n'));
  assert.ok(has(ms, 'commit-to-rollback', 4));
  const drop = ms.find((m) => m.operator === 'drop-rollback');
  assert.equal(drop.line, 6);
  assert.equal(drop.replacement, 'void 0;');
  assert.equal(CATEGORY['drop-rollback'], 'transactions');
});

test('authorization: guards that turn callers away get bypassed, guard calls get dropped', () => {
  const src = [
    'export async function handler(req, res) {',
    "  if (!req.user.roles.includes('admin')) return res.status(403).end();",
    '  await requirePermission(req.user, "refunds:write");',
    "  if (!session) throw new Error('signed out');",
    '  if (count > 10) return 0;',
    '  logEvent(req.user);',
    '}',
  ].join('\n');
  const ms = ops(src);
  assert.ok(has(ms, 'bypass-auth', 2), 'role guard');
  assert.ok(has(ms, 'drop-auth-check', 3), 'guard call');
  assert.ok(has(ms, 'bypass-auth', 4), 'session guard');
  assert.ok(!has(ms, 'bypass-auth', 5), 'an ordinary early return is not an access check');
  assert.ok(!has(ms, 'drop-auth-check', 6), 'a call that is not a guard is left alone');
  assert.match(explain(ms.find((m) => m.operator === 'bypass-auth')), /turned away/);
});

test('retries: one attempt only, no wait between attempts; unrelated loops untouched', () => {
  const src = [
    'export async function send(job, maxRetries) {',
    '  for (let attempt = 0; attempt < maxRetries; attempt++) {',
    '    try { return await post(job); } catch { await sleep(2 ** attempt * 100); }',
    '  }',
    '  setTimeout(() => flush(), 250);',
    '  for (const entries of groups) { if (entries < limit) return; }',
    '}',
  ].join('\n');
  const ms = ops(src);
  const once = ms.find((m) => m.operator === 'retry-once');
  assert.equal(once.original, 'maxRetries');
  assert.equal(once.replacement, '1');
  assert.ok(has(ms, 'no-backoff', 3));
  assert.ok(ms.some((m) => m.operator === 'no-backoff' && m.line === 5 && m.original === '250'), 'setTimeout delay');
  assert.ok(!has(ms, 'retry-once', 6), '"entries" is not a retry');
});

test('boundaries: an index or length loses its -1 / +1', () => {
  const ms = ops('export const last = (items) => items[items.length - 1];\nexport const next = (page) => page + 1;\nexport const bump = (a, b) => a + 1;');
  assert.ok(has(ms, 'off-by-one', 1));
  assert.ok(has(ms, 'off-by-one', 2));
  assert.ok(!has(ms, 'off-by-one', 3), 'no index-like name, no off-by-one');
});

test('concurrency: dropped await, skipped lock, Promise.all stops failing fast; for-await untouched', () => {
  const src = ['export async function run(m, xs) {', '  await m.acquire();', '  await Promise.all(xs.map(save));', '  for await (const x of stream) use(x);', '  m.release();', '}'].join('\n');
  const ms = ops(src);
  assert.ok(has(ms, 'drop-lock', 2));
  assert.ok(has(ms, 'all-settled', 3));
  assert.ok(has(ms, 'drop-await', 3));
  assert.ok(!ms.some((m) => m.operator === 'drop-await' && m.line === 4), 'for await is not touched');
});

test('nothing fires inside strings or comments, and behavioural mutants come first under a cap', () => {
  const ms = ops('// await tx.commit() if (!user.isAdmin) return\nconst s = "await requireAdmin(user); items.length - 1";\nexport const f = (a, b) => a < b;');
  assert.ok(!ms.some((m) => isBehavioural(m.operator)));
  const mixed = ops(['export async function f(user, a, b) {', "  if (!user.isAdmin) throw new Error('no');", '  return a < b && a > 0;', '}'].join('\n'));
  assert.ok(isBehavioural(prioritize(mixed)[0].operator), 'a behavioural defect is tried first');
  assert.equal(BEHAVIOURS.length, 10);
});

test('fingerprints survive a line shift', () => {
  const a = ops("export function g(user) {\n  if (!user.isAdmin) throw new Error('no');\n}").find((m) => m.operator === 'bypass-auth');
  const b = ops("// a new comment\n\nexport function g(user) {\n  if (!user.isAdmin) throw new Error('no');\n}").find((m) => m.operator === 'bypass-auth');
  assert.notEqual(a.line, b.line);
  assert.equal(mutantFingerprint(a), mutantFingerprint(b));
});

test('findings: contradicted claims and survivors become structured, ranked findings', () => {
  const verify = { results: [{ kind: 'tests', claim: 'All tests pass.', verdict: 'contradicted', reason: 'exit 1', evidence: { command: 'npm test', exitCode: 1, excerpt: '1 failed' } }, { kind: 'deps', claim: 'Bumped zod.', verdict: 'verified', reason: 'ok', evidence: null }] };
  const strength = { mutants: [{ status: 'MUTATION_SURVIVED', fingerprint: 'a'.repeat(32), category: 'logic', operator: 'boolean', file: 'a.js', line: 3, why: 'w' }, { status: 'MUTATION_SURVIVED', fingerprint: 'b'.repeat(32), category: 'authorization', operator: 'bypass-auth', file: 'b.js', line: 9, why: 'w' }, { status: 'MUTATION_KILLED', fingerprint: 'c'.repeat(32), operator: 'boundary', file: 'c.js', line: 1 }] };
  const f = findingsFrom({ verify, strength });
  assert.equal(f.length, 3, 'verified claims and killed mutants are not findings');
  assert.deepEqual(f.map((x) => x.severity), ['high', 'high', 'low']);
  assert.ok(f.every((x) => x.status === 'open' && x.ask && x.recheck));
  assert.equal(f.find((x) => x.type === 'mutant' && x.category === 'authorization').id, `mutant-${'b'.repeat(32)}`);
});

test('the loop: a behavioural gap is found, an agent adds a test, only the independent re-check closes it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-home-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-loop-'));
  const prev = { home: process.env.CROSSEXAM_HOME, uns: process.env.CROSSEXAM_ALLOW_UNSANDBOXED };
  process.env.CROSSEXAM_HOME = home;
  process.env.CROSSEXAM_ALLOW_UNSANDBOXED = '1';
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', type: 'module' }));
    fs.writeFileSync(path.join(dir, 'src', 'refund.js'), 'export function refund(user, amount) {\n  return amount;\n}\n');
    const t = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { refund } from '../src/refund.js';\ntest('finance can refund', () => assert.equal(refund({ roles: ['finance'] }, 20), 20));\n";
    fs.writeFileSync(path.join(dir, 'test', 'refund.test.js'), t);
    g('init', '-q');
    g('add', '-A');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'src', 'refund.js'), "export function refund(user, amount) {\n  if (!user.roles.includes('finance')) throw new Error('forbidden');\n  return amount;\n}\n");

    const r = spawnSync(process.execPath, [BIN, 'mutate', '--cwd', dir, '--unsandboxed', '--agent', 'codex', '--json', '--no-cache', '--test-command', 'node --test test/refund.test.js'], { encoding: 'utf8', env: process.env, timeout: 120000 });
    const report = JSON.parse(r.stdout);
    const gap = report.findings.find((f) => f.operator === 'bypass-auth');
    assert.ok(gap, 'the missing denial test is found');
    assert.equal(gap.severity, 'high');
    assert.match(report.session, /^cx-[0-9a-f]{10}$/);

    // no fix yet: the re-check keeps it open
    const before = await reverify(report.session, { allowUnsandboxed: true, isolation: 'none' });
    assert.equal(before.changes.find((c) => c.id === gap.id).status, 'still-open');

    // the agent adds the test it was asked for
    fs.appendFileSync(path.join(dir, 'test', 'refund.test.js'), "test('others are turned away', () => assert.throws(() => refund({ roles: ['support'] }, 20), /forbidden/));\n");
    const after = await reverify(report.session, { allowUnsandboxed: true, isolation: 'none' });
    assert.equal(after.changes.find((c) => c.id === gap.id).status, 'resolved');
    assert.equal(loadSession(report.session).findings.find((f) => f.id === gap.id).resolvedRound, 2);

    // the code is rewritten: the finding no longer applies rather than passing quietly
    const s2 = openSession({ findings: [{ ...gap, status: 'open' }], cwd: dir, agent: 'codex', testCommand: 'node --test test/refund.test.js' });
    // (the suite still passes on the new code, so the re-check can judge it)
    fs.writeFileSync(path.join(dir, 'src', 'refund.js'), "export function refund(user, amount) {\n  if (user.roles.indexOf('finance') < 0) throw new Error('forbidden');\n  return amount;\n}\n");
    const gone = await reverify(s2.id, { allowUnsandboxed: true, isolation: 'none' });
    assert.equal(gone.changes[0].status, 'superseded');

    assert.throws(() => loadSession('not-a-session'), /not a crossexam session id/);
  } finally {
    process.env.CROSSEXAM_HOME = prev.home;
    if (prev.uns === undefined) delete process.env.CROSSEXAM_ALLOW_UNSANDBOXED;
    else process.env.CROSSEXAM_ALLOW_UNSANDBOXED = prev.uns;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('reliability: three measures per agent, from recorded evidence, never blended', () => {
  const at = (d) => new Date(Date.UTC(2026, 10, d)).toISOString();
  const records = [
    ...['verified', 'verified', 'verified', 'contradicted'].map((v, i) => ({ type: 'verify', at: at(2 + i), agent: 'codex', kind: 'tests', verdict: v })),
    { agent: 'claude-code', at: at(3), kind: 'tests', verdict: 'stale' }, // from the transcript hook: no type
    { agent: 'claude-code', at: at(4), kind: 'tests', verdict: 'verified' },
    { type: 'mutation', at: at(5), agent: 'codex', killed: 6, survived: 2, rating: 'moderate', survivors: [{ behavioural: true }, { behavioural: false }] },
    { type: 'reverify', at: at(6), session: 's1', agent: 'codex', round: 1, allResolved: false },
    { type: 'reverify', at: at(7), session: 's1', agent: 'codex', round: 2, allResolved: true },
    { type: 'reverify', at: at(8), session: 's2', agent: 'codex', round: 1, allResolved: true },
    { type: 'verify', at: at(1), agent: 'old', kind: 'tests', verdict: 'contradicted' },
  ];
  const r = reliability({ records, since: Date.parse(at(2)) });
  const codex = r.agents.find((a) => a.agent === 'codex');
  assert.equal(codex.claims.checked, 4);
  assert.equal(codex.claims.falseDoneRate, 0.25);
  assert.equal(codex.strength.score, 0.75);
  assert.equal(codex.strength.behaviouralSurvivors, 1);
  assert.equal(codex.fixes.sessions, 2);
  assert.equal(codex.fixes.firstRecheckRate, 0.5, 's1 needed two rounds, s2 one');
  assert.equal(codex.fixes.roundsToClose, 1.5);
  assert.ok(codex.weeks.length >= 1 && codex.weeks.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.week)));
  const claude = r.agents.find((a) => a.agent === 'claude-code');
  assert.equal(claude.claims.falseDoneRate, 0.5, 'hook records count too');
  assert.ok(!r.agents.some((a) => a.agent === 'old'), 'older than --since');
  assert.ok(!('score' in codex) && !('overall' in codex), 'no blended score');
  assert.equal(weekOf('2026-11-26T10:00:00Z'), '2026-11-23');
});
