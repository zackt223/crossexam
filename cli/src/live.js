// Live verification: check claims against the repo as it is right now.
//
// This is the agent-agnostic path. It needs nothing but the text an agent
// wrote ("all tests pass, build is clean, renamed getUserById everywhere")
// and a working copy, so it works for any agent, editor, CI job or PR bot.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectClaims } from './claims.js';
import { excerpt, judgeRun } from './evidence.js';

const CONFIG_FILES = ['crossexam.json', '.crossexam.json'];

/** Optional per-repo overrides: { "commands": { "tests": "pnpm test:unit", "migration": "prisma migrate status" }, "timeoutSeconds": 300 } */
export function loadConfig(cwd) {
  for (const f of CONFIG_FILES) {
    const p = path.join(cwd, f);
    if (fs.existsSync(p)) {
      try {
        return { ...JSON.parse(fs.readFileSync(p, 'utf8')), file: f };
      } catch (e) {
        throw new Error(`${f} is not valid JSON: ${e.message}`);
      }
    }
  }
  return {};
}

const read = (cwd, f) => {
  try {
    return fs.readFileSync(path.join(cwd, f), 'utf8');
  } catch {
    return null;
  }
};
const has = (cwd, f) => fs.existsSync(path.join(cwd, f));

/**
 * Which command backs each kind of claim in this repo.
 * @returns {Record<'tests'|'build'|'types'|'lint'|'migration', {command: string, source: string} | undefined>}
 */
export function detectCommands(cwd, config = loadConfig(cwd)) {
  const out = {};
  const set = (kind, command, source) => {
    if (command && !out[kind]) out[kind] = { command, source };
  };
  for (const [k, v] of Object.entries(config.commands || {})) set(k, v, config.file);

  const pkgRaw = read(cwd, 'package.json');
  if (pkgRaw) {
    let scripts = {};
    try {
      scripts = JSON.parse(pkgRaw).scripts || {};
    } catch {}
    const pm = has(cwd, 'pnpm-lock.yaml') ? 'pnpm' : has(cwd, 'yarn.lock') ? 'yarn' : has(cwd, 'bun.lockb') || has(cwd, 'bun.lock') ? 'bun' : 'npm';
    const run = (s) => (pm === 'npm' && s === 'test' ? 'npm test' : `${pm} run ${s}`);
    if (scripts.test && !/no test specified/.test(scripts.test)) set('tests', run('test'), 'package.json');
    if (scripts.build) set('build', run('build'), 'package.json');
    const typeScript = ['typecheck', 'type-check', 'check-types', 'types', 'tsc'].find((s) => scripts[s]);
    if (typeScript) set('types', run(typeScript), 'package.json');
    if (scripts.lint) set('lint', run('lint'), 'package.json');
    if (has(cwd, 'tsconfig.json') && has(cwd, 'node_modules/.bin/tsc')) set('types', 'npx --no-install tsc --noEmit', 'tsconfig.json');
  }

  const pyproject = read(cwd, 'pyproject.toml') || '';
  if (pyproject || has(cwd, 'pytest.ini') || has(cwd, 'setup.cfg') || has(cwd, 'requirements.txt')) {
    if (/\[tool\.pytest|pytest/.test(pyproject) || has(cwd, 'pytest.ini') || has(cwd, 'tests') || has(cwd, 'conftest.py')) set('tests', 'python -m pytest -q', 'python project');
    if (/\[tool\.ruff/.test(pyproject) || has(cwd, 'ruff.toml')) set('lint', 'ruff check .', 'ruff config');
    if (/\[tool\.mypy/.test(pyproject) || has(cwd, 'mypy.ini')) set('types', 'mypy .', 'mypy config');
    if (/\[tool\.pyright/.test(pyproject) || has(cwd, 'pyrightconfig.json')) set('types', 'pyright', 'pyright config');
  }
  if (has(cwd, 'go.mod')) {
    set('tests', 'go test ./...', 'go.mod');
    set('build', 'go build ./...', 'go.mod');
    set('types', 'go vet ./...', 'go.mod');
  }
  if (has(cwd, 'Cargo.toml')) {
    set('tests', 'cargo test', 'Cargo.toml');
    set('build', 'cargo build', 'Cargo.toml');
    set('types', 'cargo check', 'Cargo.toml');
    set('lint', 'cargo clippy -- -D warnings', 'Cargo.toml');
  }
  if (has(cwd, 'Gemfile') && (has(cwd, 'spec') || has(cwd, '.rspec'))) set('tests', 'bundle exec rspec', 'Gemfile');
  if (has(cwd, 'mix.exs')) set('tests', 'mix test', 'mix.exs');
  if (has(cwd, 'gradlew')) set('tests', process.platform === 'win32' ? 'gradlew.bat test' : './gradlew test', 'gradlew');
  else if (has(cwd, 'pom.xml')) set('tests', 'mvn -q test', 'pom.xml');
  // Migrations touch a database, so they only run when the repo names a
  // read-only status command in crossexam.json.
  return out;
}

/** Run a shell command without blocking the event loop (the MCP server keeps answering pings). */
export function runCommand(command, { cwd, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, windowsHide: true });
    let output = '';
    const keep = (d) => {
      output += d;
      if (output.length > 400000) output = output.slice(-200000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      output += `\n[crossexam] timed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ command, exitCode: code ?? 1, output, isError: code !== 0 });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ command, exitCode: 127, output: String(e.message), isError: true });
    });
  });
}

export function runCommandSync(command, { cwd, timeoutMs = 300000 } = {}) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, windowsHide: true });
  return { command, exitCode: r.status ?? 1, output: (r.stdout || '') + (r.stderr || ''), isError: r.status !== 0 };
}

/** Where the old name still appears. null = can't tell (no git). */
export function grepRepo(cwd, sym, to) {
  try {
    const out = execFileSync('git', ['grep', '-n', '-w', '-I', '--', sym], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 << 20 });
    return out.split('\n').filter((l) => l && (!to || !l.includes(to))).slice(0, 50);
  } catch (e) {
    if (e.status === 1) return [];
    return null;
  }
}

/** The version a manifest pins for a package, across ecosystems. */
export function manifestVersion(cwd, pkg) {
  const pj = read(cwd, 'package.json');
  if (pj) {
    try {
      const j = JSON.parse(pj);
      const v = j.dependencies?.[pkg] || j.devDependencies?.[pkg] || j.peerDependencies?.[pkg] || j.optionalDependencies?.[pkg];
      if (v) return { version: v, file: 'package.json' };
    } catch {}
  }
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const probes = [
    ['requirements.txt', new RegExp(`^${esc}\\s*(?:\\[[^\\]]*\\])?\\s*[=<>~!]=?\\s*([\\w.*-]+)`, 'im')],
    ['pyproject.toml', new RegExp(`["']?${esc}["']?\\s*(?:=\\s*["'][\\^~>=<]*|[=<>~!]=?\\s*)v?(\\d[\\w.]*)`, 'i')],
    ['Cargo.toml', new RegExp(`^${esc}\\s*=\\s*(?:\\{[^}]*version\\s*=\\s*)?["'][\\^~=]*([\\w.-]+)`, 'im')],
    ['go.mod', new RegExp(`${esc}\\s+v(\\d[\\w.+-]*)`, 'i')],
    ['Gemfile', new RegExp(`gem\\s+["']${esc}["']\\s*,\\s*["'][~>=<\\s]*([\\w.]+)`, 'i')],
  ];
  for (const [file, re] of probes) {
    const m = (read(cwd, file) || '').match(re);
    if (m) return { version: m[1], file };
  }
  return null;
}

export function versionMatches(found, claimed) {
  const f = String(found).replace(/^[\^~>=<v\s]+/, '');
  const c = String(claimed).replace(/^v/, '');
  // "3.23.8" matches "^3.23.8" and "3.23.8"; a claim of "3.23" matches "3.23.8".
  return f === c || f.startsWith(c + '.') || c.startsWith(f + '.') || f.startsWith(c);
}

/**
 * Verify free text against the working copy.
 * @param {string} text  what the agent said
 * @param {{cwd: string, run?: boolean, timeoutMs?: number, agent?: string, onRun?: (cmd: string) => void}} opts
 */
export async function verifyText(text, opts) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const config = loadConfig(cwd);
  const commands = detectCommands(cwd, config);
  const timeoutMs = opts.timeoutMs ?? (config.timeoutSeconds ? config.timeoutSeconds * 1000 : 300000);
  const ran = new Map();
  const runOnce = (cmd) => {
    if (!ran.has(cmd)) {
      opts.onRun?.(cmd);
      ran.set(cmd, runCommand(cmd, { cwd, timeoutMs }));
    }
    return ran.get(cmd);
  };

  // One verdict per claim kind and subject; the agent's last word wins.
  const seen = new Map();
  for (const c of detectClaims(text)) seen.set(c.kind + (c.subject?.from || c.subject?.pkg || ''), c);

  const results = [];
  for (const c of seen.values()) {
    const v = await judgeLive(c, { cwd, commands, run: opts.run !== false, runOnce });
    results.push({ kind: c.kind, claim: c.sentence, subject: c.subject, ...v });
  }
  return { cwd, commands, results, ok: !results.some((r) => r.verdict === 'contradicted') };
}

async function judgeLive(c, { cwd, commands, run, runOnce }) {
  if (c.kind === 'security') return { verdict: 'review', reason: 'Security fixes always go to a human reviewer.', evidence: null };

  if (c.kind === 'refactor') {
    const sym = c.subject?.from;
    if (!sym) return { verdict: 'review', reason: 'No symbol named in the claim (put it in `backticks`), so there is nothing to search for.', evidence: null };
    const hits = grepRepo(cwd, sym, c.subject?.to);
    if (hits === null) return { verdict: 'review', reason: 'Not a git repository, so the old name could not be searched.', evidence: null };
    const ev = { command: `git grep -nw ${sym}`, exitCode: hits.length ? 0 : 1, excerpt: hits.slice(0, 8).join('\n') };
    return hits.length
      ? { verdict: 'contradicted', reason: `\`${sym}\` is still referenced in ${hits.length} place${hits.length === 1 ? '' : 's'}.`, evidence: ev }
      : { verdict: 'verified', reason: `No references to \`${sym}\` remain.`, evidence: ev };
  }

  if (c.kind === 'deps') {
    const { pkg, version } = c.subject || {};
    if (!pkg || !version) return { verdict: 'review', reason: 'Could not tell which package and version were claimed.', evidence: null };
    const found = manifestVersion(cwd, pkg);
    if (!found) return { verdict: 'review', reason: `${pkg} isn't in any manifest crossexam reads.`, evidence: null };
    const ev = { command: `read ${found.file}`, exitCode: 0, excerpt: `${pkg} ${found.version}` };
    return versionMatches(found.version, version)
      ? { verdict: 'verified', reason: `${found.file} has ${pkg} at ${found.version}.`, evidence: ev }
      : { verdict: 'contradicted', reason: `Claimed ${pkg} ${version}, but ${found.file} still has ${found.version}.`, evidence: ev };
  }

  const cmd = commands[c.kind]?.command;
  if (!cmd) {
    const hint = c.kind === 'migration' ? 'crossexam never touches your database on its own. Add a read-only status command to crossexam.json, e.g. {"commands": {"migration": "npx prisma migrate status"}}.' : `No ${c.kind} command found. Add one to crossexam.json under "commands".`;
    return { verdict: 'review', reason: hint, evidence: null };
  }
  if (!run) return { verdict: 'review', reason: `Would run \`${cmd}\` (dry run).`, evidence: { command: cmd, exitCode: null, excerpt: '' } };

  const res = await runOnce(cmd);
  const j = judgeRun(res);
  const ev = { command: cmd, exitCode: res.exitCode, excerpt: excerpt(res.output), rerun: true };
  if (j.status === 'fail') return { verdict: 'contradicted', reason: `Ran \`${cmd}\` just now: ${j.why}.`, evidence: ev };
  return { verdict: 'verified', reason: `Ran \`${cmd}\` just now and it passed.`, evidence: ev };
}
