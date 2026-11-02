// Claim detection: find sentences where an agent asserts something is done
// and classify what kind of claim it is.

/** @typedef {'tests'|'build'|'types'|'lint'|'refactor'|'migration'|'deps'|'security'} ClaimKind */

const KINDS = /** @type {const} */ ({
  tests: [
    /\b(?:all\s+)?(?:the\s+)?(?:\d+\s+)?(?:unit\s+|e2e\s+|integration\s+|existing\s+|new\s+)?tests?\s+(?:now\s+|still\s+|all\s+|are\s+all\s+)?(?:pass(?:es|ed|ing)?|are\s+(?:passing|green)|(?:is|are)\s+green|succeed(?:s|ed)?)\b/i,
    /\btest\s+suite\s+(?:now\s+)?(?:passes|passed|is\s+green|is\s+passing)\b/i,
    /\b\d+\s*(?:\/\s*\d+\s*)?(?:tests?\s+)?passing\b/i,
    /\b(?:all|every)\s+(?:\d+\s+)?(?:specs?|test\s+cases?)\s+pass/i,
  ],
  build: [
    /\b(?:the\s+)?build\s+(?:now\s+)?(?:succeeds|succeeded|passes|passed|is\s+green|is\s+clean|works)\b/i,
    /\bbuilds?\s+(?:cleanly|successfully|without\s+errors)\b/i,
    /\bcompiles\s+(?:cleanly|successfully|without\s+(?:any\s+)?errors|fine)\b/i,
  ],
  types: [
    /\b(?:typecheck(?:ing)?|type[- ]check(?:ing)?|tsc)\s+(?:now\s+)?(?:passes|passed|is\s+clean|comes\s+back\s+clean|clean)\b/i,
    /\bno\s+(?:remaining\s+)?(?:type|typescript|ts)\s+errors\b/i,
  ],
  lint: [
    /\blint(?:er|ing)?\s+(?:now\s+)?(?:passes|passed|is\s+clean|comes\s+back\s+clean|clean)\b/i,
    /\bno\s+(?:remaining\s+)?lint(?:ing)?\s+(?:errors|warnings|issues)\b/i,
  ],
  refactor: [
    /\b(?:all|every)\s+(?:the\s+)?(?:remaining\s+)?(?:callers?|call\s*sites?|usages?|references?|imports?|occurrences?|consumers?|uses)\s+(?:\S+\s+){0,4}?(?:have\s+been\s+|has\s+been\s+|were\s+|are\s+(?:now\s+)?)?(?:updated|migrated|renamed|changed|replaced|switched|moved|fixed)\b/i,
    /\brenamed\s+`?[\w.$]+`?\s+(?:to|→|->)\s+`?[\w.$]+`?\s+(?:everywhere|across|throughout)/i,
  ],
  migration: [
    /\bmigrations?\s+(?:\S+\s+){0,3}?(?:ran|applied|succeeded|completed|went\s+through|(?:has|have)\s+been\s+(?:applied|run))\b/i,
    /\b(?:applied|ran)\s+(?:the\s+)?(?:\S+\s+)?migrations?\s+(?:successfully|cleanly)\b/i,
  ],
  deps: [
    /\b(?:upgraded|bumped|updated|pinned)\s+`?(@?[\w./-]+)`?\s+(?:from\s+`?v?[\w.^~-]+`?\s+)?to\s+`?v?\d[\w.-]*`?/i,
  ],
  security: [
    /\b(?:fixed|patched|closed|resolved|mitigated|plugged)\s+(?:the\s+)?(?:\S+\s+){0,3}?(?:vulnerability|vuln|xss|injection|cve-\d{4}-\d+|ssrf|csrf|rce|security\s+(?:issue|bug|hole|flaw))/i,
  ],
});

// A sentence that talks about a check rather than asserting its result.
const HEDGE =
  /\b(?:make\s+sure|ensure|should|to\s+verify|to\s+confirm|check\s+(?:that|whether|if)|until|once|if|unless|whether|will|would|could|might|need(?:s)?\s+to|let'?s|let\s+me|i'?ll|want\s+to|try\s+to|expect(?:ed)?|hopefully|before)\b/i;
const NEGATION =
  /\b(?:not|n't|never|no\s+longer|fail(?:s|ed|ing)?|broken|still\s+(?:fail|broken|red)|couldn'?t|unable|can'?t|without\s+running|didn'?t\s+run|haven'?t\s+run)\b/i;

/** Split assistant prose into sentence-ish units without breaking `code`. */
export function sentences(text) {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\r/g, '');
  const out = [];
  for (const line of clean.split(/\n+/)) {
    const parts = line.split(/(?<=[.!?])\s+(?=[A-Z`*✅✓])/);
    for (const p of parts) {
      const s = p.replace(/^[\s>*\-•#|]+/, '').replace(/\*\*/g, '').trim();
      if (s.length >= 8) out.push(s);
    }
  }
  return out;
}

/**
 * Find claims in a piece of assistant text.
 * @returns {{kind: ClaimKind, sentence: string, subject?: {from?: string, to?: string, pkg?: string, version?: string}}[]}
 */
export function detectClaims(text) {
  const found = [];
  for (const s of sentences(text)) {
    for (const [kind, patterns] of Object.entries(KINDS)) {
      const hit = patterns.map((re) => s.match(re)).find(Boolean);
      if (!hit) continue;
      // Look only at the words leading into the claim for hedges and negations,
      // so "I fixed X, and all tests pass" counts but "make sure tests pass" doesn't.
      const lead = s.slice(Math.max(0, hit.index - 60), hit.index);
      const own = hit[0];
      if (HEDGE.test(lead) || HEDGE.test(own)) continue;
      if (NEGATION.test(lead.slice(-30)) || NEGATION.test(own)) continue;
      if (/\?\s*$/.test(s)) continue;
      found.push({ kind: /** @type {ClaimKind} */ (kind), sentence: s.slice(0, 280), subject: subjectOf(kind, s) });
    }
  }
  return found;
}

function subjectOf(kind, s) {
  if (kind === 'refactor') {
    const r = s.match(/\brenamed\s+`([\w.$]+)`\s+(?:to|→|->)\s+`([\w.$]+)`/i) || s.match(/`([\w.$]+)`\s*(?:→|->)\s*`([\w.$]+)`/);
    if (r) return { from: r[1].split('.').pop(), to: r[2].split('.').pop() };
    const tick = s.match(/`([A-Za-z_$][\w$]{2,})`/);
    return tick ? { from: tick[1] } : undefined;
  }
  if (kind === 'deps') {
    const d = s.match(/\b(?:upgraded|bumped|updated|pinned)\s+`?(@?[\w./-]+)`?\s+(?:from\s+`?v?[\w.^~-]+`?\s+)?to\s+`?v?(\d+(?:\.\d+)*(?:-[\w.]+)?)`?/i);
    return d ? { pkg: d[1], version: d[2] } : undefined;
  }
  return undefined;
}

/** Rough task type from the user's prompt, used to bucket reliability history. */
export function taskTypeOf(prompt = '') {
  const p = prompt.toLowerCase();
  if (/\bmigrat/.test(p)) return 'migration';
  if (/\b(refactor|rename|extract|clean ?up|restructure|move\s+\w+\s+to)\b/.test(p)) return 'refactor';
  if (/\b(upgrade|bump|dependenc|update\s+\w+\s+to\s+v?\d)/.test(p)) return 'dependency';
  if (/\b(cve|vulnerab|xss|injection|security|auth bypass)/.test(p)) return 'security';
  if (/\b(test|spec|coverage)\b/.test(p)) return 'tests';
  if (/\b(fix|bug|broken|error|crash|fails?|issue)\b/.test(p)) return 'bugfix';
  return 'feature';
}
