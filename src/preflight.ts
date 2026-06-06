/**
 * SF-142 (pre-flight): verify the host has the tools the runner needs before it
 * starts claiming jobs, and provide a `doctor` command that reports the same.
 *
 * Checks:
 *   - git installed (+ a minimum version),
 *   - gh installed and authenticated (the agent uses the host's ambient gh
 *     credentials, so an authenticated `gh auth login` is always required),
 *   - claude installed (only required when the configured harness is 'claude').
 *
 * Tool detection is injectable so tests don't touch the real binaries.
 */

import type { ExecFn } from './git-ops.js';
import type { HarnessName } from './types.js';

export interface PreflightInput {
  harness: HarnessName;
  exec: ExecFn;
  /** Minimum git version (major.minor). Default 2.20. */
  minGit?: { major: number; minor: number };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  /** Detail line: version, auth status, or the actionable failure guidance. */
  detail: string;
  /** When false, this is a hard failure that should abort `start`. */
  required: boolean;
}

export interface PreflightReport {
  ok: boolean;
  checks: CheckResult[];
}

/** Parse the first semver-ish "x.y(.z)" out of a version string. */
export function parseVersion(s: string): { major: number; minor: number } | null {
  const m = s.match(/(\d+)\.(\d+)(?:\.\d+)?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

function gte(a: { major: number; minor: number }, b: { major: number; minor: number }): boolean {
  return a.major > b.major || (a.major === b.major && a.minor >= b.minor);
}

async function tryExec(exec: ExecFn, cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const res = await exec(cmd, args);
    return { ok: res.exitCode === 0, out: `${res.stdout}\n${res.stderr}` };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

async function checkGit(input: PreflightInput): Promise<CheckResult> {
  const min = input.minGit ?? { major: 2, minor: 20 };
  const res = await tryExec(input.exec, 'git', ['--version']);
  if (!res.ok) {
    return {
      name: 'git',
      ok: false,
      required: true,
      detail: 'git not found. Install git (e.g. `apt-get install git`) and ensure it is on PATH.',
    };
  }
  const version = parseVersion(res.out);
  if (version && !gte(version, min)) {
    return {
      name: 'git',
      ok: false,
      required: true,
      detail: `git ${version.major}.${version.minor} is too old; need >= ${min.major}.${min.minor}. Upgrade git.`,
    };
  }
  return { name: 'git', ok: true, required: true, detail: res.out.trim().split('\n')[0] ?? 'git ok' };
}

async function checkGh(input: PreflightInput): Promise<CheckResult> {
  const present = await tryExec(input.exec, 'gh', ['--version']);
  if (!present.ok) {
    return {
      name: 'gh',
      ok: false,
      required: true,
      detail: 'GitHub CLI (gh) not found. Install it from https://cli.github.com and run `gh auth login`.',
    };
  }
  const versionLine = present.out.trim().split('\n')[0] ?? 'gh';

  const auth = await tryExec(input.exec, 'gh', ['auth', 'status']);
  if (!auth.ok) {
    return {
      name: 'gh',
      ok: false,
      required: true,
      detail: 'gh is installed but not authenticated. Run `gh auth login`.',
    };
  }
  return { name: 'gh', ok: true, required: true, detail: `${versionLine} (authenticated)` };
}

async function checkClaude(input: PreflightInput): Promise<CheckResult> {
  const required = input.harness === 'claude';
  const res = await tryExec(input.exec, 'claude', ['--version']);
  if (!res.ok) {
    return {
      name: 'claude',
      ok: !required,
      required,
      detail: required
        ? 'Claude Code CLI (claude) not found, but harness=claude needs it. Install it and run `claude` once to authenticate.'
        : 'claude not found (not required for the current harness).',
    };
  }
  return { name: 'claude', ok: true, required, detail: res.out.trim().split('\n')[0] ?? 'claude ok' };
}

/** Run all preflight checks and aggregate. */
export async function preflight(input: PreflightInput): Promise<PreflightReport> {
  const checks = await Promise.all([checkGit(input), checkGh(input), checkClaude(input)]);
  const ok = checks.every((c) => c.ok || !c.required);
  return { ok, checks };
}

/** Format a report for human output (doctor command / start warnings). */
export function formatReport(report: PreflightReport): string {
  const lines = report.checks.map((c) => {
    const mark = c.ok ? 'ok ' : c.required ? 'FAIL' : 'warn';
    return `[${mark}] ${c.name.padEnd(7)} ${c.detail}`;
  });
  lines.push('');
  lines.push(report.ok ? 'Preflight: all required checks passed.' : 'Preflight: one or more required checks FAILED.');
  return lines.join('\n');
}
