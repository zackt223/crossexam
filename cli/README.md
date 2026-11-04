# crossexamdev

**Your agents say done. We check.**

crossexam cross-examines what coding agents claim ("all tests pass", "every caller updated", "migration applied", "bumped zod to 3.23.8") against what actually happened in your repo. It works with any agent: Claude Code, Codex, Cursor, Copilot, Gemini CLI, Windsurf, Cline, Aider, Devin and the rest.

```bash
npx crossexamdev scan                          # how often have your agents been wrong?
npx crossexamdev verify "All tests pass."      # re-check any agent's summary right now
npx crossexamdev init --mcp                    # make every agent in this repo check itself
npx crossexamdev mcp                           # MCP server with a verify_claims tool
```

Node 18.17+, zero dependencies, runs entirely on your machine. Once installed, the command is also available as `crossexam`.

Full docs, the GitHub Action and the dashboard: https://github.com/zackt223/crossexam

Free and open source under the MIT license. Built by [Zack Telsem](https://zacktelsem.com).
