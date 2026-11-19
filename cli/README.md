# crossexamdev

**Your agents say done. We check.**

crossexam cross-examines what coding agents claim ("all tests pass", "every caller updated", "migration applied", "bumped zod to 3.23.8") against what actually happened in your repo. It works with any agent: Claude Code, Codex, Cursor, Copilot, Gemini CLI, Windsurf, Cline, Aider, Devin and the rest.

```bash
npx crossexamdev scan                          # how often have your agents been wrong?
npx crossexamdev verify "All tests pass."      # re-check any agent's summary right now
npx crossexamdev init --mcp                    # make every agent in this repo check itself
npx crossexamdev mcp                           # MCP server with verify_claims and assess_test_strength
npx crossexamdev mutate                        # would the tests notice a bug in what the agent changed?
```

Node 18.17+, zero dependencies, runs entirely on your machine. Once installed, the command is also available as `crossexam`.

`mutate` plants small defects in the changed lines and runs your tests against each one, in a disposable copy of the repo. Tests run inside a sandbox (bubblewrap on Linux, `sandbox-exec` on macOS, or Docker). Where none is available, crossexam refuses unless you pass `--unsandboxed`. Details and the threat model: https://github.com/zackt223/crossexam/blob/master/docs/mutation-security.md

Site: https://zackt223.github.io/crossexam/

Full docs and the GitHub Action: https://github.com/zackt223/crossexam

Free and open source under the MIT license. Built by [Zack Telsem](https://zacktelsem.com).
