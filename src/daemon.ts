/**
 * SF-133: Daemon / pidfile helpers.
 *
 * Pure, side-effect-light helpers for managing the agent's pidfile so `start
 * --daemon` and `stop` can find and signal a running agent. The actual fork is
 * done in cli.ts (it needs argv); this module owns the pidfile contract.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Default pidfile location inside the config dir. */
export function defaultPidfile(configDir: string): string {
  return join(configDir, 'agent.pid');
}

/** Write the current (or given) pid to a pidfile, creating parent dirs. */
export function writePidfile(path: string, pid: number = process.pid): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`, 'utf8');
}

/** Read a pid from a pidfile, or null if absent/invalid. */
export function readPidfile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Remove a pidfile, ignoring errors. */
export function removePidfile(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

/** Whether a process with the given pid is alive (signal 0 probe). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it; treat as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface RunningInfo {
  running: boolean;
  pid: number | null;
}

/** Inspect the pidfile and whether that process is alive; cleans stale files. */
export function inspectRunning(pidfile: string): RunningInfo {
  const pid = readPidfile(pidfile);
  if (pid === null) return { running: false, pid: null };
  if (isProcessAlive(pid)) return { running: true, pid };
  // Stale pidfile: process gone. Clean it up.
  removePidfile(pidfile);
  return { running: false, pid: null };
}

/** Send a signal to the pid in the pidfile. Returns the pid signalled or null. */
export function signalRunning(pidfile: string, signal: NodeJS.Signals = 'SIGTERM'): number | null {
  const info = inspectRunning(pidfile);
  if (!info.running || info.pid === null) return null;
  try {
    process.kill(info.pid, signal);
    return info.pid;
  } catch {
    return null;
  }
}
