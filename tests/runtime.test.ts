/**
 * SF-152: Runtime orchestration coverage.
 *
 * Verifies the runtime wires heartbeat + poller together, requires a token,
 * marks the runner offline on shutdown, and is idempotent on double-shutdown.
 * Uses a fake ApiClient so nothing touches the network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.js';
import { loadConfig, type AgentConfig } from '../src/config.js';
import type { ApiClient } from '../src/api-client.js';

let dir: string;

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return loadConfig({
    cwd: dir,
    env: { VPS_AGENT_CONFIG_DIR: dir },
    overrides: { config_dir: dir, ...overrides },
  });
}

interface FakeClient extends ApiClient {
  heartbeatCalls: Array<{ status: string }>;
}

function fakeClient(): FakeClient {
  const heartbeatCalls: Array<{ status: string }> = [];
  const client = {
    heartbeatCalls,
    async heartbeat(input: { status: string }) {
      heartbeatCalls.push({ status: input.status });
      return { acknowledged: true, next_check_interval: 30, runner_id: 1 };
    },
    async nextJob() {
      return { job: null as null };
    },
  } as unknown as FakeClient;
  return client;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vps-agent-rt-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Runtime', () => {
  it('throws if started without a token', () => {
    const runtime = new Runtime({
      config: baseConfig({ token: null }),
      client: fakeClient(),
      installSignalHandlers: false,
    });
    expect(() => runtime.start()).toThrow(/No runner token/);
  });

  it('runs both loops and marks offline on shutdown', async () => {
    const client = fakeClient();
    const runtime = new Runtime({
      config: baseConfig({ token: 'rt_x', heartbeat_interval: 1, poll_interval: 1 }),
      client,
      installSignalHandlers: false,
    });
    const started = runtime.start();
    await new Promise((r) => setTimeout(r, 30));
    await runtime.shutdown();
    await started;
    expect(client.heartbeatCalls.some((c) => c.status === 'offline')).toBe(true);
  });

  it('is idempotent on a second shutdown call', async () => {
    const client = fakeClient();
    const runtime = new Runtime({
      config: baseConfig({ token: 'rt_x', heartbeat_interval: 1, poll_interval: 1 }),
      client,
      installSignalHandlers: false,
    });
    runtime.start();
    await runtime.shutdown();
    const offlineBefore = client.heartbeatCalls.filter((c) => c.status === 'offline').length;
    await runtime.shutdown(); // no-op
    const offlineAfter = client.heartbeatCalls.filter((c) => c.status === 'offline').length;
    expect(offlineAfter).toBe(offlineBefore);
  });

  it('tolerates the offline heartbeat failing on shutdown', async () => {
    const client = {
      async heartbeat() {
        throw new Error('network down');
      },
      async nextJob() {
        return { job: null as null };
      },
    } as unknown as ApiClient;
    const runtime = new Runtime({
      config: baseConfig({ token: 'rt_x', heartbeat_interval: 1, poll_interval: 1 }),
      client,
      installSignalHandlers: false,
    });
    runtime.start();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it('builds its own client/logger from config when none injected', () => {
    const runtime = new Runtime({
      config: baseConfig({ token: 'rt_x', api_url: 'http://127.0.0.1:1' }),
      installSignalHandlers: false,
    });
    expect(runtime.client).toBeDefined();
    expect(runtime.logger).toBeDefined();
  });
});
