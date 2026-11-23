#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSession } from '../src/analyze.js';
import { detectWorkClaims } from '../src/claims.js';
import { emitActions, readPullRequest } from '../src/github.js';
import { globalSnippets, runInit } from '../src/init.js';
import { detectCommands, verifyText } from '../src/live.js';
import { formatForAgent, startMcpServer } from '../src/mcp.js';
import { discoverAider, discoverMore } from '../src/readers.js';
import { buildReport, c, printReport, printStrength } from '../src/report.js';
import { assessStrength, ledgerRecord, qualityOf, strengthHistory, toCsv, withoutSource } from '../src/strength.js';
import { AGENTS, defaultSources, findTranscripts, readSession } from '../src/transcripts.js';
import { SOURCE_POLICIES, buildPayload, classifyReport, githubContext, validatePayload } from '../src/upload.js';

const VERSION = '0.3.0';
const HELP = `
  ${c.bold('crossexam')} — cross-examine what your coding agents claim

  ${c.bold('Works with any agent')}
    crossexam verify "<summary>"   check any agent's "done" message against the repo right now
    crossexam mcp                  MCP server: any MCP agent calls verify_claims before it says done
    crossexam init [--mcp]         add the rule to AGENTS.md (and MCP configs) so agents check themselves
    crossexam verify --github      in CI: check the claims in an agent's pull request description

  ${c.bold('Test strength')}
    crossexam mutate               plant small defects in the changed code and see if the tests notice
    crossexam verify --mutate      verify claims, then grade how strong the tests behind them are

  ${c.bold('Cloud')} (not open yet: nothing is ever sent today)
    crossexam upload --dry-run --report <file>
                                   show exactly what a run would send to crossexam cloud: paths made
                                   relative, secrets redacted. --source none leaves code lines out

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
    --mutate                       also assess test strength when tests or finished work are claimed

  ${c.bold('mutate')}
    --base <ref>                   compare against this ref       (default: uncommitted changes, else HEAD~1)
    --files <a.ts,b.js>            mutate these files, every line, instead of the diff
    --max <n>                      mutants to run this time       (default 25; finished ones are cached)
    --budget <seconds>             stop starting new mutants after this long (default 300)
    --isolation <auto|bwrap|sandbox-exec|docker>
                                   sandbox for the test runs      (default auto: the first one that works here;
                                                                   refuses to run if none does)
    --unsandboxed                  run without a sandbox, with your own permissions (code you trust only)
    --test-command <cmd>           the oracle                     (default: the repo's test command)
    --no-cache                     ignore cached results
    --json [out.json] / --csv <f>  write the full report (secret-looking values are redacted)
    --no-source                    leave code lines out of the report
    --agent <name>                 record which agent made the change, for history
    --fail-under <0-1>             exit 1 when the mutation score is below this

  ${c.bold('upload')}
    --dry-run                      build and check the payload, print it, send nothing
    --report <file>                a report saved with verify --json or mutate --json (repeatable)
    --source <changed-lines|none>  include the changed code lines, or none of them (default changed-lines)
    --agent <name>                 which agent made the change (otherwise taken from the pr)
    --out <file>                   write the payload to a file instead of stdout

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

const VALUED = new Set(['report', 'source', 'out', 'since', 'agent', 'repo', 'file', 'json', 'limit', 'path', 'cwd', 'fail-on', 'timeout', 'base', 'files', 'max', 'budget', 'isolation', 'test-command', 'csv', 'fail-under']);
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
  else if (cmd === 'mutate') await mutate();
  else if (cmd === 'upload') upload();
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
  // Test strength from earlier `mutate` / `verify --mutate` / MCP runs: a separate dimension.
  const mutation = strengthHistory({ since, agent: typeof onlyAgent === 'string' ? onlyAgent : undefined, repo: typeof onlyRepo === 'string' ? onlyRepo : undefined });
  if (mutation) report.mutation = mutation;
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

  if (flag('mutate') && wantsStrength(text, r)) {
    if (!json) process.stderr.write(c.dim('  assessing test strength (planting defects in an isolated copy)…\n'));
    const strength = await assessStrength({ cwd, ...mutateOpts(), onProgress: json ? undefined : progress });
    attachStrength(r, strength);
    ledger([ledgerRecord(strength, { agent: pr?.agent || String(opt('agent', 'unknown')), claim: r.results.find((x) => x.kind === 'tests')?.claim ?? null, source: github ? 'github' : 'verify' })]);
  }

  if (json) process.stdout.write(JSON.stringify({ ...r, pr }, null, 2) + '\n');
  else if (github) emitActions(pr, r);
  else {
    console.log();
    console.log(formatForAgent(r).replace(/^/gm, '  '));
    if (r.strength) printStrength(r.strength, { limit: 4 });
    if (!r.results.length && Object.keys(r.commands).length) console.log(c.dim(`\n  Checks available here: ${Object.entries(r.commands).map(([k, v]) => `${k} (${v.command})`).join(', ')}`));
    console.log();
  }
  if (opt('fail-on', 'contradicted') !== 'none' && !r.ok) process.exitCode = 1;
}

/**
 * What a run would send to crossexam cloud. Cloud isn't open yet, so this only
 * ever builds, checks and prints the payload; it has no way to send it.
 */
function upload() {
  if (!flag('dry-run')) {
    process.stderr.write("crossexam cloud isn't open yet, so there is nowhere to send this and nothing was sent.\nRun with --dry-run to see exactly what a run would send.\n");
    process.exitCode = 2;
    return;
  }
  const files = opts('report');
  if (!files.length) throw new Error('upload --dry-run needs --report <file>: save one with `crossexam verify "…" --json > verify.json` or `crossexam mutate --json mutate.json`.');
  let verify = null;
  let mutation = null;
  for (const f of files) {
    const got = classifyReport(JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')));
    verify = got.verify ?? verify;
    mutation = got.mutation ?? mutation;
  }
  const source = String(opt('source', 'changed-lines'));
  if (!SOURCE_POLICIES.includes(source)) throw new Error(`--source must be one of ${SOURCE_POLICIES.join(', ')}`);
  const agent = opt('agent');
  const payload = buildPayload({
    verify,
    mutation,
    github: githubContext(),
    agent: typeof agent === 'string' ? agent : undefined,
    cliVersion: VERSION,
    root: path.resolve(String(opt('cwd', verify?.cwd || process.cwd()))),
    sourcePolicy: source,
  });
  const errors = validatePayload(payload);
  if (errors.length) throw new Error(`the payload failed its own checks:\n  ${errors.join('\n  ')}`);
  const text = JSON.stringify(payload, null, 2);
  const out = opt('out');
  if (typeof out === 'string') {
    fs.writeFileSync(out, text + '\n');
    process.stderr.write(`dry run: ${Buffer.byteLength(text)} bytes written to ${out}. nothing was sent.\n`);
  } else {
    process.stdout.write(text + '\n');
    process.stderr.write(`dry run: ${Buffer.byteLength(text)} bytes. nothing was sent.\n`);
  }
}

async function mutate() {
  const cwd = path.resolve(String(opt('cwd', process.cwd())));
  const json = opt('json');
  const toStdout = json === true;
  const full = await assessStrength({ cwd, ...mutateOpts(), onProgress: toStdout ? undefined : progress });
  const r = flag('no-source') ? withoutSource(full) : full;
  ledger([ledgerRecord(r, { agent: String(opt('agent', 'unknown')), source: 'mutate' })]);
  const csv = opt('csv');
  if (typeof csv === 'string') fs.writeFileSync(csv, toCsv(r));
  if (toStdout) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    if (typeof json === 'string') fs.writeFileSync(json, JSON.stringify(r, null, 2));
    printStrength(r, { limit: Number(opt('limit', 8)) });
    if (typeof json === 'string') console.log(`  ${c.dim('Report written to')} ${path.resolve(json)}\n`);
  }
  const under = opt('fail-under');
  if (under !== undefined && r.summary.score != null && r.summary.score < Number(under)) process.exitCode = 1;
}

function mutateOpts() {
  const files = opts('files').flatMap((f) => f.split(',')).filter(Boolean);
  const str = (k) => (typeof opt(k) === 'string' ? String(opt(k)) : undefined);
  const num = (k) => (typeof opt(k) === 'string' ? Number(opt(k)) : undefined);
  const unsandboxed = flag('unsandboxed');
  return { base: str('base'), files: files.length ? files : undefined, max: num('max'), budgetSeconds: num('budget'), isolation: str('isolation') || (unsandboxed ? 'none' : undefined), allowUnsandboxed: unsandboxed, testCommand: str('test-command'), cache: !flag('no-cache') };
}

function progress(e) {
  if (!process.stderr.isTTY) return;
  if (e.phase === 'copy') process.stderr.write(c.dim(`  copying the repo to a temporary folder; tests will run ${e.isolation?.sandboxed ? 'sandboxed (' + e.isolation.method + ')' : 'NOT SANDBOXED'}…\n`));
  else if (e.phase === 'baseline') process.stderr.write(c.dim('  running the unmutated test suite (baseline)…\n'));
  else if (e.phase === 'mutant') {
    const st = { MUTATION_KILLED: c.green('killed    '), MUTATION_SURVIVED: c.red('survived  '), MUTATION_INVALID: c.gray('invalid   '), MUTATION_UNRESOLVED: c.yellow('unresolved') }[e.status];
    process.stderr.write(c.dim(`  [${String(e.i).padStart(2)}/${e.total}] `) + st + c.dim(` ${e.mutant.file}:${e.mutant.line} ${e.mutant.operator}${e.cached ? ' (cached)' : ''}\n`));
  }
}

/** Only grade test strength when someone claimed tests pass or that work was done. */
function wantsStrength(text, r) {
  return r.results.some((x) => x.kind === 'tests') || detectWorkClaims(text).length > 0;
}

/** Quality rides alongside the verdict; it never changes it. */
function attachStrength(r, strength) {
  r.strength = strength;
  const q = qualityOf(strength);
  for (const x of r.results) if (x.kind === 'tests') x.quality = q;
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
    const dir = (process.env.CROSSEXAM_HOME || path.join(os.homedir(), '.crossexam'));
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
