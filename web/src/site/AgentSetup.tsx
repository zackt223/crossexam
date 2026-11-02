import { useState } from 'react';

const MCP_JSON = `{
  "mcpServers": {
    "crossexam": { "command": "npx", "args": ["-y", "crossexam", "mcp"] }
  }
}`;

const SETUPS: { agent: string; how: string; file: string; code: string; also?: string }[] = [
  { agent: 'Claude Code', how: 'mcp tool + stop hook + history', file: 'terminal', code: 'claude mcp add crossexam -- npx -y crossexam mcp\nnpx crossexam install     # sends a false "done" back, once', also: 'transcripts are read by crossexam scan' },
  { agent: 'Cursor', how: 'mcp tool + AGENTS.md rule', file: '.cursor/mcp.json', code: MCP_JSON, also: 'or just run npx crossexam init --mcp' },
  { agent: 'Copilot', how: 'mcp tool in vs code agent mode', file: '.vscode/mcp.json', code: `{
  "servers": {
    "crossexam": { "type": "stdio", "command": "npx", "args": ["-y", "crossexam", "mcp"] }
  }
}`, also: 'copilot coding agent prs: use the github action' },
  { agent: 'Codex', how: 'mcp tool + AGENTS.md + history', file: '~/.codex/config.toml', code: `[mcp_servers.crossexam]
command = "npx"
args = ["-y", "crossexam", "mcp"]`, also: 'codex reads AGENTS.md on its own' },
  { agent: 'Gemini CLI', how: 'mcp tool + GEMINI.md + history', file: '.gemini/settings.json', code: MCP_JSON },
  { agent: 'Windsurf', how: 'mcp tool', file: '~/.codeium/windsurf/mcp_config.json', code: MCP_JSON },
  { agent: 'Cline · Roo · Kilo', how: 'mcp tool + history', file: 'mcp settings', code: MCP_JSON, also: 'task history is read by crossexam scan' },
  { agent: 'Aider', how: 'verify + history', file: 'terminal', code: `/run npx crossexam verify "all tests pass"
npx crossexam scan --path .   # reads .aider.chat.history.md` },
  { agent: 'Devin · Jules · PR bots', how: 'github action on every pr', file: '.github/workflows/crossexam.yml', code: `on: pull_request
jobs:
  crossexam:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - uses: crossexam/crossexam@v0` },
  { agent: 'anything else', how: 'verify any text, or write the open format', file: 'terminal', code: `npx crossexam verify "renamed \`foo\` to \`bar\` everywhere"
echo "$AGENT_SUMMARY" | npx crossexam verify` },
];

export function AgentSetup() {
  const [i, setI] = useState(0);
  const [copied, setCopied] = useState(false);
  const s = SETUPS[i];
  return (
    <div className="setup spot">
      <div className="setup-tabs" role="tablist" aria-label="Pick your agent">
        {SETUPS.map((x, k) => (
          <button key={x.agent} role="tab" aria-selected={k === i} className={k === i ? 'on' : ''} onClick={() => setI(k)}>
            {x.agent}
          </button>
        ))}
      </div>
      <div className="setup-body" key={i}>
        <div className="setup-meta">
          <span className="setup-how">{s.how}</span>
          <span className="setup-file">{s.file}</span>
        </div>
        <div className="setup-code">
          <pre>{s.code}</pre>
          <button
            className="setup-copy"
            onClick={() =>
              navigator.clipboard?.writeText(s.code).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              })
            }
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
        {s.also && <div className="setup-also">{s.also}</div>}
      </div>
    </div>
  );
}
