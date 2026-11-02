import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { analyzeSession } from '../src/analyze.js';
import { detectClaims } from '../src/claims.js';
import { judgeRun } from '../src/evidence.js';
import { readClaudeSession, readCodexSession } from '../src/transcripts.js';

// ---- fixture builders: the smallest transcripts that exercise each verdict ----

let n = 0;
const claude = {
  prompt: (text) => ({ type: 'user', message: { role: 'user', content: text }, cwd: '/work/acme-api', timestamp: ts() }),
  say: (text) => ({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] }, timestamp: ts() }),
  bash: (command, out, code = 0) => {
    const id = 'toolu_' + ++n;
    return [
      { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }, timestamp: ts() },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: code ? `Exit code ${code}\n${out}` : out, is_error: !!code }] }, timestamp: ts() },
    ];
  },
  edit: (file) => {
    const id = 'toolu_' + ++n;
    return [
      { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file } }] }, timestamp: ts() },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, timestamp: ts() },
    ];
  },
};
let t0 = Date.parse('2026-10-01T10:00:00Z');
const ts = () => new Date((t0 += 1000)).toISOString();

function writeJsonl(rows) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cx-')), 'session.jsonl');
  fs.writeFileSync(f, rows.flat().map((r) => JSON.stringify(r)).join('\n'));
  return f;
}

async function verdictsOf(rows) {
  const s = await readClaudeSession(writeJsonl(rows));
  return analyzeSession(s).claims.map((c) => `${c.kind}:${c.verdict}`);
}

// ---- claim detection ----

test('detects assertions, ignores intentions and negations', () => {
  assert.deepEqual(detectClaims('Fixed the null check. All tests pass now.').map((c) => c.kind), ['tests']);
  assert.deepEqual(detectClaims('Next I will make sure the tests pass.'), []);
  assert.deepEqual(detectClaims("The tests don't pass yet because of the fixture."), []);
  assert.deepEqual(detectClaims('Can you confirm the tests pass on CI?'), []);
  assert.deepEqual(detectClaims('Run `npm test` to check that the build succeeds.'), []);
  assert.deepEqual(detectClaims('Build succeeds and typecheck is clean.').map((c) => c.kind).sort(), ['build', 'types']);
  const r = detectClaims('Renamed `getUserById` to `fetchUser` everywhere — all call sites are updated.');
  assert.equal(r[0].kind, 'refactor');
  assert.deepEqual(r[0].subject, { from: 'getUserById', to: 'fetchUser' });
  assert.deepEqual(detectClaims('Bumped zod from 3.22 to 3.23.8.')[0].subject, { pkg: 'zod', version: '3.23.8' });
});

test('judges runs by exit code, failure lines and masked pipes', () => {
  assert.equal(judgeRun({ command: 'npm test', exitCode: 1, output: 'Tests: 2 failed, 40 passed' }).status, 'fail');
  assert.equal(judgeRun({ command: 'npm test | tail -5', exitCode: 0, output: 'Tests: 2 failed, 40 passed, 42 total' }).status, 'fail');
  assert.equal(judgeRun({ command: 'npm test | tail -5', exitCode: 0, output: 'done' }).status, 'masked');
  assert.equal(judgeRun({ command: 'npm test', exitCode: 0, output: 'Tests: 42 passed, 42 total' }).status, 'pass');
});

// ---- verdicts end to end ----

test('contradicted: claims green after a red run', async () => {
  const v = await verdictsOf([claude.prompt('fix the login bug'), claude.edit('src/auth.ts'), claude.bash('npm test', 'FAIL src/auth.test.ts\nTests: 1 failed, 12 passed', 1), claude.say('Fixed it. All tests pass.')]);
  assert.deepEqual(v, ['tests:contradicted']);
});

test('contradicted: failure hidden behind a pipe still counts', async () => {
  const v = await verdictsOf([claude.prompt('fix it'), claude.bash('npx vitest run 2>&1 | tail -3', ' Tests  3 failed | 40 passed (43)'), claude.say('All tests pass.')]);
  assert.deepEqual(v, ['tests:contradicted']);
});

test('stale: passed, then edited, then claimed', async () => {
  const v = await verdictsOf([claude.prompt('add pagination'), claude.bash('pnpm test', 'Tests: 30 passed, 30 total'), claude.edit('src/list.ts'), claude.say('Done — tests are passing.')]);
  assert.deepEqual(v, ['tests:stale']);
});

test('verified: edit, then a passing run, then the claim', async () => {
  const v = await verdictsOf([claude.prompt('add pagination'), claude.edit('src/list.ts'), claude.bash('pnpm test', 'Tests: 31 passed, 31 total'), claude.say('Pagination added and all 31 tests pass.')]);
  assert.deepEqual(v, ['tests:verified']);
});

test('unbacked: nothing ran', async () => {
  const v = await verdictsOf([claude.prompt('rename the helper'), claude.edit('src/a.ts'), claude.say('Build succeeds and all callers have been updated.')]);
  assert.deepEqual(v.sort(), ['build:unbacked', 'refactor:unbacked']);
});

test('review: claimed the whole suite, ran one file', async () => {
  const v = await verdictsOf([claude.prompt('fix'), claude.edit('a.ts'), claude.bash('npx vitest run src/a.test.ts', 'Tests 4 passed (4)'), claude.say('All tests pass.')]);
  assert.deepEqual(v, ['tests:review']);
});

test('denied tool calls are not evidence', async () => {
  const id = 'toolu_denied';
  const v = await verdictsOf([
    claude.prompt('fix'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] }, timestamp: ts() },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: "The user doesn't want to proceed with this tool use.", is_error: true }] }, timestamp: ts() },
    claude.say('Tests pass.'),
  ]);
  assert.deepEqual(v, ['tests:unbacked']);
});

test('reads Codex rollouts', async () => {
  const rows = [
    { timestamp: ts(), type: 'session_meta', payload: { id: 'rollout-1', cwd: '/work/monorepo' } },
    { timestamp: ts(), type: 'turn_context', payload: { cwd: '/work/monorepo', model: 'gpt-5-codex' } },
    { timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'write the users migration' }] } },
    { timestamp: ts(), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'npx prisma migrate dev'] }) } },
    { timestamp: ts(), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'Error: P3006 Migration failed to apply cleanly', metadata: { exit_code: 1 } }) } },
    { timestamp: ts(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The migration has been applied and the users table is ready.' }] } },
  ];
  const s = await readCodexSession(writeJsonl(rows));
  assert.equal(s.repo, 'monorepo');
  const { claims } = analyzeSession(s);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, 'migration');
  assert.equal(claims[0].verdict, 'contradicted');
  assert.equal(claims[0].model, 'gpt-5-codex');
  assert.equal(claims[0].taskType, 'migration');
});
