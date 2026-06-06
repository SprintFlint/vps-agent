/**
 * SF-152: CLI command-handler coverage.
 *
 * Drives buildProgram() in-process, capturing stdout/stderr/exitCode. Commands
 * that fork a daemon (start --daemon) are not exercised here; the integration
 * test (SF-153) covers the run loop end to end. These tests target the parsing,
 * branching, and error paths of each command handler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/cli.js';
import { saveConfig, configPath } from '../src/config.js';

let dir: string;
let out: string;
let err: string;
let restoreEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vps-agent-cli-'));
  out = '';
  err = '';
  restoreEnv = process.env.VPS_AGENT_CONFIG_DIR;
  process.env.VPS_AGENT_CONFIG_DIR = dir;
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    err += String(c);
    return true;
  });
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (restoreEnv === undefined) delete process.env.VPS_AGENT_CONFIG_DIR;
  else process.env.VPS_AGENT_CONFIG_DIR = restoreEnv;
  rmSync(dir, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride(); // throw instead of process.exit on commander errors
  await program.parseAsync(['node', 'vps-agent', ...args]);
}

describe('version', () => {
  it('prints version + runtime info', async () => {
    await run('version');
    expect(out).toMatch(/vps-agent \d+\.\d+\.\d+ \(node /);
  });
});

describe('config show', () => {
  it('redacts the token', async () => {
    saveConfig({ token: 'rt_secret_value' }, dir);
    await run('config', 'show');
    expect(out).toContain('***redacted***');
    expect(out).not.toContain('rt_secret_value');
    expect(out).toContain('config file:');
  });

  it('shows token: null when unregistered', async () => {
    await run('config', 'show');
    expect(out).toContain('"token": null');
  });
});

describe('config set', () => {
  it('persists a valid string key', async () => {
    await run('config', 'set', 'harness', 'claude');
    const persisted = JSON.parse(readFileSync(configPath(dir), 'utf8'));
    expect(persisted.harness).toBe('claude');
    expect(out).toContain('Set harness');
  });

  it('coerces a valid numeric key', async () => {
    await run('config', 'set', 'poll_interval', '12');
    const persisted = JSON.parse(readFileSync(configPath(dir), 'utf8'));
    expect(persisted.poll_interval).toBe(12);
  });

  it('rejects an unknown key', async () => {
    await run('config', 'set', 'bogus', 'x');
    expect(err).toContain('Unknown config key');
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-numeric value for a numeric key', async () => {
    await run('config', 'set', 'poll_interval', 'notanumber');
    expect(err).toContain('must be a number');
    expect(process.exitCode).toBe(1);
  });
});

describe('register error path', () => {
  it('fails clearly when neither token nor org-id+name are given', async () => {
    await run('register');
    expect(err).toContain('register failed:');
    expect(process.exitCode).toBe(1);
  });

  it('persists a directly-provided token (mode b, no API call)', async () => {
    await run('register', '--token', 'rt_from_ui', '--api-url', 'http://localhost:3000');
    const persisted = JSON.parse(readFileSync(configPath(dir), 'utf8'));
    expect(persisted.token).toBe('rt_from_ui');
    expect(out).toContain('Saved runner token');
  });
});

describe('status', () => {
  it('reports not running + unregistered as JSON', async () => {
    await run('status');
    const parsed = JSON.parse(out);
    expect(parsed.running).toBe(false);
    expect(parsed.registered).toBe(false);
    expect(parsed.config_file).toBe(configPath(dir));
  });

  it('reports registered=true once a token is saved', async () => {
    saveConfig({ token: 'rt_x', runner_id: 5 }, dir);
    await run('status');
    const parsed = JSON.parse(out);
    expect(parsed.registered).toBe(true);
    expect(parsed.runner_id).toBe(5);
  });
});

describe('stop', () => {
  it('reports no running agent when there is none', async () => {
    await run('stop');
    expect(out).toContain('No running agent found.');
  });
});

describe('unregister', () => {
  it('clears the local token + runner_id', async () => {
    saveConfig({ token: 'rt_x', runner_id: 9 }, dir);
    await run('unregister');
    const persisted = JSON.parse(readFileSync(configPath(dir), 'utf8'));
    expect(persisted.token).toBeNull();
    expect(persisted.runner_id).toBeNull();
    expect(out).toContain('Cleared local token');
  });
});

describe('start without a token', () => {
  it('refuses to start and exits non-zero', async () => {
    await run('start');
    expect(err).toContain('No runner token configured');
    expect(process.exitCode).toBe(1);
  });
});

describe('logs', () => {
  it('reports when there is no log file yet', async () => {
    await run('logs', '-n', '5');
    expect(out).toContain('no log file yet');
  });
});
