import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultPidfile,
  writePidfile,
  readPidfile,
  removePidfile,
  isProcessAlive,
  inspectRunning,
} from '../src/daemon.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vps-daemon-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('daemon pidfile helpers', () => {
  it('defaultPidfile lives in the config dir', () => {
    expect(defaultPidfile(dir)).toBe(join(dir, 'agent.pid'));
  });

  it('writes and reads back a pid', () => {
    const path = defaultPidfile(dir);
    writePidfile(path, 12345);
    expect(readPidfile(path)).toBe(12345);
  });

  it('readPidfile returns null when absent', () => {
    expect(readPidfile(join(dir, 'nope.pid'))).toBeNull();
  });

  it('removePidfile deletes the file', () => {
    const path = defaultPidfile(dir);
    writePidfile(path, 1);
    expect(existsSync(path)).toBe(true);
    removePidfile(path);
    expect(existsSync(path)).toBe(false);
  });

  it('isProcessAlive is true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('inspectRunning reports the live current process and cleans stale files', () => {
    const path = defaultPidfile(dir);
    writePidfile(path, process.pid);
    expect(inspectRunning(path)).toEqual({ running: true, pid: process.pid });

    // Use an almost-certainly-dead pid to exercise stale cleanup.
    const deadPid = 2 ** 31 - 1;
    writePidfile(path, deadPid);
    const info = inspectRunning(path);
    expect(info.running).toBe(false);
    expect(existsSync(path)).toBe(false); // stale pidfile removed
  });
});
