// Test strength: would the repo's tests notice if the changed code were wrong?
//
// Plants deterministic defects (mutate.js) in the lines an agent changed, runs
// the repo's own test command against each one inside an isolated copy
// (sandbox.js), and reports which defects the tests caught and which survived.
//
// This is a quality dimension, kept apart from factual verification: a
// "tests pass" claim can be verified (they did pass) and still be weak
// evidence (they would also have passed with a bug in place).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { excerpt, judgeRun } from './evidence.js';
import { redact, tildify } from './redact.js';
import { detectCommands, loadConfig } from './live.js';
import { JS_EXT, TEST_FILE, applyMutant, classifyFile, explain, generateMutants, prioritize } from './mutate.js';
import { allowlistedEnv, chooseIsolation, clampLimits, createCopy, describeIsolation, fingerprint, gitState, git as gitRead, isInside, projectFiles, runIsolated, scrubbedEnv, sha, sweepStaleCopies } from './sandbox.js';

export const STATUS = /** @type {const} */ ({
  KILLED: 'MUTATION_KILLED',
  SURVIVED: 'MUTATION_SURVIVED',
  INVALID: 'MUTATION_INVALID',
  UNRESOLVED: 'MUTATION_UNRESOLVED',
});

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0';
  }
})();

// Output that means the mutant broke compilation, not behaviour.
// Case-sensitive on purpose: vitest prints assertion failures as
// "Error: expected 5 to be 7", which must count as a kill, not a compile error.
const INVALID_SIG = /\bSyntaxError\b|Transform failed|\bUnexpected token\b|ERROR: Expected "[^"\n]*" but found|\berror TS\d{3,5}\b|Failed to parse source|\bParseError\b|is not a valid (?:JavaScript|TypeScript)/;

const git = gitRead; // read-only subcommands, GIT_OPTIONAL_LOCKS=0
const tryGit = (cwd, args) => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};

/** Pick the comparison base when none was given. */
export function resolveBase(cwd, base) {
  if (base) return { base, label: `vs ${base}` };
  if (process.env.GITHUB_BASE_REF) {
    const mb = tryGit(cwd, ['merge-base', 'HEAD', `origin/${process.env.GITHUB_BASE_REF}`]);
    if (mb) return { base: mb.trim(), label: `vs origin/${process.env.GITHUB_BASE_REF}` };
  }
  const dirty = tryGit(cwd, ['status', '--porcelain', '--', '.']);
  if (dirty === null) return { base: null, label: 'not a git repository' };
  if (dirty.trim()) return { base: 'HEAD', label: 'uncommitted changes vs HEAD' };
  if (tryGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD~1'])) return { base: 'HEAD~1', label: 'last commit (HEAD~1..HEAD)' };
  // A shallow clone (CI's default fetch-depth: 1) has no parent to diff
  // against; falling through to "initial commit" would mutate every file.
  if ((tryGit(cwd, ['rev-parse', '--is-shallow-repository']) || '').trim() === 'true') {
    return { base: null, label: 'shallow clone: no base to compare against (use fetch-depth: 0, or pass --base)' };
  }
  // A repo with a single commit: that commit is the change.
  const empty = tryGit(cwd, ['hash-object', '-t', 'tree', process.platform === 'win32' ? 'NUL' : '/dev/null']);
  if (empty && tryGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])) return { base: empty.trim(), label: 'initial commit' };
  return { base: null, label: 'no commits yet' };
}

/** Changed lines per file, relative to cwd. null = every line (new or explicitly named file). */
export function changedLines(cwd, base) {
  const out = new Map();
  if (!base) return out;
  const diff = tryGit(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--relative', base, '--']) || '';
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(6).trim();
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) {
      const start = Number(h[1]);
      const n = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = 0; i < n; i++) out.get(file).add(start + i);
    }
  }
  for (const f of (tryGit(cwd, ['ls-files', '-o', '--exclude-standard']) || '').split('\n').filter(Boolean)) out.set(f, null);
  for (const [f, set] of out) if (set && !set.size) out.delete(f);
  return out;
}

/** Test files that import a changed module or mention a changed function. */
export function associatedTests(cwd, files, fnNames) {
  const tests = projectFiles(cwd).filter((f) => TEST_FILE.test(f) && JS_EXT.test(f));
  const names = [...new Set(fnNames)].filter((n) => n && n.length >= 4);
  const mods = files.map((f) => {
    const base = path.basename(f).replace(/\.[^.]+$/, '');
    const key = base === 'index' ? path.basename(path.dirname(f)) : base;
    return { f, re: new RegExp(`['"\`][^'"\`\\n]*[/.]${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.[cm]?[jt]sx?)?['"\`]`) };
  });
  const nameRe = names.length ? new RegExp(`\\b(?:${names.map((n) => n.replace(/[$]/g, '\\$')).join('|')})\\b`) : null;
  const hits = [];
  for (const t of tests.slice(0, 3000)) {
    let text;
    try {
      text = fs.readFileSync(path.join(cwd, t), 'utf8');
    } catch {
      continue;
    }
    if (text.length > 1 << 20) continue;
    const imports = mods.filter((m) => m.re.test(text)).map((m) => m.f);
    const mentions = nameRe ? [...new Set(text.match(new RegExp(nameRe.source, 'g')) || [])] : [];
    if (imports.length || mentions.length) hits.push({ file: t, imports, mentions });
  }
  return { tests, associated: hits };
}

// ---------- cache ----------

function cacheFile(cwd) {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {}
  return path.join(process.env.CROSSEXAM_HOME || path.join(os.homedir(), '.crossexam'), 'mutation-cache', sha(real.toLowerCase()).slice(0, 16) + '.json');
}
function loadCache(cwd) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(cwd), 'utf8'));
  } catch {
    return { entries: {} };
  }
}
function saveCache(cwd, cache) {
  try {
    const keys = Object.keys(cache.entries);
    if (keys.length > 5000) for (const k of keys.sort((a, b) => cache.entries[a].at.localeCompare(cache.entries[b].at)).slice(0, keys.length - 5000)) delete cache.entries[k];
    const f = cacheFile(cwd);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(cache));
  } catch {
    /* the cache is an optimisation */
  }
}

// ---------- the run ----------

const HARD = { max: 500, budgetSeconds: 3600, mutantTimeoutSeconds: 600 };
const clampNum = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d;
};

/**
 * @param {{
 *   cwd: string, base?: string, files?: string[], max?: number, budgetSeconds?: number,
 *   isolation?: 'auto'|'bwrap'|'sandbox-exec'|'docker'|'none', allowUnsandboxed?: boolean,
 *   testCommand?: string, cache?: boolean,
 *   onProgress?: (e: {phase: string, i?: number, total?: number, mutant?: object, status?: string, ms?: number}) => void
 * }} opts
 */
export async function assessStrength(opts) {
  const t0 = Date.now();
  const cwd = path.resolve(opts.cwd || process.cwd());
  const config = loadConfig(cwd);
  const mc = config.mutation || {};
  const max = clampNum(opts.max ?? mc.maxMutants, 0, HARD.max, 25);
  const budgetMs = clampNum(opts.budgetSeconds ?? mc.budgetSeconds, 1, HARD.budgetSeconds, 300) * 1000;
  const limits = clampLimits(mc.limits);
  const notes = [];
  const testCommand = opts.testCommand || mc.testCommand || detectCommands(cwd, config).tests?.command || null;

  // Isolation is decided first, and a repository's own config can't weaken it.
  const allowUnsandboxed = opts.allowUnsandboxed === true || process.env.CROSSEXAM_ALLOW_UNSANDBOXED === '1';
  const iso = chooseIsolation({ requested: opts.isolation || mc.isolation || 'auto', allowUnsandboxed, fromRepoConfig: !opts.isolation && !!mc.isolation });
  notes.push(...iso.notes);

  // 1. Scope: which lines changed. Named files must stay inside the repo.
  let scope;
  let baseInfo;
  const skipped = [];
  if (opts.files?.length) {
    scope = new Map();
    for (const f of opts.files) {
      const abs = path.resolve(cwd, f);
      const rel = path.relative(cwd, abs).split(path.sep).join('/');
      let st = null;
      try {
        st = fs.lstatSync(abs);
      } catch {}
      if (rel.startsWith('..') || path.isAbsolute(rel) || !isInside(cwd, abs)) skipped.push({ file: String(f), reason: 'outside the repository: refused' });
      else if (st?.isSymbolicLink()) skipped.push({ file: rel, reason: 'a symbolic link: refused' });
      else scope.set(rel, null);
    }
    baseInfo = { base: null, label: `named files (${opts.files.length})` };
  } else {
    baseInfo = resolveBase(cwd, opts.base || mc.base);
    scope = changedLines(cwd, baseInfo.base);
  }

  const files = [];
  for (const [f, lines] of scope) {
    const cls = classifyFile(f);
    const abs = path.join(cwd, f);
    if (!cls.ok) {
      if (!cls.quiet) skipped.push({ file: f, reason: cls.reason });
    } else if (!fs.existsSync(abs)) skipped.push({ file: f, reason: 'deleted' });
    else if (fs.lstatSync(abs).isSymbolicLink() || !isInside(cwd, abs)) skipped.push({ file: f, reason: 'a symbolic link: refused' });
    else files.push({ file: f, lines, language: cls.language });
  }

  // 2–4. Mutants, functions, associated tests.
  const all = [];
  const originals = new Map();
  for (const f of files) {
    const src = fs.readFileSync(path.join(cwd, f.file), 'utf8');
    originals.set(f.file, src);
    const ms = generateMutants(f.file, src, f.lines);
    f.sha256 = sha(src);
    f.changedLines = f.lines ? f.lines.size : src.split('\n').length;
    f.mutants = ms.length;
    all.push(...ms);
  }
  const queue = prioritize(all);
  const fnNames = [...new Set(all.map((m) => m.function).filter(Boolean))];
  const { tests, associated } = associatedTests(cwd, files.map((f) => f.file), fnNames);

  const report = {
    kind: 'crossexam.mutation/v1',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    cwd: tildify(cwd),
    repo: repoName(cwd),
    scope: baseInfo.label,
    base: baseInfo.base,
    isolation: iso.method ? describeIsolation(iso.method, { ...limits, timeoutMs: 0 }) : { method: null, sandboxed: false },
    testCommand,
    files: files.map(({ file, language, changedLines, mutants, sha256 }) => ({ file, language, changedLines, mutants, sha256 })),
    skippedFiles: skipped,
    associatedTests: associated,
    baseline: null,
    mutants: [],
    functions: [],
    summary: null,
    headline: null,
    rating: 'inconclusive',
    blocker: null,
    remaining: 0,
    workingTreeUntouched: null,
    execution: { repository: repoName(cwd), mutantsGenerated: all.length, mutantsPlanned: queue.length, testRuns: 0, staleCopiesRemoved: 0, cleanup: { status: 'not needed' } },
    notes,
  };
  const block = (text) => {
    report.blocker = text;
    notes.unshift(text);
  };
  const finish = () => {
    summarise(report, t0);
    report.execution.durationMs = Date.now() - t0;
    return report;
  };

  if (!files.length) {
    block(scope.size ? 'No changed JavaScript or TypeScript source to mutate (only tests, config, other languages, or refused paths).' : `Nothing changed (${baseInfo.label}).`);
    return finish();
  }
  if (!queue.length) {
    block('The changed lines contain no operators crossexam mutates yet (comparisons, conditions, arithmetic, booleans, logic).');
    return finish();
  }
  if (!testCommand) {
    block('No test command found. Add one to crossexam.json: {"mutation": {"testCommand": "npm test"}} or {"commands": {"tests": "…"}}.');
    report.remaining = queue.length;
    return finish();
  }
  if (!iso.method) {
    block(iso.refused);
    report.remaining = queue.length;
    return finish();
  }

  // 5. A disposable copy; prove the working tree and git state are left alone.
  report.execution.staleCopiesRemoved = sweepStaleCopies(cwd).length;
  const watch = [...new Set([...projectFiles(cwd)])];
  const before = fingerprint(cwd, watch);
  const gitBefore = gitState(cwd);
  const removedEnv = iso.method === 'none' ? scrubbedEnv().removed : allowlistedEnv().removed;
  if (removedEnv.length) notes.push(`${removedEnv.length} environment variable${removedEnv.length === 1 ? ' was' : 's were'} withheld from the test runs${iso.method === 'none' ? ' (credential-like names)' : ' (sandboxed runs get an allowlist only)'}.`);
  opts.onProgress?.({ phase: 'copy', isolation: report.isolation });
  const copy = createCopy(cwd, { linkDeps: iso.method !== 'docker' });
  if (copy.skippedLinks.length) notes.push(`${copy.skippedLinks.length} tracked symbolic link${copy.skippedLinks.length === 1 ? '' : 's'} pointing outside the repository ${copy.skippedLinks.length === 1 ? 'was' : 'were'} not copied: ${copy.skippedLinks.slice(0, 3).join(', ')}.`);
  const onSig = () => {
    copy.dispose();
    process.exit(130);
  };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);
  const run = (command, timeoutMs) => {
    report.execution.testRuns++;
    return runIsolated(command, { copy, cwd: copy.dir, timeoutMs, method: iso.method, limits, docker: mc.docker || {} });
  };

  try {
    // 6. Baseline: a red suite can't detect anything.
    opts.onProgress?.({ phase: 'baseline' });
    const baseTimeout = clampNum(config.timeoutSeconds, 10, HARD.mutantTimeoutSeconds, 300) * 1000;
    report.isolation.limits.timeoutSeconds = Math.round(baseTimeout / 1000);
    const b = await run(testCommand, baseTimeout);
    const bj = judgeRun({ ...b, command: testCommand });
    report.baseline = { exitCode: b.exitCode, ms: b.ms, timedOut: b.timedOut, excerpt: b.exitCode === 0 ? '' : redact(excerpt(b.output)) };
    if (b.exitCode !== 0 || b.timedOut) {
      const sandboxHint = iso.method !== 'none' ? ' Inside the sandbox there is no network, no home directory and no credentials; a suite that needs them fails here.' : '';
      block(b.timedOut ? `The unmutated test suite timed out after ${Math.round(baseTimeout / 1000)}s, so no mutant could be judged.` : `The unmutated test suite fails (\`${testCommand}\` exited ${b.exitCode}), so no mutant could be judged.${sandboxHint}`);
      report.remaining = queue.length;
      return finish();
    }
    const exitOnly = bj.status === 'fail'; // noisy-but-passing suites: trust the exit code alone
    const baselineInvalid = INVALID_SIG.test(b.output);
    const perTimeout = Math.min(Math.max(b.ms * 3 + 5000, 10000), clampNum(mc.mutantTimeoutSeconds, 5, HARD.mutantTimeoutSeconds, 120) * 1000);
    report.isolation.limits.timeoutSeconds = Math.round(perTimeout / 1000);
    const deadline = t0 + budgetMs;

    // 7–8. Run each mutant.
    const useCache = opts.cache !== false && mc.cache !== false;
    const cache = useCache ? loadCache(cwd) : { entries: {} };
    const testHash = sha(tests.map((t) => `${t}:${before[t] ?? ''}`).join('|'));
    let executed = 0;
    let i = 0;
    for (const m of queue) {
      i++;
      const src = originals.get(m.file);
      const key = sha([VERSION, testCommand, iso.method, sha(src), m.id, m.replacement, testHash].join('\0'));
      const hit = cache.entries[key];
      if (hit) {
        report.mutants.push(record(m, hit.status, hit.why, hit.ms, true));
        opts.onProgress?.({ phase: 'mutant', i, total: queue.length, mutant: m, status: hit.status, cached: true });
        continue;
      }
      if (executed >= max || Date.now() + perTimeout > deadline) {
        report.remaining++;
        continue;
      }
      executed++;
      const target = path.join(copy.dir, m.file);
      // The copy is crossexam's own: refuse to write anywhere else, even if a
      // test replaced a folder in the copy with a link while it ran.
      if (!isInside(copy.root, path.dirname(target)) || (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())) {
        throw new Error(`Refusing to write ${m.file}: its path in the copy now leads outside the copy.`);
      }
      const mutated = applyMutant(src, m);
      let status;
      let why;
      let ms = 0;
      try {
        fs.writeFileSync(target, mutated);
        if (/\.[cm]?js$/i.test(m.file)) {
          // Parse only, never execute: node --check compiles and exits.
          const chk = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
          if (chk.status !== 0) {
            status = STATUS.INVALID;
            why = 'the mutant is not valid syntax';
          }
        }
        if (!status) {
          const r = await run(testCommand, perTimeout);
          ms = r.ms;
          if (r.spawnError) [status, why] = [STATUS.UNRESOLVED, `could not start the tests: ${r.spawnError}`];
          else if (r.timedOut) [status, why] = [STATUS.UNRESOLVED, `timed out after ${Math.round(perTimeout / 1000)}s (the defect may loop forever); not counted as caught`];
          else if (r.signal) [status, why] = [STATUS.UNRESOLVED, `the test process was killed by ${r.signal} (a resource limit); not counted as caught`];
          else {
            const failed = exitOnly ? r.exitCode !== 0 : r.exitCode !== 0 || judgeRun({ ...r, command: testCommand }).status === 'fail';
            if (failed && !baselineInvalid && INVALID_SIG.test(r.output)) [status, why] = [STATUS.INVALID, 'the mutant did not compile or load'];
            else if (failed) [status, why] = [STATUS.KILLED, redact(firstFailure(r))];
            else [status, why] = [STATUS.SURVIVED, explain(m)];
          }
        }
      } finally {
        // Restore and prove it, before the next mutant touches anything.
        fs.writeFileSync(target, src);
        if (sha(fs.readFileSync(target, 'utf8')) !== sha(src)) throw new Error(`Could not restore ${m.file} in the isolated copy; stopping.`);
      }
      if (status !== STATUS.UNRESOLVED) cache.entries[key] = { status, why, ms, at: new Date().toISOString() };
      report.mutants.push(record(m, status, why, ms, false));
      opts.onProgress?.({ phase: 'mutant', i, total: queue.length, mutant: m, status, ms });
    }
    if (useCache) saveCache(cwd, cache);
    if (report.remaining) notes.push(`${report.remaining} more mutant${report.remaining === 1 ? '' : 's'} not run this time (--max ${max} / --budget ${Math.round(budgetMs / 1000)}s). Run again to continue: finished mutants are cached.`);
  } finally {
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
    const cleaned = copy.dispose();
    report.execution.cleanup = cleaned.removed ? { status: 'removed' } : { status: 'incomplete', path: cleaned.path, reason: cleaned.reason };
    if (!cleaned.removed) notes.push(`The temporary copy could not be fully removed (${cleaned.reason}). It is at ${cleaned.path}; nothing in it is linked to your repo's files except read-only dependency links.`);
    const after = fingerprint(cwd, watch);
    const gitAfter = gitState(cwd);
    const treeSame = watch.every((f) => before[f] === after[f]);
    const gitSame = ['head', 'refs', 'stash', 'status'].every((k) => gitBefore[k] === gitAfter[k]);
    report.workingTreeUntouched = treeSame && gitSame;
    report.execution.gitUnchanged = gitSame;
    if (!report.workingTreeUntouched) notes.push('The working tree or git state changed during the run. crossexam only writes inside its temporary copy, so something else (an editor, a watcher, the agent) changed it.');
  }
  return finish();
}

export { redact };

/** A report without code lines, for sharing outside the team. */
export function withoutSource(report) {
  return {
    ...report,
    baseline: report.baseline ? { ...report.baseline, excerpt: '' } : null,
    mutants: report.mutants.map(({ before, after, ...m }) => ({ ...m, before: undefined, after: undefined, why: m.status === STATUS.KILLED ? '' : m.why })),
  };
}

function record(m, status, why, ms, cached) {
  return {
    id: m.id,
    file: m.file,
    line: m.line,
    col: m.col,
    function: m.function,
    functionLine: m.functionLine,
    operator: m.operator,
    original: m.original,
    replacement: m.replacement,
    before: redact(m.before),
    after: redact(m.after),
    status,
    why,
    ms,
    cached,
  };
}

function firstFailure(r) {
  const j = judgeRun({ ...r, command: '' });
  const ex = excerpt(r.output, 240).split('\n').find((l) => /fail|error|assert|expected|✗|×|not ok/i.test(l));
  return (ex ? ex.trim() : j.why).slice(0, 200);
}

const repoName = (cwd) => {
  const url = tryGit(cwd, ['config', '--get', 'remote.origin.url']);
  const m = url && url.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : path.basename(cwd);
};

// ---------- summary ----------

// Survivors that say the most about missing tests come first.
const WEIGHT = { 'negate-condition': 6, boundary: 5, equality: 5, logical: 4, 'remove-not': 4, boolean: 3, arithmetic: 3, update: 2 };

function summarise(report, t0) {
  const n = (s) => report.mutants.filter((m) => m.status === s).length;
  const killed = n(STATUS.KILLED);
  const survived = n(STATUS.SURVIVED);
  const invalid = n(STATUS.INVALID);
  const unresolved = n(STATUS.UNRESOLVED);
  const attempted = report.mutants.length;
  const judged = killed + survived;
  report.summary = {
    attempted,
    valid: attempted - invalid,
    killed,
    survived,
    invalid,
    unresolved,
    remaining: report.remaining,
    score: judged ? Math.round((killed / judged) * 1000) / 1000 : null,
    ms: Date.now() - t0,
    cachedResults: report.mutants.filter((m) => m.cached).length,
  };

  const fns = new Map();
  for (const m of report.mutants) {
    const k = `${m.file}#${m.function ?? ''}`;
    if (!fns.has(k)) fns.set(k, { file: m.file, name: m.function, line: m.functionLine ?? m.line, killed: 0, survived: 0, invalid: 0, unresolved: 0 });
    const f = fns.get(k);
    f[{ [STATUS.KILLED]: 'killed', [STATUS.SURVIVED]: 'survived', [STATUS.INVALID]: 'invalid', [STATUS.UNRESOLVED]: 'unresolved' }[m.status]]++;
  }
  report.functions = [...fns.values()]
    .map((f) => ({ ...f, score: f.killed + f.survived ? Math.round((f.killed / (f.killed + f.survived)) * 1000) / 1000 : null }))
    .sort((a, b) => b.survived - a.survived || (a.score ?? 1) - (b.score ?? 1) || a.file.localeCompare(b.file));

  // Rating: only when there's enough to go on.
  const s = report.summary.score;
  report.rating = judged < 3 ? 'inconclusive' : s >= 0.8 ? 'strong' : s >= 0.6 ? 'moderate' : 'weak';

  const survivors = report.mutants.filter((m) => m.status === STATUS.SURVIVED);
  if (survivors.length) {
    const worstFn = report.functions[0];
    const pick = survivors
      .filter((m) => m.file === worstFn.file && m.function === worstFn.name)
      .sort((a, b) => (WEIGHT[b.operator] || 0) - (WEIGHT[a.operator] || 0) || a.line - b.line)[0];
    const where = pick.function ? `\`${pick.function}\` (${pick.file}:${pick.line})` : `${pick.file}:${pick.line}`;
    report.headline = {
      tone: report.rating === 'strong' ? 'note' : 'warn',
      text: `${survived} of ${judged} planted defects went unnoticed by the tests. Biggest gap: ${where}: ${pick.why.replace(/^In [^,]+, /, '').replace(/\.$/, '')}.`,
      mutant: pick.id,
    };
  } else if (judged) {
    report.headline = { tone: 'good', text: `The tests caught all ${killed} planted defect${killed === 1 ? '' : 's'} in the changed code.`, mutant: null };
  } else {
    report.headline = { tone: report.blocker ? 'warn' : 'note', text: report.blocker || 'No mutant could be judged.', mutant: null };
  }
}

/** A compact block to attach to a verified "tests pass" claim: a separate dimension, never a verdict. */
export function qualityOf(report) {
  const s = report.summary;
  return {
    dimension: 'test-strength',
    rating: report.rating,
    score: s.score,
    killed: s.killed,
    survived: s.survived,
    invalid: s.invalid,
    unresolved: s.unresolved,
    headline: report.headline?.text ?? null,
    warning: report.rating === 'weak' || report.rating === 'moderate' ? report.headline?.text ?? null : null,
  };
}

// ---------- exports ----------

export function toCsv(report) {
  const head = ['mutant_id', 'repo', 'file', 'line', 'function', 'operator', 'original', 'replacement', 'status', 'ms', 'cached', 'explanation'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const rows = report.mutants.map((m) => [m.id, report.repo, m.file, m.line, m.function ?? '', m.operator, m.original, m.replacement, m.status, m.ms, m.cached, m.why].map(esc).join(','));
  return [head.join(','), ...rows].join('\n') + '\n';
}

/** What goes into ~/.crossexam/ledger.jsonl, so history can show test strength per agent and repo. */
export function ledgerRecord(report, { agent = 'unknown', claim = null, source = 'cli' } = {}) {
  return {
    type: 'mutation',
    at: report.generatedAt,
    agent,
    repo: report.repo,
    source,
    claim,
    scope: report.scope,
    testCommand: report.testCommand,
    rating: report.rating,
    ...report.summary,
    survivors: report.mutants.filter((m) => m.status === STATUS.SURVIVED).slice(0, 20).map((m) => ({ id: m.id, function: m.function, operator: m.operator })),
  };
}

// ---------- history ----------

/**
 * Test strength over time, from the ledger. Kept beside, never blended into,
 * the factual false-done rates: an agent can be honest and still ship weak tests.
 */
export function strengthHistory({ since = 0, agent, repo, file = path.join(process.env.CROSSEXAM_HOME || path.join(os.homedir(), '.crossexam'), 'ledger.jsonl') } = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
  const runs = [];
  for (const l of lines) {
    if (!l.includes('"type":"mutation"')) continue;
    try {
      const r = JSON.parse(l);
      if (r.type !== 'mutation' || !(r.killed + r.survived)) continue;
      if (since && Date.parse(r.at) < since) continue;
      if ((agent && r.agent !== agent) || (repo && r.repo !== repo)) continue;
      runs.push(r);
    } catch {
      /* a torn line from a crash: skip it */
    }
  }
  if (!runs.length) return null;
  const group = (key) => {
    const m = {};
    for (const r of runs) {
      const k = r[key] || 'unknown';
      m[k] ??= { runs: 0, killed: 0, survived: 0, weakRuns: 0 };
      m[k].runs++;
      m[k].killed += r.killed;
      m[k].survived += r.survived;
      if (r.rating === 'weak') m[k].weakRuns++;
    }
    for (const v of Object.values(m)) v.score = Math.round((v.killed / (v.killed + v.survived)) * 1000) / 1000;
    return m;
  };
  const killed = runs.reduce((a, r) => a + r.killed, 0);
  const survived = runs.reduce((a, r) => a + r.survived, 0);
  return {
    runs: runs.length,
    killed,
    survived,
    score: Math.round((killed / (killed + survived)) * 1000) / 1000,
    byAgent: group('agent'),
    byRepo: group('repo'),
    recent: runs.slice(-20).reverse().map(({ at, agent, repo, rating, score, killed, survived, source, claim }) => ({ at, agent, repo, rating, score, killed, survived, source, claim })),
  };
}
