import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detectClaims, detectWorkClaims } from '../src/claims.js';
import { markdownSummary } from '../src/github.js';
import { classifyFile, findFunctions, generateMutants, maskJs, prioritize } from '../src/mutate.js';
import { createCopy, scrubbedEnv } from '../src/sandbox.js';
import { STATUS, assessStrength, qualityOf, strengthHistory, toCsv } from '../src/strength.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'crossexam.js');
// Keep the cache and ledger out of the real ~/.crossexam.
process.env.CROSSEXAM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-home-'));
// Use the real sandbox where one works; elsewhere, the explicit (labelled) unsandboxed opt-in.
process.env.CROSSEXAM_ALLOW_UNSANDBOXED = '1';

// ---------- engine ----------

test('masking blanks strings, templates, comments and regexes but keeps every offset', () => {
  const src = 'const a = "x < y"; // a < b\nconst r = /c > d/g; const t = `${p > q}`; /* e && f */ let z = a < b;';
  const m = maskJs(src);
  assert.equal(m.length, src.length);
  assert.equal(m.split('\n').length, src.split('\n').length);
  assert.ok(!/x < y|a < b\n|c > d|p > q|e && f/.test(m));
  assert.ok(m.includes('let z = a < b;'));
});

test('operators fire only on changed lines, never in imports, strings or generics', () => {
  const src = [
    'import * as fs from "fs";',
    'export function clamp(n: number, lo: number, hi: number): Array<number> {',
    '  if (n < lo) return [lo];',
    '  const label = "n < lo";',
    '  return n > hi ? [hi] : [n];',
    '}',
  ].join('\n');
  const all = generateMutants('a.ts', src, null);
  assert.ok(all.length > 0);
  assert.ok(all.every((m) => m.line !== 1 && m.line !== 4), 'nothing on the import or the string line');
  assert.ok(!all.some((m) => m.line === 2), 'Array<number> is a generic, not a comparison');
  const only3 = generateMutants('a.ts', src, new Set([3]));
  assert.deepEqual([...new Set(only3.map((m) => m.line))], [3]);
  assert.deepEqual(only3.map((m) => m.operator).sort(), ['boundary', 'negate-condition']);
  assert.equal(only3.find((m) => m.operator === 'boundary').after, 'if (n <= lo) return [lo];');
  assert.ok(only3.every((m) => m.function === 'clamp'));
  // Same input, same mutants: ids are stable.
  assert.deepEqual(generateMutants('a.ts', src, null).map((m) => m.id), all.map((m) => m.id));
});

test('`if (!x)` gets one mutant (remove-not), not a duplicate negate-condition', () => {
  const ms = generateMutants('a.js', 'function f(x) {\n  if (!x) return 1;\n}\n', null);
  assert.deepEqual(ms.map((m) => m.operator), ['remove-not']);
});

test('functions are found for declarations, arrows, methods and object properties', () => {
  const src = 'function a() { return 1 }\nconst b = (x) => x + 1;\nclass C {\n  async c(y: T): Promise<T> {\n    return y;\n  }\n}\nconst o = { d: (z) => z * 2 };\n';
  const names = findFunctions(maskJs(src)).map((f) => f.name);
  for (const n of ['a', 'b', 'c', 'd']) assert.ok(names.includes(n), `found ${n}`);
});

test('prioritize spreads a capped run across every changed function', () => {
  const src = 'function a(x) { return x + 1 + 2 + 3 + 4; }\nfunction b(y) { return y > 0; }\n';
  const order = prioritize(generateMutants('a.js', src, null)).map((m) => m.function);
  assert.deepEqual(order.slice(0, 2).sort(), ['a', 'b']);
});

test('only JS/TS source is mutated; tests, configs and other languages are skipped with a reason', () => {
  assert.equal(classifyFile('src/x.ts').ok, true);
  assert.equal(classifyFile('src/x.test.ts').reason, 'test file');
  assert.equal(classifyFile('vite.config.ts').ok, false);
  assert.equal(classifyFile('app/main.py').reason, 'language not supported yet');
  assert.equal(classifyFile('README.md').quiet, true);
});

test('credential-like environment variables never reach the test process', () => {
  const { env, removed } = scrubbedEnv({ PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 't', STRIPE_SECRET_KEY: 's', DATABASE_URL: 'd', AWS_REGION: 'r' });
  assert.deepEqual(removed.sort(), ['AWS_REGION', 'DATABASE_URL', 'GITHUB_TOKEN', 'STRIPE_SECRET_KEY']);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CI, '1');
});

test('work claims trigger strength checks but never become verdicts', () => {
  assert.equal(detectWorkClaims('I fixed the off-by-one in clamp and added tests.').length, 1);
  assert.equal(detectWorkClaims('I will fix it once the build is green.').length, 0);
  assert.equal(detectClaims('I fixed the off-by-one in clamp.').length, 0);
});

// ---------- end to end, on a real repo with a real test runner ----------

/** A tiny git repo: clamp() has a test that misses the boundaries, add() is fully pinned down. */
function fixture({ failing = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-mut-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', type: 'module', scripts: { test: 'node --test test/math.test.js' } }));
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  fs.writeFileSync(
    path.join(dir, 'test', 'math.test.js'),
    `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add, clamp } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), ${failing ? 6 : 5}));\ntest('clamp', () => assert.equal(clamp(50, 0, 10), 10));\n`,
  );
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  // The "agent's" uncommitted change: a new clamp() whose boundaries no test checks.
  fs.appendFileSync(path.join(dir, 'src', 'math.js'), 'export function clamp(n, lo, hi) {\n  if (n < lo) return lo;\n  if (n > hi) return hi;\n  return n;\n}\n');
  return dir;
}

const leftovers = (dir) => fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith(`.${path.basename(dir)}.crossexam-mut-`));

test('mutation run: kills and survivors are real, the working tree is untouched, the copy is gone', async () => {
  const dir = fixture();
  const before = fs.readFileSync(path.join(dir, 'src', 'math.js'), 'utf8');
  const r = await assessStrength({ cwd: dir, cache: false, testCommand: 'node --test test/math.test.js' });
  assert.equal(r.scope, 'uncommitted changes vs HEAD');
  assert.equal(r.baseline.exitCode, 0);
  // Only the changed lines (clamp) are mutated; add() was committed before.
  assert.ok(r.mutants.length > 0 && r.mutants.every((m) => m.function === 'clamp'));
  const by = (s) => r.mutants.filter((m) => m.status === s);
  assert.ok(by(STATUS.KILLED).length > 0, 'inverting `n > hi` breaks clamp(50,0,10) and must be caught');
  assert.ok(by(STATUS.SURVIVED).some((m) => m.operator === 'boundary'), 'no test sits on a boundary');
  assert.equal(r.summary.score, by(STATUS.KILLED).length / (by(STATUS.KILLED).length + by(STATUS.SURVIVED).length));
  assert.equal(r.workingTreeUntouched, true);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'math.js'), 'utf8'), before);
  assert.deepEqual(leftovers(dir), []);
  assert.match(r.headline.text, /clamp/);
  assert.equal(r.associatedTests[0].file, 'test/math.test.js');
  // Quality is its own dimension, with the same numbers.
  const q = qualityOf(r);
  assert.equal(q.dimension, 'test-strength');
  assert.equal(q.survived, r.summary.survived);
  assert.match(toCsv(r).split('\n')[0], /^mutant_id,repo,file,line,function,operator/);
});

test('a second run reuses cached results instead of re-running mutants', async () => {
  const dir = fixture();
  const first = await assessStrength({ cwd: dir, testCommand: 'node --test test/math.test.js' });
  const second = await assessStrength({ cwd: dir, testCommand: 'node --test test/math.test.js' });
  assert.ok(first.summary.cachedResults === 0);
  assert.equal(second.summary.cachedResults, second.mutants.length);
  assert.deepEqual(second.mutants.map((m) => m.status), first.mutants.map((m) => m.status));
});

test('a failing suite blocks the run: nothing is judged against a red baseline', async () => {
  const dir = fixture({ failing: true });
  const r = await assessStrength({ cwd: dir, cache: false, testCommand: 'node --test test/math.test.js' });
  assert.equal(r.mutants.length, 0);
  assert.equal(r.rating, 'inconclusive');
  assert.match(r.blocker, /suite fails/);
  assert.equal(r.headline.text, r.blocker);
  assert.deepEqual(leftovers(dir), []);
});

test('--max caps the run and the rest continue from cache next time', async () => {
  const dir = fixture();
  const a = await assessStrength({ cwd: dir, max: 2, testCommand: 'node --test test/math.test.js' });
  assert.equal(a.mutants.length, 2);
  assert.ok(a.remaining > 0);
  const b = await assessStrength({ cwd: dir, max: 50, testCommand: 'node --test test/math.test.js' });
  assert.equal(b.summary.cachedResults, 2);
  assert.equal(b.remaining, 0);
});

test('verify --mutate keeps the factual verdict and adds test strength beside it', () => {
  const dir = fixture();
  const r = spawnSync('node', [BIN, 'verify', 'I added clamp and all tests pass.', '--cwd', dir, '--mutate', '--json', '--no-cache'], { encoding: 'utf8', env: process.env, timeout: 240000 });
  const j = JSON.parse(r.stdout);
  const tests = j.results.find((x) => x.kind === 'tests');
  assert.equal(tests.verdict, 'verified', 'the tests did pass: that fact stands');
  assert.equal(tests.quality.dimension, 'test-strength');
  const why = () => JSON.stringify({ quality: tests.quality, blocker: j.strength.blocker, isolation: j.strength.isolation?.method, command: j.strength.testCommand, mutants: (j.strength.mutants || []).map((m) => [m.status, m.operator, m.replacement, String(m.why || '').slice(0, 400)]) }, null, 1);
  assert.ok(tests.quality.survived > 0, why());
  assert.ok(j.strength.mutants.length > 0, why());
  assert.equal(r.status, 0, 'weak tests are a warning, not a failed claim');
  // The run is in the ledger, and scan history reads it back.
  const h = strengthHistory();
  assert.ok(h && h.runs >= 1 && h.byAgent.unknown);
});

test('mutate --json and --csv write the full report', () => {
  const dir = fixture();
  const csv = path.join(dir, '..', path.basename(dir) + '.csv');
  const r = spawnSync('node', [BIN, 'mutate', '--cwd', dir, '--json', '--csv', csv, '--max', '3', '--no-cache', '--test-command', 'node --test test/math.test.js'], { encoding: 'utf8', env: process.env, timeout: 240000 });
  const j = JSON.parse(r.stdout);
  assert.equal(j.kind, 'crossexam.mutation/v1');
  assert.equal(j.mutants.length, 3);
  assert.equal(fs.readFileSync(csv, 'utf8').trim().split('\n').length, 4);
});

test('PR summary shows test strength as its own section', () => {
  const strength = { rating: 'weak', summary: { score: 0.25, attempted: 4, killed: 1, survived: 3, invalid: 0, unresolved: 0, ms: 2000 }, headline: { text: '3 of 4 planted defects went unnoticed.' }, mutants: [{ status: 'MUTATION_SURVIVED', file: 'src/a.js', line: 2, function: 'clamp', before: 'if (n < lo)', after: 'if (n <= lo)' }] };
  const md = markdownSummary({ number: 7, agent: 'codex', author: 'x' }, { ok: true, results: [{ verdict: 'verified', claim: 'All tests pass.', reason: 'Ran npm test.' }], strength });
  assert.match(md, /Test strength: 🔴 weak · 25% of planted defects caught/);
  assert.match(md, /n &lt;= lo/);
  assert.match(md, /not whether the code is correct/);
});

test('MCP lists assess_test_strength next to verify_claims', async () => {
  const child = spawn('node', [BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'cursor-vscode' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  const tools = JSON.parse(lines[1]).result.tools.map((t) => t.name);
  assert.deepEqual(tools, ['verify_claims', 'assess_test_strength', 'list_checks']);
});

test('the copy never deletes through its dependency links', () => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'keep');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  const c = createCopy(dir);
  assert.equal(fs.readFileSync(path.join(c.dir, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'keep');
  c.dispose();
  assert.equal(fs.existsSync(c.root), false);
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'keep');
});
