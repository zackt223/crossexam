# crossexam

**Your agents say done. We check.**

crossexam cross-examines what coding agents claim (“all tests pass”, “every caller updated”, “migration applied”, “bumped zod to 3.23.8”) against what actually happened in the repo. It doesn't trust any agent, and it doesn't need any agent's cooperation, so it works with all of them.

```
cli/      the verifier: a zero-dependency Node CLI, MCP server, Claude Code hook and GitHub Action entry point
web/      crossexam.dev (landing page) and the team dashboard at /app
docs/     the open transcript format
action.yml
```

## Any agent: four ways in

| Way in | Command | Works with |
|---|---|---|
| **MCP tool**: the agent calls `verify_claims` before it says done | `crossexam init --mcp` writes `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.roo/mcp.json`, and prints snippets for Codex, Windsurf, Cline, Zed and Goose | any MCP client |
| **AGENTS.md rule**: tells every agent in the repo to verify before reporting | `crossexam init` (also updates `CLAUDE.md` / `GEMINI.md` if present) | Codex, Cursor, Copilot, Jules, Amp, opencode, … |
| **PR check**: verifies the claims in an agent's PR description on the checked-out branch | `crossexam verify --github` / `action.yml` | Copilot coding agent, Codex, Devin, Jules, Cursor background agents, Claude |
| **Any text**: re-checks whatever an agent said | `crossexam verify "All tests pass and I renamed \`foo\` to \`bar\`"` | CI, git hooks, scripts, internal agents |

`verify` re-checks live. It runs the repo's own test, build, typecheck and lint commands (found in `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, Gradle/Maven, Gemfile and mix.exs, or set in `crossexam.json`). It runs `git grep` on names that were said to be renamed, and reads manifests for claimed versions. It exits with 1 when a claim is contradicted. It **never runs migrations**: name a read-only status command instead:

```json
{ "commands": { "migration": "npx prisma migrate status", "tests": "pnpm test:unit" }, "timeoutSeconds": 600 }
```

### History: what your agents claimed, and how often they were wrong

```bash
crossexam scan                     # last 30 days, every agent it can find
crossexam scan --since all --json report.json   # then drop report.json on the dashboard
```

| Agent | Transcripts read from |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` |
| Gemini CLI | `~/.gemini/tmp/*/chats/*.json` |
| Cline, Roo Code, Kilo Code | `<VS Code / Cursor / Windsurf / VSCodium>/User/globalStorage/<extension>/tasks/*/ui_messages.json` |
| Aider | `.aider.chat.history.md` in the repo (`--path` for more repos) |
| anything else | the [open transcript format](docs/transcript-format.md) in `~/.crossexam/transcripts/` |

The Claude Code reader was tested against real transcripts. The other readers were built from each tool's documented on-disk format and tested against fixtures, so check them against your own logs. If a transcript can't be read, it's skipped instead of stopping the scan.

### Claude Code Stop hook

```bash
crossexam install --dry-run   # preview
crossexam install             # adds it to ~/.claude/settings.json (backs the file up first)
```

A false “done” sends the turn back once with the failing output. If it's still false after that, crossexam tells you instead of looping.

### GitHub Action

```yaml
# .github/workflows/crossexam.yml
on: pull_request
jobs:
  crossexam:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci                          # whatever your checks need
      - uses: zackt223/crossexam@master      # while the repo is private, only your own repos can use it
        with:
          fail-on: contradicted
```

It annotates the run, writes a job summary, and exposes `ok`, `contradicted`, `agent` and a Markdown `summary` output that you can post as a PR comment.

## Verdicts

| verdict | meaning |
|---|---|
| **verified** | the most recent relevant check passed, and nothing was edited after it |
| **contradicted** | the check failed, or a live re-check disagrees |
| **stale** | a check passed, then files were edited before the claim, with no re-run |
| **unbacked** | nothing that could back the claim ran |
| **review** | evidence exists but can't settle it (masked exit code, subset of tests, no exit code recorded, security fixes, migrations) |

Only assertions count. “I'll make sure tests pass”, “tests don't pass yet”, questions, and claims inside quotation marks are ignored.

```bash
cd cli && npm test     # 23 tests
```

## The web app

```bash
cd web && npm install && npm run dev     # http://localhost:5291
```

`/` is the landing page. `/app` is the dashboard: agents, reliability matrix, activity, claims, review routing with a live policy, and an audit trail with SOC 2 evidence export. It starts on demo data. Drop in a `scan --json` report to see your own numbers; the report stays in your browser.

## Before launch

- [ ] Buy the domain (`crossexam.dev` is assumed everywhere) and point the `WAITLIST` mailto in `web/src/site/Landing.tsx` at a real inbox or form
- [ ] Put the real GitHub URL in the nav's Star button, and make the repo public, or split out a public action repo, so others can `uses:` it
- [ ] `npm publish` from `cli/` so `npx crossexam` works (until then `init` writes `node "<path>"` commands)
- [ ] Add `web/public/og.png` (1200×630) for link previews
- [ ] Deploy `web/` (Vercel: the included `vercel.json` rewrites `/app` to the SPA)
