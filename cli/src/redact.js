// Keeping secrets and local paths out of anything crossexam writes or shares.
import os from 'node:os';

// Values that look like secrets never leave in a report.
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const SECRET_ASSIGN = /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(["'`])([^"'`\n]{6,})\2/gi;

export function redact(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out.replace(SECRET_ASSIGN, (_, k, q) => `${k}${q}[redacted]${q}`);
}

/** A path under the home folder, written from `~`. */
export function tildify(p) {
  const h = os.homedir();
  return typeof p === 'string' && p.toLowerCase().startsWith(h.toLowerCase()) ? '~' + p.slice(h.length) : p;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Absolute paths that would say something about the machine: drive letters,
// home folders, temp folders, CI workspaces.
const ABSOLUTE = /(?:\b[A-Za-z]:[\\/]|(?<![\w.~])\/(?:home|Users|root|tmp|private|var|opt|mnt|srv|github|runner|workspace|builds)\/)[^\s'"`<>|)]*/g;

/**
 * Make text safe to leave this machine: paths inside `root` become relative,
 * the home folder becomes `~`, any other absolute path becomes `[path]`, and
 * secret-looking values are redacted.
 */
export function scrubText(s, root) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  if (root) {
    // both slash styles; Windows paths compare case-insensitively
    const variants = new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')]);
    for (const v of variants) {
      if (v.length < 2) continue;
      out = out.replace(new RegExp(escapeRe(v) + '[\\\\/]?', process.platform === 'win32' || /^[A-Za-z]:/.test(v) ? 'gi' : 'g'), '');
    }
  }
  const home = os.homedir();
  for (const v of new Set([home, home.replace(/\\/g, '/')])) {
    if (v.length > 3) out = out.replace(new RegExp(escapeRe(v), 'gi'), '~');
  }
  out = out.replace(ABSOLUTE, '[path]');
  return redact(out);
}
