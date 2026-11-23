# What a run would send to crossexam cloud

crossexam cloud isn't open yet, and **the CLI has no code that sends anything.** This page describes the format a run *will* send once it is open, so you can check it ahead of time. Uploading will always be opt-in: the Action's `cloud: true` input, or an explicit command.

```bash
crossexam verify "All tests pass." --json > verify.json
crossexam mutate --json mutate.json
crossexam upload --dry-run --report verify.json --report mutate.json   # prints the payload, sends nothing
crossexam upload --dry-run --report mutate.json --source none          # without any code lines
```

`crossexam upload` without `--dry-run` refuses and says so.

## What's in it

The format is `crossexam.upload/v1`, described in [upload.schema.json](upload.schema.json).

| Field | What | Where it comes from |
|---|---|---|
| `claims[]` | kind, the claim sentence, verdict, reason, the command that was run, its exit code, and a short excerpt of its output (at most 2 KB) | `crossexam verify` |
| `mutation.summary` | attempted, killed, survived, invalid, unresolved, score, time | `crossexam mutate` / `verify --mutate` |
| `mutation.mutants[]` | file, line, function, operator, status, the explanation, and a **fingerprint**. Also the changed line before and after, unless the source policy is `none` | the same |
| `mutation.files[]` | file, language, number of changed lines, number of mutants, content hash | the same |
| `github` | repository and its id, run id and attempt, event, commit, ref. For pull requests: number, title, author login, head and base refs, and whether it's from a fork | the GitHub Actions environment |
| `agent` | the agent behind the change, when it can be told | `--agent`, or the PR author or signature |

## What's never in it

- **Absolute paths.** Paths inside the repository become relative, and the home folder becomes `~`. Any other absolute path is replaced with `[path]`. The working directory, which `verify --json` includes, is dropped.
- **Secret-looking values** (API keys, tokens, private keys, `password = "…"`), wherever they appear: they become `[redacted]`. Claim-check output is redacted before it's even written, so terminal output, PR summaries and JSON reports are covered too.
- **Environment variables, the PR description, transcripts, or any file other than the changed lines.**
- **Code**, under `--source none`. Only fingerprints, operators and line numbers remain.

## Limits

| Item | Limit |
|---|---|
| Claims | 100 |
| Mutants | 500 |
| Files | 300 |
| Output excerpt | 2 KB |
| Each code line | 400 characters |
| Other text | 600 characters |
| The whole payload | 2 MB |

Over the size limit, the dry run stops and tells you to run fewer mutants or use `--source none`.

## Fingerprints

A fingerprint is a hash of the file, function, operator, original and replacement text, and the changed line with its whitespace collapsed. It stays the same when the line moves, so a decision like "equivalent" or "accepted risk" carries over to later runs of the same code.
