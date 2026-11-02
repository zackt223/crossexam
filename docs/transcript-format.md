# The crossexam open transcript format

crossexam reads Claude Code, Codex, Gemini CLI, Cline, Roo Code, Kilo Code and Aider transcripts as they are. Any other agent, framework or internal tool can be checked by writing this format: one JSON object per line, in the order things happened.

```jsonl
{"type":"session","agent":"my-agent","model":"gpt-5","cwd":"/work/api"}
{"type":"prompt","text":"bump zod and fix the schema types"}
{"type":"command","command":"pnpm add zod@3.23.8","exit_code":0,"output":"+ zod 3.23.8"}
{"type":"edit","path":"src/schema.ts"}
{"type":"command","command":"pnpm test","exit_code":1,"output":"Tests: 1 failed, 39 passed"}
{"type":"search","pattern":"oldHelper","output":""}
{"type":"message","text":"Bumped `zod` to 3.23.8. All tests pass."}
```

| type | fields | notes |
|---|---|---|
| `session` | `agent`, `model`, `cwd`, `id` | optional, first line. `agent` is how it appears on the dashboard |
| `prompt` | `text` | starts a new turn |
| `command` | `command`, `exit_code`, `output`, `denied` | include `exit_code` whenever you have it, because a run without one can only be judged from its output |
| `edit` | `path` | any file change |
| `search` | `pattern`, `output`, `exit_code` | backs "all callers updated" claims |
| `message` | `text` | what the agent told the user; this is where claims are found |

Every line may carry `at` (an ISO timestamp) and `model`.

Drop files into `~/.crossexam/transcripts/*.jsonl` and `crossexam scan` picks them up, or check one directly:

```bash
crossexam scan --agent open --file run.jsonl
```

## Wrappers for popular SDKs

The format maps directly onto agent SDK event streams:

- **OpenAI Agents SDK / Responses API**: `function_call` + `function_call_output` → `command`; the final `message` → `message`.
- **Anthropic SDK / Claude Agent SDK**: `tool_use` + `tool_result` (`is_error`) → `command`; final assistant `text` → `message`.
- **LangGraph / LangChain**: tool start/end callbacks → `command`; the last AI message → `message`.
