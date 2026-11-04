#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSession } from '../src/analyze.js';
import { emitActions, readPullRequest } from '../src/github.js';
import { globalSnippets, runInit } from '../src/init.js';
import { detectCommands, verifyText } from '../src/live.js';
import { formatForAgent, startMcpServer } from '../src/mcp.js';
import { discoverAider, discoverMore } from '../src/readers.js';
import { buildReport, c, printReport } from '../src/report.js';
import { AGENTS, defaultSources, findTranscripts, readSession } from '../src/transcripts.js';

const VERSION = '0.2.0';
const HELP = `
  ${c.bold('crossexam')} — cross-examine what your coding agents claim

  ${c.bold('Works with any agent')}
    crossexam verify "<summary>"   check any agent's "done" message against the repo right now
    crossexam mcp                  MCP server: any MCP agent calls verify_claims before it says done
    crossexam init [--mcp]         add the rule to AGENTS.md (and MCP configs) so agents check themselves
    crossexam verify --github      in CI: check the claims in an agent's pull request description

  ${c.bold('History')}
    crossexam scan                 check local transcripts: Claude Code, Codex, Gemini CLI, Cline,
                                   Roo Code, Kilo Code, Aider and the open format
    crossexam hook                 Claude Code Stop hook: send a false "done" back to the agent
    crossexam install              add that hook to ~/.claude/settings.json

  ${c.bold('verify')}
    <text> | --file <path> | stdin the summary to check
    --cwd <dir>                    repository to check            (default: current directory)
    --dry-run                      show which checks would run, run nothing
    --json                         machine-readable result
    --fail-on <contradicted|none>  exit 1 when a claim is contradicted (default: contradicted)
    --timeout <seconds>            per command                    (default 300)

  ${c.bold('scan')}
    --since <30d|12h|all>          how far back to look           (default 30d)
    --agent <name>                 one of: ${AGENTS.join(', ')}
    --repo <name>                  only one repo
    --path <dir>                   also look for Aider history here (repeatable; cwd is always checked)
    --file <path>                  one transcript (with --agent)
    --json [out.json]              write the full report; open it in the dashboard
    --limit <n>                    false "done"s to print         (default 8)

  ${c.bold('hook / install / init')}
    --rerun                        re-run the test command before trusting a "tests pass"
    --project                      install into ./.claude/settings.json instead
    --mcp                          init: also write project MCP configs (Claude Code, Cursor, VS Code, Gemini CLI, Roo Code)
    --dry-run                      print the change, write nothing
`;

const VALUED = new Set(['since', 'agent', 'repo', 'file', 'json', 'limit', 'path', 'cwd', 'fail-on', 'timeout']);
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'scan';
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] && !args[i + 1].startsWith('--') ? [args[i + 1]] : []));
const positional = () => args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && VALUED.has(args[i - 1].slice(2))));

try {
  if (flag('help') || cmd === 'help') process.stdout.write(HELP + '\n');
  else if (flag('version') || cmd === 'version') console.log(VERSION);
  else if (cmd === 'scan') await scan();
  else if (cmd === 'verify') await verify();
  else if (cmd === 'mcp') startMcpServer({ version: VERSION, defaultCwd: path.resolve(String(opt('cwd', process.cwd()))) });
  else if (cmd === 'init') init();
  else if (cmd === 'hook') await hook();
  else if (cmd === 'install') install();
  else {
    process.stderr.write(`Unknown command "${cmd}".\n${HELP}\n`);
    process.exitCode = 2;
  }
} catch (e) {
  // A verifier must never take the agent down with it.
  process.stderr.write(`crossexam: ${cmd === 'hook' ? e?.stack || e : e?.message || e}\n`);
  process.exitCode = cmd === 'hook' ? 0 : 2;
}

async function scan() {
  const since = parseSince(opt('since', '30d'));
  const onlyAgent = opt('agent');
  const onlyRepo = opt('repo');
  const single = opt('file');

  let files = [];
  if (typeof single === 'string') files = [{ agent: typeof onlyAgent === 'string' ? onlyAgent : 'claude-code', file: path.resolve(single) }];
  else {
    for (const src of defaultSources()) for (const f of findTranscripts(src.root, since)) files.push({ agent: src.agent, file: f });
    files.push(...discoverMore(since), ...discoverAider([process.cwd(), ...opts('path').map((p) => path.resolve(p))], since));
    if (typeof onlyAgent === 'string') files = files.filter((f) => f.agent === onlyAgent);
  }

  const claims = [];
  let turns = 0;
  let ranCheckTurns = 0;
  let contradictedTurns = 0;
  let sessions = 0;
  const agents = new Set();
  for (const { agent, file } of files) {
    let s;
    try {
      s = await readSession(agent, file);
    } catch (e) {
      // One unreadable transcript (an agent mid-write, a format change) shouldn't sink the scan.
      process.stderr.write(c.dim(`  skipped ${file}: ${e.message}\n`));
      continue;
    }
    if (onlyRepo && s.repo !== onlyRepo) continue;
    if (!s.turns.length) continue;
    sessions++;
    agents.add(s.agent);
    const r = analyzeSession(s);
    turns += r.turns;
    ranCheckTurns += r.ranCheckTurns;
    contradictedTurns += new Set(r.claims.filter((x) => x.verdict === 'contradicted').map((x) => x.turn)).size;
    claims.push(...r.claims);
  }

  const report = buildReport(claims, { sessions, turns, ranCheckTurns, contradictedTurns, agents: [...agents], since: since ? new Date(since).toISOString() : null });
  const json = opt('json');
  if (json) {
    const out = typeof json === 'string' ? json : 'crossexam-report.json';
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    printReport(report, { limit: Number(opt('limit', 8)) });
    console.log(`  ${c.dim('Report written to')} ${path.resolve(out)}`);
    console.log(`  ${c.dim('Drop it on the dashboard to see reliability by agent, model and repo.')}\n`);
  } else {
    printReport(report, { limit: Number(opt('limit', 8)) });
    console.log(c.dim('  Run with --json to save the full report for the dashboard.\n'));
  }
}

async function verify() {
  const cwd = path.resolve(String(opt('cwd', process.cwd())));
  const github = flag('github');
  const pr = github ? readPullRequest() : null;
  if (github && !pr) throw new Error('--github needs a pull_request event (GITHUB_EVENT_PATH).');

  let text = pr ? `${pr.title}\n\n${pr.body}` : positional().join(' ');
  const file = opt('file');
  if (!text && typeof file === 'string') text = fs.readFileSync(file, 'utf8');
  if (!text) text = await readStdin();
  if (!text.trim()) throw new Error('Nothing to verify. Pass the summary as an argument, with --file, or on stdin.');

  const json = flag('json');
  const r = await verifyText(text, {
    cwd,
    run: !flag('dry-run'),
    timeoutMs: opt('timeout') ? Number(opt('timeout')) * 1000 : undefined,
    onRun: (command) => !json && process.stderr.write(c.dim(`  running ${command}…\n`)),
  });

  if (json) process.stdout.write(JSON.stringify({ ...r, pr }, null, 2) + '\n');
  else if (github) emitActions(pr, r);
  else {
    console.log();
    console.log(formatForAgent(r).replace(/^/gm, '  '));
    if (!r.results.length && Object.keys(r.commands).length) console.log(c.dim(`\n  Checks available here: ${Object.entries(r.commands).map(([k, v]) => `${k} (${v.command})`).join(', ')}`));
    console.log();
  }
  if (opt('fail-on', 'contradicted') !== 'none' && !r.ok) process.exitCode = 1;
}

function init() {
  const cwd = path.resolve(String(opt('cwd', process.cwd())));
  const { cli, server } = selfCommands();
  const changes = runInit({ cwd, cliCmd: cli, serverCmd: server, mcp: flag('mcp'), dryRun: flag('dry-run') });
  console.log(`\n  ${c.bold('crossexam init')} ${c.dim(cwd)}${flag('dry-run') ? c.dim('  (dry run, nothing written)') : ''}\n`);
  for (const ch of changes) console.log(`  ${ch.action === 'unchanged' ? c.dim('·') : c.green('✓')} ${ch.file.padEnd(24)} ${c.dim(ch.action)}`);
  const cmds = detectCommands(cwd);
  console.log(`\n  ${c.bold('Checks found')}  ${['tests', 'build', 'types', 'lint', 'migration'].map((k) => (cmds[k] ? `${k}: ${cmds[k].command}` : c.dim(`${k}: —`))).join(c.dim('  ·  '))}`);
  if (!cmds.migration) console.log(c.dim('  Migrations are only checked through a read-only status command you name in crossexam.json.'));
  if (!flag('mcp')) console.log(c.dim('\n  Add --mcp to also write MCP configs for Claude Code, Cursor, VS Code/Copilot, Gemini CLI and Roo Code.'));
  console.log(`\n  ${c.bold('Per-user MCP setup for other agents')}`);
  for (const [name, snippet] of globalSnippets(server)) console.log(`\n  ${c.dim(name)}\n${indent(snippet, '    ')}`);
  console.log();
}

async function hook() {
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    return;
  }
  if (!input.transcript_path || !fs.existsSync(input.transcript_path)) return;

  const s = await readSession('claude-code', input.transcript_path);
  const cwd = input.cwd || s.cwd || process.cwd();
  const { claims } = analyzeSession(s, { onlyLastTurn: true, live: { cwd, rerun: flag('rerun') } });
  if (!claims.length) return;
  ledger(claims);

  const bad = claims.filter((x) => x.verdict === 'contradicted' || x.verdict === 'stale');
  if (!bad.length) return;

  const lines = bad.map((x) => `- You said: "${x.claim}"\n  crossexam: ${x.reason}${x.evidence?.excerpt ? `\n  Output:\n${indent(x.evidence.excerpt, '    ')}` : ''}`);
  if (input.stop_hook_active) {
    // Already sent back once this turn; tell the human instead of looping.
    process.stdout.write(JSON.stringify({ systemMessage: `crossexam: ${bad.length} claim${bad.length > 1 ? 's' : ''} still not backed by a passing check.\n${lines.join('\n')}` }));
    return;
  }
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: `crossexam checked your summary against what actually ran this turn, and ${bad.length === 1 ? 'one claim does' : bad.length + ' claims do'} not hold up:\n${lines.join('\n')}\n\nFix the problem and re-run the check, or correct your summary to say what is actually true.`,
    }),
  );
}

function install() {
  const file = flag('project') ? path.resolve('.claude', 'settings.json') : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  const { cli } = selfCommands();
  const command = `${cli} hook${flag('rerun') ? ' --rerun' : ''}`;

  let settings = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  const already = settings.hooks.Stop.some((g) => g.hooks?.some((h) => /crossexam/.test(h.command || '')));
  if (already) {
    console.log(`\n  ${c.green('✓')} crossexam is already a Stop hook in ${file}\n`);
    return;
  }
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command, timeout: flag('rerun') ? 240 : 30 }] });

  if (flag('dry-run')) {
    console.log(`\n  Would write ${file}:\n`);
    console.log(indent(JSON.stringify({ hooks: { Stop: settings.hooks.Stop } }, null, 2), '  '));
    console.log();
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`\n  ${c.green('✓')} Added crossexam as a Stop hook in ${file}`);
  console.log(`  ${c.dim('When Claude Code says it is done and the evidence disagrees, the turn is sent back with the failing output.')}\n`);
}

// ---------- helpers ----------

/** How this copy of crossexam should be invoked by agents and configs. */
function selfCommands() {
  const self = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  // Published on npm as "crossexamdev" (the bare name was taken).
  if (/\/_npx\/|\/node_modules\/crossexamdev\//.test(self)) return { cli: 'npx -y crossexamdev', server: ['npx', '-y', 'crossexamdev', 'mcp'] };
  return { cli: `node "${self}"`, server: ['node', self, 'mcp'] };
}

function parseSince(v) {
  if (v === 'all' || v === true) return 0;
  const m = String(v).match(/^(\d+)\s*([hdw])$/);
  if (!m) return 0;
  const ms = { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2]];
  return Date.now() - Number(m[1]) * ms;
}

function ledger(claims) {
  try {
    const dir = path.join(os.homedir(), '.crossexam');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'ledger.jsonl'), claims.map((x) => JSON.stringify(x)).join('\n') + '\n');
  } catch {
    /* history is best effort */
  }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
  });
}

// A declaration, not a const: the commands above run at module top level
// before a const down here would be initialised.
function indent(s, p) {
  return s.split('\n').map((l) => p + l).join('\n');
}
