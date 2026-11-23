// crossexam.upload/v1: what a run would send to crossexam cloud.
//
// This module only builds and checks the payload. It never opens a network
// connection: sending arrives with crossexam cloud, and `crossexam upload
// --dry-run` shows exactly what would leave, so nothing is a surprise later.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { agentOf } from './github.js';
import { scrubText } from './redact.js';

export const UPLOAD_KIND = 'crossexam.upload/v1';
export const LIMITS = { excerpt: 2048, text: 600, code: 400, claims: 100, mutants: 500, files: 300, payloadBytes: 2 * 1024 * 1024 };
const VERDICTS = ['verified', 'contradicted', 'stale', 'unbacked', 'review'];
const STATUSES = ['MUTATION_KILLED', 'MUTATION_SURVIVED', 'MUTATION_INVALID', 'MUTATION_UNRESOLVED'];
const RATINGS = ['strong', 'moderate', 'weak', 'inconclusive'];
export const SOURCE_POLICIES = ['changed-lines', 'none'];

const cap = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A stable id for a surviving mutant that outlives line shifts: the same
 * change to the same code in the same function gets the same fingerprint, so
 * a triage decision ("equivalent", "accepted") carries over between runs.
 */
export function mutantFingerprint(m) {
  const firstLine = String(m.before ?? '').split('\n')[0].replace(/\s+/g, ' ').trim();
  return createHash('sha256').update([m.file, m.function ?? '', m.operator, m.original ?? '', m.replacement ?? '', firstLine].join('\u0000')).digest('hex').slice(0, 32);
}

/** The GitHub Actions run this is part of, from the runner's environment. Null outside Actions. */
export function githubContext(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_REPOSITORY) return null;
  let pr = null;
  try {
    const ev = env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : null;
    const p = ev?.pull_request;
    if (p) {
      pr = {
        number: p.number,
        title: p.title || '',
        author: p.user?.login || '',
        headSha: p.head?.sha || null,
        headRef: p.head?.ref || null,
        baseRef: p.base?.ref || null,
        fork: !!(p.head?.repo && p.base?.repo && p.head.repo.full_name !== p.base.repo.full_name),
        agent: agentOf(p.user?.login || '', p.body || ''),
      };
    }
  } catch {
    /* an unreadable event file leaves pr empty, it doesn't stop the run */
  }
  const int = (v) => (v && /^\d+$/.test(v) ? Number(v) : null);
  return {
    repositoryId: int(env.GITHUB_REPOSITORY_ID),
    repositoryOwnerId: int(env.GITHUB_REPOSITORY_OWNER_ID),
    repository: env.GITHUB_REPOSITORY,
    runId: int(env.GITHUB_RUN_ID),
    runAttempt: int(env.GITHUB_RUN_ATTEMPT) ?? 1,
    event: env.GITHUB_EVENT_NAME || null,
    sha: env.GITHUB_SHA || null,
    ref: env.GITHUB_REF || null,
    pr,
  };
}

/** Tell the two kinds of saved report apart. */
export function classifyReport(j) {
  if (j && j.kind === 'crossexam.mutation/v1') return { verify: null, mutation: j };
  if (j && Array.isArray(j.results)) return { verify: j, mutation: j.strength ?? null };
  throw new Error('not a crossexam report: expected `crossexam verify --json` or `crossexam mutate --json` output');
}

/**
 * Build the payload from a verify result and/or a mutation report.
 * Every string is scrubbed (paths made relative to `root`, home folder to ~,
 * other absolute paths dropped, secrets redacted) and capped.
 */
export function buildPayload({ verify = null, mutation = null, github = null, agent, cliVersion, root, sourcePolicy = 'changed-lines', now = new Date() } = {}) {
  if (!verify && !mutation) throw new Error('nothing to upload: pass a verify result or a mutation report');
  if (!SOURCE_POLICIES.includes(sourcePolicy)) throw new Error(`source policy must be one of ${SOURCE_POLICIES.join(', ')}`);
  const t = (s, n = LIMITS.text) => cap(scrubText(s, root), n);
  const code = sourcePolicy !== 'none';

  const claims = (verify?.results ?? []).slice(0, LIMITS.claims).map((r) => ({
    kind: String(r.kind),
    claim: t(r.claim),
    verdict: VERDICTS.includes(r.verdict) ? r.verdict : 'review',
    reason: t(r.reason),
    command: r.evidence?.command ? t(r.evidence.command, 300) : null,
    exitCode: num(r.evidence?.exitCode),
    excerpt: r.evidence?.excerpt ? t(r.evidence.excerpt, LIMITS.excerpt) : null,
  }));

  let mut = null;
  if (mutation) {
    const s = mutation.summary ?? {};
    mut = {
      scope: t(mutation.scope, 200),
      base: t(mutation.base, 80),
      testCommand: t(mutation.testCommand, 300),
      isolation: { method: mutation.isolation?.method ?? null, sandboxed: !!mutation.isolation?.sandboxed },
      rating: RATINGS.includes(mutation.rating) ? mutation.rating : 'inconclusive',
      blocker: mutation.blocker ? t(mutation.blocker) : null,
      summary: {
        attempted: num(s.attempted) ?? 0,
        killed: num(s.killed) ?? 0,
        survived: num(s.survived) ?? 0,
        invalid: num(s.invalid) ?? 0,
        unresolved: num(s.unresolved) ?? 0,
        remaining: num(s.remaining) ?? 0,
        score: num(s.score),
        ms: num(s.ms),
      },
      files: (mutation.files ?? []).slice(0, LIMITS.files).map((f) => ({
        file: t(f.file, 300),
        language: f.language ?? null,
        changedLines: Array.isArray(f.changedLines) ? f.changedLines.length : num(f.changedLines) ?? 0,
        mutants: num(f.mutants) ?? 0,
        sha256: typeof f.sha256 === 'string' ? f.sha256 : null,
      })),
      mutants: (mutation.mutants ?? []).slice(0, LIMITS.mutants).map((m) => ({
        fingerprint: mutantFingerprint(m),
        file: t(m.file, 300),
        line: num(m.line),
        col: num(m.col),
        function: m.function ? t(m.function, 120) : null,
        operator: String(m.operator),
        status: STATUSES.includes(m.status) ? m.status : 'MUTATION_UNRESOLVED',
        why: m.why ? t(m.why) : null,
        ms: num(m.ms),
        // the changed code itself only travels when the project allows it
        original: code ? t(m.original, LIMITS.code) : null,
        replacement: code ? t(m.replacement, LIMITS.code) : null,
        before: code && m.before ? t(m.before, LIMITS.code) : null,
        after: code && m.after ? t(m.after, LIMITS.code) : null,
      })),
      execution: mutation.execution
        ? { mutantsGenerated: num(mutation.execution.mutantsGenerated), mutantsPlanned: num(mutation.execution.mutantsPlanned), testRuns: num(mutation.execution.testRuns), durationMs: num(mutation.execution.durationMs), gitUnchanged: mutation.execution.gitUnchanged ?? null }
        : null,
    };
  }

  const payload = {
    kind: UPLOAD_KIND,
    cli: String(cliVersion),
    createdAt: now.toISOString(),
    sourcePolicy,
    repository: github?.repository ?? (mutation?.repo ? t(mutation.repo, 200) : null),
    github: github
      ? {
          repositoryId: github.repositoryId,
          repositoryOwnerId: github.repositoryOwnerId,
          repository: github.repository,
          runId: github.runId,
          runAttempt: github.runAttempt,
          event: github.event,
          sha: github.sha,
          ref: github.ref,
          pr: github.pr ? { number: github.pr.number, title: t(github.pr.title, 300), author: github.pr.author, headSha: github.pr.headSha, headRef: github.pr.headRef, baseRef: github.pr.baseRef, fork: github.pr.fork } : null,
        }
      : null,
    agent: agent || github?.pr?.agent || 'unknown',
    claims,
    mutation: mut,
  };
  const size = Buffer.byteLength(JSON.stringify(payload));
  if (size > LIMITS.payloadBytes) throw new Error(`payload is ${size} bytes, over the ${LIMITS.payloadBytes}-byte limit; run fewer mutants (--max) or use --source none`);
  return payload;
}

/**
 * Check a payload against crossexam.upload/v1 (docs/upload.schema.json).
 * Returns a list of problems; empty means valid. Cloud runs the same checks.
 */
export function validatePayload(p) {
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  const str = (v) => typeof v === 'string';
  const optStr = (v) => v === null || v === undefined || typeof v === 'string';
  const optNum = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));
  need(p && typeof p === 'object', 'payload must be an object');
  if (errs.length) return errs;
  need(p.kind === UPLOAD_KIND, `kind must be ${UPLOAD_KIND}`);
  need(str(p.cli), 'cli must be a string');
  need(str(p.createdAt) && !Number.isNaN(Date.parse(p.createdAt)), 'createdAt must be an ISO date');
  need(SOURCE_POLICIES.includes(p.sourcePolicy), 'sourcePolicy is not recognised');
  need(optStr(p.repository), 'repository must be a string or null');
  need(str(p.agent), 'agent must be a string');
  need(Array.isArray(p.claims) && p.claims.length <= LIMITS.claims, `claims must be an array of at most ${LIMITS.claims}`);
  for (const [i, c] of (p.claims ?? []).entries()) {
    need(str(c.kind) && str(c.claim), `claims[${i}] needs kind and claim`);
    need(VERDICTS.includes(c.verdict), `claims[${i}].verdict is not recognised`);
    need(optNum(c.exitCode), `claims[${i}].exitCode must be a number or null`);
    need(!c.excerpt || c.excerpt.length <= LIMITS.excerpt + 1, `claims[${i}].excerpt is too long`);
  }
  if (p.github !== null && p.github !== undefined) {
    need(str(p.github.repository), 'github.repository is required');
    need(optNum(p.github.repositoryId) && optNum(p.github.runId), 'github ids must be numbers');
  }
  if (p.mutation !== null && p.mutation !== undefined) {
    const m = p.mutation;
    need(RATINGS.includes(m.rating), 'mutation.rating is not recognised');
    need(m.summary && ['attempted', 'killed', 'survived', 'invalid', 'unresolved'].every((k) => typeof m.summary[k] === 'number'), 'mutation.summary needs the counts');
    need(m.summary?.score === null || (typeof m.summary?.score === 'number' && m.summary.score >= 0 && m.summary.score <= 1), 'mutation.summary.score must be 0..1 or null');
    need(Array.isArray(m.mutants) && m.mutants.length <= LIMITS.mutants, `mutation.mutants must be an array of at most ${LIMITS.mutants}`);
    for (const [i, x] of (m.mutants ?? []).entries()) {
      need(/^[0-9a-f]{32}$/.test(x.fingerprint ?? ''), `mutants[${i}].fingerprint is malformed`);
      need(str(x.file) && str(x.operator), `mutants[${i}] needs file and operator`);
      need(STATUSES.includes(x.status), `mutants[${i}].status is not recognised`);
      if (p.sourcePolicy === 'none') need(x.before == null && x.after == null && x.original == null && x.replacement == null, `mutants[${i}] carries code under source policy none`);
    }
  }
  need(p.claims?.length || p.mutation, 'payload has neither claims nor a mutation report');
  // nothing that looks like a local absolute path may travel
  const leak = JSON.stringify(p).match(/(?:[A-Za-z]:\\\\|\/(?:home|Users|root)\/[^"\s/]+)/);
  need(!leak, `payload contains a local path (${leak?.[0]})`);
  return errs;
}
