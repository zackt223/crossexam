// M0 of crossexam cloud: the upload contract. Nothing here touches the network;
// these tests pin down what a run would send and what it must never contain.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { excerpt } from '../src/evidence.js';
import { scrubText } from '../src/redact.js';
import { LIMITS, buildPayload, classifyReport, githubContext, mutantFingerprint, validatePayload } from '../src/upload.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'crossexam.js');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'docs', 'upload.schema.json'), 'utf8'));
const HOME = os.homedir();
const SECRET = 'sk-' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4';
const GH_TOKEN = 'ghp_' + 'Z'.repeat(36);

const ROOT = process.platform === 'win32' ? 'C:\\work\\acme\\payments' : '/home/runner/work/payments/payments';
const inRoot = (p) => path.join(ROOT, p);

function verifyResult() {
  return {
    cwd: ROOT,
    commands: { tests: 'npm test' },
    ok: false,
    results: [
      {
        kind: 'tests',
        claim: 'All 214 tests pass.',
        verdict: 'contradicted',
        reason: 'the test command failed',
        evidence: { command: 'npm test', exitCode: 1, excerpt: `FAIL ${inRoot('src/refund.test.ts')}\n  token=${GH_TOKEN}\n  at ${path.join(HOME, '.npm', '_cacache', 'x.js')}:3:9\n  at /tmp/other/place.js:1:1` },
      },
      { kind: 'deps', claim: 'Bumped zod to 3.23.8.', verdict: 'verified', reason: 'package.json says so', evidence: { command: 'read package.json', exitCode: 0, excerpt: 'zod 3.23.8' } },
    ],
  };
}

function mutationReport() {
  return {
    kind: 'crossexam.mutation/v1',
    version: '0.3.0',
    repo: 'acme/payments',
    cwd: '~/work/payments',
    scope: 'uncommitted changes',
    base: 'HEAD',
    testCommand: 'npm test',
    isolation: { method: 'bwrap', sandboxed: true },
    rating: 'moderate',
    blocker: null,
    summary: { attempted: 3, valid: 3, killed: 2, survived: 1, invalid: 0, unresolved: 0, remaining: 0, score: 0.667, ms: 4210, cachedResults: 0 },
    files: [{ file: 'src/refund.ts', language: 'typescript', changedLines: [47, 48, 52], mutants: 3, sha256: 'ab'.repeat(32) }],
    mutants: [
      { id: 'src/refund.ts:48:20:boundary', file: 'src/refund.ts', line: 48, col: 20, function: 'refundableAmount', functionLine: 44, operator: 'boundary', original: '>', replacement: '>=', before: `  if (daysSince > 30) return 0; // key: ${SECRET}`, after: '  if (daysSince >= 30) return 0;', status: 'MUTATION_SURVIVED', why: 'In `refundableAmount`, `>` → `>=` still passed every test: no test sits exactly on the boundary.', ms: 1200, cached: false },
      { id: 'src/refund.ts:52:15:arithmetic', file: 'src/refund.ts', line: 52, col: 15, function: 'refundableAmount', operator: 'arithmetic', original: '*', replacement: '/', before: '  return amount * rate;', after: '  return amount / rate;', status: 'MUTATION_KILLED', why: 'refund.test.ts › annual plan', ms: 900, cached: false },
      { id: 'src/refund.ts:47:9:negate-condition', file: 'src/refund.ts', line: 47, col: 9, function: 'refundableAmount', operator: 'negate-condition', original: 'if (plan.annual)', replacement: 'if (!(plan.annual))', before: '  if (plan.annual) {', after: '  if (!(plan.annual)) {', status: 'MUTATION_KILLED', why: '', ms: 800, cached: true },
    ],
    execution: { mutantsGenerated: 3, mutantsPlanned: 3, testRuns: 4, durationMs: 4210, gitUnchanged: true },
  };
}

/** Every key the payload uses must be declared in the schema (additionalProperties: false). */
function checkAgainstSchema(value, schema, where = '$') {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkAgainstSchema(v, schema.items ?? {}, `${where}[${i}]`));
    return;
  }
  if (!schema.properties) return;
  for (const k of Object.keys(value)) {
    assert.ok(k in schema.properties || schema.additionalProperties !== false, `${where}.${k} is not in upload.schema.json`);
    if (schema.properties[k]) checkAgainstSchema(value[k], schema.properties[k], `${where}.${k}`);
  }
  for (const k of schema.required ?? []) assert.ok(k in value, `${where}.${k} is required by the schema`);
}

test('scrubText: repo paths become relative, home becomes ~, other absolute paths go, secrets are redacted', () => {
  const s = scrubText(`at ${inRoot('src/a.ts')}:3 and ${path.join(HOME, 'x', 'y.js')} and /tmp/zz/q.js and C:\\Windows\\temp\\b.js with ${SECRET}`, ROOT);
  assert.ok(s.includes(`src${path.sep}a.ts:3`) || s.includes('src/a.ts:3'), s);
  assert.ok(!s.includes(ROOT), s);
  assert.ok(s.includes('~'), s);
  assert.ok(!s.includes(HOME), s);
  assert.ok(!s.includes('/tmp/zz') && !s.includes('C:\\Windows'), s);
  assert.ok(s.includes('[path]'), s);
  assert.ok(!s.includes(SECRET) && s.includes('[redacted]'), s);
  // urls and relative paths are left alone
  assert.equal(scrubText('see https://github.com/acme/x and src/var/thing.ts', ROOT), 'see https://github.com/acme/x and src/var/thing.ts');
});

test('excerpt() redacts secrets, so verify output, pr summaries and json reports never carry them', () => {
  const out = excerpt(`running\nFAIL auth.test.ts\n  expected token ${GH_TOKEN}\n  password = "hunter2hunter2"\n`);
  assert.ok(out.includes('FAIL auth.test.ts'));
  assert.ok(!out.includes(GH_TOKEN) && !out.includes('hunter2'));
});

test('a payload from verify + mutate is valid, matches the schema, and carries no local paths or secrets', () => {
  const p = buildPayload({ verify: verifyResult(), mutation: mutationReport(), cliVersion: '0.4.0', root: ROOT, agent: 'claude-code' });
  assert.deepEqual(validatePayload(p), []);
  checkAgainstSchema(p, SCHEMA);
  const text = JSON.stringify(p);
  for (const bad of [ROOT, ROOT.replace(/\\/g, '\\\\'), HOME, HOME.replace(/\\/g, '\\\\'), SECRET, GH_TOKEN, '/tmp/other']) assert.ok(!text.includes(bad), `payload leaks ${bad}`);
  assert.ok(!('cwd' in p));
  assert.equal(p.kind, 'crossexam.upload/v1');
  assert.equal(p.agent, 'claude-code');
  assert.equal(p.claims.length, 2);
  assert.equal(p.claims[0].verdict, 'contradicted');
  assert.equal(p.mutation.summary.survived, 1);
  assert.equal(p.mutation.files[0].changedLines, 3, 'changed lines travel as a count, not a list');
  const survivor = p.mutation.mutants.find((m) => m.status === 'MUTATION_SURVIVED');
  assert.match(survivor.fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(survivor.original, '>');
  assert.ok(survivor.before.includes('[redacted]'));
});

test('source policy none: no code at all, and the validator refuses code that sneaks in', () => {
  const p = buildPayload({ mutation: mutationReport(), cliVersion: '0.4.0', root: ROOT, sourcePolicy: 'none' });
  assert.deepEqual(validatePayload(p), []);
  for (const m of p.mutation.mutants) for (const k of ['original', 'replacement', 'before', 'after']) assert.equal(m[k], null);
  // fingerprints are still there, so triage still works without code
  assert.ok(p.mutation.mutants.every((m) => /^[0-9a-f]{32}$/.test(m.fingerprint)));
  const tampered = structuredClone(p);
  tampered.mutation.mutants[0].before = 'if (x > 1)';
  assert.ok(validatePayload(tampered).some((e) => /source policy none/.test(e)));
  assert.throws(() => buildPayload({ mutation: mutationReport(), cliVersion: '0', sourcePolicy: 'everything' }), /source policy/);
});

test('long text is capped: excerpts at 2 KB, code lines at 400 characters', () => {
  const v = verifyResult();
  v.results[0].evidence.excerpt = 'x'.repeat(10000);
  const m = mutationReport();
  m.mutants[0].before = 'y'.repeat(5000);
  const p = buildPayload({ verify: v, mutation: m, cliVersion: '0.4.0', root: ROOT });
  assert.ok(p.claims[0].excerpt.length <= LIMITS.excerpt + 1);
  assert.ok(p.mutation.mutants[0].before.length <= LIMITS.code + 1);
  assert.deepEqual(validatePayload(p), []);
});

test('fingerprints survive a line shift and change when the mutation changes', () => {
  const m = mutationReport().mutants[0];
  const a = mutantFingerprint(m);
  assert.equal(a, mutantFingerprint({ ...m, line: m.line + 12, col: 4, id: 'moved' }), 'same change, new line number');
  assert.equal(a, mutantFingerprint({ ...m, before: `    ${m.before.trim()}   ` }), 'whitespace does not matter');
  assert.notEqual(a, mutantFingerprint({ ...m, operator: 'equality' }));
  assert.notEqual(a, mutantFingerprint({ ...m, replacement: '<' }));
  assert.notEqual(a, mutantFingerprint({ ...m, file: 'src/other.ts' }));
});

test('github context: read from the actions environment, null outside it, forks flagged', () => {
  assert.equal(githubContext({}), null);
  const ev = path.join(os.tmpdir(), `cx-ev-${process.pid}.json`);
  fs.writeFileSync(
    ev,
    JSON.stringify({ pull_request: { number: 1475, title: 'add refund window', body: 'Generated with [Claude Code](https://claude.com)', user: { login: 'maya' }, head: { sha: 'abc123', ref: 'refunds', repo: { full_name: 'someone/payments' } }, base: { ref: 'main', repo: { full_name: 'acme/payments' } } } }),
  );
  try {
    const g = githubContext({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/payments', GITHUB_REPOSITORY_ID: '42', GITHUB_REPOSITORY_OWNER_ID: '7', GITHUB_RUN_ID: '987', GITHUB_RUN_ATTEMPT: '2', GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: 'def456', GITHUB_REF: 'refs/pull/1475/merge', GITHUB_EVENT_PATH: ev });
    assert.equal(g.repositoryId, 42);
    assert.equal(g.runAttempt, 2);
    assert.equal(g.pr.number, 1475);
    assert.equal(g.pr.fork, true, 'head repo differs from base repo');
    assert.equal(g.pr.agent, 'claude-code');
    const p = buildPayload({ mutation: mutationReport(), github: g, cliVersion: '0.4.0', root: ROOT });
    assert.deepEqual(validatePayload(p), []);
    checkAgainstSchema(p, SCHEMA);
    assert.equal(p.agent, 'claude-code', 'agent falls back to the one behind the pr');
    assert.equal(p.repository, 'acme/payments');
    assert.ok(!JSON.stringify(p).includes('Generated with'), 'the pr description is never sent');
  } finally {
    fs.rmSync(ev, { force: true });
  }
});

test('the validator rejects malformed payloads', () => {
  const good = buildPayload({ mutation: mutationReport(), cliVersion: '0.4.0', root: ROOT });
  const bad = (f) => {
    const p = structuredClone(good);
    f(p);
    return validatePayload(p);
  };
  assert.ok(bad((p) => (p.kind = 'something/v2')).length);
  assert.ok(bad((p) => (p.mutation.mutants[0].status = 'killed')).length);
  assert.ok(bad((p) => (p.mutation.mutants[0].fingerprint = 'nope')).length);
  assert.ok(bad((p) => (p.mutation.summary.score = 4)).length);
  assert.ok(bad((p) => (p.mutation.mutants[0].file = '/home/someone/secret/app.ts')).some((e) => /local path/.test(e)));
  assert.ok(bad((p) => ((p.mutation = null), (p.claims = []))).some((e) => /neither/.test(e)));
  assert.deepEqual(validatePayload(good), []);
});

test('classifyReport tells verify and mutate reports apart and refuses anything else', () => {
  assert.ok(classifyReport(mutationReport()).mutation);
  const v = verifyResult();
  assert.ok(classifyReport(v).verify && classifyReport(v).mutation === null);
  assert.ok(classifyReport({ ...v, strength: mutationReport() }).mutation, 'verify --mutate carries its strength report');
  assert.throws(() => classifyReport({ hello: 'world' }), /not a crossexam report/);
});

test('cli: upload without --dry-run sends nothing and says so; --dry-run prints a valid payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-up-'));
  try {
    const refuse = spawnSync(process.execPath, [BIN, 'upload'], { encoding: 'utf8' });
    assert.equal(refuse.status, 2);
    assert.match(refuse.stderr, /nothing was sent/);
    const m = path.join(dir, 'mutate.json');
    const v = path.join(dir, 'verify.json');
    fs.writeFileSync(m, JSON.stringify(mutationReport()));
    fs.writeFileSync(v, JSON.stringify(verifyResult()));
    const env = { ...process.env, GITHUB_ACTIONS: '' };
    const r = spawnSync(process.execPath, [BIN, 'upload', '--dry-run', '--report', v, '--report', m, '--cwd', ROOT], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /nothing was sent/);
    const p = JSON.parse(r.stdout);
    assert.deepEqual(validatePayload(p), []);
    assert.equal(p.claims.length, 2);
    assert.equal(p.mutation.mutants.length, 3);
    const none = spawnSync(process.execPath, [BIN, 'upload', '--dry-run', '--report', m, '--source', 'none', '--out', path.join(dir, 'p.json')], { encoding: 'utf8', env });
    assert.equal(none.status, 0, none.stderr);
    const p2 = JSON.parse(fs.readFileSync(path.join(dir, 'p.json'), 'utf8'));
    assert.ok(p2.mutation.mutants.every((x) => x.before === null));
    const missing = spawnSync(process.execPath, [BIN, 'upload', '--dry-run'], { encoding: 'utf8', env });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /needs --report/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
