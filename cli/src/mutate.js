// Mutation operators: plant small, deterministic defects in changed code.
//
// Pure functions, no I/O. The engine works on a "masked" copy of the source
// in which strings, template literals, comments and regex literals are blanked
// out (same length, newlines kept), so an operator never fires inside text and
// every offset in the masked copy is also an offset in the original.

export const CODE_EXT = /\.(?:py|go|rs|java|kt|kts|rb|swift|cs|php|c|cc|cpp|h|hpp|scala|ex|exs|dart|vue|svelte|lua|r|jl)$/i;
export const JS_EXT = /\.(?:[cm]?jsx?|[cm]?tsx?)$/i;
export const TEST_FILE = /(?:^|[\\/])(?:__tests__|__mocks__|tests?|spec|e2e|fixtures?)[\\/]|[._-](?:test|spec)\.[cm]?[jt]sx?$/i;
const SKIP_FILE = /(?:^|[\\/])(?:node_modules|dist|build|out|coverage|\.next|\.nuxt|vendor)[\\/]|\.d\.[cm]?ts$|\.min\.js$|(?:^|[\\/])(?:vite|vitest|jest|webpack|rollup|babel|eslint|prettier|tailwind|postcss|next|svelte)\.config\.[cm]?[jt]s$/i;

/** Why a file is or isn't mutated. */
export function classifyFile(file) {
  if (TEST_FILE.test(file)) return { ok: false, reason: 'test file' };
  if (SKIP_FILE.test(file)) return { ok: false, reason: 'generated, vendored or config' };
  if (!JS_EXT.test(file)) return CODE_EXT.test(file) ? { ok: false, reason: 'language not supported yet' } : { ok: false, reason: 'not source code', quiet: true };
  return { ok: true, language: /tsx?$/i.test(file) ? 'typescript' : 'javascript' };
}

// ---------- masking ----------

const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]$/;
const REGEX_KEYWORD = /\b(?:return|typeof|case|in|of|new|delete|void|throw|yield|await|else|do)$/;

/** Blank out strings, templates, comments and regex literals (JS/TS). */
export function maskJs(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  // Last significant (unmasked, non-space) text, to tell regex from division.
  const prevSig = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    return out.slice(Math.max(0, k - 12), k + 1).join('');
  };

  const skipTemplate = (start) => {
    // start is at the opening backtick; returns index after the closing one.
    let k = start + 1;
    while (k < n) {
      const ch = src[k];
      if (ch === '\\') k += 2;
      else if (ch === '`') return k + 1;
      else if (ch === '$' && src[k + 1] === '{') {
        k = skipExpr(k + 2);
      } else k++;
    }
    return n;
  };
  const skipQuoted = (start, q) => {
    let k = start + 1;
    while (k < n && src[k] !== q && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
    return Math.min(n, k + 1);
  };
  const skipExpr = (start) => {
    // inside ${ … }: balance braces, honouring nested strings and templates.
    let depth = 1;
    let k = start;
    while (k < n && depth > 0) {
      const ch = src[k];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '`') {
        k = skipTemplate(k);
        continue;
      } else if (ch === '"' || ch === "'") {
        k = skipQuoted(k, ch);
        continue;
      }
      k++;
    }
    return k;
  };

  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    if (ch === '/' && nx === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
    } else if (ch === '/' && nx === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (ch === '"' || ch === "'") {
      const end = skipQuoted(i, ch);
      blank(i, end);
      i = end;
    } else if (ch === '`') {
      const end = skipTemplate(i);
      blank(i, end);
      i = end;
    } else if (ch === '/') {
      const before = prevSig(i);
      if (before === '' || REGEX_BEFORE.test(before) || REGEX_KEYWORD.test(before)) {
        let k = i + 1;
        let cls = false;
        while (k < n && src[k] !== '\n') {
          if (src[k] === '\\') k += 2;
          else if (src[k] === '[') (cls = true), k++;
          else if (src[k] === ']') (cls = false), k++;
          else if (src[k] === '/' && !cls) break;
          else k++;
        }
        if (src[k] === '/') {
          k++;
          while (k < n && /[a-z]/i.test(src[k])) k++;
          blank(i, k);
          i = k;
        } else i++;
      } else i++;
    } else i++;
  }
  return out.join('');
}

// ---------- lines ----------

export function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

export function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---------- functions ----------

const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'constructor', 'super', 'typeof', 'new', 'await', 'import', 'export']);

function matchClose(masked, open) {
  const pair = { '(': ')', '{': '}', '[': ']' }[masked[open]];
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const ch = masked[k];
    if (ch === masked[open]) depth++;
    else if (ch === pair && --depth === 0) return k;
  }
  return -1;
}

/**
 * Named function-like ranges in JS/TS. Lexical, not a full parser: good enough
 * to say which function a changed line belongs to.
 * @returns {{name: string, line: number, start: number, end: number}[]}
 */
export function findFunctions(masked) {
  const starts = lineStarts(masked);
  const found = [];
  const add = (name, at, bodyFrom) => {
    if (!name || NOT_A_NAME.has(name)) return;
    const range = bodyRange(masked, bodyFrom);
    if (range) found.push({ name, line: lineOf(starts, at), start: at, end: range });
  };

  // function foo(…) {   async function* foo<T>(…) {
  for (const m of masked.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>{]*>)?\s*\(/g)) {
    add(m[1], m.index, m.index + m[0].length - 1);
  }
  // const foo = (…) => …   const foo = async x => …   const foo = function (…) {
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?=function\b|\(|[A-Za-z_$][\w$]*\s*=>|<)/g)) {
    add(m[1], m.index, m.index + m[0].length);
  }
  // foo: (…) => …   foo: function (…) {
  for (const m of masked.matchAll(/(?<![\w$.?])([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?=function\b|\([^()]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g)) {
    add(m[1], m.index, m.index + m[0].length);
  }
  // class / object methods:   async foo(…) {   static get bar() {   foo<T>(…): Type {
  for (const m of masked.matchAll(/^[ \t]*(?:(?:public|private|protected|static|async|override|readonly|get|set|abstract)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>\n]*>)?\s*\(/gm)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close < 0) continue;
    // Only a method if a body brace follows the parameter list (allowing a return type).
    const tail = masked.slice(close + 1, close + 200).match(/^\s*(?::\s*[^{;]+?)?\s*\{/);
    if (tail) add(m[1], m.index + m[0].indexOf(m[1]), open);
  }

  // Dedupe by start, innermost-first lookups come from sorting by size.
  const byStart = new Map();
  for (const f of found) if (!byStart.has(f.start) || byStart.get(f.start).end < f.end) byStart.set(f.start, f);
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/** From somewhere in a function header, find where its body ends. */
function bodyRange(masked, from) {
  let k = from;
  // Skip a parameter list if we're on one.
  while (k < masked.length && /\s/.test(masked[k])) k++;
  if (masked.startsWith('function', k)) {
    const p = masked.indexOf('(', k);
    if (p < 0) return null;
    k = p;
  }
  if (masked[k] === '<') {
    // generic arrow: <T,>(…) =>
    const p = masked.indexOf('(', k);
    if (p < 0) return null;
    k = p;
  }
  if (masked[k] === '(') {
    const close = matchClose(masked, k);
    if (close < 0) return null;
    k = close + 1;
  } else {
    // single-parameter arrow: x => …
    const m = masked.slice(k).match(/^[A-Za-z_$][\w$]*\s*/);
    if (m) k += m[0].length;
  }
  // Return type annotation, arrow, then the body.
  const rest = masked.slice(k, k + 400);
  const arrow = rest.match(/^\s*(?::\s*[^={;]+?)?\s*=>\s*/);
  if (arrow) {
    k += arrow[0].length;
    if (masked[k] === '{') return matchClose(masked, k);
    return expressionEnd(masked, k);
  }
  const brace = rest.match(/^\s*(?::\s*[^{;]+?)?\s*\{/);
  if (brace) {
    const open = k + brace[0].length - 1;
    return matchClose(masked, open);
  }
  return null;
}

function expressionEnd(masked, from) {
  let depth = 0;
  for (let k = from; k < masked.length; k++) {
    const ch = masked[k];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return k;
      depth--;
    } else if (depth === 0 && (ch === ';' || ch === ',')) return k;
    else if (depth === 0 && ch === '\n' && !/^\s*[.?:+\-*/&|]/.test(masked.slice(k + 1, k + 40))) {
      // a newline ends the expression unless the next line continues it
      const before = masked.slice(from, k).trim();
      if (before && !/[=(,:?+\-*/&|]$/.test(before)) return k;
    }
  }
  return masked.length;
}

export function enclosingFunction(fns, offset) {
  let best = null;
  for (const f of fns) if (f.start <= offset && offset <= f.end && (!best || f.end - f.start < best.end - best.start)) best = f;
  return best;
}

// ---------- operators ----------

const SWAP = (map) => (s) => map[s];

export const OPERATORS = [
  {
    id: 'boundary',
    label: 'boundary',
    re: /(?<=\s)(<=|>=|<|>)(?=\s)/g,
    swap: SWAP({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' }),
    why: 'no test sits exactly on the boundary',
  },
  {
    id: 'equality',
    label: 'equality',
    re: /(?<=\s)(===|!==|==|!=)(?=\s)/g,
    swap: SWAP({ '===': '!==', '!==': '===', '==': '!=', '!=': '==' }),
    why: 'the outcome of this comparison is never asserted',
  },
  {
    id: 'logical',
    label: 'logical',
    re: /(?<=\s)(&&|\|\|)(?=\s)/g,
    swap: SWAP({ '&&': '||', '||': '&&' }),
    why: 'the two conditions are never tested apart',
  },
  {
    id: 'remove-not',
    label: 'negation',
    re: /(?<![!=\w$)\]])(!)(?=[\w$(])/g,
    swap: () => '',
    why: 'the negated case is not tested',
  },
  {
    id: 'boolean',
    label: 'boolean',
    re: /(?<![.\w$])(true|false)(?![\w$])/g,
    swap: SWAP({ true: 'false', false: 'true' }),
    why: 'this flag or return value is never asserted',
  },
  {
    id: 'arithmetic',
    label: 'arithmetic',
    re: /(?<=\s)([+\-*/%])(?=\s)/g,
    swap: SWAP({ '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' }),
    why: 'the computed value is not checked exactly',
  },
  {
    id: 'update',
    label: 'update',
    re: /(?<![+\-])(\+\+|--)(?![+\-=])|(?<=\s)(\+=|-=)(?=\s)/g,
    swap: SWAP({ '++': '--', '--': '++', '+=': '-=', '-=': '+=' }),
    why: 'the counter or running total is not checked',
  },
];

const NEGATE = { id: 'negate-condition', label: 'condition', why: 'neither branch of this condition is pinned down by a test' };
export const OPERATOR_WHY = Object.fromEntries([...OPERATORS, NEGATE].map((o) => [o.id, o.why]));

// Lines where an operator-looking token isn't an operator.
const NOT_CODE_LINE = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\}\s+from)|\/\/|\*|type\s+\w+\s*=|interface\b|@)/;

/**
 * Every mutant on the given lines of one file.
 * @param {string} file
 * @param {string} src
 * @param {Set<number>|null} lines  1-based line numbers to mutate (null = all)
 */
export function generateMutants(file, src, lines) {
  const masked = maskJs(src);
  const starts = lineStarts(src);
  const fns = findFunctions(masked);
  const srcLines = src.split('\n');
  const mutants = [];
  const seen = new Set();

  const push = (operator, start, end, replacement) => {
    const original = src.slice(start, end);
    if (original === replacement) return;
    const line = lineOf(starts, start);
    const col = start - starts[line - 1] + 1;
    const id = `${file}:${line}:${col}:${operator}`;
    if (seen.has(id)) return;
    seen.add(id);
    const mutated = src.slice(0, start) + replacement + src.slice(end);
    const fn = enclosingFunction(fns, start);
    const lineEnd = (n) => {
      const s = mutated.split('\n');
      return s.slice(line - 1, line - 1 + n).join('\n');
    };
    const spanLines = src.slice(start, end).split('\n').length;
    mutants.push({
      id,
      file,
      line,
      col,
      operator,
      original,
      replacement,
      start,
      end,
      function: fn ? fn.name : null,
      functionLine: fn ? fn.line : null,
      before: srcLines.slice(line - 1, line - 1 + spanLines).join('\n').trim(),
      after: lineEnd(spanLines + (replacement.split('\n').length - spanLines)).trim(),
    });
  };

  for (let ln = 1; ln <= starts.length; ln++) {
    if (lines && !lines.has(ln)) continue;
    const a = starts[ln - 1];
    const b = ln < starts.length ? starts[ln] - 1 : src.length;
    const mline = masked.slice(a, b);
    if (!mline.trim() || NOT_CODE_LINE.test(mline)) continue;

    for (const op of OPERATORS) {
      op.re.lastIndex = 0;
      for (const m of mline.matchAll(op.re)) {
        const tok = m[1] ?? m[2];
        const at = a + m.index;
        const rep = op.swap(tok);
        if (rep === undefined) continue;
        push(op.id, at, at + tok.length, rep);
      }
    }
    // if (cond) → if (!(cond))
    for (const m of mline.matchAll(/\b(?:if|while)\s*\(/g)) {
      const open = a + m.index + m[0].length - 1;
      const close = matchClose(masked, open);
      if (close < 0) continue;
      const cond = src.slice(open + 1, close);
      // `if (!x)` is already covered by remove-not; `!(!x)` would be the same mutant twice.
      if (!cond.trim() || /^\s*!\s*(?:[\w$.]+|\([^()]*\))\s*$/.test(cond)) continue;
      push(NEGATE.id, open + 1, close, `!(${cond})`);
    }
  }
  return mutants;
}

/**
 * Pick which mutants to run: spread across functions first, then operators,
 * so a cap still touches every changed function. Deterministic.
 */
export function prioritize(mutants) {
  const byFn = new Map();
  for (const m of [...mutants].sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line || x.col - y.col)) {
    const k = `${m.file}#${m.function ?? '(top level)'}`;
    if (!byFn.has(k)) byFn.set(k, new Map());
    const ops = byFn.get(k);
    if (!ops.has(m.operator)) ops.set(m.operator, []);
    ops.get(m.operator).push(m);
  }
  // Within a function: round-robin across operators.
  const queues = [...byFn.values()].map((ops) => {
    const lists = [...ops.values()];
    const q = [];
    for (let i = 0; lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i]) q.push(l[i]);
    return q;
  });
  const out = [];
  for (let i = 0; queues.some((q) => q.length > i); i++) for (const q of queues) if (q[i]) out.push(q[i]);
  return out;
}

export function applyMutant(src, m) {
  return src.slice(0, m.start) + m.replacement + src.slice(m.end);
}

/** One sentence on what a surviving mutant says about the tests. */
export function explain(m) {
  const where = m.function ? `\`${m.function}\`` : 'top-level code';
  const change = m.operator === 'negate-condition' ? `inverting \`${clip(m.original)}\`` : m.operator === 'remove-not' ? `dropping the \`!\`` : `\`${m.original}\` → \`${m.replacement}\``;
  return `In ${where}, ${change} still passed every test: ${OPERATOR_WHY[m.operator]}.`;
}

const clip = (s) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 48 ? one.slice(0, 45) + '…' : one;
};
