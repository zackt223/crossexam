# crossexam

**Your agents say done. We check.**

crossexam cross-examines what your coding agents claim (“all tests pass”, “every caller updated”, “migration applied”, “bumped zod to 3.23.8”) against what actually ran. It's neutral across agents: it reads Claude Code and Codex transcripts today, with more agents to come.

```
cli/   the verifier: a zero-dependency Node CLI and Claude Code Stop hook
web/   crossexam.dev (landing page) and the team dashboard at /app
```

## The CLI

```bash
node cli/bin/crossexam.js scan                 # last 30 days of local agent transcripts
node cli/bin/crossexam.js scan --since all --json report.json
node cli/bin/crossexam.js install --dry-run    # preview the Claude Code Stop hook
node cli/bin/crossexam.js install              # add it to ~/.claude/settings.json (backs up first)
```

Once it's published to npm, all of these become `npx crossexam …`.

### Verdicts

| verdict | meaning |
|---|---|
| **verified** | the most recent relevant check passed, and nothing was edited after it |
| **contradicted** | the most recent relevant check failed, or a live re-check disagrees |
| **stale** | a check passed, then files were edited before the claim, with no re-run |
| **unbacked** | nothing that could back the claim ran at all |
| **review** | evidence exists but can't settle it (exit code hidden by a pipe, only a subset of tests ran, security fixes) |

How it decides:

- **Claims** are only sentences that assert a result. “I'll make sure tests pass”, “tests don't pass yet” and questions are ignored (`cli/src/claims.js`).
- **Evidence** is matched to the program a shell line actually runs. `cat vitest.config.ts` or a heredoc that only mentions jest doesn't count as a test run. Edits to `/tmp`, scratch files and Markdown don't count as code changes (`cli/src/evidence.js`).
- **Live checks** run in hook mode. For a rename, it runs `git grep` on the old name in the repo. For a dependency bump, it reads `package.json`. With `--rerun`, it re-runs the test command before trusting “tests pass”.
- **Hook behaviour**: a false “done” sends the turn back once with the failing output. If it's still false after that, crossexam tells you rather than looping.

```bash
cd cli && npm test     # 10 tests: detection, run judging, every verdict, Codex rollouts
```

## The web app

```bash
cd web && npm install && npm run dev     # http://localhost:5291
```

- `/` is the landing page.
- `/app` is the dashboard: agents, reliability matrix, activity, claims, review routing with a live policy, and an audit trail with SOC 2 evidence export (CSV/JSON).

The dashboard starts on demo data. Drop a `crossexam scan --json` report onto it to see your own numbers. The report stays in your browser.

## Before launch

- [ ] Buy the domain (`crossexam.dev` is assumed everywhere) and point the `WAITLIST` mailto in `web/src/site/Landing.tsx` at a real inbox or form
- [ ] Put the real GitHub URL in the nav's Star button
- [ ] `npm publish` from `cli/` so `npx crossexam` works
- [ ] Add `web/public/og.png` (1200×630) for link previews
- [ ] Deploy `web/` (Vercel: the included `vercel.json` rewrites `/app` to the SPA)
