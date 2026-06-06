import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace, cleanupWorkspace, jobsRoot } from '../src/workspace.js';
import type { ExecFn, ExecResult } from '../src/git-ops.js';

interface Call {
  command: string;
  args: string[];
}

const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vps-ws-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('jobsRoot', () => {
  it('is <config_dir>/jobs', () => {
    expect(jobsRoot('/cfg')).toBe(join('/cfg', 'jobs'));
  });
});

describe('prepareWorkspace', () => {
  it('clones and checks out an existing branch', async () => {
    const calls: Call[] = [];
    const exec: ExecFn = vi.fn(async (command, args) => {
      calls.push({ command, args });
      return ok; // clone ok, checkout ok
    });
    const ws = await prepareWorkspace({
      jobsDir: join(root, 'jobs'),
      jobId: 5,
      cloneUrl: 'https://github.com/acme/repo.git',
      branch: 'sf-5',
      exec,
    });
    expect(ws.repoDir).toBe(join(root, 'jobs', '5', 'repo'));
    expect(existsSync(join(root, 'jobs', '5'))).toBe(true);
    expect(calls[0]!.args[0]).toBe('clone');
    expect(calls[1]!.args).toEqual(['checkout', 'sf-5']);
  });

  it('creates the branch when checkout fails', async () => {
    const calls: Call[] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'checkout' && args[1] === 'sf-new') {
        return { stdout: '', stderr: 'no such branch', exitCode: 1 };
      }
      return ok;
    };
    await prepareWorkspace({
      jobsDir: join(root, 'jobs'),
      jobId: 6,
      cloneUrl: 'https://github.com/acme/repo.git',
      branch: 'sf-new',
      exec,
    });
    expect(calls.at(-1)!.args).toEqual(['checkout', '-b', 'sf-new']);
  });

  it('uses a tokenized remote in token mode and redacts it in logs', async () => {
    const calls: Call[] = [];
    const logs: string[] = [];
    const exec: ExecFn = async (command, args) => {
      calls.push({ command, args });
      return ok;
    };
    await prepareWorkspace({
      jobsDir: join(root, 'jobs'),
      jobId: 7,
      cloneUrl: 'https://github.com/acme/repo.git',
      branch: 'sf-7',
      gitAuth: 'token',
      gitToken: 'shh',
      exec,
      log: (m) => logs.push(m),
    });
    expect(calls[0]!.args[1]).toContain('x-access-token:shh@github.com');
    expect(logs.join('\n')).not.toContain('shh');
  });

  it('throws when git clone fails', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'not found', exitCode: 128 });
    await expect(
      prepareWorkspace({
        jobsDir: join(root, 'jobs'),
        jobId: 8,
        cloneUrl: 'https://github.com/acme/missing.git',
        branch: 'sf-8',
        exec,
      }),
    ).rejects.toThrow(/git clone failed/);
  });
});

describe('cleanupWorkspace', () => {
  it('removes the job directory and never throws', () => {
    const dir = join(root, 'jobs', '9');
    mkdtempSync(root); // ensure root exists
    expect(() => cleanupWorkspace(dir)).not.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});
