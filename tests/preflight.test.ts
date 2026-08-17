import { describe, it, expect } from 'vitest';
import { preflight, parseVersion, formatReport } from '../src/preflight.js';
import type { ExecFn, ExecResult } from '../src/git-ops.js';

/** Build an exec that answers per-command from a map of `${cmd} ${arg0}`. */
function execFor(table: Record<string, ExecResult>): ExecFn {
  return async (command, args) => {
    const key = `${command} ${args[0] ?? ''}`.trim();
    return table[key] ?? { stdout: '', stderr: 'unknown command', exitCode: 127 };
  };
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'not found'): ExecResult => ({ stdout: '', stderr, exitCode: 127 });

describe('parseVersion', () => {
  it('parses major.minor from a version string', () => {
    expect(parseVersion('git version 2.39.3')).toEqual({ major: 2, minor: 39 });
    expect(parseVersion('gh version 2.40.1 (2024)')).toEqual({ major: 2, minor: 40 });
  });
  it('returns null on garbage', () => {
    expect(parseVersion('no version here')).toBeNull();
  });
});

describe('preflight', () => {
  it('passes when git + gh (authed) are present and claude not required', async () => {
    const exec = execFor({
      'git --version': ok('git version 2.39.0'),
      'gh --version': ok('gh version 2.40.0'),
      'gh auth': ok('Logged in to github.com'),
      'claude --version': fail(),
    });
    const report = await preflight({ harness: 'noop', exec });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'claude')?.ok).toBe(true); // not required
  });

  it('fails when git is missing', async () => {
    const exec = execFor({
      'git --version': fail(),
      'gh --version': ok('gh version 2.40.0'),
      'gh auth': ok('ok'),
    });
    const report = await preflight({ harness: 'noop', exec });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'git')?.detail).toMatch(/Install git/);
  });

  it('fails when git is too old', async () => {
    const exec = execFor({
      'git --version': ok('git version 2.10.0'),
      'gh --version': ok('gh version 2.40.0'),
      'gh auth': ok('ok'),
    });
    const report = await preflight({ harness: 'noop', exec });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'git')?.detail).toMatch(/too old/);
  });

  it('fails when gh is unauthenticated', async () => {
    const exec = execFor({
      'git --version': ok('git version 2.39.0'),
      'gh --version': ok('gh version 2.40.0'),
      'gh auth': fail('not logged in'),
    });
    const report = await preflight({ harness: 'noop', exec });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'gh')?.detail).toMatch(/auth login/);
  });

  it('requires claude when harness=claude', async () => {
    const exec = execFor({
      'git --version': ok('git version 2.39.0'),
      'gh --version': ok('gh version 2.40.0'),
      'gh auth': ok('ok'),
      'claude --version': fail(),
    });
    const report = await preflight({ harness: 'claude', exec });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'claude')?.required).toBe(true);
  });

  it('does not require prime-agent for other harnesses', async () => {
    const exec = execFor({
      'git --version': ok('git version 2.39.0'),
      'gh --version': ok('gh version 2.40.0'),
      'gh auth': ok('ok'),
      'claude --version': fail(),
      'prime-agent -v': fail(),
    });
    const report = await preflight({ harness: 'noop', exec });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'prime-agent')?.required).toBe(false);
  });

  it('requires prime-agent when harness=prime-agent', async () => {
    const exec = execFor({
      'git --version': ok('git version 2.39.0'),
      'gh --version': ok('gh version 2.40.0'),
      'gh auth': ok('ok'),
      'claude --version': fail(),
      'prime-agent -v': fail(),
    });
    const report = await preflight({ harness: 'prime-agent', exec });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'prime-agent')?.required).toBe(true);
  });

  it('formatReport renders ok/FAIL markers', () => {
    const text = formatReport({
      ok: false,
      checks: [
        { name: 'git', ok: true, required: true, detail: 'git version 2.39' },
        { name: 'gh', ok: false, required: true, detail: 'run gh auth login' },
      ],
    });
    expect(text).toContain('[ok ] git');
    expect(text).toContain('[FAIL] gh');
    expect(text).toContain('FAILED');
  });
});
