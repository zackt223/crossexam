// The agent-agnostic paths: live verify, MCP, init, PR mode, and the
// transcript readers for agents beyond Claude Code and Codex.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSession } from '../src/analyze.js';
import { agentOf } from '../src/github.js';
import { ruleBlock, runInit, upsertBlock } from '../src/init.js';
import { detectCommands, manifestVersion, verifyText } from '../src/live.js';
import { readAiderSession, readClineSession, readGeminiSession, readOpenSession } from '../src/readers.js';
import { readClaudeSession } from '../src/transcripts.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'crossexam.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cx-u-'));

/** A tiny repo whose "test suite" passes or fails on demand. */
function repo({ testsPass = true, files = {} } = {}) {
  const dir = tmp();
  const testCmd = testsPass ? 'node -e "console.log(\'Tests: 3 passed, 3 total\')"' : 'node -e "console.log(\'Tests: 1 failed, 2 passed, 3 total\');process.exit(1)"';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: testCmd, build: 'node -e "0"' }, dependencies: { zod: '^3.22.4' } }));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

// ---------------------------------------------------------------- live verify

test('verify: re-runs the suite and contradicts a false "tests pass"', async () => {
  const r = await verifyText('Fixed the bug. All tests pass and the build succeeds.', { cwd: repo({ testsPass: false }) });
  const by = Object.fromEntries(r.results.map((x) => [x.kind, x.verdict]));
  assert.deepEqual(by, { tests: 'contradicted', build: 'verified' });
  assert.equal(r.ok, false);
});

test('verify: a true "tests pass" is verified', async () => {
  const r = await verifyText('All tests pass.', { cwd: repo({ testsPass: true }) });
  assert.equal(r.results[0].verdict, 'verified');
  assert.equal(r.ok, true);
});

test('verify: renames are searched, versions read from the manifest', async () => {
  const dir = repo({ files: { 'src/a.ts': 'export const u = getUserById(1)\n' } });
  const r = await verifyText('Renamed `getUserById` to `fetchUser` everywhere. Bumped zod to 3.23.8.', { cwd: dir });
  const by = Object.fromEntries(r.results.map((x) => [x.kind, x]));
  assert.equal(by.refactor.verdict, 'contradicted');
  assert.match(by.refactor.evidence.excerpt, /src\/a\.ts:1/);
  assert.equal(by.deps.verdict, 'contradicted');
  assert.match(by.deps.reason, /\^3\.22\.4/);
});

test('hook --rerun runs the repo test command, never a transcript string', async () => {
  const dir = repo({ testsPass: true });
  // A command the sandbox or a guard hook stopped, with a payload chained on.
  const payload = `npm test && node -e "require('fs').writeFileSync('PWNED','x')"`;
  const t = path.join(tmp(), 't.jsonl');
  fs.writeFileSync(
    t,
    [
      { type: 'user', message: { role: 'user', content: 'fix it' }, cwd: dir, timestamp: '2026-11-02T10:00:00Z' },
      { type: 'assistant', message: { model: 'm', content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: payload } }] }, timestamp: '2026-11-02T10:00:01Z' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'Exit code 1\nblocked by sandbox: network denied', is_error: true }] }, timestamp: '2026-11-02T10:00:02Z' },
      { type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'All tests pass.' }] }, timestamp: '2026-11-02T10:00:03Z' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );
  const { claims } = analyzeSession(await readClaudeSession(t), { onlyLastTurn: true, live: { cwd: dir, rerun: true } });
  assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
  assert.equal(claims[0].evidence.command, 'npm test');
  assert.equal(claims[0].verdict, 'verified');
});

test('verify: never runs migrations on its own, and dry runs run nothing', async () => {
  const dir = repo();
  const m = await verifyText('The migration has been applied.', { cwd: dir });
  assert.equal(m.results[0].verdict, 'review');
  const d = await verifyText('All tests pass.', { cwd: dir, run: false });
  assert.equal(d.results[0].verdict, 'review');
  assert.match(d.results[0].reason, /dry run/);
});

test('detects commands across ecosystems, and crossexam.json wins', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n\nrequire github.com/stretchr/testify v1.9.0\n');
  assert.equal(detectCommands(dir).tests.command, 'go test ./...');
  assert.equal(manifestVersion(dir, 'github.com/stretchr/testify').version, '1.9.0');
  fs.writeFileSync(path.join(dir, 'crossexam.json'), JSON.stringify({ commands: { tests: 'make test', migration: 'prisma migrate status' } }));
  const c = detectCommands(dir);
  assert.equal(c.tests.command, 'make test');
  assert.equal(c.migration.command, 'prisma migrate status');
  const py = tmp();
  fs.writeFileSync(path.join(py, 'pyproject.toml'), '[tool.pytest.ini_options]\n[tool.ruff]\n');
  fs.writeFileSync(path.join(py, 'requirements.txt'), 'requests==2.32.3\n');
  assert.equal(detectCommands(py).tests.command, 'python -m pytest -q');
  assert.equal(detectCommands(py).lint.command, 'ruff check .');
  assert.equal(manifestVersion(py, 'requests').version, '2.32.3');
});

test('verify CLI: exit code 1 on a contradicted claim, 0 otherwise', () => {
  const bad = spawnSync('node', [BIN, 'verify', 'All tests pass.', '--cwd', repo({ testsPass: false })], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /CONTRADICTED/);
  const good = spawnSync('node', [BIN, 'verify', '--cwd', repo(), '--json'], { input: 'All tests pass.', encoding: 'utf8' });
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).ok, true);
});

// ---------------------------------------------------------------- MCP

test('MCP server: initialize, list tools, verify a summary', async () => {
  const dir = repo({ testsPass: false });
  const child = spawn('node', [BIN, 'mcp', '--cwd', dir], { stdio: ['pipe', 'pipe', 'ignore'] });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        const m = JSON.parse(line);
        replies.get(m.id)?.(m);
      }
    }
  });
  const call = (id, method, params) =>
    new Promise((resolve) => {
      replies.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  const init = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'crossexam');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await call(2, 'tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['verify_claims', 'assess_test_strength', 'reverify_findings', 'agent_reliability', 'list_checks']);

  const res = await call(3, 'tools/call', { name: 'verify_claims', arguments: { summary: 'Done. All tests pass.' } });
  assert.equal(res.result.structuredContent.ok, false);
  assert.match(res.result.content[0].text, /Do not report the task as done/);

  const unknown = await call(4, 'nope/never', {});
  assert.equal(unknown.error.code, -32601);
  child.kill();
});

// ---------------------------------------------------------------- init

test('init: writes the AGENTS.md rule and MCP configs, idempotently', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# House rules\n\nUse tabs.\n');
  fs.mkdirSync(path.join(dir, '.cursor'));
  fs.writeFileSync(path.join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  const first = runInit({ cwd: dir, cliCmd: 'npx -y crossexamdev', serverCmd: ['npx', '-y', 'crossexamdev', 'mcp'], mcp: true });
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# House rules\n\nUse tabs\./);
  assert.match(agents, /verify_claims/);
  const cursor = JSON.parse(fs.readFileSync(path.join(dir, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(cursor.mcpServers).sort(), ['crossexam', 'other']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.vscode', 'mcp.json'), 'utf8')).servers.crossexam.type, 'stdio');
  assert.ok(first.some((c) => c.file === '.mcp.json' && c.action === 'created'));
  const second = runInit({ cwd: dir, cliCmd: 'npx -y crossexamdev', serverCmd: ['npx', '-y', 'crossexamdev', 'mcp'], mcp: true });
  assert.ok(second.every((c) => c.action === 'unchanged'));
  const block = ruleBlock('crossexam');
  assert.equal(upsertBlock(upsertBlock('a\n', block), block).match(/crossexam:start/g).length, 1);
});

// ---------------------------------------------------------------- pull requests

test('verify --github: reads the PR body, annotates, writes the job summary', () => {
  const dir = repo({ testsPass: false });
  const ev = path.join(tmp(), 'event.json');
  fs.writeFileSync(ev, JSON.stringify({ pull_request: { number: 42, title: 'Fix proration', body: 'Fixed rounding. All tests pass.', user: { login: 'Copilot' } } }));
  const summary = path.join(tmp(), 'summary.md');
  const out = path.join(tmp(), 'out.txt');
  const r = spawnSync('node', [BIN, 'verify', '--github', '--cwd', dir], { encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: ev, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: out } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error title=crossexam: false claim::/);
  assert.match(fs.readFileSync(summary, 'utf8'), /PR #42 by \*\*copilot\*\*/);
  assert.match(fs.readFileSync(out, 'utf8'), /contradicted=1/);
  // The heredoc delimiter is unguessable, so repo text can't close it early.
  assert.match(fs.readFileSync(out, 'utf8'), /^summary<<CROSSEXAM_EOF_[0-9a-f]{32}$/m);
  assert.equal(agentOf('devin-ai-integration[bot]'), 'devin');
  assert.equal(agentOf('someone', 'Generated with [Claude Code](https://claude.com)'), 'claude-code');
});

// ---------------------------------------------------------------- readers

const write = (name, body) => {
  const f = path.join(tmp(), name);
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
};
const verdicts = (s) => analyzeSession(s).claims.map((c) => `${c.kind}:${c.verdict}`);

test('Gemini CLI sessions', () => {
  const f = write('session-1.json', {
    sessionId: 'g1',
    projectHash: 'abc',
    messages: [
      { type: 'user', content: 'fix the date bug', timestamp: '2026-10-01T10:00:00Z' },
      { type: 'gemini', model: 'gemini-2.5-pro', content: '', timestamp: '2026-10-01T10:00:01Z', toolCalls: [{ id: 'c1', name: 'replace', args: { file_path: '/w/app/src/d.ts' }, status: 'success' }, { id: 'c2', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success', result: [{ functionResponse: { response: { output: 'Command: npm test\nDirectory: /w/app\nStdout: Tests: 1 failed, 4 passed\nExit Code: 1' } } }] }] },
      { type: 'gemini', model: 'gemini-2.5-pro', content: 'Fixed the DST bug. All tests pass.', timestamp: '2026-10-01T10:00:05Z' },
    ],
  });
  const s = readGeminiSession(f);
  assert.equal(s.cwd, '/w/app');
  assert.equal(s.model, 'gemini-2.5-pro');
  assert.deepEqual(verdicts(s), ['tests:contradicted']);
});

test('Cline / Roo / Kilo task logs', () => {
  const dir = tmp();
  const f = path.join(dir, 'ui_messages.json');
  fs.writeFileSync(
    f,
    JSON.stringify([
      { ts: 1, type: 'say', say: 'task', text: 'add pagination' },
      { ts: 2, type: 'say', say: 'api_req_started', text: JSON.stringify({ model: 'claude-sonnet-5-5' }) },
      { ts: 3, type: 'ask', ask: 'command', text: 'npm test' },
      { ts: 4, type: 'say', say: 'command_output', text: 'Tests: 12 passed, 12 total' },
      { ts: 5, type: 'ask', ask: 'tool', text: JSON.stringify({ tool: 'editedExistingFile', path: 'src/list.ts' }) },
      { ts: 6, type: 'say', say: 'completion_result', text: 'Pagination is in and the tests are passing.' },
    ]),
  );
  fs.writeFileSync(path.join(dir, 'api_conversation_history.json'), JSON.stringify([{ role: 'user', content: [{ type: 'text', text: '# Current Working Directory (/w/shop) Files' }] }]));
  const s = readClineSession(f, 'roo-code');
  assert.equal(s.agent, 'roo-code');
  assert.equal(s.repo, 'shop');
  assert.deepEqual(verdicts(s), ['tests:stale']);
});

test('Aider chat history', () => {
  const f = write(
    '.aider.chat.history.md',
    ['# aider chat started at 2026-10-02 09:00:00', '', '#### fix the parser', '', 'I updated parse.py.', '', '> Applied edit to parse.py', '', '#### /test pytest -q', '', '> FAILED tests/test_parse.py::test_empty - IndexError', '> 1 failed, 9 passed in 0.4s', '', 'Fixed. All tests pass now.', ''].join('\n'),
  );
  const s = readAiderSession(f);
  assert.deepEqual(verdicts(s), ['tests:contradicted']);
});

test('open format, for any agent or framework', () => {
  const f = write(
    'run.jsonl',
    [
      { type: 'session', agent: 'my-langgraph-bot', model: 'gpt-5', cwd: '/w/api' },
      { type: 'prompt', text: 'bump zod' },
      { type: 'command', command: 'pnpm add zod@3.23.8', exit_code: 0, output: '+ zod 3.23.8' },
      { type: 'edit', path: 'src/schema.ts' },
      { type: 'command', command: 'pnpm test', exit_code: 0, output: 'Tests: 40 passed, 40 total' },
      { type: 'message', text: 'Bumped `zod` to 3.23.8 and all tests pass.' },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n'),
  );
  const s = readOpenSession(f);
  assert.equal(s.agent, 'my-langgraph-bot');
  assert.deepEqual(verdicts(s).sort(), ['deps:verified', 'tests:verified']);
});
