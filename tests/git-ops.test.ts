import { describe, it, expect } from 'vitest';
import {
  hasChanges,
  commitAndPush,
  buildCommitMessage,
  tokenizeRemote,
  redactRemote,
  type ExecFn,
  type ExecResult,
} from '../src/git-ops.js';

interface Call {
  command: string;
  args: string[];
  cwd?: string;
}

/** Build a mock exec that records calls and returns scripted results by index. */
function scriptedExec(results: ExecResult[]): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const exec: ExecFn = async (command, args, options) => {
    calls.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
    return results[i++] ?? { stdout: '', stderr: '', exitCode: 0 };
  };
  return { exec, calls };
}

const ok: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

describe('buildCommitMessage', () => {
  it('uses the title and appends an issue ref', () => {
    expect(buildCommitMessage(7, 'Fix the login bug')).toBe('Fix the login bug\n\nRefs SF-7');
  });
  it('truncates very long subjects', () => {
    const msg = buildCommitMessage(7, 'x'.repeat(100));
    expect(msg.split('\n')[0]!.length).toBeLessThanOrEqual(72);
    expect(msg).toContain('Refs SF-7');
  });
});

describe('tokenizeRemote / redactRemote', () => {
  it('embeds the token into an https URL and redacts it back', () => {
    const remote = tokenizeRemote('https://github.com/acme/repo.git', 'secrettoken');
    expect(remote).toContain('x-access-token:secrettoken@github.com');
    expect(redactRemote(remote)).not.toContain('secrettoken');
    expect(redactRemote(remote)).toContain('***');
  });
  it('leaves ssh URLs untouched', () => {
    expect(tokenizeRemote('git@github.com:acme/repo.git', 'tok')).toBe('git@github.com:acme/repo.git');
  });
});

describe('hasChanges', () => {
  it('is true when git status --porcelain has output', async () => {
    const { exec } = scriptedExec([{ stdout: ' M file.ts\n', stderr: '', exitCode: 0 }]);
    expect(await hasChanges({ workdir: '/w', exec })).toBe(true);
  });
  it('is false on a clean tree', async () => {
    const { exec } = scriptedExec([ok]);
    expect(await hasChanges({ workdir: '/w', exec })).toBe(false);
  });
});

describe('commitAndPush (machine mode)', () => {
  it('adds, commits, and pushes to origin', async () => {
    const { exec, calls } = scriptedExec([
      { stdout: ' M f.ts\n', stderr: '', exitCode: 0 }, // status
      ok, // add
      ok, // commit
      ok, // push
    ]);
    const pushed = await commitAndPush({
      workdir: '/w',
      branch: 'sf-7',
      issueId: 7,
      issueTitle: 'Fix it',
      gitAuth: 'machine',
      exec,
    });
    expect(pushed).toBe(true);
    const push = calls.at(-1)!;
    expect(push.args).toEqual(['push', '-u', 'origin', 'HEAD:sf-7']);
  });

  it('returns false and does not commit a clean tree', async () => {
    const { exec, calls } = scriptedExec([ok]);
    const pushed = await commitAndPush({
      workdir: '/w',
      branch: 'sf-7',
      issueId: 7,
      issueTitle: 'Fix it',
      exec,
    });
    expect(pushed).toBe(false);
    expect(calls).toHaveLength(1); // only the status check ran
  });
});

describe('commitAndPush (token mode)', () => {
  it('pushes to a tokenized remote, never to origin', async () => {
    const { exec, calls } = scriptedExec([
      { stdout: ' M f.ts\n', stderr: '', exitCode: 0 },
      ok,
      ok,
      ok,
    ]);
    const logs: string[] = [];
    await commitAndPush({
      workdir: '/w',
      branch: 'sf-7',
      issueId: 7,
      issueTitle: 'Fix it',
      gitAuth: 'token',
      gitToken: 'topsecret',
      repoUrl: 'https://github.com/acme/repo.git',
      exec,
      log: (m) => logs.push(m),
    });
    const push = calls.at(-1)!;
    expect(push.args[0]).toBe('push');
    expect(push.args[2]).toContain('x-access-token:topsecret@github.com');
    // The token must never appear in logs.
    expect(logs.join('\n')).not.toContain('topsecret');
  });

  it('throws when token mode is selected but no token is present', async () => {
    const { exec } = scriptedExec([{ stdout: ' M f.ts\n', stderr: '', exitCode: 0 }, ok, ok]);
    await expect(
      commitAndPush({
        workdir: '/w',
        branch: 'sf-7',
        issueId: 7,
        issueTitle: 'Fix it',
        gitAuth: 'token',
        repoUrl: 'https://github.com/acme/repo.git',
        exec,
      }),
    ).rejects.toThrow(/no git token/);
  });
});

describe('commit failure', () => {
  it('throws when git commit exits non-zero', async () => {
    const { exec } = scriptedExec([
      { stdout: ' M f.ts\n', stderr: '', exitCode: 0 }, // status
      ok, // add
      { stdout: '', stderr: 'nothing to commit', exitCode: 1 }, // commit fails
    ]);
    await expect(
      commitAndPush({ workdir: '/w', branch: 'sf-7', issueId: 7, issueTitle: 'x', exec }),
    ).rejects.toThrow(/git commit failed/);
  });
});
