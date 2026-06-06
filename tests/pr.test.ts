import { describe, it, expect } from 'vitest';
import { openPullRequest, buildPrBody } from '../src/pr.js';
import { issueContextFromPayload } from '../src/harness.js';
import type { ExecFn, ExecResult } from '../src/git-ops.js';
import type { JobPayload } from '../src/types.js';

interface Recorded {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function recordExec(result: ExecResult): { exec: ExecFn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const exec: ExecFn = async (command, args, options) => {
    calls.push({ command, args, ...(options?.env ? { env: options.env } : {}) });
    return result;
  };
  return { exec, calls };
}

const payload: JobPayload = {
  issue_id: 12,
  issue_reference: 'SF12',
  issue_title: 'Wire up the dashboard',
  repository_url: 'https://github.com/acme/repo.git',
  branch_name: 'sf-12',
  description: 'Build the dashboard view',
  acceptance_criteria: ['shows metrics', 'loads under 1s'],
  default_branch: 'develop',
};

describe('buildPrBody', () => {
  it('includes description, criteria, and the issue reference', () => {
    const body = buildPrBody(issueContextFromPayload(payload));
    expect(body).toContain('Build the dashboard view');
    expect(body).toContain('## Acceptance criteria');
    expect(body).toContain('- shows metrics');
    expect(body).toContain('Refs SF12');
  });

  it('falls back to "#<id>" when no issue reference is present', () => {
    const { issue_reference, ...without } = payload;
    void issue_reference;
    expect(buildPrBody(issueContextFromPayload(without))).toContain('Refs #12');
  });
});

describe('openPullRequest', () => {
  const prUrl = 'https://github.com/acme/repo/pull/34';

  it('calls gh pr create with base + head and returns the URL', async () => {
    const { exec, calls } = recordExec({ stdout: `${prUrl}\n`, stderr: '', exitCode: 0 });
    const url = await openPullRequest({
      workdir: '/w',
      branch: 'sf-12',
      base: 'develop',
      title: 'Wire up the dashboard',
      body: 'body',
      exec,
    });
    expect(url).toBe(prUrl);
    const call = calls[0]!;
    expect(call.command).toBe('gh');
    expect(call.args).toEqual([
      'pr',
      'create',
      '--head',
      'sf-12',
      '--title',
      'Wire up the dashboard',
      '--body',
      'body',
      '--base',
      'develop',
    ]);
  });

  it('omits --base when none provided (gh uses repo default)', async () => {
    const { exec, calls } = recordExec({ stdout: prUrl, stderr: '', exitCode: 0 });
    await openPullRequest({
      workdir: '/w',
      branch: 'sf-12',
      base: null,
      title: 't',
      body: 'b',
      exec,
    });
    expect(calls[0]!.args).not.toContain('--base');
  });

  it('throws on a non-zero gh exit', async () => {
    const { exec } = recordExec({ stdout: '', stderr: 'auth required', exitCode: 1 });
    await expect(
      openPullRequest({ workdir: '/w', branch: 'sf-12', title: 't', body: 'b', exec }),
    ).rejects.toThrow(/gh pr create failed/);
  });
});
