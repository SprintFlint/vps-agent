/**
 * Default child_process-backed command runner, shared by workspace, git-ops,
 * pr, and preflight. All of those modules accept an injectable {@link ExecFn}
 * so tests never shell out; this is the production implementation.
 */

import { spawn } from 'node:child_process';
import type { ExecResult, ExecFn } from './git-ops.js';

export type { ExecResult, ExecFn } from './git-ops.js';

export interface DefaultExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Stream stdout/stderr line-ish chunks here as they arrive. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

/**
 * Run a command to completion, collecting stdout/stderr. Never rejects on a
 * non-zero exit; callers inspect `exitCode`. Rejects only on spawn failure
 * (e.g. command not found).
 */
export function runCommand(
  command: string,
  args: string[],
  options: DefaultExecOptions = {},
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      options.onOutput?.(s, 'stdout');
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      options.onOutput?.(s, 'stderr');
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/** The default ExecFn used by modules when no injection is provided. */
export const defaultExec: ExecFn = (command, args, options) =>
  runCommand(command, args, {
    ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
  });
