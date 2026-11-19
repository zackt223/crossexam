// Pull-request mode: every cloud agent that opens a PR (Copilot coding agent,
// Codex, Devin, Jules, Cursor background agents, Claude) writes its claims in
// the PR description. In CI the branch is checked out, so verify them there.

import crypto from 'node:crypto';
import fs from 'node:fs';

const BOTS = [
  [/^copilot(-swe-agent)?(\[bot\])?$/i, 'copilot'],
  [/^devin-ai-integration\[bot\]$/i, 'devin'],
  [/^chatgpt-codex-connector\[bot\]$|codex/i, 'codex'],
  [/^google-labs-jules\[bot\]$|jules/i, 'jules'],
  [/^cursor(-agent)?\[bot\]$|^cursor$/i, 'cursor'],
  [/^claude(\[bot\])?$|anthropic/i, 'claude-code'],
  [/^sweep-ai\[bot\]$/i, 'sweep'],
];

/** Read the PR from the Actions event payload. */
export function readPullRequest(eventPath = process.env.GITHUB_EVENT_PATH) {
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  const ev = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = ev.pull_request;
  if (!pr) return null;
  return { number: pr.number, title: pr.title || '', body: pr.body || '', author: pr.user?.login || '', agent: agentOf(pr.user?.login || '', pr.body || '') };
}

export function agentOf(login, body = '') {
  for (const [re, name] of BOTS) if (re.test(login)) return name;
  if (/Generated with \[?Claude Code/i.test(body)) return 'claude-code';
  if (/codex/i.test(body) && /openai/i.test(body)) return 'codex';
  return 'unknown';
}

const ICON = { verified: '✅', contradicted: '❌', review: '🔎', stale: '⏱️', unbacked: '⚪' };

export function markdownSummary(pr, r) {
  const head = `### crossexam · ${r.ok ? 'claims hold up' : 'false claims in this PR'}`;
  const who = pr ? `PR #${pr.number}${pr.agent !== 'unknown' ? ` by **${pr.agent}**` : pr.author ? ` by @​${pr.author}` : ''}` : '';
  if (!r.results.length) return `${head}\n\n${who}\n\nNo checkable completion claims in the description.\n${r.strength ? strengthMarkdown(r.strength) : ''}`;
  const rows = r.results.map((x) => `| ${ICON[x.verdict]} ${x.verdict} | ${cell(x.claim)} | ${cell(x.reason)} |`);
  const details = r.results
    .filter((x) => x.verdict === 'contradicted' && x.evidence?.excerpt)
    .map((x) => `<details><summary><code>${escapeHtml(x.evidence.command)}</code></summary>\n\n\`\`\`\n${x.evidence.excerpt}\n\`\`\`\n</details>`);
  return `${head}\n\n${who}\n\n| Verdict | Claim | Why |\n|---|---|---|\n${rows.join('\n')}\n\n${details.join('\n\n')}\n${r.strength ? strengthMarkdown(r.strength) : ''}`;
}

const RATING_ICON = { strong: '🟢', moderate: '🟡', weak: '🔴', inconclusive: '⚪' };

/** Test strength is its own section: it never changes a verdict above. */
export function strengthMarkdown(s) {
  const t = s.summary;
  const score = t.score != null ? ` · ${Math.round(t.score * 100)}% of planted defects caught` : '';
  const surv = s.mutants.filter((m) => m.status === 'MUTATION_SURVIVED').slice(0, 8);
  const code = (x) => `<code>${escapeHtml(x.split('\n')[0].trim().slice(0, 80)).replace(/\|/g, '&#124;')}</code>`;
  const rows = surv.map((m) => `| \`${m.file}:${m.line}\` | ${cell(m.function || 'top level')} | ${code(m.before)} → ${code(m.after)} |`);
  return [
    `\n#### Test strength: ${RATING_ICON[s.rating]} ${s.rating}${score}`,
    s.headline ? `\n${cell(s.headline.text)}` : '',
    t.attempted ? `\n${t.attempted} mutants · ${t.killed} killed · ${t.survived} survived · ${t.invalid} invalid · ${t.unresolved} unresolved · ${(t.ms / 1000).toFixed(0)}s` : '',
    rows.length ? `\n<details><summary>Defects the tests did not notice</summary>\n\n| Where | Function | Change that still passed |\n|---|---|---|\n${rows.join('\n')}\n</details>` : '',
    '\n<sub>Separate from the verdicts above: a mutation score measures how well the tests pin down the changed code, not whether the code is correct.</sub>\n',
  ].join('\n');
}

/** Workflow commands: annotations on the run, plus the job summary. */
export function emitActions(pr, r) {
  for (const x of r.results) {
    const msg = `${x.claim} → ${x.reason}`.replace(/\r?\n/g, ' ').replace(/%/g, '%25');
    if (x.verdict === 'contradicted') console.log(`::error title=crossexam: false claim::${msg}`);
    else if (x.verdict === 'review') console.log(`::warning title=crossexam: needs review::${msg}`);
    else console.log(`::notice title=crossexam: verified::${msg}`);
  }
  if (r.strength?.headline && (r.strength.rating === 'weak' || r.strength.rating === 'moderate')) {
    const top = r.strength.mutants.find((m) => m.id === r.strength.headline.mutant);
    const loc = top ? ` file=${top.file},line=${top.line},` : ' ';
    console.log(`::warning${loc}title=crossexam: ${r.strength.rating} tests::${r.strength.headline.text.replace(/\r?\n/g, ' ').replace(/%/g, '%25')}`);
  }
  const md = markdownSummary(pr, r);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (process.env.GITHUB_OUTPUT) {
    const n = (v) => r.results.filter((x) => x.verdict === v).length;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ok=${r.ok}\ncontradicted=${n('contradicted')}\nverified=${n('verified')}\nagent=${pr?.agent ?? 'unknown'}\n`);
    if (r.strength) fs.appendFileSync(process.env.GITHUB_OUTPUT, `mutation-score=${r.strength.summary.score ?? ''}\nmutation-rating=${r.strength.rating}\nmutants-survived=${r.strength.summary.survived}\n`);
    // A fresh delimiter each run, so test output or grepped repo text can't end
    // the block early and set outputs of its own.
    const eof = `CROSSEXAM_EOF_${crypto.randomUUID().replace(/-/g, '')}`;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary<<${eof}\n${md}\n${eof}\n`);
  }
  return md;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/`([^`]+)`/g, '<code>$1</code>');
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
