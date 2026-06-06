/**
 * SF-154 (security): central secret redaction.
 *
 * The agent streams raw stdout/stderr from git/gh/claude into the job log (which
 * is POSTed to the server) and into the local agent.log. A tokenized push remote
 * or an accidental credential echo from a subprocess must never survive that
 * trip. This module scrubs known secret shapes from any string before it is
 * logged or transmitted.
 *
 * It is intentionally pattern-based and conservative: it targets the exact
 * shapes this agent produces or handles (credentials embedded in URLs, common
 * provider token prefixes, and explicit token=… query/body fragments) so it does
 * not mangle ordinary log output.
 */

const REDACTED = '***redacted***';

/**
 * Patterns matched anywhere in a line. Order matters: URL-embedded credentials
 * are handled first so the whole `user:pass@host` segment collapses cleanly.
 */
const PATTERNS: ReadonlyArray<{ re: RegExp; replace: string }> = [
  // https://x-access-token:<tok>@host  /  https://user:pass@host
  { re: /\b((?:https?|git):\/\/)[^/\s:@]+:[^/\s@]+@/gi, replace: `$1${REDACTED}@` },
  // GitHub-style tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_…
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replace: REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: REDACTED },
  // Anthropic keys.
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replace: REDACTED },
  // Explicit token=… / authorization: bearer … fragments (query string or body).
  { re: /\b(token|auth_token|git_token|access_token)=([^&\s"']+)/gi, replace: `$1=${REDACTED}` },
  { re: /\b(authorization:\s*bearer)\s+\S+/gi, replace: `$1 ${REDACTED}` },
  { re: /\bx-runner-token:\s*\S+/gi, replace: `x-runner-token: ${REDACTED}` },
];

/** Scrub a single string of any known secret shapes. Never throws. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Deep-redact an arbitrary log-metadata value: strings are scrubbed, objects and
 * arrays are walked, and keys whose name looks secret have their value masked
 * outright regardless of shape. Cyclic structures are guarded.
 */
const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization|credential/i;

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redactValue(v, seen);
  }
  return out;
}

export { REDACTED };
