# Mutation intelligence: security and isolation

Mutation testing runs code: the repository's tests, the tools those tests start, and the planted defects themselves. That code can come from a coding agent, or from whoever wrote the repository. This document describes how crossexam keeps your working tree and your machine out of reach of it, and where those protections stop.

Nothing here is a claim that crossexam is "100% secure". Each guarantee below names the mechanism behind it and the test that checks it, and the limitations section is part of the design.

## 1. Architecture assessment

Mutation intelligence (`cli/src/strength.js`) does six things:

1. It reads the diff with git, using read-only commands.
2. It plans mutants (`mutate.js`). This is pure computation and runs nothing.
3. It builds a disposable copy of the checkout (`sandbox.js`).
4. It runs the repo's test command once as a baseline, then once per mutant, inside an isolation backend.
5. It classifies each result.
6. It deletes the copy.

Before the security work, the copy protected the working tree, but test processes ran with the user's full permissions: home directory, SSH keys, environment, network. A temporary directory is not a sandbox, and crossexam no longer presents it as one.

## 2. Threat model

| Asset | Threat | Control |
|---|---|---|
| Working tree, uncommitted changes | A mutant is written to the real file, or a crash leaves it there | Mutants are only ever written inside the copy. Files are hashed before and after the run, and the report says whether they match. |
| Git history and state | Commits, branch changes, index rewrites | crossexam runs only read-only git subcommands, with `GIT_OPTIONAL_LOCKS=0` so `git status` can't rewrite the index. `GIT_CEILING_DIRECTORIES` stops test-time git from finding a parent repo. |
| Credentials: `~/.ssh`, `~/.aws`, `~/.npmrc`, browser profiles… | Test code reads them | Home directories are hidden (bwrap tmpfs, sandbox-exec deny rules, or a container). `HOME` points at an empty folder inside the copy. |
| Environment secrets | Test code reads `GITHUB_TOKEN`, `AWS_*`… | Sandboxed runs get an allowlisted environment (PATH, locale, CI flags) and nothing else. Unsandboxed runs strip credential-looking names. |
| Network | Exfiltration, downloads | No network in any sandbox backend: a new network namespace, `(deny network*)`, or `--network none`. |
| Host resources | Fork bombs, memory exhaustion, infinite loops | Per-run timeout that kills the whole process tree, a total budget, and a cap on mutant count. Memory, CPU and process limits where the backend supports them (see the platform table). |
| Files outside the copy | Writes or deletes through `../`, symlinks, or dependency links | The copy is written by crossexam, not by the tests. Tracked symlinks are recreated only when they resolve inside the repo. `--files` and MCP `files` must resolve inside the repo. Dependency folders are mounted read-only in every sandbox backend. |
| Docker socket | Container escape from the test process | `/run` and `/var/run` are hidden (bwrap) or denied (sandbox-exec). The container backend never mounts the socket. |
| Isolation settings | A malicious repo, or an agent, turns the sandbox off | A repository's `crossexam.json` can pick a stronger backend, never `none`. Unsandboxed runs need the human's `--unsandboxed` flag or `CROSSEXAM_ALLOW_UNSANDBOXED=1` in the environment. |
| Your source and transcripts | Upload to a third party | crossexam makes no network requests. Mutation intelligence runs locally. There is no LLM call in this release. |
| Exported reports | Secrets or private code shared by accident | Secret-looking values in code and output are redacted in reports. `--no-source` drops code lines entirely. Absolute paths under your home folder are shown as `~`. |

Out of scope:

- A malicious kernel, or a container or namespace escape (0-days).
- Tests that need network access or secrets to pass. Those suites fail the baseline inside the sandbox, which is a safe failure.

## 3. Isolation backends

`--isolation auto` (the default) picks the first backend that **passes a live probe** on this machine. A binary being installed is not enough.

| Backend | Platforms | Filesystem | Network | Limits | Notes |
|---|---|---|---|---|---|
| `bwrap` (bubblewrap) | Linux | Whole system read-only. `/home`, `/root`, `/run` and `/tmp` replaced by empty tmpfs. Only the copy is writable. Dependency folders and the toolchain are re-mounted read-only. | none (new namespace) | timeout and tree kill, `ulimit -t` CPU seconds, `ulimit -d` data size, own pid namespace | Needs unprivileged user namespaces. On Ubuntu 24.04+ AppArmor may block them, so the probe fails and crossexam says so. |
| `sandbox-exec` | macOS | Writes denied outside the copy. Reads denied under your home folder, except the copy, dependency folders and toolchain. | denied | timeout and tree kill, `ulimit -t` | `sandbox-exec` is deprecated by Apple but still shipped. macOS does not enforce `ulimit -d`, so memory is only bounded by the timeout. |
| `docker` / `podman` | any OS with a Linux container engine | Only the copy is mounted (read-write). Dependencies are mounted read-only. Root filesystem is read-only. | `--network none` | `--memory`, `--cpus`, `--pids-limit`, `--cap-drop ALL`, `no-new-privileges`, non-root user on Linux | Native dependencies built for macOS or Windows won't load in a Linux container. Set `mutation.image` for your toolchain. |
| `none` (unsandboxed) | any | A temporary copy only. **Tests run with your user's permissions.** | **your network** | timeout and tree kill, credential-stripped environment | Only with `--unsandboxed` or `CROSSEXAM_ALLOW_UNSANDBOXED=1`. Every output says `NOT SANDBOXED`. Use only for code you would run with `npm test` anyway. |

**Windows.** Plain Node can't reach an unprivileged OS sandbox (AppContainer, job objects). The options are Docker Desktop (Linux containers), or an explicit `--unsandboxed` run. Without either, crossexam refuses to run mutants and explains why.

## 4. Mutation controls

- Operators are deterministic: the same diff produces the same mutants with the same ids.
- Each mutated file's SHA-256 is recorded in the report. Each mutant records its file, line, column, operator, and the exact original and replacement text.
- After every mutant, the file in the copy is restored and its hash is checked before the next one runs. A mismatch stops the run.
- Results come in four kinds: `MUTATION_KILLED`, `MUTATION_SURVIVED`, `MUTATION_INVALID` and `MUTATION_UNRESOLVED`. Only survivors are reported as findings. Invalid and unresolved mutants are counted and shown, never scored.
- Hard caps:
  - Mutants per run: `--max`, at most 500.
  - Total time: `--budget`, at most 3600 s.
  - Per-run timeout: at most 600 s.
  - Captured output per run: 200 KB.

## 5. Cleanup and failure

- The copy is deleted on success, on failure, on a timeout, and on Ctrl-C or SIGTERM. Deletion first removes every link inside it without following it, so it can never reach your real `node_modules`.
- A crash or `kill -9` can't run cleanup. Each copy carries a manifest with its owner's process id, so the next run removes copies whose owner is gone, using the same link-safe deletion.
- If a copy can't be removed safely, it is left in place. The report says where, and says cleanup was incomplete.

## 6. Test plan

The tests live in `cli/test/security.test.js` and run on Linux, macOS and Windows in CI (`.github/workflows/cli.yml`). Sandbox-only cases run wherever a backend passes its probe. When none does, they are reported as skipped, never as passed.

| Check | Where |
|---|---|
| Working tree, uncommitted and untracked changes byte-identical after a run | all |
| `HEAD`, refs, stash and index unchanged | all |
| Copy removed after success, baseline failure, a crashing test command, and a timeout | all |
| Stale copy from a killed run is removed by the next run | all |
| A timed-out run's grandchild processes are killed | all |
| `--files ../outside.js` and symlinks that escape the repo are refused | all |
| A repo config can't select `none`; `auto` without a backend refuses | all |
| A canary file in `$HOME` can't be read from a test | sandbox |
| Writing outside the copy fails | sandbox |
| Outbound network fails | sandbox |
| A canary environment secret is not visible | sandbox, and unsandboxed for credential names |
| A CPU-bound loop is stopped by the limits | sandbox |

## 7. Release criteria

Mutation intelligence is not production-ready on a platform until this suite passes there with a real sandbox backend. As of this commit:

- **Windows:** the suite runs and passes locally (no sandbox backend; refusal and unsandboxed paths covered).
- **Linux (bwrap) and macOS (sandbox-exec):** waiting on the CI matrix. Until it is green, treat those backends as unverified.
