import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, tailLog } from '../src/logger.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vps-agent-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Logger', () => {
  it('writes structured JSON lines and respects level', () => {
    const logger = new Logger({ dir, level: 'info', console: false });
    logger.info('hello', { a: 1 });
    logger.debug('skipped'); // below level
    const lines = readFileSync(logger.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.level).toBe('info');
    expect(rec.message).toBe('hello');
    expect(rec.a).toBe(1);
    expect(typeof rec.timestamp).toBe('string');
  });

  it('rotates when exceeding maxBytes', () => {
    const logger = new Logger({ dir, level: 'info', console: false, maxBytes: 200, maxBackups: 2 });
    for (let i = 0; i < 50; i++) logger.info(`line ${i} ${'x'.repeat(20)}`);
    expect(existsSync(`${logger.path}.1`)).toBe(true);
  });

  it('child logger merges bindings', () => {
    const logger = new Logger({ dir, level: 'info', console: false });
    logger.child({ job_id: 7 }).info('with binding');
    const rec = JSON.parse(readFileSync(logger.path, 'utf8').trim());
    expect(rec.job_id).toBe(7);
  });
});

describe('tailLog', () => {
  it('prints trailing lines and resolves when not following', async () => {
    const logger = new Logger({ dir, level: 'info', console: false });
    logger.info('one');
    logger.info('two');
    const captured: string[] = [];
    const { done } = tailLog(logger.path, { follow: false, onLine: (l) => captured.push(l) });
    await done;
    expect(captured).toHaveLength(2);
    expect(JSON.parse(captured[1]!).message).toBe('two');
  });

  it('handles missing file gracefully', async () => {
    const captured: string[] = [];
    const { done } = tailLog(join(dir, 'nope.log'), {
      follow: false,
      onLine: (l) => captured.push(l),
    });
    await done;
    expect(captured[0]).toContain('no log file');
  });
});
