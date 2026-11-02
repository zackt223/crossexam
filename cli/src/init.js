// `crossexam init`: wire a repo up so whatever agent works in it checks
// itself. Two layers, both agent-neutral:
//   1. A rule in AGENTS.md (read by Codex, Cursor, Copilot, Jules, Amp,
//      opencode and others), mirrored into CLAUDE.md / GEMINI.md if present.
//   2. With --mcp, project MCP configs for the agents that read them.

import fs from 'node:fs';
import path from 'node:path';

const START = '<!-- crossexam:start -->';
const END = '<!-- crossexam:end -->';

export function ruleBlock(cmd) {
  return `${START}
## Before you say a task is done

crossexam checks completion claims against the repo. Before you report that a task is finished:

1. Call the \`verify_claims\` tool from the crossexam MCP server with the exact summary you are about to give, or run \`${cmd} verify "<your summary>"\`.
2. If any claim comes back **contradicted**, fix it and verify again, or correct the summary to say what is actually true.
3. Don't claim tests, the build, types or lint pass unless crossexam verified it. If you renamed or removed something, name it in \`backticks\` so it can be searched for.
${END}`;
}

/** Insert or replace the crossexam block, leaving the rest of the file alone. */
export function upsertBlock(existing, block) {
  if (existing == null) return block + '\n';
  const i = existing.indexOf(START);
  const j = existing.indexOf(END);
  if (i >= 0 && j > i) return existing.slice(0, i) + block + existing.slice(j + END.length);
  return existing.replace(/\s*$/, '') + '\n\n' + block + '\n';
}

export function mcpEntry(serverCmd) {
  const [command, ...args] = serverCmd;
  return { command, args };
}

/** The project-level MCP files each agent reads, in that agent's own shape. */
export function mcpTargets(serverCmd) {
  const e = mcpEntry(serverCmd);
  return [
    { agent: 'Claude Code', file: '.mcp.json', key: 'mcpServers', value: e },
    { agent: 'Cursor', file: '.cursor/mcp.json', key: 'mcpServers', value: e },
    { agent: 'VS Code / Copilot', file: '.vscode/mcp.json', key: 'servers', value: { type: 'stdio', ...e } },
    { agent: 'Gemini CLI', file: '.gemini/settings.json', key: 'mcpServers', value: e },
    { agent: 'Roo Code', file: '.roo/mcp.json', key: 'mcpServers', value: e },
  ];
}

/** Agents whose MCP config is per-user, not per-repo: print, don't write. */
export function globalSnippets(serverCmd) {
  const [command, ...args] = serverCmd;
  const json = JSON.stringify({ mcpServers: { crossexam: { command, args } } }, null, 2);
  return [
    ['Codex (~/.codex/config.toml)', `[mcp_servers.crossexam]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`],
    ['Claude Code (all projects)', `claude mcp add --scope user crossexam -- ${serverCmd.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`],
    ['Windsurf (~/.codeium/windsurf/mcp_config.json), Cline, Zed, Goose, anything else', json],
  ];
}

/**
 * @returns {{file: string, action: string}[]}  what was (or would be) written
 */
export function runInit({ cwd, cliCmd, serverCmd, mcp, dryRun }) {
  const changes = [];
  const write = (rel, text) => {
    const p = path.join(cwd, rel);
    const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (before === text) return changes.push({ file: rel, action: 'unchanged' });
    changes.push({ file: rel, action: before == null ? 'created' : 'updated' });
    if (!dryRun) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
  };

  const block = ruleBlock(cliCmd);
  const agentsMd = path.join(cwd, 'AGENTS.md');
  write('AGENTS.md', upsertBlock(fs.existsSync(agentsMd) ? fs.readFileSync(agentsMd, 'utf8') : null, block));
  for (const f of ['CLAUDE.md', 'GEMINI.md']) {
    const p = path.join(cwd, f);
    if (fs.existsSync(p)) write(f, upsertBlock(fs.readFileSync(p, 'utf8'), block));
  }

  if (mcp) {
    for (const t of mcpTargets(serverCmd)) {
      const p = path.join(cwd, t.file);
      let json = {};
      if (fs.existsSync(p)) {
        try {
          json = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
        } catch {
          changes.push({ file: t.file, action: 'skipped (not valid JSON, left alone)' });
          continue;
        }
      }
      json[t.key] = { ...(json[t.key] || {}), crossexam: t.value };
      write(t.file, JSON.stringify(json, null, 2) + '\n');
    }
  }
  return changes;
}
