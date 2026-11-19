// Security and isolation for mutation intelligence. See docs/mutation-security.md.
//
// Cases marked "sandbox" need a working isolation backend (bwrap on Linux,
// sandbox-exec on macOS, or Docker/Podman). Where none passes its probe they
// are skipped with a reason, never counted as passed.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { availableBackends, chooseIsolation, createCopy, gitState, runIsolated, safeRemove, sweepStaleCopies } from '../src/sandbox.js';
import { assessStrength, redact, toCsv, withoutSource } from '../src/strength.js';

process.env.CROSSEXAM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-sec-home-'));
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'crossexam.js');
const BACKEND = process.env.CROSSEXAM_TEST_BACKEND || availableBackends()[0] || null;
const NO_SANDBOX = BACKEND ? false : `no isolation backend passes its probe on ${process.platform}`;
// Functional runs use the real sandbox where there is one, else the explicit opt-in.
const ISO = BACKEND ? { isolation: BACKEND } : { isolation: 'none', allowUnsandboxed: true };
const LIMITS = { timeoutMs: 15000, memoryMb: 512, cpuSeconds: 30 };

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const commit = (cwd, msg) => g(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg);

function fixture(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-sec-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', type: 'module' }));
  fs.writeFileSync(path.join(dir, 'src', 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  for (const [f, body] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  g(dir, 'init', '-q');
  g(dir, 'add', '-A');
  commit(dir, 'init');
  return dir;
}

/** Every file under dir (except .git) with its hash. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === '.git') continue;
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}
const leftovers = (dir) => fs.readdirSync(path.dirname(dir)).filter((n) => n.startsWith(`.${path.basename(dir)}.crossexam-mut-`));
const TEST_CMD = 'node --test test/math.test.js';

// ---------- repository protection (all platforms) ----------

test('uncommitted, staged, untracked and stashed work, HEAD, refs and the index survive a run byte for byte', async () => {
  const dir = fixture();
  g(dir, 'branch', 'feature');
  fs.writeFileSync(path.join(dir, 'stash.txt'), 'stashed');
  g(dir, 'add', 'stash.txt');
  g(dir, 'stash', '-q');
  fs.appendFileSync(path.join(dir, 'src', 'math.js'), 'export const sub = (a, b) => a - b;\n'); // unstaged
  fs.writeFileSync(path.join(dir, 'src', 'staged.js'), 'export const t = 1 > 0;\n');
  g(dir, 'add', 'src/staged.js'); // staged
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'untracked'); // untracked
  const files = snapshot(dir);
  const git = gitState(dir);
  const r = await assessStrength({ cwd: dir, ...ISO, cache: false, testCommand: TEST_CMD });
  assert.ok(r.mutants.length > 0, 'mutants actually ran');
  assert.deepEqual(snapshot(dir), files);
  assert.deepEqual(gitState(dir), git);
  assert.equal(r.workingTreeUntouched, true);
  assert.equal(r.execution.gitUnchanged, true);
  assert.equal(r.execution.cleanup.status, 'removed');
  assert.deepEqual(leftovers(dir), []);
});

test('failed runs leave nothing behind: crashing command, red baseline, timeout', async () => {
  const dir = fixture({ 'crossexam.json': JSON.stringify({ timeoutSeconds: 10 }) });
  fs.appendFileSync(path.join(dir, 'src', 'math.js'), 'export const gt = (a, b) => a > b;\n');
  const files = snapshot(dir);
  for (const testCommand of ['node -e "process.exit(3)"', 'node -e "setTimeout(() => {}, 60000)"', 'definitely-not-a-command-xyz']) {
    const r = await assessStrength({ cwd: dir, ...ISO, cache: false, testCommand });
    assert.equal(r.mutants.length, 0, `${testCommand}: nothing judged`);
    assert.ok(r.blocker, `${testCommand}: says why`);
    assert.equal(r.execution.cleanup.status, 'removed', `${testCommand}: copy removed`);
    assert.deepEqual(leftovers(dir), [], `${testCommand}: no leftovers`);
    assert.deepEqual(snapshot(dir), files, `${testCommand}: working tree unchanged`);
  }
});

test('a timed-out run takes its whole process tree with it', async () => {
  // The child starts a grandchild that would write a marker into the copy after 6s, then hangs.
  const dir = fixture({
    'grand.cjs': "setTimeout(() => require('fs').writeFileSync('grandchild-alive', 'x'), 6000);\n",
    'hang.cjs': "require('child_process').spawn(process.execPath, ['grand.cjs'], { stdio: 'ignore' });\nsetTimeout(() => {}, 60000);\n",
  });
  const copy = createCopy(dir);
  const marker = path.join(copy.dir, 'grandchild-alive');
  const r = await runIsolated('node hang.cjs', { copy, cwd: copy.dir, timeoutMs: 3000, method: ISO.isolation });
  assert.equal(r.timedOut, true);
  assert.ok(r.ms < 7000, `killed promptly (${r.ms}ms)`);
  await new Promise((res) => setTimeout(res, 7000));
  assert.equal(fs.existsSync(marker), false, 'the grandchild was killed too');
  assert.equal(copy.dispose().removed, true);
});

test('a copy left by a killed run is removed by the next run, without touching linked dependencies', async () => {
  const dir = fixture({ '.gitignore': 'node_modules/\n' });
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'keep');
  fs.appendFileSync(path.join(dir, 'src', 'math.js'), 'export const lt = (a, b) => a < b;\n');
  const files = snapshot(dir);
  // A real crash: SIGKILL crossexam while a (slow) test run is in progress.
  const slow = 'node -e "setTimeout(() => {}, 5000)"';
  const child = spawn(process.execPath, [BIN, 'mutate', '--cwd', dir, '--test-command', slow, ...(BACKEND ? ['--isolation', BACKEND] : ['--unsandboxed'])], { stdio: 'ignore', env: process.env });
  for (let i = 0; i < 100 && !leftovers(dir).length; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 500));
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  assert.equal(leftovers(dir).length, 1, 'the crash left its copy behind (cleanup could not run)');
  assert.deepEqual(snapshot(dir), files, 'the crash did not touch the working tree');
  if (process.platform === 'win32') {
    // The orphaned test run still has its working directory in the copy, and
    // Windows won't delete it while that process lives. The sweep can't safely
    // kill a bare pid on Windows, so this run leaves it and a later one removes it.
    assert.deepEqual(sweepStaleCopies(dir), [], 'not removed while the orphan holds it');
    assert.equal(leftovers(dir).length, 1);
    await new Promise((r) => setTimeout(r, 6000));
  }
  // On POSIX the sweep stops the orphaned process group itself.
  const removed = sweepStaleCopies(dir);
  assert.equal(removed.length, 1);
  assert.deepEqual(leftovers(dir), []);
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'keep', 'the real dependency survived');
});

test('a copy owned by a live process is never swept', () => {
  const dir = fixture();
  const copy = createCopy(dir);
  assert.deepEqual(sweepStaleCopies(dir), []);
  assert.equal(fs.existsSync(copy.root), true);
  copy.dispose();
});

test('safeRemove refuses to delete anything if a link inside cannot be removed first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-sec-rm-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-sec-out-'));
  fs.writeFileSync(path.join(outside, 'precious'), 'x');
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const r = safeRemove(root);
  assert.equal(r.removed, true);
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'x');
});

// ---------- paths and links (all platforms) ----------

test('named files outside the repository are refused, never read', async () => {
  const dir = fixture();
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-secret.js`);
  fs.writeFileSync(outside, 'export const key = "sk-live-should-never-be-read" === process.env.X;\n');
  const r = await assessStrength({ cwd: dir, ...ISO, files: [`../${path.basename(outside)}`, outside, 'src/../../etc/passwd'], testCommand: TEST_CMD });
  assert.equal(r.files.length, 0);
  assert.equal(r.mutants.length, 0);
  assert.ok(r.skippedFiles.every((f) => /outside the repository/.test(f.reason)), JSON.stringify(r.skippedFiles));
  assert.ok(!JSON.stringify(r).includes('should-never-be-read'));
});

function trySymlink(target, at) {
  try {
    fs.symlinkSync(target, at);
    return true;
  } catch {
    return false; // Windows without Developer Mode can't create file symlinks
  }
}

test('symlinks: one escaping the repo is neither mutated nor copied; one inside is kept', async (t) => {
  const dir = fixture();
  const secret = path.join(path.dirname(dir), `${path.basename(dir)}-ssh-key`);
  fs.writeFileSync(secret, 'PRIVATE');
  if (!trySymlink(path.relative(path.join(dir, 'src'), secret), path.join(dir, 'src', 'escape.js'))) return t.skip('cannot create symlinks here');
  trySymlink('math.js', path.join(dir, 'src', 'alias.js'));
  g(dir, 'add', '-A');
  commit(dir, 'links');
  const r = await assessStrength({ cwd: dir, ...ISO, files: ['src/escape.js'], testCommand: TEST_CMD });
  assert.equal(r.files.length, 0);
  assert.match(r.skippedFiles[0].reason, /symbolic link|outside/);
  const copy = createCopy(dir);
  try {
    assert.ok(copy.skippedLinks.includes('src/escape.js'));
    assert.equal(fs.existsSync(path.join(copy.dir, 'src', 'escape.js')), false, 'the escaping link is not in the copy');
    if (fs.existsSync(path.join(dir, 'src', 'alias.js'))) assert.equal(fs.lstatSync(path.join(copy.dir, 'src', 'alias.js')).isSymbolicLink(), true, 'an in-repo link is kept');
  } finally {
    copy.dispose();
  }
});

// ---------- isolation policy (all platforms) ----------

test('a repository config cannot turn the sandbox off', () => {
  const c = chooseIsolation({ requested: 'none', fromRepoConfig: true });
  assert.ok(c.notes.some((n) => /cannot turn the sandbox off/.test(n)));
  assert.notEqual(c.method, 'none');
  if (!BACKEND) assert.match(c.refused, /No sandbox is available/);
});

test('auto refuses without a backend unless the human opts in, and an opt-in is labelled', async () => {
  assert.match(chooseIsolation({ requested: 'none' }).refused, /--unsandboxed/);
  assert.deepEqual(chooseIsolation({ requested: 'none', allowUnsandboxed: true }).method, 'none');
  const dir = fixture({ 'crossexam.json': JSON.stringify({ mutation: { isolation: 'none' } }) });
  fs.appendFileSync(path.join(dir, 'src', 'math.js'), 'export const ge = (a, b) => a >= b;\n');
  const prev = process.env.CROSSEXAM_ALLOW_UNSANDBOXED;
  delete process.env.CROSSEXAM_ALLOW_UNSANDBOXED;
  try {
    const r = await assessStrength({ cwd: dir, cache: false, testCommand: TEST_CMD });
    if (BACKEND) assert.equal(r.isolation.method, BACKEND);
    else {
      assert.equal(r.mutants.length, 0, 'nothing ran');
      assert.equal(r.execution.testRuns, 0);
      assert.match(r.blocker, /No sandbox is available/);
    }
    const u = await assessStrength({ cwd: dir, isolation: 'none', allowUnsandboxed: true, cache: false, max: 1, testCommand: TEST_CMD });
    assert.equal(u.isolation.sandboxed, false);
    assert.match(u.isolation.filesystem, /NOT SANDBOXED/);
  } finally {
    if (prev !== undefined) process.env.CROSSEXAM_ALLOW_UNSANDBOXED = prev;
  }
});

test('credential-like environment variables are not visible to tests, sandboxed or not', async () => {
  const dir = fixture();
  process.env.CROSSEXAM_CANARY_SECRET = 'canary-' + crypto.randomUUID();
  process.env.MY_SERVICE_API_KEY = 'canary-key';
  try {
    for (const iso of [ISO, { isolation: 'none', allowUnsandboxed: true }]) {
      const copy = createCopy(dir);
      const r = await runIsolated('node -e "console.log(JSON.stringify(process.env))"', { copy, cwd: copy.dir, timeoutMs: 15000, method: iso.isolation });
      copy.dispose();
      assert.equal(r.exitCode, 0, r.output);
      assert.ok(!r.output.includes('canary-'), `${iso.isolation}: no canary in the test environment`);
      assert.ok(!r.output.includes('NODE_TEST_CONTEXT'), `${iso.isolation}: no parent test-runner state`);
    }
  } finally {
    delete process.env.CROSSEXAM_CANARY_SECRET;
    delete process.env.MY_SERVICE_API_KEY;
  }
});

// ---------- sandbox enforcement (needs a backend) ----------

const PROBE = `
const fs = require('fs'), net = require('net'), path = require('path');
const [canary, outside, port] = process.argv.slice(1);
const out = {};
try { fs.readFileSync(canary, 'utf8'); out.readHome = 'ALLOWED'; } catch (e) { out.readHome = e.code; }
try { fs.writeFileSync(outside, 'x'); out.writeOutside = 'ALLOWED'; } catch (e) { out.writeOutside = e.code; }
try { fs.writeFileSync('inside.txt', 'x'); out.writeInside = 'ALLOWED'; } catch (e) { out.writeInside = e.code; }
const s = net.connect({ host: '127.0.0.1', port: Number(port) });
const done = (v) => { out.network = v; console.log(JSON.stringify(out)); process.exit(0); };
s.on('connect', () => done('ALLOWED'));
s.on('error', (e) => done(e.code));
setTimeout(() => done('TIMEOUT'), 4000);
`;

test('sandbox: no reading the home folder, no writing outside the copy, no network', { skip: NO_SANDBOX }, async () => {
  const dir = fixture({ 'probe.cjs': PROBE });
  const canary = path.join(os.homedir(), `.crossexam-canary-${crypto.randomUUID()}`);
  const outside = path.join(path.dirname(dir), `${path.basename(dir)}-written-from-sandbox`);
  fs.writeFileSync(canary, 'secret');
  const server = net.createServer((c) => c.end()).listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const copy = createCopy(dir);
  try {
    const r = await runIsolated(`node probe.cjs "${canary}" "${outside}" ${server.address().port}`, { copy, cwd: copy.dir, timeoutMs: 20000, method: BACKEND, limits: LIMITS });
    const res = JSON.parse(r.output.trim().split('\n').pop());
    assert.equal(res.writeInside, 'ALLOWED', 'positive control: the probe really ran inside the copy');
    assert.notEqual(res.readHome, 'ALLOWED', 'home folder readable');
    assert.notEqual(res.writeOutside, 'ALLOWED', 'wrote outside the copy');
    assert.notEqual(res.network, 'ALLOWED', 'network reachable');
    assert.equal(fs.existsSync(outside), false);
  } finally {
    copy.dispose();
    server.close();
    fs.rmSync(canary, { force: true });
  }
});

test('sandbox: a CPU-bound loop is stopped and reported, not left running', { skip: NO_SANDBOX }, async () => {
  const dir = fixture();
  const copy = createCopy(dir);
  try {
    const r = await runIsolated('node -e "for(;;){}"', { copy, cwd: copy.dir, timeoutMs: 6000, method: BACKEND, limits: { ...LIMITS, cpuSeconds: 10 } });
    assert.ok(r.timedOut || r.signal || r.exitCode !== 0);
    assert.ok(r.ms < 12000);
  } finally {
    copy.dispose();
  }
});

test('sandbox: memory past the limit kills the run (bwrap, docker)', { skip: NO_SANDBOX || (!['bwrap', 'docker'].includes(BACKEND) && `${BACKEND} cannot enforce a memory limit`) }, async () => {
  const dir = fixture();
  const copy = createCopy(dir, { linkDeps: BACKEND !== 'docker' });
  try {
    const hog = 'node -e "const a=[]; for(;;) a.push(Buffer.alloc(64*1024*1024, 1))"';
    const r = await runIsolated(hog, { copy, cwd: copy.dir, timeoutMs: 30000, method: BACKEND, limits: { ...LIMITS, memoryMb: 512 } });
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.timedOut, false, 'stopped by the memory limit, not the timeout');
  } finally {
    copy.dispose();
  }
});

// ---------- privacy ----------

test('reports redact secret-looking values and can drop source lines entirely', async () => {
  const keyLine = 'const key = process.env.K || "sk-abcdefghijklmnopqrstuvwxyz0123" && true;';
  assert.ok(!redact(keyLine).includes('sk-abcdefghijklmnopqrstuvwxyz0123'));
  assert.ok(!redact('password: "hunter2hunter2"').includes('hunter2'));
  assert.ok(!redact('ghp_' + 'a'.repeat(36)).includes('aaaa'));
  const dir = fixture();
  fs.appendFileSync(path.join(dir, 'src', 'math.js'), `export function k() {\n  ${keyLine}\n  return key;\n}\n`);
  const r = await assessStrength({ cwd: dir, ...ISO, cache: false, testCommand: TEST_CMD });
  assert.ok(r.mutants.length > 0);
  const json = JSON.stringify(r);
  assert.ok(!json.includes('sk-abcdefghijklmnopqrstuvwxyz0123'), 'no key in the JSON report');
  assert.ok(!toCsv(r).includes('sk-abcdefghijklmnopqrstuvwxyz0123'), 'no key in the CSV');
  assert.ok(!r.cwd.includes(os.homedir()) || !r.cwd.startsWith(os.homedir()), 'home path shortened to ~');
  const bare = withoutSource(r);
  assert.ok(bare.mutants.every((m) => m.before === undefined && m.after === undefined));
});

test('crossexam itself makes no network requests', () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  for (const f of fs.readdirSync(src)) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    assert.ok(!/\bfetch\(|node:https?['"]|node:net['"]|node:dgram|XMLHttpRequest|WebSocket/.test(text), `${f} has no network calls`);
  }
});
