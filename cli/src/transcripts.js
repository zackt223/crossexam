// Readers for agent transcripts. Each agent writes its own format; all of
// them are normalised into the same Session shape so the verifier stays
// neutral about who did the work.
//
// Session = { agent, id, file, cwd, repo, model, startedAt, turns: Turn[] }
// Turn    = { index, prompt, at, model, items: Item[] }
// Item    = { kind: 'text', text, at } | { kind: 'tool', id, name, command, output, isError, exitCode, denied, at }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { readAiderSession, readClineSession, readGeminiSession, readOpenSession } from './readers.js';

export function defaultSources(home = os.homedir()) {
  return [
    { agent: 'claude-code', root: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects') },
    { agent: 'codex', root: path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions') },
  ];
}

export function findTranscripts(root, sinceMs = 0) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir, depth) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Claude Code keeps subagent runs under <session>/subagents; their claims
        // are checked by the parent turn that reports them.
        if (depth < 5 && ent.name !== 'subagents' && ent.name !== 'tool-results') walk(p, depth + 1);
      } else if (ent.name.endsWith('.jsonl')) {
        const st = fs.statSync(p);
        if (st.mtimeMs >= sinceMs) out.push(p);
      }
    }
  };
  walk(root, 0);
  return out;
}

async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* torn final line while the agent is still writing */
    }
  }
}

export function repoOf(cwd = '') {
  const norm = cwd.replace(/\\/g, '/').replace(/\/\.claude\/worktrees\/[^/]+.*$/, '').replace(/\/+$/, '');
  return norm.split('/').pop() || 'unknown';
}

const DENIED = /doesn't want to proceed|was rejected|permission to use .* (?:was )?denied|requires approval|tool use was rejected/i;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
  return '';
}

function commandOf(name, input = {}) {
  if (typeof input.command === 'string') return input.command;
  if (Array.isArray(input.command)) return input.command.join(' ');
  if (name === 'Grep') return `grep ${input.pattern ?? ''} ${input.path ?? ''}`.trim();
  if (name === 'Glob') return `glob ${input.pattern ?? ''}`;
  return undefined;
}

/** Claude Code: ~/.claude/projects/<project>/<session>.jsonl */
export async function readClaudeSession(file) {
  const s = { agent: 'claude-code', id: path.basename(file, '.jsonl'), file, cwd: '', repo: '', model: '', startedAt: '', turns: [] };
  const byId = new Map();
  let turn = null;
  const newTurn = (prompt, at) => {
    turn = { index: s.turns.length, prompt: prompt.slice(0, 400), at, model: '', items: [] };
    s.turns.push(turn);
  };

  for await (const o of lines(file)) {
    if (o.isSidechain) continue;
    if (o.cwd && !s.cwd) s.cwd = o.cwd;
    if (o.timestamp && !s.startedAt) s.startedAt = o.timestamp;
    const msg = o.message;
    if (o.type === 'user' && msg) {
      const blocks = Array.isArray(msg.content) ? msg.content : null;
      const results = blocks?.filter((b) => b.type === 'tool_result') ?? [];
      if (results.length) {
        for (const r of results) {
          const ev = byId.get(r.tool_use_id);
          if (!ev) continue;
          const out = textOf(r.content);
          ev.output = out.length > 20000 ? out.slice(0, 4000) + '\n…\n' + out.slice(-12000) : out;
          ev.isError = !!r.is_error;
          const code = out.match(/^Exit code (-?\d+)/);
          // Claude Code's shell tools only flag an error on a non-zero exit.
          ev.exitCode = code ? Number(code[1]) : ev.isError ? null : ev.command ? 0 : null;
          ev.denied = ev.isError && DENIED.test(out.slice(0, 300));
        }
      } else if (!o.isMeta) {
        const prompt = textOf(msg.content);
        if (prompt.trim()) newTurn(prompt, o.timestamp);
      }
    } else if (o.type === 'assistant' && msg && Array.isArray(msg.content)) {
      if (!turn) newTurn('', o.timestamp);
      if (msg.model && msg.model !== '<synthetic>') {
        turn.model = msg.model;
        s.model = msg.model;
      }
      for (const b of msg.content) {
        if (b.type === 'text' && b.text?.trim()) turn.items.push({ kind: 'text', text: b.text, at: o.timestamp });
        if (b.type === 'tool_use') {
          const ev = { kind: 'tool', id: b.id, name: b.name, command: commandOf(b.name, b.input), file: b.input?.file_path || b.input?.notebook_path, output: '', isError: false, exitCode: null, denied: false, at: o.timestamp };
          byId.set(b.id, ev);
          turn.items.push(ev);
        }
      }
    }
  }
  s.repo = repoOf(s.cwd);
  return s;
}

/** Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (wrapped and legacy rows). */
export async function readCodexSession(file) {
  const s = { agent: 'codex', id: path.basename(file, '.jsonl'), file, cwd: '', repo: '', model: '', startedAt: '', turns: [] };
  const byId = new Map();
  let turn = null;
  const newTurn = (prompt, at) => {
    turn = { index: s.turns.length, prompt: prompt.slice(0, 400), at, model: s.model, items: [] };
    s.turns.push(turn);
  };

  for await (const o of lines(file)) {
    const at = o.timestamp;
    if (at && !s.startedAt) s.startedAt = at;
    const p = o.payload ?? o;
    if (o.type === 'turn_context') {
      if (p.model) s.model = p.model;
      if (turn && p.model) turn.model = p.model;
      s.cwd ||= p.cwd || '';
      continue;
    }
    if (o.type === 'session_meta' || (p.cwd && !p.type)) {
      s.cwd ||= p.cwd || '';
      s.id = p.id || s.id;
      continue;
    }
    if (p.type === 'message') {
      const text = textOf(p.content);
      if (p.role === 'user') {
        if (/^\s*<(environment_context|user_instructions|permissions)/.test(text)) continue;
        if (text.trim()) newTurn(text, at);
      } else if (p.role === 'assistant' && text.trim()) {
        if (!turn) newTurn('', at);
        turn.items.push({ kind: 'text', text, at });
      }
    } else if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
      if (!turn) newTurn('', at);
      let args = {};
      try {
        args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments || p.action || {};
      } catch {
        args = {};
      }
      if (p.action?.command) args = p.action;
      const cmd = Array.isArray(args.command) ? unwrapShell(args.command) : args.command || args.cmd;
      const name = p.name === 'apply_patch' || (typeof p.input === 'string' && p.input.includes('*** Begin Patch')) ? 'apply_patch' : p.name || 'shell';
      const ev = { kind: 'tool', id: p.call_id || p.id, name, command: name === 'apply_patch' ? undefined : cmd, output: '', isError: false, exitCode: null, denied: false, at };
      byId.set(ev.id, ev);
      turn.items.push(ev);
    } else if (p.type === 'function_call_output' || p.type === 'local_shell_call_output' || p.type === 'custom_tool_call_output') {
      const ev = byId.get(p.call_id);
      if (!ev) continue;
      let out = p.output;
      let code = null;
      if (typeof out === 'string') {
        try {
          const j = JSON.parse(out);
          out = j.output ?? out;
          code = j.metadata?.exit_code ?? null;
        } catch {
          const m = out.match(/Exit code:\s*(-?\d+)/i);
          if (m) code = Number(m[1]);
        }
      } else if (out && typeof out === 'object') {
        code = out.metadata?.exit_code ?? null;
        out = out.output ?? out.content ?? '';
      }
      ev.output = String(out ?? '');
      ev.exitCode = code;
      ev.isError = code != null && code !== 0;
      ev.denied = DENIED.test(ev.output.slice(0, 300));
    }
  }
  s.repo = repoOf(s.cwd);
  return s;
}

function unwrapShell(argv) {
  // ["bash","-lc","npm test"] -> "npm test"
  if (argv.length >= 3 && /(?:ba|z)?sh$|pwsh|powershell/i.test(argv[0]) && /^-l?c$|^-Command$/i.test(argv[1])) return argv.slice(2).join(' ');
  return argv.join(' ');
}

export const AGENTS = ['claude-code', 'codex', 'gemini', 'cline', 'roo-code', 'kilo-code', 'aider', 'open'];

export async function readSession(agent, file) {
  switch (agent) {
    case 'codex':
      return readCodexSession(file);
    case 'gemini':
      return readGeminiSession(file);
    case 'cline':
    case 'roo-code':
    case 'kilo-code':
      return readClineSession(file, agent);
    case 'aider':
      return readAiderSession(file);
    case 'open':
      return readOpenSession(file);
    default:
      return readClaudeSession(file);
  }
}
