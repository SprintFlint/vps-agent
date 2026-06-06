import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  saveConfig,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_MAX_LOG_BATCH_SIZE,
  DEFAULT_POLL_INTERVAL,
} from '../src/config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vps-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runtime config keys', () => {
  it('defaults the runtime keys', () => {
    const cfg = loadConfig({ overrides: { config_dir: dir }, env: {} });
    expect(cfg.heartbeat_interval).toBe(DEFAULT_HEARTBEAT_INTERVAL);
    expect(cfg.poll_interval).toBe(DEFAULT_POLL_INTERVAL);
    expect(cfg.max_log_batch_size).toBe(DEFAULT_MAX_LOG_BATCH_SIZE);
    expect(cfg.runner_id).toBeNull();
  });

  it('reads persisted numeric keys from config.json', () => {
    saveConfig({ heartbeat_interval: 45, runner_id: 7, max_log_batch_size: 200 }, dir);
    const cfg = loadConfig({ overrides: { config_dir: dir }, env: {} });
    expect(cfg.heartbeat_interval).toBe(45);
    expect(cfg.runner_id).toBe(7);
    expect(cfg.max_log_batch_size).toBe(200);
  });

  it('env var overrides persisted numeric key', () => {
    saveConfig({ heartbeat_interval: 45 }, dir);
    const cfg = loadConfig({
      overrides: { config_dir: dir },
      env: { VPS_AGENT_HEARTBEAT_INTERVAL: '12' },
    });
    expect(cfg.heartbeat_interval).toBe(12);
  });

  it('ignores non-numeric env values for numeric keys', () => {
    const cfg = loadConfig({
      overrides: { config_dir: dir },
      env: { VPS_AGENT_POLL_INTERVAL: 'not-a-number' },
    });
    expect(cfg.poll_interval).toBe(DEFAULT_POLL_INTERVAL);
  });

  it('does not persist config_dir into config.json', () => {
    saveConfig({ config_dir: '/somewhere/else', token: 't' } as never, dir);
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(raw.config_dir).toBeUndefined();
    expect(raw.token).toBe('t');
  });
});
