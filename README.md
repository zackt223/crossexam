# crossexam

**Your agents say done. We check.**

crossexam cross-examines what coding agents claim (“all tests pass”, “every caller updated”, “migration applied”, “bumped zod to 3.23.8”) against what actually happened in the repo. It doesn't trust any agent, and it doesn't need any agent's cooperation, so it works with all of them.

Site: **https://zackt223.github.io/crossexam/**

Free and open source under the [MIT license](LICENSE). No accounts, no paid tier, no telemetry: everything runs on your machine.

## Getting started

```bash
npx crossexamdev scan          # how often have your agents been wrong?
npx crossexamdev init --mcp    # in any repo: make every agent there check itself
```

Node 18.17+ and no dependencies. The npm package is `crossexamdev` (the bare name was taken); once installed, the command is also available as `crossexam`, which is what the examples below use. To run from source instead: `git clone https://github.com/zackt223/crossexam && node crossexam/cli/bin/crossexam.js scan`.

```
cli/      the verifier: a zero-dependency Node CLI, MCP server, Claude Code hook and GitHub Action entry point
web/      the landing page (deployed to GitHub Pages)
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
      - uses: zackt223/crossexam@master
        with:
          fail-on: contradicted
```

It annotates the run, writes a job summary, and exposes `ok`, `contradicted`, `agent` and a Markdown `summary` output that you can post as a PR comment.

To also grade test strength, add `mutate: true`, and check out with `fetch-depth: 0` so there's a base to compare against. On Linux runners the action installs bubblewrap and runs mutants sandboxed. `mutation-score` and `mutation-rating` become outputs.

## Verdicts

| verdict | meaning |
|---|---|
| **verified** | the most recent relevant check passed, and nothing was edited after it |
| **contradicted** | the check failed, or a live re-check disagrees |
| **stale** | a check passed, then files were edited before the claim, with no re-run |
| **unbacked** | nothing that could back the claim ran |
| **review** | evidence exists but can't settle it (masked exit code, subset of tests, no exit code recorded, security fixes, migrations) |

Only assertions count. “I'll make sure tests pass”, “tests don't pass yet”, questions, and claims inside quotation marks are ignored.

## Test strength (mutation intelligence)

A passing test suite only proves something if it would have failed on broken code. `crossexam mutate` checks that by planting small, deterministic defects in the lines an agent changed: a flipped `<`, an inverted `if`, `&&` swapped for `||`. It then runs your tests against each one and reports which defects the tests never noticed.

```bash
crossexam mutate                    # the uncommitted change (or the last commit)
crossexam mutate --base main        # everything since main
crossexam verify "Fixed clamp and all tests pass." --mutate
```

Results are reported alongside the factual verdicts, never mixed into them:

```
✓ verified: "all tests pass"
  test strength: weak (2 of 7 planted defects caught). This is separate from the verdict above.
```

- **What it reports.** Each mutant is killed, survived, invalid (didn't compile) or unresolved (timed out or inconclusive). Only survivors are findings, and each comes with the exact line that changed. The score is killed ÷ (killed + survived). It measures how well the tests pin down the changed code, **not** whether the code is correct.
- **Where it shows up.**
  - `--json` and `--csv` reports.
  - The `assess_test_strength` MCP tool, and `verify_claims {mutate: true}`.
  - The GitHub Action (`mutate: true`).
  - `crossexam scan` history: test strength by agent, from earlier runs.
- **Languages.** JavaScript and TypeScript for now, with any test runner your test command uses (`node --test`, vitest, jest, mocha…). Other languages are listed as skipped, never silently ignored.

### Isolation: what runs where

Mutation testing runs your repository's code, so crossexam treats that code as untrusted.

**Your working tree is never modified.** crossexam:

- copies the checkout to a hidden folder next to it;
- writes mutants only there;
- deletes the copy afterwards, even on Ctrl-C;
- removes copies left by a crash on the next run;
- checks every file hash, `HEAD`, refs, stash and status before and after, and says so.

It runs only read-only git commands and never commits, pushes or switches branches.

**Tests run in a sandbox, or not at all:**

| Platform | Sandbox (`--isolation auto` picks the first one that works) | Network | Your home folder |
|---|---|---|---|
| Linux | bubblewrap (`apt install bubblewrap`) | none | hidden |
| macOS | `sandbox-exec` (built in) | denied | unreadable |
| any, with Docker or Podman | Linux container, read-only root, no capabilities | none | not mounted |
| Windows without Docker | **none available: crossexam refuses to run mutants** | – | – |

- **`--unsandboxed`** runs the tests with your own permissions and network. It is labelled `NOT SANDBOXED` in every output, and a repository's `crossexam.json` can't turn it on. Use it only for code you'd run `npm test` on anyway.
- **Limits:**
  - per-run timeout that kills the whole process tree;
  - CPU time (all sandboxes);
  - memory (bubblewrap, Docker);
  - a cap on mutants per run (`--max`, default 25);
  - a total time budget (`--budget`, default 300 s).
- **Permissions it needs:**
  - read access to the repo;
  - write access to the folder that contains it (for the temporary copy);
  - unprivileged user namespaces on Linux, or a working Docker.
- **When things fail:**
  - a failing or timing-out suite stops the run before any mutant ("fix the suite first");
  - a suite that needs network or secrets fails inside the sandbox, by design;
  - cleanup problems are reported with the path that was left.

### What stays local

crossexam makes no network requests. Your code, transcripts and environment variables are never uploaded, and this release makes no LLM calls. Reports stay on your disk:

- Secret-looking values (API keys, tokens, private keys, `password = "…"`) are redacted.
- Paths under your home folder are shortened to `~`.
- `--no-source` leaves code lines out entirely.

A hosted crossexam cloud is planned, and uploading to it will always be opt-in. The CLI has no code that sends anything today. `crossexam upload --dry-run --report <file>` shows exactly what a run would send, with paths made relative and secrets redacted. The format is described in [docs/upload-format.md](docs/upload-format.md).

### Known limitations

- A sandbox narrows what test code can reach. It is not a guarantee against kernel or container escapes.
- macOS `sandbox-exec` is deprecated by Apple and can't enforce a memory limit.
- On Windows the only sandbox is Docker, and Docker's Linux containers can't load native dependencies built for Windows.
- Surviving mutants can be equivalent (the change can't alter behaviour). Treat them as leads for a reviewer, not proof of a gap.

### Turning it off

It's off unless you ask for it:

- `crossexam mutate` and `--mutate` are explicit.
- The MCP tool only runs when an agent calls it.
- The Action input defaults to `mutate: false`.

To stop agents calling it over MCP, remove `assess_test_strength` from your client's allowed tools.

Details: [docs/mutation-intelligence.md](docs/mutation-intelligence.md) (design) and [docs/mutation-security.md](docs/mutation-security.md) (threat model, backends, test plan).

```bash
cd cli && npm test     # functional + security tests; sandbox cases run where a sandbox works
```

## The web app

```bash
cd web && npm install && npm run dev     # http://localhost:5291
```

Pushes to `master` that touch `web/` deploy the site to GitHub Pages (`.github/workflows/pages.yml`). The team dashboard in `web/src/app` is not linked from the site for now.

## Contributing

Issues and pull requests are welcome. New transcript readers are the most useful thing to add: if your agent writes logs crossexam can't read yet, open an issue with a redacted sample, or send a reader in `cli/src/readers.js` with a fixture test in `cli/test/`.

```bash
cd cli && npm test                      # the CLI's tests, no install needed
cd web && npm install && npm run build  # typecheck and build the site
```

## License

[MIT](LICENSE) © Zack Telsem

## Author

Built by **Zack Telsem**: [zacktelsem.com](https://zacktelsem.com) · [LinkedIn](https://www.linkedin.com/in/zackariah-telsem-a8b245246/)
