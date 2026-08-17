/**
 * PrimeAgentHarness: run Prime Agent headless in the prepared workdir.
 *
 *   prime-agent -p --offline --autonomous --autonomous-timeout-ms <n> -- "<prompt>"
 *
 * Same contract as ClaudeCodeHarness: stream stdout/stderr to the job log,
 * honor AbortSignal / timeout, never commit/push/PR (the runner does that).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Harness, HarnessResult, IssueContext, HarnessRunOptions } from './harness.js';
import { buildPrompt } from './claude-harness.js';

export interface SpawnedProcess {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedProcess;

export interface PrimeAgentHarnessOptions {
  spawn?: SpawnFn;
  binary?: string;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as ChildProcess as SpawnedProcess;

export class PrimeAgentHarness implements Harness {
  private readonly spawnFn: SpawnFn;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly setTimer: NonNullable<PrimeAgentHarnessOptions['setTimer']>;
  private readonly clearTimer: NonNullable<PrimeAgentHarnessOptions['clearTimer']>;

  constructor(options: PrimeAgentHarnessOptions = {}) {
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.binary = options.binary ?? 'prime-agent';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  }

  buildArgs(issue: IssueContext): string[] {
    return [
      '-p',
      '--offline',
      '--autonomous',
      '--autonomous-timeout-ms',
      String(this.timeoutMs),
      '--',
      buildPrompt(issue),
    ];
  }

  async run(workdir: string, issue: IssueContext, options: HarnessRunOptions = {}): Promise<HarnessResult> {
    const log = options.log ?? (() => {});
    const args = this.buildArgs(issue);

    log(`Launching ${this.binary} (autonomous print mode)`);

    return new Promise<HarnessResult>((resolve) => {
      let child: SpawnedProcess;
      try {
        child = this.spawnFn(this.binary, args, { cwd: workdir, env: process.env });
      } catch (err) {
        resolve({
          success: false,
          summary: `Failed to launch ${this.binary}: ${err instanceof Error ? err.message : String(err)}`,
          changed: false,
        });
        return;
      }

      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let tail = '';

      const onAbort = (): void => {
        cancelled = true;
        log('Cancel requested; killing prime-agent', 'warn');
        child.kill('SIGTERM');
      };

      const timer = this.setTimer(() => {
        timedOut = true;
        log(`Timed out after ${this.timeoutMs}ms; killing prime-agent`, 'error');
        child.kill('SIGTERM');
        this.setTimer(() => child.kill('SIGKILL'), 2000);
      }, this.timeoutMs);

      const signal = options.signal;
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const finish = (result: HarnessResult): void => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const capture = (chunk: Buffer | string, level: 'info' | 'error'): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        tail = (tail + text).slice(-2000);
        for (const line of text.split('\n')) {
          if (line.trim().length > 0) log(line, level);
        }
      };

      child.stdout?.on('data', (c) => capture(c, 'info'));
      child.stderr?.on('data', (c) => capture(c, 'error'));

      child.on('error', (err) => {
        finish({
          success: false,
          summary: `prime-agent process error: ${err.message}`,
          changed: false,
        });
      });

      child.on('close', (code) => {
        if (timedOut) {
          finish({
            success: false,
            summary: `prime-agent timed out after ${this.timeoutMs}ms (partial work may remain in the workspace)`,
            changed: true,
          });
          return;
        }
        if (cancelled) {
          finish({
            success: false,
            summary: 'prime-agent was cancelled before completing (partial work may remain)',
            changed: true,
          });
          return;
        }
        if (code === 0) {
          const summary =
            tail.trim().split('\n').slice(-5).join('\n') ||
            `prime-agent completed issue ${issue.issueReference ?? `#${issue.issueId}`}`;
          finish({ success: true, summary, changed: true });
          return;
        }
        finish({
          success: false,
          summary: `prime-agent exited with code ${code ?? 'signal'}: ${tail.trim().slice(-500) || '(no output)'}`,
          changed: false,
        });
      });
    });
  }
}
