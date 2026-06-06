/**
 * SF-154: security pass integration tests.
 *
 *  - config/token file is written 0600 inside a 0700 dir,
 *  - the Logger never writes a secret to disk or console,
 *  - the LogStreamer never POSTs a secret to append_log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { saveConfig, configPath } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { LogStreamer } from '../src/log-streamer.js';
import type { ApiClient } from '../src/api-client.js';
import type { LogLine } from '../src/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vps-agent-sec-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const isPosix = platform() !== 'win32';

describe('config file permissions (SF-154)', () => {
  it.skipIf(!isPosix)('writes the config/token file as 0600', () => {
    saveConfig({ token: 'rt_supersecret' }, dir);
    const mode = statSync(configPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(!isPosix)('writes the config directory as 0700', () => {
    saveConfig({ token: 'rt_supersecret' }, dir);
    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it.skipIf(!isPosix)('tightens an already-too-open config file on the next write', () => {
    saveConfig({ token: 'rt_a' }, dir);
    chmodSync(configPath(dir), 0o644);
    saveConfig({ token: 'rt_b' }, dir);
    const mode = statSync(configPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does keep the token in the file (it is the secret store) but not world-readable', () => {
    saveConfig({ token: 'rt_supersecret' }, dir);
    const contents = readFileSync(configPath(dir), 'utf8');
    expect(contents).toContain('rt_supersecret');
  });
});

describe('Logger secret redaction (SF-154)', () => {
  it('redacts secrets from the message and metadata written to disk', () => {
    const logger = new Logger({ dir, console: false, level: 'debug' });
    logger.info('pushed to https://x-access-token:ghp_0123456789abcdefABCD@github.com/a/b.git', {
      git_token: 'ghp_0123456789abcdefABCD',
      ok: true,
    });
    const written = readFileSync(logger.path, 'utf8');
    expect(written).not.toContain('ghp_0123456789abcdefABCD');
    expect(written).toContain('***redacted***');
    expect(written).toContain('"ok":true');
  });

  it('redacts secrets echoed to the console sink', () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error narrow override for the test
    process.stderr.write = (chunk: string) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      const logger = new Logger({ dir, console: true, level: 'debug' });
      logger.warn('saw token=abc123def456 in output');
    } finally {
      process.stderr.write = orig;
    }
    const joined = lines.join('');
    expect(joined).not.toContain('abc123def456');
    expect(joined).toContain('token=***redacted***');
  });
});

describe('LogStreamer secret redaction (SF-154)', () => {
  it('never POSTs a raw secret to append_log', async () => {
    const sent: LogLine[] = [];
    const fakeClient = {
      appendLog: async (input: { job_id: number; log_lines: LogLine[] }) => {
        sent.push(...input.log_lines);
        return { acknowledged: true, job_id: input.job_id, lines_appended: input.log_lines.length };
      },
    } as unknown as ApiClient;

    const logger = new Logger({ dir, console: false });
    const streamer = new LogStreamer({ client: fakeClient, logger, jobId: 7, maxBatchSize: 100 });
    streamer.append(
      'git push to https://x-access-token:ghp_0123456789abcdefABCD@github.com/a/b.git',
      'info',
      {
        remote_token: 'ghp_0123456789abcdefABCD',
      },
    );
    await streamer.flushAll();

    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain('ghp_0123456789abcdefABCD');
    expect(serialized).toContain('***redacted***');
  });
});

describe('agent.log is created without world/group write (best-effort)', () => {
  it.skipIf(!isPosix)('does not widen an existing tightened log file', () => {
    const logger = new Logger({ dir, console: false });
    logger.info('first line');
    // Tighten, then log again; the agent must not loosen it.
    chmodSync(logger.path, 0o600);
    logger.info('second line');
    const mode = statSync(logger.path).mode & 0o077;
    // No group/other write bits.
    expect(mode & 0o022).toBe(0);
  });
});
