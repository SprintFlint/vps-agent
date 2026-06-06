import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from '../src/register.js';
import type { ApiClient } from '../src/api-client.js';
import type { AgentConfig } from '../src/config.js';

let dir: string;

function baseConfig(): AgentConfig {
  return {
    api_url: 'http://localhost:3000',
    token: null,
    log_level: 'info',
    harness: 'noop',
    permission_mode: 'default',
    config_dir: dir,
    runner_id: null,
    heartbeat_interval: 30,
    poll_interval: 5,
    max_log_batch_size: 100,
  };
}

function readSaved(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vps-register-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('register', () => {
  it('mode (a): calls register and persists token + runner_id + server config', async () => {
    const registerFn = vi.fn().mockResolvedValue({
      runner_id: 99,
      auth_token: 'srv-token',
      config: { heartbeat_interval: 45, max_log_batch_size: 250, supported_job_types: [], api_version: 'v1' },
    });
    const client = { register: registerFn } as unknown as ApiClient;

    const result = await register(
      { orgId: 'org-1', name: 'my-box' },
      baseConfig(),
      { makeClient: () => client },
    );

    expect(result.mode).toBe('register');
    expect(result.token).toBe('srv-token');
    expect(result.runnerId).toBe(99);
    const saved = readSaved();
    expect(saved.token).toBe('srv-token');
    expect(saved.runner_id).toBe(99);
    expect(saved.heartbeat_interval).toBe(45);
    expect(saved.max_log_batch_size).toBe(250);
    // register payload included org + name + hostname.
    const payload = registerFn.mock.calls[0]![0] as { organization_id: string; name: string };
    expect(payload.organization_id).toBe('org-1');
    expect(payload.name).toBe('my-box');
  });

  it('mode (b): persists a provided token without calling the API', async () => {
    const registerFn = vi.fn();
    const client = { register: registerFn } as unknown as ApiClient;

    const result = await register(
      { token: 'ui-token', apiUrl: 'https://sprintflint.com' },
      baseConfig(),
      { makeClient: () => client },
    );

    expect(registerFn).not.toHaveBeenCalled();
    expect(result.mode).toBe('token');
    const saved = readSaved();
    expect(saved.token).toBe('ui-token');
    expect(saved.api_url).toBe('https://sprintflint.com');
  });

  it('throws when neither token nor org-id+name is provided', async () => {
    await expect(register({ name: 'only-name' }, baseConfig())).rejects.toThrow(/requires/);
  });
});
