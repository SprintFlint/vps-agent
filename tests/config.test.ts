import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  saveConfig,
  readPersisted,
  parseEnvFile,
  PROD_API_URL,
} from '../src/config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vps-agent-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('parses key=value, comments, blanks, and quotes', () => {
    const parsed = parseEnvFile(
      ['# comment', '', 'A=1', 'B="two"', "C='three'", 'D = spaced'].join('\n'),
    );
    expect(parsed).toEqual({ A: '1', B: 'two', C: 'three', D: 'spaced' });
  });
});

describe('loadConfig', () => {
  it('returns defaults with prod api_url when nothing is set', () => {
    const cfg = loadConfig({ cwd: dir, env: {}, overrides: { config_dir: dir } });
    expect(cfg.api_url).toBe(PROD_API_URL);
    expect(cfg.token).toBeNull();
    expect(cfg.log_level).toBe('info');
    expect(cfg.harness).toBe('noop');
    expect(cfg.permission_mode).toBe('default');
    expect(cfg.config_dir).toBe(dir);
  });

  it('layers config.json under .env under env vars', () => {
    saveConfig({ api_url: 'http://from-json', log_level: 'warn' }, dir);
    writeFileSync(join(dir, '.env'), 'VPS_AGENT_API_URL=http://from-env-file\n');
    const cfg = loadConfig({
      cwd: dir,
      env: { VPS_AGENT_CONFIG_DIR: dir, VPS_AGENT_LOG_LEVEL: 'debug' },
    });
    // env var beats .env file for api_url? api_url only in .env -> .env wins over json
    expect(cfg.api_url).toBe('http://from-env-file');
    // log_level: env var beats json
    expect(cfg.log_level).toBe('debug');
  });

  it('env var beats .env file', () => {
    writeFileSync(join(dir, '.env'), 'VPS_AGENT_API_URL=http://from-env-file\n');
    const cfg = loadConfig({
      cwd: dir,
      env: { VPS_AGENT_CONFIG_DIR: dir, VPS_AGENT_API_URL: 'http://from-real-env' },
    });
    expect(cfg.api_url).toBe('http://from-real-env');
  });

  it('rejects invalid log levels and falls back', () => {
    const cfg = loadConfig({
      cwd: dir,
      env: { VPS_AGENT_CONFIG_DIR: dir, VPS_AGENT_LOG_LEVEL: 'bogus' },
    });
    expect(cfg.log_level).toBe('info');
  });

  it('explicit overrides win over everything', () => {
    writeFileSync(join(dir, '.env'), 'VPS_AGENT_HARNESS=from-env\n');
    const cfg = loadConfig({
      cwd: dir,
      env: { VPS_AGENT_CONFIG_DIR: dir },
      overrides: { config_dir: dir, harness: 'override-harness' },
    });
    expect(cfg.harness).toBe('override-harness');
  });
});

describe('saveConfig / readPersisted', () => {
  it('round-trips and merges, never writing config_dir', () => {
    saveConfig({ token: 'abc' }, dir);
    saveConfig({ harness: 'noop' }, dir);
    const persisted = readPersisted(dir);
    expect(persisted).toEqual({ token: 'abc', harness: 'noop' });
    expect('config_dir' in persisted).toBe(false);
  });
});
