// A Model Context Protocol server over stdio, so any MCP-capable agent
// (Claude Code, Cursor, Copilot, Codex, Gemini CLI, Windsurf, Cline, Zed,
// Goose…) can ask crossexam to check its summary before it says "done".
// Newline-delimited JSON-RPC 2.0, no dependencies. stdout is the protocol;
// anything human goes to stderr.

import path from 'node:path';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import { detectWorkClaims } from './claims.js';
import { detectCommands, verifyText } from './live.js';
import { STATUS, assessStrength, ledgerRecord, qualityOf } from './strength.js';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `crossexam checks claims against the repository. Before you tell the user a task is done, call verify_claims with the exact summary you are about to give and the absolute path of the workspace. If any claim comes back "contradicted", fix the problem or correct the summary before finishing. Never say tests, build, types or lint pass unless verify_claims verified it.`;

const TOOLS = [
  {
    name: 'verify_claims',
    title: 'Verify completion claims',
    description:
      'Check what you are about to tell the user ("all tests pass", "build is clean", "renamed `foo` to `bar` everywhere", "bumped zod to 3.23.8") against the repository right now. Runs the project\'s own test/build/typecheck/lint commands and searches the code. Call this before reporting a task as done.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'The completion message you are about to send, verbatim.' },
        cwd: { type: 'string', description: 'Absolute path of the workspace/repository root. Defaults to the server\'s working directory.' },
        mutate: { type: 'boolean', description: 'Also grade how strong the tests behind a "tests pass" or "implemented/fixed" claim are, by planting small defects in the changed code (slower: runs the test suite once per mutant).' },
      },
      required: ['summary'],
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'assess_test_strength',
    title: 'Assess test strength (mutation testing)',
    description:
      "Plant small deterministic defects (flipped comparisons, inverted conditions, swapped operators) in the code you changed, run the repo's tests against each one in an isolated copy, and report which defects the tests failed to notice. Your working tree is never modified. Use the surviving defects to write tests that would catch them.",
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute path of the repository root.' },
        base: { type: 'string', description: 'Git ref to compare against. Default: uncommitted changes, else the last commit.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Mutate these files (every line) instead of the diff.' },
        max: { type: 'number', description: 'Most mutants to run in this call (default 15). Finished results are cached, so calling again continues.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_checks',
    title: 'List the checks crossexam would run',
    description: 'Show which test, build, typecheck, lint and migration-status commands crossexam found for a repository.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Absolute path of the repository root.' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

export function startMcpServer({ version, defaultCwd = process.cwd() }) {
  let client = 'unknown';
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, -32700, 'Parse error');
    }
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case 'initialize':
          client = agentFromClient(params.clientInfo?.name);
          return reply(id, {
            protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'crossexam', title: 'crossexam', version },
            instructions: INSTRUCTIONS,
          });
        case 'ping':
          return reply(id, {});
        case 'tools/list':
          return reply(id, { tools: TOOLS });
        case 'tools/call':
          return reply(id, await callTool(params.name, params.arguments || {}, defaultCwd, client));
        default:
          if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      if (isRequest) fail(id, -32603, String(e?.message || e));
    }
  });
  rl.on('close', () => process.exit(0));
  process.stderr.write(`crossexam MCP server ${version} ready (cwd ${defaultCwd})\n`);
}

// Keep MCP calls well inside client timeouts; results are cached, so the agent can call again.
const MCP_LIMITS = { max: 15, budgetSeconds: 120 };

async function callTool(name, args, defaultCwd, client = 'unknown') {
  const cwd = path.resolve(typeof args.cwd === 'string' && args.cwd ? args.cwd : defaultCwd);
  if (name === 'list_checks') {
    const cmds = detectCommands(cwd);
    const lines = ['tests', 'build', 'types', 'lint', 'migration'].map((k) => `${k.padEnd(9)} ${cmds[k] ? `${cmds[k].command}   (from ${cmds[k].source})` : '—'}`);
    return { content: [{ type: 'text', text: `Checks for ${cwd}\n\n${lines.join('\n')}` }], structuredContent: { cwd, commands: cmds } };
  }
  if (name === 'verify_claims') {
    if (typeof args.summary !== 'string' || !args.summary.trim()) {
      return { isError: true, content: [{ type: 'text', text: 'summary is required: pass the completion message you are about to send.' }] };
    }
    const r = await verifyText(args.summary, { cwd });
    if (args.mutate === true && (r.results.some((x) => x.kind === 'tests') || detectWorkClaims(args.summary).length)) {
      const strength = await assessStrength({ cwd, ...MCP_LIMITS });
      r.strength = strength;
      for (const x of r.results) if (x.kind === 'tests') x.quality = qualityOf(strength);
      ledger(ledgerRecord(strength, { agent: client, claim: args.summary.slice(0, 280), source: 'mcp' }));
    }
    const text = formatForAgent(r) + (r.strength ? '\n\n' + formatStrengthForAgent(r.strength) : '');
    return { content: [{ type: 'text', text }], structuredContent: { ok: r.ok, results: r.results, strength: r.strength ? qualityOf(r.strength) : undefined } };
  }
  if (name === 'assess_test_strength') {
    const files = Array.isArray(args.files) ? args.files.filter((x) => typeof x === 'string') : undefined;
    const max = Number.isFinite(args.max) ? Math.min(Math.max(1, args.max), 50) : MCP_LIMITS.max;
    const strength = await assessStrength({ cwd, base: typeof args.base === 'string' ? args.base : undefined, files, max, budgetSeconds: MCP_LIMITS.budgetSeconds });
    ledger(ledgerRecord(strength, { agent: client, source: 'mcp' }));
    return {
      content: [{ type: 'text', text: formatStrengthForAgent(strength) }],
      structuredContent: { quality: qualityOf(strength), summary: strength.summary, survivors: strength.mutants.filter((m) => m.status === STATUS.SURVIVED) },
    };
  }
  return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
}

export function formatForAgent(r) {
  if (!r.results.length) {
    return 'No checkable claims found in that summary. If you are saying tests, build, types or lint pass, say so explicitly; if you renamed something, name it in `backticks`.';
  }
  const mark = { verified: '✓ verified', contradicted: '✗ CONTRADICTED', review: '◇ needs review', stale: '◷ stale', unbacked: '○ unbacked' };
  const lines = r.results.map((x) => `${mark[x.verdict]}: "${x.claim}"\n  ${x.reason.replace(/`/g, '')}${x.quality ? `\n  test strength: ${x.quality.rating}${x.quality.score != null ? ` (${Math.round(x.quality.score * 100)}% of planted defects caught)` : ''}. This is separate from the verdict above.` : ''}${x.verdict === 'contradicted' && x.evidence?.excerpt ? `\n  Output:\n${x.evidence.excerpt.split('\n').map((l) => '    ' + l).join('\n')}` : ''}`);
  const head = r.ok
    ? 'No claim was contradicted. You may report these as checked.'
    : 'At least one claim is FALSE. Do not report the task as done: fix the problem and verify again, or correct your summary to say what is actually true.';
  return `${head}\n\n${lines.join('\n\n')}`;
}

/** What an agent needs to act on: the gap, the exact surviving defects, and what to do next. */
export function formatStrengthForAgent(r) {
  const s = r.summary;
  const head = `Test strength: ${r.rating}${s.score != null ? ` (${s.killed} of ${s.killed + s.survived} planted defects caught)` : ''}. ${r.headline?.text ?? ''}`.trim();
  const surv = r.mutants.filter((m) => m.status === STATUS.SURVIVED).slice(0, 10);
  const lines = surv.map((m) => `- ${m.file}:${m.line} (${m.function || 'top level'}): changing\n    ${m.before.split('\n')[0].trim()}\n  to\n    ${m.after.split('\n')[0].trim()}\n  did not fail any test.`);
  const next = surv.length
    ? 'Add or strengthen tests so each of these changes would fail them, then call assess_test_strength again. Do not describe the tests as thorough until it reports strong.'
    : r.blocker
      ? ''
      : 'The tests caught every planted defect in the changed code.';
  const tail = [
    r.remaining ? `${r.remaining} more mutants were not run in this call; call again to continue (finished ones are cached).` : '',
    'A mutation score measures how well tests pin down the changed code, not whether the code is correct. The working tree was not modified.',
  ].filter(Boolean);
  return [head, lines.join('\n'), next, ...tail].filter(Boolean).join('\n\n');
}

const CLIENTS = [
  [/claude/i, 'claude-code'],
  [/codex/i, 'codex'],
  [/cursor/i, 'cursor'],
  [/copilot|visual studio code|vscode/i, 'copilot'],
  [/gemini/i, 'gemini'],
  [/windsurf|codeium/i, 'windsurf'],
  [/roo/i, 'roo-code'],
  [/kilo/i, 'kilo-code'],
  [/cline/i, 'cline'],
  [/zed/i, 'zed'],
  [/goose/i, 'goose'],
];
function agentFromClient(name = '') {
  for (const [re, id] of CLIENTS) if (re.test(name)) return id;
  return name ? String(name).toLowerCase().slice(0, 40) : 'unknown';
}

function ledger(rec) {
  try {
    const dir = (process.env.CROSSEXAM_HOME || path.join(os.homedir(), '.crossexam'));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify(rec) + '\n');
  } catch {
    /* history is best effort */
  }
}
