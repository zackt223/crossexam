# Mutation intelligence

> An agent should not get full credit just because its own tests pass.

crossexam already answers a **factual** question: did the check the agent cites actually pass? Mutation intelligence answers a separate **quality** question: would those tests notice if the code were wrong?

It works by planting small, deliberate defects (mutants) in the code the agent changed, then running the repo's own tests against each one. If the tests still pass with a defect in place, that behaviour is not really being tested.

The two answers are kept apart. A "tests pass" claim can be `verified` (they did pass) and still carry a `weak` test-strength warning (they would also have passed with a bug in place). A mutation score is not a measure of correctness. It only says how much of the changed behaviour the existing tests pin down.

## 1. Where it plugs into the existing architecture

| Existing piece | File | What mutation intelligence adds |
|---|---|---|
| Claim detector | `cli/src/claims.js` | `detectWorkClaims()` finds "implemented / fixed / added" sentences. These are triggers only, not a new verdict kind, so the factual stats are unchanged. |
| Repo checks | `cli/src/live.js` `detectCommands` | The test command (or `mutation.testCommand` in `crossexam.json`) is the oracle. |
| Run judging | `cli/src/evidence.js` `judgeRun` | Classifies each mutant run. |
| Live verify | `verifyText` / `crossexam verify --mutate` | Attaches a `quality` block to `tests` results. The verdict is untouched. |
| MCP server | `cli/src/mcp.js` | Adds an `assess_test_strength` tool and `verify_claims {mutate: true}`. |
| Evidence ledger | `~/.crossexam/ledger.jsonl` | Appends `{type: "mutation"}` records. |
| Reliability history | `crossexam scan` → report | Adds `report.mutation`: test strength by agent and repo, read from the ledger. |
| Exports | `scan --json`, dashboard CSV/JSON | Adds `crossexam mutate --json --csv`. The dashboard exports mutants as CSV and JSON. |
| Review routing | `web/src/app/Routing.tsx` | Policy: verified tests with weak test strength go to standard review, not auto-merge. |
| GitHub Action | `action.yml`, `cli/src/github.js` | Optional `mutate` input, a `mutation-score` output, and a summary section. |
| Dashboard | `web/src/app` | A new **test strength** view. |

New modules:

- `cli/src/mutate.js`: operators, string and comment masking, function boundaries, and mutant generation (pure, no I/O).
- `cli/src/sandbox.js`: the isolated copy, scrubbed environment, process-tree timeouts, and the optional Docker runner.
- `cli/src/strength.js`: orchestration (changed lines, baseline, run loop, cache, report).
- `cli/src/scenarios.js`: opt-in LLM test scenarios, validated by execution.

## 2. Pipeline

1. **Scope.** Changed files and lines come from `git diff -U0 <base>` plus untracked files, or from `--files`. Test files, generated files and unsupported languages are dropped.
2. **Functions.** Each changed line is mapped to its enclosing function. Function bodies are found by brace matching on code with strings and comments masked out.
3. **Associated tests.** These are test files that import the changed module or name a changed function (`git grep`). The list is reported so a reviewer can see what is supposed to cover the change.
4. **Mutants.** Deterministic operators are applied only on changed lines. Results are de-duplicated, spread round-robin across functions, and capped (default 25).
5. **Isolation.** The repo is copied to a temp directory outside the working tree (`git ls-files -co --exclude-standard`), and dependency folders are linked rather than copied. The user's files are hashed before and after the run, and the report states whether they were untouched.
6. **Baseline.** The test command runs once on the unmutated copy. If it fails, nothing is mutated: a red suite cannot detect anything, so every mutant would be meaningless.
7. **Run.** For each mutant, crossexam writes it, runs the tests with a timeout, restores the original, and checks the restore by hash.
8. **Classify** each mutant:
   - `MUTATION_KILLED`: the tests failed.
   - `MUTATION_SURVIVED`: the tests passed with the defect in place.
   - `MUTATION_INVALID`: the change was a syntax error, a compile or transform error, or a no-op.
   - `MUTATION_UNRESOLVED`: a timeout, a spawn error, or the budget ran out mid-run.
9. **Report.**
   - Score is `killed / (killed + survived)`. Invalid and unresolved mutants are excluded and reported separately.
   - Each survivor comes with a plain-language explanation of what behaviour went untested.

## 3. Operators (MVP: JavaScript and TypeScript)

| id | change | a survivor means |
|---|---|---|
| `boundary` | `<` ↔ `<=`, `>` ↔ `>=` | no test sits exactly on the boundary |
| `equality` | `===` ↔ `!==`, `==` ↔ `!=` | the comparison's outcome isn't asserted |
| `logical` | `&&` ↔ `\|\|` | the two conditions are never tested apart |
| `negate-condition` | `if (x)` → `if (!(x))` | neither branch of the `if` is pinned down |
| `remove-not` | `!x` → `x` | the negated case isn't tested |
| `boolean` | `true` ↔ `false` | the flag or return value isn't asserted |
| `arithmetic` | `+` ↔ `-`, `*` ↔ `/`, `%` → `*` | the computed value isn't checked exactly |
| `update` | `++` ↔ `--`, `+=` ↔ `-=` | the counter or accumulator isn't checked |

Binary operators only match with whitespace on both sides (`a < b`). This keeps generics (`Array<T>`), arrows (`=>`) and JSX tags out of scope.

## 4. Safety and performance

The full threat model, the isolation backends and the security tests are in [mutation-security.md](mutation-security.md). In short:

- **The working tree is never touched.** Mutants are only written inside a disposable copy, which is deleted afterwards, including on Ctrl-C or SIGTERM, and swept on the next run after a crash. Every file hash, `HEAD`, refs, stash and status are compared before and after the run.
- **Tests run in a sandbox, or not at all.**
  - `auto` picks a backend that passes a live probe: bubblewrap on Linux, `sandbox-exec` on macOS, or Docker/Podman.
  - With no working backend (for example on Windows without Docker), crossexam refuses to run any mutant.
  - `--unsandboxed` is an explicit, labelled opt-in, and a repository's own config can't select it.
- **Secrets.** Sandboxed runs get an allowlisted environment and an empty `HOME`. Unsandboxed runs strip credential-like variables. Reports redact secret-looking values.
- **Limits:**
  - `--max` caps the number of mutants (default 25).
  - `--budget` caps total seconds (default 300).
  - Each mutant times out at 3× the baseline plus 5 s.
  - Output is capped.
  - A timeout kills the whole process tree.
- **Incremental.** Results are cached in `~/.crossexam/mutation-cache/`, keyed by file content, mutant, test command and a hash of the test files. Re-running after a small change only executes the new mutants.
- **No LLM calls in this release.** AI-assisted test scenarios (M3 below) are not built yet. When they are, they will be opt-in, disclosed, and only run after the deterministic pass.

## 5. Language support and limitations

- **MVP: JavaScript and TypeScript** (`.js .mjs .cjs .jsx .ts .tsx .mts .cts`), with any test runner the repo's test command uses: `node --test`, vitest, jest, mocha and so on.
  - `node --check` catches invalid `.js` mutants before running anything.
  - For TS and JSX, compile and transform errors in the test output mark a mutant invalid.
- **Not yet:** Python, Go, Rust, Java and the rest. Their files are listed as skipped, never silently ignored. Python is next: the masking and operator tables are designed to take a second language.
- **Function detection is lexical, not a full parser.** Exotic syntax can map a line to the wrong function name. The line number is always exact.
- **The whole test command runs per mutant.** Runner-specific narrowing (`vitest related`, `jest --findRelatedTests`) is a later milestone.
- **Equivalent mutants** (a change that cannot alter behaviour) are not detected automatically. A survivor is a lead for a reviewer, not proof of a gap.
- **Flaky suites** can make a mutant look killed. The baseline must pass first, but flakiness during the run is not re-checked yet.

## 6. Milestones

1. **M1 engine:**
   - Operators, masking, function mapping, the isolated copy, baseline, the run loop, classification, the cache, and the `crossexam mutate` terminal report with JSON and CSV output.
   - Tested on crossexam's own CLI (`node --test`) and two real vitest repos.
2. **M2 integration:** `verify --mutate`, work-claim triggers, the MCP tool, ledger records, `scan` history, the GitHub Action input and summary, and tests.
3. **M3 scenarios:**
   - An opt-in independent LLM (Anthropic API, or any CLI that reads a prompt on stdin) proposes edge cases.
   - Each proposed test runs inside the copy. It must pass on the current code and kill at least one survivor before it is reported as *validated*.
   - A test that fails on current code is reported as a disagreement for a human, never as a bug.
4. **M4 dashboard:** a test strength view with the headline finding first, the killed/survived breakdown, per-function bars, expandable mutant evidence, CSV and JSON export, and a routing policy threshold.
