import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspace, cleanupWorkspace, jobsRoot } from '../src/workspace.js';
import type { ExecFn, ExecResult } from '../src/git-ops.js';
import type { ResolvedSource } from '../src/source-mode.js';

interface Call {
  command: string;
  args: string[];
  cwd?: string;
}

const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
const fail = (stderr = 'boom'): ExecResult => ({ stdout: '', stderr, exitCode: 1 });

function recorder(handler?: (c: Call) => ExecResult): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (command, args, options) => {
    const call: Call = { command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) };
    calls.push(call);
    return handler?.(call) ?? ok;
  };
  return { exec, calls };
}

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

describe('prepareWorkspace — clone mode', () => {
  const clone: ResolvedSource = { mode: 'clone' };

  it('clones and checks out an existing branch', async () => {
    const { exec, calls } = recorder();
    const ws = await prepareWorkspace({
      source: clone,
      jobsDir: join(root, 'jobs'),
      jobId: 5,
      cloneUrl: 'https://github.com/acme/repo.git',
      branch: 'sf-5',
      exec,
    });
    expect(ws.repoDir).toBe(join(root, 'jobs', '5', 'repo'));
    expect(ws.mode).toBe('clone');
    expect(existsSync(join(root, 'jobs', '5'))).toBe(true);
    expect(calls[0]!.args[0]).toBe('clone');
    expect(calls[1]!.args).toEqual(['checkout', 'sf-5']);
  });

  it('creates the branch when checkout fails', async () => {
    const { exec, calls } = recorder((c) =>
      c.args[0] === 'checkout' && c.args[1] === 'sf-new' ? fail('no such branch') : ok,
    );
    await prepareWorkspace({
      source: clone,
      jobsDir: join(root, 'jobs'),
      jobId: 6,
      cloneUrl: 'https://github.com/acme/repo.git',
      branch: 'sf-new',
      exec,
    });
    expect(calls.at(-1)!.args).toEqual(['checkout', '-b', 'sf-new']);
  });

  it('throws when git clone fails', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: 'not found', exitCode: 128 });
    await expect(
      prepareWorkspace({
        source: clone,
        jobsDir: join(root, 'jobs'),
        jobId: 8,
        cloneUrl: 'https://github.com/acme/missing.git',
        branch: 'sf-8',
        exec,
      }),
    ).rejects.toThrow(/git clone failed/);
  });

  it('cleanup removes the per-job dir', async () => {
    const { exec } = recorder();
    const ws = await prepareWorkspace({
      source: clone,
      jobsDir: join(root, 'jobs'),
      jobId: 9,
      cloneUrl: 'https://github.com/acme/repo.git',
      branch: 'sf-9',
      exec,
    });
    expect(existsSync(join(root, 'jobs', '9'))).toBe(true);
    await ws.cleanup();
    expect(existsSync(join(root, 'jobs', '9'))).toBe(false);
  });
});

describe('prepareWorkspace — worktree mode', () => {
  it('adds a worktree (creating the branch) and removes it on cleanup', async () => {
    const base = join(root, 'base');
    const worktrees = join(root, 'wt');
    mkdirSync(base, { recursive: true });
    // rev-parse --verify of an absent branch fails -> add with -b.
    const { exec, calls } = recorder((c) =>
      c.args[0] === 'rev-parse' && c.args.includes('--verify') ? fail() : ok,
    );
    const source: ResolvedSource = { mode: 'worktree', baseRepoPath: base, worktreesDir: worktrees };

    const ws = await prepareWorkspace({
      source,
      jobsDir: join(root, 'jobs'),
      jobId: 42,
      cloneUrl: 'https://github.com/acme/repo.git',
      branch: 'sf-42',
      exec,
    });

    expect(ws.mode).toBe('worktree');
    expect(ws.repoDir).toBe(join(worktrees, '42'));
    const add = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add')!;
    expect(add.args).toEqual(['worktree', 'add', '-b', 'sf-42', join(worktrees, '42')]);
    expect(add.cwd).toBe(base);

    await ws.cleanup();
    const remove = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')!;
    expect(remove.args).toEqual(['worktree', 'remove', '--force', join(worktrees, '42')]);
    expect(remove.cwd).toBe(base);
  });

  it('reuses an existing local branch (no -b)', async () => {
    const base = join(root, 'base');
    mkdirSync(base, { recursive: true });
    const { exec, calls } = recorder(); // rev-parse --verify succeeds -> branch exists
    const ws = await prepareWorkspace({
      source: { mode: 'worktree', baseRepoPath: base, worktreesDir: join(root, 'wt') },
      jobsDir: join(root, 'jobs'),
      jobId: 7,
      cloneUrl: 'x',
      branch: 'existing',
      exec,
    });
    const add = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add')!;
    expect(add.args).toEqual(['worktree', 'add', join(root, 'wt', '7'), 'existing']);
    expect(ws.repoDir).toBe(join(root, 'wt', '7'));
  });

  it('throws when base_repo_path is missing', async () => {
    const { exec } = recorder();
    await expect(
      prepareWorkspace({
        source: { mode: 'worktree' },
        jobsDir: join(root, 'jobs'),
        jobId: 1,
        cloneUrl: 'x',
        branch: 'b',
        exec,
      }),
    ).rejects.toThrow(/requires base_repo_path/);
  });

  it('throws when the base repo path does not exist', async () => {
    const { exec } = recorder();
    await expect(
      prepareWorkspace({
        source: { mode: 'worktree', baseRepoPath: join(root, 'nope') },
        jobsDir: join(root, 'jobs'),
        jobId: 1,
        cloneUrl: 'x',
        branch: 'b',
        exec,
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('prepareWorkspace — local_path mode', () => {
  function gitRepoDir(): string {
    const p = join(root, 'checkout');
    mkdirSync(p, { recursive: true });
    return p;
  }

  it('stashes a dirty tree, checks out the branch, and restores on cleanup', async () => {
    const path = gitRepoDir();
    const { exec, calls } = recorder((c) => {
      if (c.args[0] === 'symbolic-ref') return { stdout: 'develop\n', stderr: '', exitCode: 0 };
      if (c.args[0] === 'status') return { stdout: ' M app.rb\n', stderr: '', exitCode: 0 };
      return ok;
    });

    const ws = await prepareWorkspace({
      source: { mode: 'local_path', localPath: path },
      jobsDir: join(root, 'jobs'),
      jobId: 3,
      cloneUrl: 'x',
      branch: 'sf-3',
      exec,
    });

    expect(ws.mode).toBe('local_path');
    expect(ws.repoDir).toBe(path);
    // Never clones, never deletes.
    expect(calls.some((c) => c.args[0] === 'clone')).toBe(false);
    const stash = calls.find((c) => c.args[0] === 'stash' && c.args[1] === 'push')!;
    expect(stash.args).toContain('--include-untracked');
    expect(calls.some((c) => c.args[0] === 'checkout' && c.args[1] === 'sf-3')).toBe(true);

    await ws.cleanup();
    // Restores original branch + pops stash; checkout dir still exists.
    expect(calls.some((c) => c.args[0] === 'checkout' && c.args[1] === 'develop')).toBe(true);
    expect(calls.some((c) => c.args[0] === 'stash' && c.args[1] === 'pop')).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it('does not stash when the tree is clean', async () => {
    const path = gitRepoDir();
    const { exec, calls } = recorder((c) => {
      if (c.args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '', exitCode: 0 };
      if (c.args[0] === 'status') return ok; // clean
      return ok;
    });
    const ws = await prepareWorkspace({
      source: { mode: 'local_path', localPath: path },
      jobsDir: join(root, 'jobs'),
      jobId: 4,
      cloneUrl: 'x',
      branch: 'sf-4',
      exec,
    });
    expect(calls.some((c) => c.args[0] === 'stash')).toBe(false);
    await ws.cleanup();
    expect(calls.some((c) => c.args[0] === 'stash' && c.args[1] === 'pop')).toBe(false);
  });

  it('throws when local_path is missing', async () => {
    const { exec } = recorder();
    await expect(
      prepareWorkspace({
        source: { mode: 'local_path' },
        jobsDir: join(root, 'jobs'),
        jobId: 1,
        cloneUrl: 'x',
        branch: 'b',
        exec,
      }),
    ).rejects.toThrow(/requires local_path/);
  });

  it('throws when local_path is not a git repository', async () => {
    const path = gitRepoDir();
    const exec: ExecFn = async (_cmd, args) =>
      args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree' ? fail() : ok;
    await expect(
      prepareWorkspace({
        source: { mode: 'local_path', localPath: path },
        jobsDir: join(root, 'jobs'),
        jobId: 1,
        cloneUrl: 'x',
        branch: 'b',
        exec,
      }),
    ).rejects.toThrow(/not a git repository/);
  });
});

describe('cleanupWorkspace', () => {
  it('removes the job directory and never throws', () => {
    const dir = join(root, 'jobs', '9');
    expect(() => cleanupWorkspace(dir)).not.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});
