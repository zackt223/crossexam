// More transcript readers, each normalised into the same Session shape as
// transcripts.js. Formats are the agents' own on-disk logs:
//
//   gemini   ~/.gemini/tmp/<project>/chats/session-*.json
//   cline    <editor>/User/globalStorage/<extension>/tasks/<id>/ui_messages.json
//            (Cline, Roo Code and Kilo Code share the format; any VS Code-family editor)
//   aider    <repo>/.aider.chat.history.md
//   open     the crossexam open format (docs/transcript-format.md): one JSON
//            event per line, for any agent or framework that wants in

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoOf } from './transcripts.js';

const newSession = (agent, file, id) => ({ agent, id, file, cwd: '', repo: '', model: '', startedAt: '', turns: [] });
const pushTurn = (s, prompt, at) => {
  const t = { index: s.turns.length, prompt: String(prompt || '').slice(0, 400), at, model: s.model, items: [] };
  s.turns.push(t);
  return t;
};
const lastTurn = (s, at) => s.turns.at(-1) ?? pushTurn(s, '', at);

// ---------------------------------------------------------------- discovery

/** VS Code-family editors' per-user storage roots on this OS. */
function editorRoots(home = os.homedir()) {
  const editors = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium', 'Trae', 'Kiro'];
  const base =
    process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming') : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return editors.map((e) => ({ editor: e, dir: path.join(base, e, 'User', 'globalStorage') }));
}

const CLINE_FAMILY = [
  ['saoudrizwan.claude-dev', 'cline'],
  ['rooveterinaryinc.roo-cline', 'roo-code'],
  ['kilocode.kilo-code', 'kilo-code'],
];

export function discoverMore(sinceMs = 0, home = os.homedir()) {
  const out = [];
  const fresh = (p) => {
    try {
      return fs.statSync(p).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  };
  // Gemini CLI
  const gem = path.join(home, '.gemini', 'tmp');
  if (fs.existsSync(gem)) {
    for (const proj of safeDir(gem)) {
      const chats = path.join(gem, proj, 'chats');
      for (const f of safeDir(chats)) if (f.endsWith('.json') && fresh(path.join(chats, f))) out.push({ agent: 'gemini', file: path.join(chats, f) });
    }
  }
  // Cline / Roo / Kilo in any VS Code-family editor
  for (const { dir } of editorRoots(home)) {
    for (const [ext, agent] of CLINE_FAMILY) {
      const tasks = path.join(dir, ext, 'tasks');
      for (const id of safeDir(tasks)) {
        const f = path.join(tasks, id, 'ui_messages.json');
        if (fs.existsSync(f) && fresh(f)) out.push({ agent, file: f });
      }
    }
  }
  // Open-format transcripts dropped into ~/.crossexam/transcripts by any tool
  const open = path.join(home, '.crossexam', 'transcripts');
  for (const f of safeDir(open)) if (f.endsWith('.jsonl') && fresh(path.join(open, f))) out.push({ agent: 'open', file: path.join(open, f) });
  return out;
}

/** Aider keeps history in the repo, not in a home directory. */
export function discoverAider(dirs, sinceMs = 0) {
  return dirs.map((d) => path.join(d, '.aider.chat.history.md')).filter((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs >= sinceMs).map((file) => ({ agent: 'aider', file }));
}

function safeDir(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- Gemini CLI

const GEMINI_EDITS = new Set(['replace', 'write_file', 'edit', 'smart_edit', 'write_new_file']);
const GEMINI_SEARCH = new Set(['search_file_content', 'grep', 'glob']);

export function readGeminiSession(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = newSession('gemini', file, j.sessionId || path.basename(file, '.json'));
  s.startedAt = j.startTime || '';
  for (const m of j.messages || []) {
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join('') : '';
    if (m.type === 'user') {
      if (text.trim() && !text.startsWith('/')) pushTurn(s, text, m.timestamp);
      continue;
    }
    if (m.type !== 'gemini') continue;
    const t = lastTurn(s, m.timestamp);
    if (m.model) t.model = s.model = m.model;
    if (text.trim()) t.items.push({ kind: 'text', text, at: m.timestamp });
    for (const tc of m.toolCalls || []) {
      const args = tc.args || {};
      const output = geminiOutput(tc);
      const ev = { kind: 'tool', id: tc.id, name: tc.name, command: undefined, file: args.file_path || args.absolute_path, output, isError: tc.status === 'error', exitCode: null, denied: tc.status === 'cancelled', at: tc.timestamp || m.timestamp };
      if (tc.name === 'run_shell_command') {
        ev.command = args.command;
        const dir = output.match(/^Directory:\s*(.+)$/m)?.[1];
        if (dir && !s.cwd && !/\(root\)/.test(dir)) s.cwd = dir.trim();
        const code = output.match(/^Exit Code:\s*(-?\d+)/m);
        ev.exitCode = code ? Number(code[1]) : /^Error:\s*(?!\(none\))\S/m.test(output) ? 1 : tc.status === 'success' ? 0 : null;
      } else if (GEMINI_EDITS.has(tc.name)) {
        ev.name = 'Edit';
      } else if (GEMINI_SEARCH.has(tc.name)) {
        ev.name = 'Grep';
        ev.command = `grep ${args.pattern ?? ''}`;
      }
      t.items.push(ev);
    }
  }
  if (!s.cwd && j.projectHash) s.repo = `gemini:${String(j.projectHash).slice(0, 8)}`;
  else s.repo = repoOf(s.cwd);
  return s;
}

function geminiOutput(tc) {
  const r = tc.result;
  if (Array.isArray(r)) {
    return r
      .map((x) => {
        const resp = x?.functionResponse?.response;
        return typeof resp?.output === 'string' ? resp.output : resp?.error || (resp ? JSON.stringify(resp) : '');
      })
      .join('\n');
  }
  if (typeof tc.resultDisplay === 'string') return tc.resultDisplay;
  return typeof r === 'string' ? r : '';
}

// ---------------------------------------------------------------- Cline / Roo / Kilo

const CLINE_EDIT_TOOLS = new Set(['editedExistingFile', 'newFileCreated', 'appliedDiff', 'insertContent', 'searchAndReplace', 'fileDeleted']);

export function readClineSession(file, agent = 'cline') {
  const msgs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = newSession(agent, file, path.basename(path.dirname(file)));
  // The API history carries the workspace path in its environment details.
  try {
    const api = fs.readFileSync(path.join(path.dirname(file), 'api_conversation_history.json'), 'utf8');
    const cwd = api.match(/Current Working Directory \(([^)]+)\)/)?.[1];
    if (cwd) s.cwd = cwd.replace(/\\\\/g, '\\');
  } catch {}
  let lastCmd = null;
  for (const m of Array.isArray(msgs) ? msgs : []) {
    const at = m.ts ? new Date(m.ts).toISOString() : '';
    if (!s.startedAt && at) s.startedAt = at;
    const kind = m.type === 'say' ? m.say : m.ask;
    const text = m.text || '';
    if (kind === 'task' || kind === 'user_feedback') {
      pushTurn(s, text, at);
      lastCmd = null;
    } else if (kind === 'command') {
      // Commands needing approval arrive as ask, auto-approved ones as say; don't double count.
      if (lastCmd && lastCmd.command === text && !lastCmd.output) continue;
      lastCmd = { kind: 'tool', id: String(m.ts), name: 'execute_command', command: text.replace(/\s*COMMAND_OUTPUT_STRING[\s\S]*$/, ''), output: '', isError: false, exitCode: null, denied: false, at };
      lastTurn(s, at).items.push(lastCmd);
    } else if (kind === 'command_output') {
      if (lastCmd) {
        lastCmd.output += text;
        const code = text.match(/exit(?:ed)? (?:with )?code:?\s*(-?\d+)/i);
        if (code) lastCmd.exitCode = Number(code[1]);
      }
    } else if (kind === 'tool') {
      let tool = {};
      try {
        tool = JSON.parse(text);
      } catch {}
      if (CLINE_EDIT_TOOLS.has(tool.tool)) lastTurn(s, at).items.push({ kind: 'tool', id: String(m.ts), name: 'Edit', file: tool.path, output: '', isError: false, exitCode: null, denied: false, at });
      if (tool.tool === 'searchFiles') lastTurn(s, at).items.push({ kind: 'tool', id: String(m.ts), name: 'Grep', command: `grep ${tool.regex ?? ''}`, output: tool.content || '', isError: false, exitCode: null, denied: false, at });
    } else if ((kind === 'text' || kind === 'completion_result') && text.trim() && m.type === 'say') {
      lastTurn(s, at).items.push({ kind: 'text', text, at });
    } else if (kind === 'api_req_started') {
      try {
        const info = JSON.parse(text);
        if (info.model) s.model = lastTurn(s, at).model = info.model;
      } catch {}
    }
  }
  s.repo = repoOf(s.cwd);
  return s;
}

// ---------------------------------------------------------------- Aider

export function readAiderSession(file) {
  const s = newSession('aider', file, 'aider-' + path.basename(path.dirname(file)));
  s.cwd = path.dirname(file);
  s.repo = repoOf(s.cwd);
  let at = '';
  let text = [];
  let cmd = null;
  const flushText = () => {
    const t = text.join('\n').trim();
    if (t) lastTurn(s, at).items.push({ kind: 'text', text: t, at });
    text = [];
  };
  const startCmd = (command) => {
    flushText();
    cmd = { kind: 'tool', id: `${s.turns.length}:${command}`, name: 'run', command, output: '', isError: false, exitCode: null, denied: false, at };
    lastTurn(s, at).items.push(cmd);
  };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const started = line.match(/^# aider chat started at (.+)$/);
    if (started) {
      flushText();
      const d = new Date(started[1].replace(' ', 'T'));
      at = Number.isNaN(d.getTime()) ? '' : d.toISOString();
      if (!s.startedAt) s.startedAt = at;
      cmd = null;
      continue;
    }
    const user = line.match(/^#### (.*)$/);
    if (user) {
      flushText();
      const u = user[1];
      const run = u.match(/^\/(?:run|test|lint)\s+(.+)$/) || u.match(/^!\s*(.+)$/);
      if (run) {
        startCmd(run[1]);
        continue;
      }
      pushTurn(s, u, at);
      cmd = null;
      continue;
    }
    if (line.startsWith('> ') || line === '>') {
      const q = line.slice(2);
      const running = q.match(/^Running (.+)$/);
      const edited = q.match(/^Applied edit to (.+)$/);
      if (running) startCmd(running[1]);
      else if (edited) {
        flushText();
        lastTurn(s, at).items.push({ kind: 'tool', id: `${s.turns.length}:edit:${edited[1]}`, name: 'Edit', file: edited[1], output: '', isError: false, exitCode: null, denied: false, at });
        cmd = null;
      } else if (cmd && !/^(Add command output to the chat|Tokens:|Commit [0-9a-f]{7}|Added \d+ lines? of output)/.test(q)) cmd.output += q + '\n';
      continue;
    }
    // Aider puts a blank line between a command and its quoted output.
    if (line.trim()) cmd = null;
    text.push(line);
  }
  flushText();
  return s;
}

// ---------------------------------------------------------------- open format

/**
 * {"type":"session","agent":"my-agent","model":"x","cwd":"/repo"}
 * {"type":"prompt","text":"fix the bug"}
 * {"type":"command","command":"npm test","exit_code":1,"output":"..."}
 * {"type":"edit","path":"src/a.ts"}
 * {"type":"search","pattern":"getUserById","output":""}
 * {"type":"message","text":"All tests pass."}
 */
export function readOpenSession(file) {
  const s = newSession('open', file, path.basename(file, '.jsonl'));
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = e.at || e.timestamp || '';
    if (!s.startedAt && at) s.startedAt = at;
    if (e.type === 'session') {
      if (e.agent) s.agent = String(e.agent);
      if (e.model) s.model = String(e.model);
      if (e.cwd) s.cwd = String(e.cwd);
      if (e.id) s.id = String(e.id);
    } else if (e.type === 'prompt') pushTurn(s, e.text, at);
    else if (e.type === 'message') lastTurn(s, at).items.push({ kind: 'text', text: String(e.text || ''), at });
    else if (e.type === 'command') {
      const code = e.exit_code ?? e.exitCode;
      lastTurn(s, at).items.push({ kind: 'tool', id: String(++n), name: 'command', command: String(e.command || ''), output: String(e.output || ''), isError: code != null && code !== 0, exitCode: code ?? null, denied: !!e.denied, at });
    } else if (e.type === 'edit') lastTurn(s, at).items.push({ kind: 'tool', id: String(++n), name: 'Edit', file: e.path, output: '', isError: false, exitCode: null, denied: false, at });
    else if (e.type === 'search') lastTurn(s, at).items.push({ kind: 'tool', id: String(++n), name: 'Grep', command: `grep ${e.pattern ?? ''}`, output: String(e.output || ''), isError: false, exitCode: e.exit_code ?? null, denied: false, at });
    if (e.model && s.turns.length) s.turns.at(-1).model = String(e.model);
  }
  s.repo = repoOf(s.cwd);
  return s;
}
