import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobExecutor } from '../src/job-executor.js';
import { issueContextFromPayload, type Harness, type HarnessResult } from '../src/harness.js';
import type { AgentConfig } from '../src/config.js';
import type { ExecFn, ExecResult } from '../src/git-ops.js';
import type { JobPayload } from '../src/types.js';

interface Call {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

const prUrl = 'https://github.com/acme/repo/pull/77';

/** Mock exec: clone/checkout/add/commit/push all succeed; status shows changes; gh returns a PR URL. */
function pipelineExec(opts: { changes?: boolean } = {}): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (command, args, options) => {
    calls.push({ command, args, ...(options?.env ? { env: options.env } : {}) });
    let result: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
    if (command === 'git' && args[0] === 'status') {
      result = { stdout: opts.changes === false ? '' : ' M src/file.ts\n', stderr: '', exitCode: 0 };
    } else if (command === 'gh') {
      result = { stdout: `${prUrl}\n`, stderr: '', exitCode: 0 };
    }
    return result;
  };
  return { exec, calls };
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    api_url: 'http://localhost:3000',
    token: 'tok',
    log_level: 'info',
    harness: 'claude',
    permission_mode: 'default',
    config_dir: root,
    runner_id: 1,
    heartbeat_interval: 30,
    poll_interval: 5,
    max_log_batch_size: 100,
    ...overrides,
  };
}

function payload(overrides: Partial<JobPayload> = {}): JobPayload {
  return {
    issue_id: 50,
    issue_title: 'Add metrics',
    repository_url: 'https://github.com/acme/repo.git',
    branch_name: 'sf-50',
    description: 'Add a metrics panel',
    default_branch: 'main',
    ...overrides,
  };
}

/** A harness that succeeds and claims changes. */
const changingHarness: Harness = {
  run: async (): Promise<HarnessResult> => ({ success: true, summary: 'made changes', changed: true }),
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vps-exec-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('JobExecutor', () => {
  it('clones, runs harness, commits, pushes, opens PR, and returns pr_url', async () => {
    const { exec, calls } = pipelineExec();
    const logs: string[] = [];
    const executor = new JobExecutor({
      harness: changingHarness,
      config: config(),
      jobId: 50,
      log: (m) => logs.push(m),
      exec,
    });
    const result = await executor.execute(issueContextFromPayload(payload(), 'default'));

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.pr_url).toBe(prUrl);

    const commands = calls.map((c) => `${c.command} ${c.args[0]}`);
    expect(commands).toEqual([
      'git clone',
      'git checkout',
      'git status',
      'git add',
      'git commit',
      'git push',
      'gh pr',
    ]);
    // push goes to origin via ambient credentials
    const push = calls.find((c) => c.command === 'git' && c.args[0] === 'push')!;
    expect(push.args).toContain('origin');
    // workspace cleaned up
    expect(existsSync(join(root, 'jobs', '50'))).toBe(false);
  });

  it('clones via the plain url with ambient credentials', async () => {
    const { exec, calls } = pipelineExec();
    const executor = new JobExecutor({
      harness: changingHarness,
      config: config(),
      jobId: 51,
      log: () => {},
      exec,
    });
    const result = await executor.execute(
      issueContextFromPayload(payload({ issue_id: 51, branch_name: 'sf-51' })),
    );
    expect(result.pr_url).toBe(prUrl);

    const clone = calls.find((c) => c.args[0] === 'clone')!;
    expect(clone.args[1]).toBe('https://github.com/acme/repo.git');
    const push = calls.find((c) => c.args[0] === 'push')!;
    expect(push.args).toContain('origin');
  });

  it('skips git/PR when the harness reports no changes', async () => {
    const { exec, calls } = pipelineExec();
    const noChange: Harness = {
      run: async () => ({ success: true, summary: 'nothing to do', changed: false }),
    };
    const executor = new JobExecutor({
      harness: noChange,
      config: config(),
      jobId: 52,
      log: () => {},
      exec,
    });
    const result = await executor.execute(issueContextFromPayload(payload({ issue_id: 52 })));
    expect(result.changed).toBe(false);
    expect(result.pr_url).toBeUndefined();
    // Only clone + checkout ran; no status/add/commit/push/gh.
    expect(calls.every((c) => c.args[0] === 'clone' || c.args[0] === 'checkout')).toBe(true);
  });

  it('reports failure and cleans up when the harness fails', async () => {
    const { exec } = pipelineExec();
    const failing: Harness = {
      run: async () => ({ success: false, summary: 'compile error', changed: false }),
    };
    const executor = new JobExecutor({
      harness: failing,
      config: config(),
      jobId: 53,
      log: () => {},
      exec,
    });
    const result = await executor.execute(issueContextFromPayload(payload({ issue_id: 53 })));
    expect(result.success).toBe(false);
    expect(result.summary).toContain('compile error');
    expect(existsSync(join(root, 'jobs', '53'))).toBe(false);
  });

  it('aborts the harness on job timeout and reports failure', async () => {
    vi.useFakeTimers();
    const { exec } = pipelineExec();
    // Harness resolves only when its abort signal fires.
    const slow: Harness = {
      run: async (_w, _i, o) =>
        new Promise<HarnessResult>((resolve) => {
          o?.signal?.addEventListener('abort', () =>
            resolve({ success: false, summary: 'cancelled', changed: true }),
          );
        }),
    };
    const executor = new JobExecutor({
      harness: slow,
      config: config(),
      jobId: 54,
      log: () => {},
      exec,
      timeoutMs: 1000,
    });
    const p = executor.execute(issueContextFromPayload(payload({ issue_id: 54 })));
    await Promise.resolve(); // let prepareWorkspace's awaits settle
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.summary).toContain('cancelled');
    vi.useRealTimers();
  });
});
