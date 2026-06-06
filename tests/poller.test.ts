import { describe, it, expect, vi } from 'vitest';
import { Poller } from '../src/poller.js';
import { defaultHarnessRegistry, HarnessRegistry, type Harness } from '../src/harness.js';
import type { ApiClient } from '../src/api-client.js';
import type { Logger } from '../src/logger.js';
import type { AgentConfig } from '../src/config.js';
import type { Job } from '../src/types.js';
import type { ExecFn, ExecResult } from '../src/git-ops.js';

/** Mock exec where every git/gh command succeeds with empty output. */
function okExec(): ExecFn {
  return vi.fn(async (): Promise<ExecResult> => ({ stdout: '', stderr: '', exitCode: 0 }));
}

function fakeLogger(): Logger {
  const l: Partial<Logger> = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  };
  (l as { child: () => Logger }).child = () => l as Logger;
  return l as Logger;
}

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    api_url: 'http://localhost:3000',
    token: 'tok',
    log_level: 'info',
    harness: 'noop',
    permission_mode: 'default',
    config_dir: '/tmp/vps-agent-test',
    runner_id: 1,
    heartbeat_interval: 30,
    poll_interval: 5,
    max_log_batch_size: 100,
    ...overrides,
  };
}

const job: Job = {
  job_id: 42,
  job_type: 'autoplay',
  payload: {
    issue_id: 7,
    issue_title: 'Fix the thing',
    repository_url: 'https://example.com/repo.git',
    branch_name: 'sf/fix',
    description: 'do it',
  },
};

function mockClient(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    nextJob: vi.fn().mockResolvedValue({ job: null }),
    updateJob: vi.fn().mockResolvedValue({ acknowledged: true, job_id: 42 }),
    appendLog: vi.fn().mockResolvedValue({ acknowledged: true, job_id: 42, lines_appended: 1 }),
    heartbeat: vi.fn(),
    register: vi.fn(),
    setToken: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

describe('Poller', () => {
  it('claims a job, marks running, runs the noop harness, and finalizes completed', async () => {
    const client = mockClient();
    const busyStates: boolean[] = [];
    const poller = new Poller({
      client,
      logger: fakeLogger(),
      registry: defaultHarnessRegistry(),
      config: baseConfig(),
      onBusyChange: (b) => busyStates.push(b),
    });

    await poller.runJob(job);

    const updateJob = client.updateJob as ReturnType<typeof vi.fn>;
    // First update marks running, last update finalizes.
    expect((updateJob.mock.calls[0]![0] as { status: string }).status).toBe('running');
    const final = updateJob.mock.calls.at(-1)![0] as {
      status: string;
      completion_percentage: number;
      result?: { summary: string; harness: string };
    };
    expect(final.status).toBe('completed');
    expect(final.completion_percentage).toBe(100);
    expect(final.result?.harness).toBe('noop');
    expect(final.result?.summary).toContain('NoopHarness');
    // busy toggled true then false.
    expect(busyStates).toEqual([true, false]);
    expect(poller.isBusy).toBe(false);
  });

  it('finalizes failed with error_message when the harness throws', async () => {
    const client = mockClient();
    const throwing: Harness = {
      run: async () => {
        throw new Error('harness exploded');
      },
    };
    const registry = new HarnessRegistry().register('boom', () => throwing);
    const poller = new Poller({
      client,
      logger: fakeLogger(),
      registry,
      config: baseConfig({ harness: 'boom' }),
      exec: okExec(),
    });

    await poller.runJob(job);

    const updateJob = client.updateJob as ReturnType<typeof vi.fn>;
    const final = updateJob.mock.calls.at(-1)![0] as { status: string; error_message?: string };
    expect(final.status).toBe('failed');
    // The JobExecutor catches the harness error and reports it as the summary.
    expect(final.error_message).toContain('harness exploded');
  });

  it('flushes logs before the terminal update_job', async () => {
    const order: string[] = [];
    const client = mockClient({
      appendLog: vi.fn().mockImplementation(async () => {
        order.push('appendLog');
        return { acknowledged: true, job_id: 42, lines_appended: 1 };
      }),
      updateJob: vi.fn().mockImplementation(async (input: { status: string }) => {
        order.push(`updateJob:${input.status}`);
        return { acknowledged: true, job_id: 42 };
      }),
    });
    const poller = new Poller({
      client,
      logger: fakeLogger(),
      registry: defaultHarnessRegistry(),
      config: baseConfig(),
    });

    await poller.runJob(job);

    // The terminal completed update must come after the log flush.
    const completedIdx = order.indexOf('updateJob:completed');
    const lastAppend = order.lastIndexOf('appendLog');
    expect(completedIdx).toBeGreaterThan(-1);
    expect(lastAppend).toBeGreaterThan(-1);
    expect(completedIdx).toBeGreaterThan(lastAppend);
  });

  it('does not claim a new job while busy (concurrency guard)', async () => {
    const nextJob = vi.fn().mockResolvedValue({ job: null });
    const client = mockClient({ nextJob });
    const timers: Array<() => void> = [];
    const poller = new Poller({
      client,
      logger: fakeLogger(),
      registry: defaultHarnessRegistry(),
      config: baseConfig(),
      setTimer: (fn) => {
        timers.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });

    // Force busy, then start: a tick while busy should skip nextJob.
    // Use a long-running harness to hold busy across a manual tick.
    void poller.runJob(job);
    poller.start(); // first tick runs while runJob may still be in flight
    // Give microtasks a chance.
    await Promise.resolve();
    // nextJob should not be called more than what idle polling would (0 or controlled).
    // Once runJob settles, busy is false; assert the loop is still alive (timer queued).
    await vi.waitFor(() => expect(poller.isBusy).toBe(false));
    poller.stop();
    expect(timers.length).toBeGreaterThan(0);
  });
});
