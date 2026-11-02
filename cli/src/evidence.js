// Evidence: which commands count as a check for which claim, and whether
// a given run passed, failed, or hid its own exit status.

export const RUNNERS = {
  tests:
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?\b|\b(?:npx\s+)?(?:vitest|jest|mocha|ava|playwright\s+test|cypress\s+run)\b|\bpytest\b|\bpython\d?\s+-m\s+(?:pytest|unittest)\b|\bgo\s+test\b|\bcargo\s+(?:test|nextest)\b|\brspec\b|\bphpunit\b|\bdotnet\s+test\b|\bmix\s+test\b|\bdeno\s+test\b|\bnode\s+--test\b|\bbun\s+test\b|\bgradlew?\s+test\b|\bmvn\s+test\b|\b(?:tox|nox)\b/i,
  build:
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bvite\s+build\b|\bnext\s+build\b|\bcargo\s+build\b|\bgo\s+build\b|\bmake\b|\bgradlew?\s+(?:build|assemble)\b|\bmvn\s+(?:package|install|compile)\b|\bdotnet\s+build\b|\bexpo\s+export\b|\bwebpack\b|\btsc\b(?![^|;&]*--noEmit)/i,
  types:
    /\btsc\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check-types|tsc)\b|\bvue-tsc\b|\bmypy\b|\bpyright\b|\bflow\s+check\b|\bcargo\s+check\b|\bgo\s+vet\b/i,
  lint:
    /\b(?:npx\s+)?(?:eslint|biome|oxlint|ruff|flake8|pylint|golangci-lint|rubocop|stylelint)\b|\bcargo\s+clippy\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/i,
  migration:
    /\bprisma\s+(?:migrate|db\s+push)\b|\bdrizzle-kit\s+(?:migrate|push)\b|\bknex\s+migrate\b|\balembic\s+upgrade\b|\b(?:rails|rake)\s+db:migrate\b|\bsupabase\s+(?:db\s+(?:push|reset)|migration\s+up)\b|\bsequelize\s+db:migrate\b|\bflyway\s+migrate\b|\bmanage\.py\s+migrate\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:db:)?migrat/i,
  deps: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|up(?:date|grade)?)\b|\bpip\d?\s+install\b|\buv\s+(?:add|pip|lock|sync)\b|\bpoetry\s+(?:add|update|lock)\b|\bcargo\s+(?:add|update)\b|\bgo\s+get\b|\bbundle\s+(?:update|install)\b/i,
};

export const SEARCH = /\b(?:rg|grep|ag|ack|git\s+grep|Select-String|findstr)\b/i;

// Wrappers that sit in front of the real program: env vars, cd, npx, uv run…
const PREFIX = /^(?:(?:\w+=\S*\s+)+|timeout\s+\d+\s+|(?:npx|bunx)\s+(?:-y\s+|--yes\s+)?|pnpm\s+(?:exec|dlx)\s+|yarn\s+dlx\s+|(?:uv|poetry|pipenv)\s+run\s+|python\d?(?:\.\d+)?\s+-m\s+|&\s*)+/i;

/**
 * The programs a shell line actually runs, one per segment. Heredoc bodies
 * and quoted strings are dropped, so `cat vitest.config.ts` or a script that
 * merely mentions "jest" doesn't count as running tests.
 */
export function commandHeads(cmd = '') {
  const body = cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\s*(?:\n|$)/g, ' ')
    .replace(/'[^'\n]*'|"[^"\n]*"/g, '""');
  return body
    .split(/&&|\|\||[;|\n]/)
    .map((seg) => seg.trim().replace(PREFIX, ''))
    .filter((seg) => seg && !/^(?:cd|echo|cat|type|less|head|tail|grep|rg|sed|awk|ls|which|git\s+(?:log|show|diff|status))\b/i.test(seg));
}

/** Did this shell line run a check from the given family? */
export function runsCheck(family, cmd) {
  if (!cmd) return false;
  const re = RUNNERS[family];
  return commandHeads(cmd).some((seg) => {
    const m = seg.match(re);
    return m && m.index === 0;
  });
}

/** Tools that change files. Bash edits are caught by pattern. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'str_replace_based_edit_tool', 'edit_file', 'write_file']);
const SHELL_EDIT = /\bsed\s+-i\b[^|;&\n]*|\bperl\s+-pi\b[^|;&\n]*|\bapply_patch\b|\bgit\s+(?:apply|checkout\s+--|restore)\b|(?:^|[^>&2])>\s*(?!\/dev\/null|&|\$null|nul\b)[\w./\\:$-]+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|css|json|sql|ya?ml|toml)\b/gi;
// Scratch files, notes and agent memory don't change what the tests see.
const IGNORED_PATH = /(?:^|[\\/])(?:tmp|temp|scratchpad)[\\/]|\$TEMP|\$TMPDIR|[\\/]\.claude[\\/]|\.(?:md|mdx|txt|log)\b/i;

export function isEdit(ev) {
  if (ev.kind !== 'tool') return false;
  if (EDIT_TOOLS.has(ev.name)) return !IGNORED_PATH.test(ev.file || '');
  if (!ev.command) return false;
  const hits = ev.command.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\s*(?:\n|$)/g, ' ').match(SHELL_EDIT);
  return !!hits && hits.some((h) => !IGNORED_PATH.test(h));
}

/** Pipes or `|| true` that swallow a failing exit code. */
export function masksExit(cmd) {
  return /\|\|\s*(?:true|:|exit\s+0|echo)\b|;\s*(?:true|exit\s+0)\s*$|\|\s*(?:tail|head|grep|Select-Object|Select-String|less|more|tee|cat|sort|wc)\b|2>\s*\/dev\/null\s*;\s*echo|\$LASTEXITCODE\s*=\s*0/i.test(cmd);
}

const FAIL_SIGNALS = [
  /\b([1-9]\d*)\s+(?:tests?\s+)?(?:failed|failing|failures?|errors?)\b/i,
  /\bTests?:\s+[1-9]\d*\s+failed/i,
  /^\s*(?:FAIL|FAILED|✗|×|✕)\s/m,
  /\bnot ok \d+/,
  /\berror TS\d{3,5}\b/,
  /\bFound [1-9]\d* errors?\b/,
  /\b(?:Build|Compilation|Migration)\s+failed\b/i,
  /\bnpm ERR!|ERR_PNPM_|\berror Command failed\b/,
  /^\s*error(?:\[E\d+\])?:/m,
  /\bTraceback \(most recent call last\)/,
  /\bAssertionError\b/,
  /^\s*✖\s+[1-9]\d* problems?/m,
  /--- FAIL:/,
  /\bpanicked at\b/,
];
const PASS_SIGNALS = [
  /\b(?:all\s+)?\d+\s+(?:tests?\s+)?pass(?:ed|ing)?\b(?![^\n]*\b[1-9]\d*\s+fail)/i,
  /\bTests?:\s+\d+\s+passed,\s+\d+\s+total/i,
  /^\s*ok\s+\S+\s+[\d.]+s/m,
  /\bPASS\b/,
  /\btest result: ok\b/,
  /\bFound 0 errors\b/,
  /\bbuilt in [\d.]+\s*m?s\b/i,
  /\bCompiled successfully\b/i,
  /\b0 (?:errors?|problems?)\b/i,
  /\bAll checks passed\b/i,
];

/**
 * Judge one run of a checking command.
 * @returns {{status: 'pass'|'fail'|'masked'|'unknown', why: string}}
 */
export function judgeRun(ev) {
  const out = ev.output || '';
  const failHit = FAIL_SIGNALS.map((re) => out.match(re)).find(Boolean);
  if (ev.exitCode != null && ev.exitCode !== 0) {
    return { status: 'fail', why: `exited ${ev.exitCode}` + (failHit ? ` · ${clip(failHit[0])}` : '') };
  }
  if (ev.isError && ev.exitCode == null) return { status: 'fail', why: failHit ? clip(failHit[0]) : 'tool reported an error' };
  if (failHit) return { status: 'fail', why: clip(failHit[0]) };
  const masked = ev.command && masksExit(ev.command);
  if (masked && !PASS_SIGNALS.some((re) => re.test(out))) {
    return { status: 'masked', why: 'exit code hidden by a pipe, and no pass line in the output' };
  }
  if (ev.exitCode === 0 || PASS_SIGNALS.some((re) => re.test(out))) return { status: 'pass', why: ev.exitCode === 0 ? 'exited 0' : 'pass line in output' };
  return { status: masked ? 'masked' : 'pass', why: masked ? 'exit code hidden by a pipe' : 'no error reported' };
}

export function excerpt(out = '', max = 420) {
  const lines = out.replace(/\r/g, '').split('\n');
  const idx = lines.findIndex((l) => FAIL_SIGNALS.some((re) => re.test(l)));
  const from = idx > 2 ? idx - 2 : 0;
  const s = lines.slice(from, from + 10).join('\n');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function clip(s) {
  s = s.trim();
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}
