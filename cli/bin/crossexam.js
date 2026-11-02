#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSession } from '../src/analyze.js';
import { buildReport, c, printReport } from '../src/report.js';
import { defaultSources, findTranscripts, readSession } from '../src/transcripts.js';

const VERSION = '0.1.0';
const HELP = `
  ${c.bold('crossexam')} — cross-examine what your coding agents claim

  ${c.bold('Usage')}
    crossexam scan              check every local agent transcript from the last 30 days
    crossexam hook              Claude Code Stop hook: block a turn that ends on a false "done"
    crossexam install           add the Stop hook to ~/.claude/settings.json

  ${c.bold('scan options')}
    --since <30d|12h|all>       how far back to look              (default 30d)
    --agent <claude-code|codex> only one agent
    --repo <name>               only one repo
    --file <path.jsonl>         one transcript (agent from --agent, default claude-code)
    --json [out.json]           write the full report; open it in the dashboard
    --limit <n>                 false "done"s to print            (default 8)

  ${c.bold('hook / install options')}
    --rerun                     re-run the test command before trusting a "tests pass"
    --project                   install into ./.claude/settings.json instead
    --dry-run                   print the settings change, write nothing
`;

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'scan';
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

try {
  if (flag('help') || cmd === 'help') process.stdout.write(HELP + '\n');
  else if (flag('version') || cmd === 'version') console.log(VERSION);
  else if (cmd === 'scan') await scan();
  else if (cmd === 'hook') await hook();
  else if (cmd === 'install') install();
  else {
    process.stderr.write(`Unknown command "${cmd}".\n${HELP}\n`);
    process.exitCode = 2;
  }
} catch (e) {
  // A verifier must never take the agent down with it.
  process.stderr.write(`crossexam: ${e?.stack || e}\n`);
  process.exitCode = cmd === 'hook' ? 0 : 1;
}

async function scan() {
  const since = parseSince(opt('since', '30d'));
  const onlyAgent = opt('agent');
  const onlyRepo = opt('repo');
  const single = opt('file');

  let files = [];
  if (typeof single === 'string') files = [{ agent: typeof onlyAgent === 'string' ? onlyAgent : 'claude-code', file: path.resolve(single) }];
  else for (const src of defaultSources()) if (!onlyAgent || onlyAgent === src.agent) for (const f of findTranscripts(src.root, since)) files.push({ agent: src.agent, file: f });

  const claims = [];
  let turns = 0;
  let ranCheckTurns = 0;
  let contradictedTurns = 0;
  let sessions = 0;
  for (const { agent, file } of files) {
    const s = await readSession(agent, file);
    if (onlyRepo && s.repo !== onlyRepo) continue;
    if (!s.turns.length) continue;
    sessions++;
    const r = analyzeSession(s);
    turns += r.turns;
    ranCheckTurns += r.ranCheckTurns;
    contradictedTurns += new Set(r.claims.filter((x) => x.verdict === 'contradicted').map((x) => x.turn)).size;
    claims.push(...r.claims);
  }

  const report = buildReport(claims, { sessions, turns, ranCheckTurns, contradictedTurns, since: since ? new Date(since).toISOString() : null });
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
  const self = fileURLToPath(import.meta.url);
  const viaNpx = /[\\/]_npx[\\/]/.test(self);
  const command = (viaNpx ? 'npx -y crossexam hook' : `node "${self.replace(/\\/g, '/')}" hook`) + (flag('rerun') ? ' --rerun' : '');

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
