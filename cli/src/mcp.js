// A Model Context Protocol server over stdio, so any MCP-capable agent
// (Claude Code, Cursor, Copilot, Codex, Gemini CLI, Windsurf, Cline, Zed,
// Goose…) can ask crossexam to check its summary before it says "done".
// Newline-delimited JSON-RPC 2.0, no dependencies. stdout is the protocol;
// anything human goes to stderr.

import path from 'node:path';
import readline from 'node:readline';
import { detectCommands, verifyText } from './live.js';

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
      },
      required: ['summary'],
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
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
          return reply(id, await callTool(params.name, params.arguments || {}, defaultCwd));
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

async function callTool(name, args, defaultCwd) {
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
    return { content: [{ type: 'text', text: formatForAgent(r) }], structuredContent: { ok: r.ok, results: r.results } };
  }
  return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
}

export function formatForAgent(r) {
  if (!r.results.length) {
    return 'No checkable claims found in that summary. If you are saying tests, build, types or lint pass, say so explicitly; if you renamed something, name it in `backticks`.';
  }
  const mark = { verified: '✓ verified', contradicted: '✗ CONTRADICTED', review: '◇ needs review', stale: '◷ stale', unbacked: '○ unbacked' };
  const lines = r.results.map((x) => `${mark[x.verdict]}: "${x.claim}"\n  ${x.reason.replace(/`/g, '')}${x.verdict === 'contradicted' && x.evidence?.excerpt ? `\n  Output:\n${x.evidence.excerpt.split('\n').map((l) => '    ' + l).join('\n')}` : ''}`);
  const head = r.ok
    ? 'No claim was contradicted. You may report these as checked.'
    : 'At least one claim is FALSE. Do not report the task as done: fix the problem and verify again, or correct your summary to say what is actually true.';
  return `${head}\n\n${lines.join('\n\n')}`;
}
