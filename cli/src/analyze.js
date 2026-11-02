// The verifier: line each claim up against what actually ran before it.
//
// Verdicts
//   verified      the most recent relevant check passed and nothing changed since
//   contradicted  the most recent relevant check failed, or a live re-check disagrees
//   stale         a check passed, then files were edited before the claim was made
//   unbacked      nothing that could back the claim ran at all
//   review        evidence exists but can't settle it (masked exit, subset run, security)

import { detectClaims, taskTypeOf } from './claims.js';
import { RUNNERS, SEARCH, excerpt, isEdit, judgeRun, runsCheck } from './evidence.js';
import { detectCommands, grepRepo, manifestVersion, runCommandSync, versionMatches } from './live.js';

/** Which runner families can back which claim kind. */
const BACKED_BY = {
  tests: ['tests'],
  build: ['build'],
  types: ['types', 'build'],
  lint: ['lint'],
  migration: ['migration'],
};

const SUBSET = /\s(?:[\w./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?|[\w./\\-]+_test\.(?:go|py)|[\w./\\-]*test_\w+\.py)\b|\s-t\s|\s--testNamePattern|\s--grep\s|\s-k\s|::\w|\s-run\s|\s--filter\b/;

/**
 * @param {object} session  normalised session from transcripts.js
 * @param {{live?: {cwd: string, rerun?: boolean, timeoutMs?: number}, onlyLastTurn?: boolean}} [opts]
 */
export function analyzeSession(session, opts = {}) {
  const claims = [];
  // One flat timeline so a claim can lean on a check from the previous turn
  // when nothing was edited in between ("tests still pass").
  const timeline = [];
  for (const t of session.turns) for (const it of t.items) timeline.push({ ...it, turn: t.index });

  const firstTurn = opts.onlyLastTurn ? session.turns.length - 1 : 0;
  let ranCheckTurns = 0;

  for (const t of session.turns.slice(Math.max(0, firstTurn))) {
    const startPos = timeline.findIndex((e) => e.turn === t.index);
    if (startPos < 0) continue;
    const turnItems = timeline.filter((e) => e.turn === t.index);
    if (turnItems.some((e) => e.kind === 'tool' && !e.denied && e.command && Object.keys(RUNNERS).some((f) => runsCheck(f, e.command)))) ranCheckTurns++;

    const seen = new Map();
    turnItems.forEach((item, k) => {
      if (item.kind !== 'text') return;
      const pos = startPos + k;
      for (const c of detectClaims(item.text)) {
        // Keep the last statement of each kind in a turn: that's what the agent signed off on.
        seen.set(c.kind + (c.subject?.from || c.subject?.pkg || ''), { c, pos });
      }
    });

    for (const { c, pos } of seen.values()) {
      const v = judge(c, pos, t.index, timeline, opts.live);
      claims.push({
        id: `${session.agent}:${session.id.slice(0, 8)}:${t.index}:${c.kind}${c.subject?.from ? ':' + c.subject.from : ''}`,
        agent: session.agent,
        model: t.model || session.model || 'unknown',
        repo: session.repo,
        session: session.id,
        turn: t.index,
        at: timeline[pos].at || t.at,
        taskType: taskTypeOf(t.prompt),
        prompt: t.prompt.slice(0, 160),
        kind: c.kind,
        claim: c.sentence,
        verdict: v.verdict,
        reason: v.reason,
        evidence: v.evidence,
      });
    }
  }
  return { claims, turns: session.turns.length - Math.max(0, firstTurn), ranCheckTurns };
}

function judge(claim, pos, turnIndex, timeline, live) {
  const before = timeline.slice(0, pos);
  const lastEditIdx = findLastIndex(before, isEdit);

  if (claim.kind === 'security') {
    return { verdict: 'review', reason: 'Security fixes always go to a human reviewer.', evidence: null };
  }
  if (claim.kind === 'refactor') return judgeRefactor(claim, before, lastEditIdx, turnIndex, live);
  if (claim.kind === 'deps') return judgeDeps(claim, before, turnIndex, live);

  const families = BACKED_BY[claim.kind];
  // Look back through this turn and the one before it.
  const runIdx = findLastIndex(before, (e) => e.kind === 'tool' && !e.denied && e.command && e.turn >= turnIndex - 1 && families.some((f) => runsCheck(f, e.command)));

  if (live?.rerun && claim.kind === 'tests') {
    // Only ever run the repo's own test command (package.json, crossexam.json…),
    // never a string from the transcript. A transcript command may be one the
    // sandbox or a guard hook stopped, with extra segments chained on
    // ("npm test; curl … | sh"); replaying it here would run it unconfined.
    const cmd = detectCommands(live.cwd).tests?.command;
    if (cmd) {
      const res = runCommandSync(cmd, { cwd: live.cwd, timeoutMs: live.timeoutMs ?? 180000 });
      const j = judgeRun(res);
      const ev = { command: cmd, exitCode: res.exitCode, excerpt: excerpt(res.output), rerun: true };
      if (j.status === 'fail') return { verdict: 'contradicted', reason: `Re-ran \`${short(cmd)}\` just now: ${j.why}.`, evidence: ev };
      if (j.status === 'pass') return { verdict: 'verified', reason: `Re-ran \`${short(cmd)}\` just now and it passed.`, evidence: ev };
    }
  }

  if (runIdx < 0) {
    return { verdict: 'unbacked', reason: UNBACKED[claim.kind], evidence: null };
  }
  const run = before[runIdx];
  const j = judgeRun(run);
  const ev = { command: run.command, exitCode: run.exitCode, excerpt: excerpt(run.output) };

  if (j.status === 'fail') {
    return { verdict: 'contradicted', reason: `Last \`${short(run.command)}\` before the claim failed: ${j.why}.`, evidence: ev };
  }
  if (lastEditIdx > runIdx) {
    const edits = before.slice(runIdx + 1).filter(isEdit).length;
    return { verdict: 'stale', reason: `\`${short(run.command)}\` passed, then ${edits} edit${edits === 1 ? '' : 's'} landed before the claim, with no re-run.`, evidence: ev };
  }
  if (j.status === 'masked') {
    return { verdict: 'review', reason: `\`${short(run.command)}\`: ${j.why}.`, evidence: ev };
  }
  if (claim.kind === 'tests' && /\ball\b|\bevery\b|\bfull\b|\bwhole\b/i.test(claim.sentence) && SUBSET.test(' ' + run.command)) {
    return { verdict: 'review', reason: `Claimed the whole suite passes; only a subset ran (\`${short(run.command)}\`).`, evidence: ev };
  }
  return { verdict: 'verified', reason: `\`${short(run.command)}\` passed after the last edit.`, evidence: ev };
}

function judgeRefactor(claim, before, lastEditIdx, turnIndex, live) {
  const sym = claim.subject?.from;
  if (live && sym) {
    const hits = grepRepo(live.cwd, sym, claim.subject?.to);
    if (hits) {
      if (hits.length) {
        return { verdict: 'contradicted', reason: `\`${sym}\` is still referenced in ${hits.length} place${hits.length === 1 ? '' : 's'}.`, evidence: { command: `git grep -nw ${sym}`, exitCode: 0, excerpt: hits.slice(0, 6).join('\n') } };
      }
      return { verdict: 'verified', reason: `No references to \`${sym}\` remain in the repo.`, evidence: { command: `git grep -nw ${sym}`, exitCode: 1, excerpt: '' } };
    }
  }
  const searches = before.filter((e, i) => i > lastEditIdx && e.turn >= turnIndex - 1 && e.kind === 'tool' && !e.denied && (e.name === 'Grep' || (e.command && SEARCH.test(e.command))));
  if (!searches.length) {
    return { verdict: 'unbacked', reason: `Said every reference was updated, but never searched after the last edit${sym ? ` for \`${sym}\`` : ''}.`, evidence: null };
  }
  const relevant = sym ? searches.filter((e) => e.command?.includes(sym)) : searches;
  const last = (relevant.length ? relevant : searches).at(-1);
  const empty = !last.output.trim() || /no (?:matches|files) found|found 0 (?:files|matches)|^0$/i.test(last.output.trim());
  const ev = { command: last.command, exitCode: last.exitCode, excerpt: excerpt(last.output) };
  if (sym && relevant.length && !empty && !(claim.subject?.to && last.output.split('\n').every((l) => !l.trim() || l.includes(claim.subject.to)))) {
    return { verdict: 'contradicted', reason: `The last search for \`${sym}\` after editing still returned matches.`, evidence: ev };
  }
  if (empty) return { verdict: 'verified', reason: `A search after the last edit came back empty.`, evidence: ev };
  return { verdict: 'review', reason: 'Searched after editing, but the results need a human to read them.', evidence: ev };
}

function judgeDeps(claim, before, turnIndex, live) {
  const { pkg, version } = claim.subject || {};
  if (live && pkg && version) {
    const found = manifestVersion(live.cwd, pkg);
    if (found) {
      const ev = { command: `read ${found.file}`, exitCode: 0, excerpt: `${pkg} ${found.version}` };
      return versionMatches(found.version, version)
        ? { verdict: 'verified', reason: `${found.file} has ${pkg} at ${found.version}.`, evidence: ev }
        : { verdict: 'contradicted', reason: `Claimed ${pkg} ${version}, but ${found.file} still has ${found.version}.`, evidence: ev };
    }
  }
  const idx = findLastIndex(before, (e) => e.kind === 'tool' && !e.denied && e.command && e.turn >= turnIndex - 1 && runsCheck('deps', e.command) && (!pkg || e.command.includes(pkg)));
  if (idx < 0) return { verdict: 'unbacked', reason: `No install or lockfile update for ${pkg || 'the package'} ran.`, evidence: null };
  const run = before[idx];
  const j = judgeRun(run);
  const ev = { command: run.command, exitCode: run.exitCode, excerpt: excerpt(run.output) };
  if (j.status === 'fail') return { verdict: 'contradicted', reason: `\`${short(run.command)}\` failed: ${j.why}.`, evidence: ev };
  return { verdict: 'verified', reason: `\`${short(run.command)}\` completed.`, evidence: ev };
}

// ---------- helpers ----------

const UNBACKED = {
  tests: 'Said the tests pass, but no test command ran.',
  build: 'Said the build passes, but no build ran.',
  types: 'Said types check, but no typecheck ran.',
  lint: 'Said lint is clean, but no linter ran.',
  migration: 'Said the migration applied, but no migration command ran.',
};

function short(cmd = '') {
  const one = cmd.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? one.slice(0, 57) + '…' : one;
}

function findLastIndex(arr, fn) {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i;
  return -1;
}
