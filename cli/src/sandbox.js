// Where mutants run: never in the user's working tree, and never with the
// user's full permissions unless the user explicitly says so.
//
// Two layers, kept separate on purpose:
//
//   1. A disposable copy of the checkout, next to the repo, that crossexam
//      writes and deletes. This protects the working tree and git state.
//      A copy is NOT a security boundary.
//   2. An isolation backend that runs the test command against that copy:
//        bwrap         Linux: read-only system, hidden homes, no network
//        sandbox-exec  macOS: writes confined to the copy, home unreadable, no network
//        docker        any OS with a Linux container engine: no network, limits, read-only root
//        none          explicit opt-in only: a scrubbed environment and a timeout, nothing more
//
// `auto` picks the first backend that passes a live probe. If none does,
// crossexam refuses to run mutants rather than silently running them unsandboxed.
// See docs/mutation-security.md for the threat model.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEP_DIRS = new Set(['node_modules', '.venv', 'venv', '.yarn', '.pnpm-store']);
const OUTPUT_CAP = 200000;
const COPY_TAG = '.crossexam-mut-';
const MANIFEST = '.crossexam-copy.json';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- environment ----------

// Anything that looks like a credential stays out of the test process.
const SECRET_ENV = /(?:TOKEN|SECRET|PASSW(?:OR)?D|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH|SESSION|COOKIE|SIGNING|WEBHOOK|DSN|CONNECTION_STRING|DATABASE_URL)/i;
const SECRET_PREFIX = /^(?:AWS_|AZURE_|GCP_|GOOGLE_APPLICATION|GH_|GITHUB_TOKEN|NPM_CONFIG__AUTH|NODE_AUTH|ANTHROPIC_|OPENAI_|STRIPE_|SUPABASE_|VERCEL_|NETLIFY_|HEROKU_|DIGITALOCEAN_|CLOUDFLARE_|TWILIO_|SENDGRID_|SLACK_|SSH_AUTH_SOCK|GPG_AGENT)/i;
// State a parent test runner leaves behind. NODE_TEST_CONTEXT makes a nested
// `node --test` report to a parent that isn't listening and always exit 0.
const RUNNER_STATE = /^(?:NODE_TEST_CONTEXT|NODE_TEST_|VITEST|VITEST_|JEST_WORKER_ID|NODE_UNIQUE_ID|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE)/;
const FIXED = { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', CROSSEXAM_MUTATION: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

/** Unsandboxed runs: the user's environment minus anything credential-like. */
export function scrubbedEnv(base = process.env) {
  const env = {};
  const removed = [];
  for (const [k, v] of Object.entries(base)) {
    if (SECRET_ENV.test(k) || SECRET_PREFIX.test(k)) removed.push(k);
    else if (!RUNNER_STATE.test(k)) env[k] = v;
  }
  Object.assign(env, FIXED);
  return { env, removed };
}

// Sandboxed runs get a short allowlist and nothing else.
const ALLOW_ENV = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'SHELL', 'USER', 'LOGNAME', 'SystemRoot', 'PATHEXT', 'COMSPEC', 'WINDIR'];
export function allowlistedEnv(base = process.env, extra = {}) {
  const env = {};
  for (const k of ALLOW_ENV) if (base[k] != null) env[k] = base[k];
  const removed = Object.keys(base).filter((k) => !(k in env));
  return { env: { ...env, ...FIXED, ...extra }, removed };
}

// ---------- git (read-only, lock-free) ----------

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20, env: GIT_ENV });
}

/** Files that make up the project: tracked plus untracked-but-not-ignored. */
export function projectFiles(cwd) {
  try {
    return git(cwd, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  } catch {
    // Not a git repo: walk it without following links, skipping heavy folders.
    const out = [];
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git' || DEP_DIRS.has(e.name) || /^(?:dist|build|coverage|\.next)$/.test(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (e.isFile() || e.isSymbolicLink()) out.push(r);
      }
    };
    walk(cwd, '');
    return out;
  }
}

/** Ignored dependency folders (node_modules, .venv…) at any depth, not nested inside each other. */
function dependencyDirs(cwd) {
  let dirs = [];
  try {
    dirs = git(cwd, ['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z']).split('\0').filter(Boolean);
  } catch {
    dirs = fs.readdirSync(cwd).map((n) => n + '/');
  }
  return dirs
    .map((d) => d.replace(/\/$/, ''))
    .filter((d) => DEP_DIRS.has(d.split('/').pop()) && !d.split('/').slice(0, -1).some((p) => DEP_DIRS.has(p)))
    .filter((d) => {
      try {
        // A real directory only: a dependency "folder" that is itself a link
        // could point anywhere.
        return fs.lstatSync(path.join(cwd, d)).isDirectory();
      } catch {
        return false;
      }
    });
}

/** Is `p` (after resolving links) inside `root`? */
export function isInside(root, p) {
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    real = path.resolve(p);
  }
  let r = root;
  try {
    r = fs.realpathSync(root);
  } catch {}
  const rel = path.relative(r, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------- the copy ----------

/**
 * Make a disposable copy of the whole checkout (tests import across packages,
 * configs extend the root, workspaces hoist dependencies), next to the repo so
 * config lookups walk up through the same parents the real repo has.
 * @returns {{dir: string, root: string, rel: string, top: string, depDirs: string[], skippedLinks: string[], files: number, dispose: () => {removed: boolean, path: string}}}
 */
function realPath(p) {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

export function createCopy(cwd, { linkDeps = true, copyDir } = {}) {
  // Resolve both ends fully: git reports the real path (macOS /private/var,
  // Windows long names), and a relative path between a real and an aliased
  // form would climb out of the copy and land back in the user's repo.
  cwd = realPath(cwd);
  let top = cwd;
  try {
    top = realPath(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  } catch {
    /* not a git repo: the folder itself is the root */
  }
  const rel = path.relative(top, cwd);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Cannot place ${cwd} inside its checkout ${top}; refusing to make a copy.`);
  const root = makeCopyDir(top, copyDir);
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), source: top }));
  let result = null;
  const dispose = () => {
    if (result) return result;
    process.removeListener('exit', dispose);
    result = safeRemove(root);
    return result;
  };
  process.once('exit', dispose);

  const depDirs = [];
  const skippedLinks = [];
  try {
    const files = projectFiles(top);
    for (const f of files) {
      const from = path.join(top, f);
      const to = path.join(root, f);
      const back = path.relative(root, to);
      if (!back || back.startsWith('..') || path.isAbsolute(back)) continue; // never write outside the copy
      let st;
      try {
        st = fs.lstatSync(from);
      } catch {
        continue; // deleted while we were copying
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (st.isSymbolicLink()) {
        // Recreate a tracked link only if it stays inside the repo; a link to
        // ~/.ssh/id_rsa must not become readable from the copy.
        const target = fs.readlinkSync(from);
        const resolved = path.resolve(path.dirname(from), target);
        if (!path.isAbsolute(target) && isInside(top, resolved)) {
          try {
            fs.symlinkSync(target, to);
          } catch {
            skippedLinks.push(f); // e.g. Windows without symlink privilege
          }
        } else skippedLinks.push(f);
      } else if (st.isFile()) fs.copyFileSync(from, to);
    }
    if (linkDeps) {
      for (const d of dependencyDirs(top)) {
        const to = path.join(root, d);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.symlinkSync(path.join(top, d), to, process.platform === 'win32' ? 'junction' : 'dir');
        depDirs.push(d);
      }
    } else depDirs.push(...dependencyDirs(top));
    // An empty home and temp dir for the tests, inside the copy.
    fs.mkdirSync(path.join(root, '.crossexam-home'), { recursive: true });
    fs.mkdirSync(path.join(root, '.crossexam-tmp'), { recursive: true });
    return { dir: path.join(root, rel), root, rel, top, depDirs, skippedLinks, files: files.length, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

// The copy sits next to the repo, not in the system temp folder: tools walk up
// the directory tree for config (package.json, tsconfig, babel, vite…), and a
// copy under ~/AppData/Local/Temp would see the home directory's files instead
// of the ones the real repo sees. Hidden, uniquely named, removed afterwards.
function makeCopyDir(top, copyDir) {
  const parents = copyDir ? [path.resolve(copyDir)] : [path.dirname(top), os.tmpdir()];
  for (const parent of parents) {
    try {
      return fs.mkdtempSync(path.join(parent, `.${path.basename(top)}${COPY_TAG}`));
    } catch {
      /* not writable: try the next place */
    }
  }
  throw new Error('Could not create an isolated copy next to the repository or in the temp directory.');
}

/**
 * Delete a copy without ever following a link out of it: every symlink and
 * junction is unlinked first (lstat sees junctions as links), then the rest
 * is removed. If any link refuses to go, nothing else is deleted.
 */
export function safeRemove(root) {
  const links = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) links.push(p);
      else if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  for (const l of links) {
    try {
      fs.unlinkSync(l);
    } catch {
      try {
        fs.rmdirSync(l); // a junction on some Windows versions
      } catch {
        /* checked below */
      }
    }
  }
  if (links.some((l) => exists(l))) return { removed: false, path: root, reason: 'a link inside the copy could not be removed safely' };
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    return { removed: false, path: root, reason: e.message };
  }
  return { removed: !exists(root), path: root };
}

/** Remove copies left by runs that crashed or were killed (their owner process is gone). */
export function sweepStaleCopies(cwd) {
  let top = realPath(cwd);
  try {
    top = realPath(git(cwd, ['rev-parse', '--show-toplevel']).trim());
  } catch {}
  const prefix = `.${path.basename(top)}${COPY_TAG}`;
  const removed = [];
  for (const parent of new Set([path.dirname(top), os.tmpdir()])) {
    let names = [];
    try {
      names = fs.readdirSync(parent).filter((n) => n.startsWith(prefix));
    } catch {
      continue;
    }
    for (const n of names) {
      const root = path.join(parent, n);
      let stale = false;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
        stale = !alive(m.pid) || Date.now() - Date.parse(m.createdAt) > 24 * 3600e3;
        if (stale) stopOrphans(m);
      } catch {
        // No manifest: created by a run that died before writing it, if it's old enough.
        try {
          stale = Date.now() - fs.statSync(root).mtimeMs > 3600e3;
        } catch {}
      }
      if (stale && safeRemove(root).removed) removed.push(root);
    }
  }
  return removed;
}

function updateManifest(root, patch) {
  try {
    const f = path.join(root, MANIFEST);
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch }));
  } catch {
    /* best effort */
  }
}

/**
 * Stop test processes a crashed run left behind. Only where it can be done
 * without risking someone else's process: a uniquely named container, or a
 * POSIX process group crossexam created. On Windows a bare pid may already
 * belong to another program, so the copy is left for a later sweep instead.
 */
function stopOrphans(m) {
  if (m.container) spawnSync(containerEngine() || 'docker', ['kill', m.container], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  if (m.child && m.posixGroup && process.platform !== 'win32' && Date.now() - Date.parse(m.startedAt || 0) < 24 * 3600e3) {
    try {
      process.kill(-m.child, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// ---------- isolation backends ----------

const probeCache = new Map();
const probe = (name, fn) => {
  if (!probeCache.has(name)) {
    let ok = false;
    try {
      ok = fn();
    } catch {
      ok = false;
    }
    probeCache.set(name, ok);
  }
  return probeCache.get(name);
};

/** Which backends actually work here, checked by running them, not by looking for binaries. */
export function availableBackends() {
  const out = [];
  if (process.platform === 'linux' && probe('bwrap', () => spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--die-with-parent', '--dev', '/dev', '--proc', '/proc', 'true'], { timeout: 10000, stdio: 'ignore' }).status === 0)) out.push('bwrap');
  if (process.platform === 'darwin' && probe('sandbox-exec', () => spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', '/usr/bin/true'], { timeout: 10000, stdio: 'ignore' }).status === 0)) out.push('sandbox-exec');
  const engine = containerEngine();
  if (engine) out.push('docker');
  return out;
}

function containerEngine() {
  return probe('container', () => {
    for (const bin of ['docker', 'podman']) {
      const r = spawnSync(bin, ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (r.status === 0 && /linux/i.test(r.stdout)) return bin;
    }
    return false;
  });
}

export const BACKENDS = ['auto', 'bwrap', 'sandbox-exec', 'docker', 'none'];

/**
 * Decide how to isolate. A repository's own config may ask for a stronger
 * backend but can never turn isolation off: only the human can, with
 * --unsandboxed or CROSSEXAM_ALLOW_UNSANDBOXED=1.
 * @returns {{method: string|null, sandboxed: boolean, refused?: string, notes: string[]}}
 */
export function chooseIsolation({ requested = 'auto', allowUnsandboxed = false, fromRepoConfig = false } = {}) {
  const notes = [];
  if (!BACKENDS.includes(requested)) return { method: null, sandboxed: false, refused: `Unknown isolation "${requested}". Use one of: ${BACKENDS.join(', ')}.`, notes };
  if (requested === 'none' && fromRepoConfig) {
    notes.push('crossexam.json asked for isolation "none"; a repository cannot turn the sandbox off, so it was ignored.');
    requested = 'auto';
  }
  if (requested === 'none') {
    if (!allowUnsandboxed) return { method: null, sandboxed: false, refused: 'Unsandboxed runs need --unsandboxed (or CROSSEXAM_ALLOW_UNSANDBOXED=1).', notes };
    return { method: 'none', sandboxed: false, notes };
  }
  const have = availableBackends();
  if (requested !== 'auto') {
    if (have.includes(requested)) return { method: requested, sandboxed: true, notes };
    return { method: null, sandboxed: false, refused: `Isolation "${requested}" is not available on this machine (its probe failed).${hint()}`, notes };
  }
  if (have.length) return { method: have[0], sandboxed: true, notes };
  if (allowUnsandboxed) {
    notes.push('No sandbox is available here; running unsandboxed because you allowed it.');
    return { method: 'none', sandboxed: false, notes };
  }
  return { method: null, sandboxed: false, refused: `No sandbox is available on this machine, so no mutant was run.${hint()} To run anyway with your own permissions (only for code you trust as much as running its tests yourself), pass --unsandboxed.`, notes };
}

function hint() {
  if (process.platform === 'linux') return ' Install bubblewrap (apt install bubblewrap); on Ubuntu 24.04+ unprivileged user namespaces must be allowed for it. Or use Docker/Podman.';
  if (process.platform === 'darwin') return ' /usr/bin/sandbox-exec did not work; Docker or Podman also works.';
  if (process.platform === 'win32') return ' Windows has no sandbox crossexam can drive without native code; Docker Desktop with Linux containers works.';
  return ' Docker or Podman works on any platform.';
}

/** Plain-language description of what a backend does and doesn't protect. */
export function describeIsolation(method, limits) {
  const d = {
    bwrap: { filesystem: 'system read-only; home, /run and /tmp hidden; only the copy is writable', network: 'none (separate network namespace)', processes: 'own pid namespace, killed with crossexam' },
    'sandbox-exec': { filesystem: 'writes only inside the copy; your home folder is unreadable except the copy, dependencies and toolchain', network: 'denied', processes: 'killed with crossexam' },
    docker: { filesystem: 'only the copy is mounted; dependencies read-only; read-only root', network: 'none (--network none)', processes: `pid limit ${limits.pids}, no capabilities, no new privileges` },
    none: { filesystem: 'NOT SANDBOXED: tests can read and write anything your user can', network: 'NOT SANDBOXED: your network', processes: 'killed on timeout' },
  }[method];
  return {
    method,
    sandboxed: method !== 'none',
    ...d,
    environment: method === 'none' ? 'your environment minus credential-like variables' : 'allowlist only (PATH, locale, CI flags); HOME is an empty folder',
    limits: {
      timeoutSeconds: Math.round(limits.timeoutMs / 1000),
      memoryMb: method === 'docker' || method === 'bwrap' ? limits.memoryMb : null,
      cpuSeconds: method === 'none' ? null : limits.cpuSeconds,
      cpus: method === 'docker' ? limits.cpus : null,
    },
  };
}

export const DEFAULT_LIMITS = { memoryMb: 4096, cpus: 2, pids: 512, cpuSeconds: 600 };
const clampLimits = (l = {}) => ({
  memoryMb: Math.min(Math.max(Number(l.memoryMb) || DEFAULT_LIMITS.memoryMb, 256), 16384),
  cpus: Math.min(Math.max(Number(l.cpus) || DEFAULT_LIMITS.cpus, 0.5), 16),
  pids: Math.min(Math.max(Number(l.pids) || DEFAULT_LIMITS.pids, 64), 4096),
  cpuSeconds: Math.min(Math.max(Number(l.cpuSeconds) || DEFAULT_LIMITS.cpuSeconds, 10), 3600),
});
export { clampLimits };

/** Toolchain folders that must stay readable in a sandbox (node from nvm, PATH entries under home). */
function toolchainDirs() {
  const home = os.homedir();
  const dirs = new Set([path.dirname(path.dirname(process.execPath))]);
  for (const p of (process.env.PATH || '').split(path.delimiter)) if (p && p.startsWith(home) && exists(p)) dirs.add(p);
  return [...dirs].filter((d) => d.startsWith(home));
}

/**
 * Run a shell command against the copy with a hard timeout that kills the
 * whole process tree.
 * @returns {Promise<{exitCode: number, output: string, ms: number, timedOut: boolean, spawnError?: string}>}
 */
export function runIsolated(command, { copy, cwd, timeoutMs, method, limits = DEFAULT_LIMITS, docker = {} }) {
  const lim = clampLimits(limits);
  const home = path.join(copy.root, '.crossexam-home');
  const tmp = path.join(copy.root, '.crossexam-tmp');
  const ulimits = `ulimit -t ${lim.cpuSeconds} 2>/dev/null; ${method === 'bwrap' ? `ulimit -d ${lim.memoryMb * 1024} 2>/dev/null; ` : ''}`;
  let file;
  let args;
  let env;
  let shell = false;
  let cleanup = () => {};

  if (method === 'none') {
    env = { ...scrubbedEnv().env, GIT_CEILING_DIRECTORIES: path.dirname(copy.root) };
    file = command;
    shell = true;
  } else if (method === 'bwrap') {
    env = allowlistedEnv(process.env, { HOME: home, TMPDIR: '/tmp', GIT_CEILING_DIRECTORIES: path.dirname(copy.root) }).env;
    const hide = ['/home', '/root', '/run', '/var/run', '/tmp', '/mnt', '/media', '/srv'].filter((p) => exists(p) && !fs.lstatSync(p).isSymbolicLink());
    const homeDir = os.homedir();
    args = ['--die-with-parent', '--new-session', '--unshare-all', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
    for (const h of hide) args.push('--tmpfs', h);
    if (!hide.some((h) => homeDir.startsWith(h + '/'))) args.push('--tmpfs', homeDir);
    for (const t of toolchainDirs()) args.push('--ro-bind', t, t);
    for (const d of copy.depDirs) args.push('--ro-bind', path.join(copy.top, d), path.join(copy.top, d));
    args.push('--bind', copy.root, copy.root, '--chdir', cwd, '--', '/bin/sh', '-c', ulimits + command);
    file = 'bwrap';
  } else if (method === 'sandbox-exec') {
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    const q = (p) => JSON.stringify(real(p));
    const readable = [copy.root, ...copy.depDirs.map((d) => path.join(copy.top, d)), ...toolchainDirs()];
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(allow network* (remote unix-socket))',
      '(deny file-write*)',
      `(allow file-write* (subpath ${q(copy.root)}) (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
      `(deny file-read* (subpath ${q(os.homedir())}) (subpath "/Volumes") (literal "/var/run/docker.sock") (literal "/private/var/run/docker.sock"))`,
      `(allow file-read* ${readable.map((p) => `(subpath ${q(p)})`).join(' ')} (literal ${q(os.homedir())}))`,
    ].join('\n');
    env = allowlistedEnv(process.env, { HOME: home, TMPDIR: tmp, GIT_CEILING_DIRECTORIES: path.dirname(copy.root) }).env;
    file = '/usr/bin/sandbox-exec';
    args = ['-p', profile, '/bin/sh', '-c', ulimits + command];
  } else if (method === 'docker') {
    const engine = containerEngine() || 'docker';
    const name = `crossexam-mut-${crypto.randomBytes(6).toString('hex')}`;
    const work = ['/work', ...(copy.rel ? copy.rel.split(path.sep) : [])].join('/');
    args = ['run', '--rm', '--name', name, '--network', 'none', '--memory', `${lim.memoryMb}m`, '--memory-swap', `${lim.memoryMb}m`, '--cpus', String(lim.cpus), '--pids-limit', String(lim.pids), '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,exec,size=512m', '-v', `${copy.root}:/work`, '-w', work, '-e', 'HOME=/work/.crossexam-home', '-e', 'TMPDIR=/tmp'];
    if (process.platform === 'linux' && process.getuid) args.push('--user', `${process.getuid()}:${process.getgid()}`);
    for (const d of copy.depDirs) args.push('-v', `${path.join(copy.top, d)}:/work/${d.split(path.sep).join('/')}:ro`);
    for (const [k, v] of Object.entries(FIXED)) args.push('-e', `${k}=${v}`);
    args.push(docker.image || 'node:22-bookworm-slim', 'sh', '-c', `ulimit -t ${lim.cpuSeconds} 2>/dev/null; ${command}`);
    file = engine;
    env = process.env; // the engine client's own environment; nothing is forwarded into the container
    cleanup = () => spawnSync(engine, ['kill', name], { stdio: 'ignore', windowsHide: true });
  } else {
    return Promise.resolve({ exitCode: 127, output: `unknown isolation ${method}`, ms: 0, timedOut: false, spawnError: `unknown isolation ${method}` });
  }

  return new Promise((resolve) => {
    const t0 = Date.now();
    const posix = process.platform !== 'win32';
    let child;
    try {
      child = spawn(file, args || [], { cwd, shell, env, windowsHide: true, detached: posix });
    } catch (e) {
      return resolve({ exitCode: 127, output: String(e.message), ms: 0, timedOut: false, spawnError: String(e.message) });
    }
    // If crossexam itself is killed mid-run, the next run's sweep needs to know
    // what was still running against this copy.
    const container = method === 'docker' ? args[args.indexOf('--name') + 1] : null;
    updateManifest(copy.root, { child: child.pid, posixGroup: posix, container, startedAt: new Date().toISOString() });
    let output = '';
    const keep = (d) => {
      output += d;
      if (output.length > OUTPUT_CAP * 2) output = output.slice(-OUTPUT_CAP);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cleanup();
      killTree(child.pid, posix);
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal && !timedOut) output += `\n[crossexam] the test process was killed by ${signal} (a resource limit was probably hit)`;
      resolve({ exitCode: code ?? 1, output, ms: Date.now() - t0, timedOut, signal: signal || null });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, output: String(e.message), ms: Date.now() - t0, timedOut: false, spawnError: String(e.message) });
    });
  });
}

function killTree(pid, posix) {
  if (!pid) return;
  try {
    if (posix) process.kill(-pid, 'SIGKILL');
    else spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

/** Hash files so we can prove the working tree came through untouched. */
export function fingerprint(cwd, files) {
  const out = {};
  for (const f of files) {
    try {
      out[f] = sha(fs.readFileSync(path.join(cwd, f)));
    } catch {
      out[f] = null;
    }
  }
  return out;
}

/** Git state that must not change: HEAD, every ref, the stash, the index. */
export function gitState(cwd) {
  const g = (args) => {
    try {
      return git(cwd, args);
    } catch {
      return null;
    }
  };
  const dir = g(['rev-parse', '--absolute-git-dir']);
  let index = null;
  try {
    index = dir ? sha(fs.readFileSync(path.join(dir.trim(), 'index'))) : null;
  } catch {}
  return { head: g(['rev-parse', 'HEAD']), refs: g(['for-each-ref', '--format=%(refname) %(objectname)']), stash: g(['stash', 'list']), status: g(['status', '--porcelain=v1', '-uall']), index };
}
