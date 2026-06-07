/**
 * SF-137 (ClaudeCodeHarness) + SF-141 (timeout/kill).
 *
 * Runs Claude Code headless in the prepared workdir:
 *
 *   claude -p "<prompt>" --permission-mode <mode> --output-format text
 *
 * The prompt is assembled from the IssueContext (title, description/body,
 * acceptance criteria, comments). stdout/stderr are streamed to the job log as
 * they arrive. A timeout (or an external cancel via AbortSignal) kills the
 * process and reports a partial/failed result.
 *
 * CRITICAL: the process spawn is INJECTABLE (see {@link SpawnFn}) so unit tests
 * exercise the command/flags/prompt assembly and timeout/kill behaviour WITHOUT
 * invoking a real `claude` binary.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Harness, HarnessResult, IssueContext, HarnessRunOptions } from './harness.js';
import type { PermissionMode } from './types.js';

/** Minimal child-process surface the harness depends on (for injection). */
export interface SpawnedProcess {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Injectable spawn. Defaults to a node:child_process-backed implementation. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedProcess;

export interface ClaudeCodeHarnessOptions {
  /** Injectable spawn (tests pass a fake). */
  spawn?: SpawnFn;
  /** Path/name of the claude binary. Defaults to 'claude'. */
  binary?: string;
  /** Hard timeout in ms. Defaults to 30 minutes. */
  timeoutMs?: number;
  /** Injectable timers (tests use fake timers). */
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

/**
 * Map our generic PermissionMode onto claude's --permission-mode flag.
 *   default          -> acceptEdits  (let it edit files; the runner reviews via PR)
 *   acceptEdits      -> acceptEdits
 *   bypassPermissions-> bypassPermissions  (explicit opt-in to full autonomy)
 *   plan             -> plan
 */
export function mapPermissionMode(mode: PermissionMode | undefined): string {
  switch (mode) {
    case undefined:
    case 'default':
      return 'acceptEdits';
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'acceptEdits';
    default:
      // Unknown string: pass through; claude validates it.
      return mode;
  }
}

/** Assemble the headless prompt from the issue context. */
export function buildPrompt(issue: IssueContext): string {
  const lines: string[] = [];
  const ref = issue.issueReference ?? `#${issue.issueId}`;
  lines.push(`You are an autonomous software engineer working on issue ${ref}.`);
  lines.push('');
  lines.push(`# Title`);
  lines.push(issue.issueTitle);

  const description = issue.body?.trim() || issue.description?.trim();
  if (description) {
    lines.push('');
    lines.push('# Description');
    lines.push(description);
  }

  if (issue.acceptanceCriteria) {
    lines.push('');
    lines.push('# Acceptance criteria');
    if (Array.isArray(issue.acceptanceCriteria)) {
      for (const c of issue.acceptanceCriteria) lines.push(`- ${c}`);
    } else {
      lines.push(issue.acceptanceCriteria.trim());
    }
  }

  if (issue.comments && issue.comments.length > 0) {
    lines.push('');
    lines.push('# Discussion');
    for (const c of issue.comments) {
      lines.push(`- ${c.author ? `${c.author}: ` : ''}${c.body}`);
    }
  }

  lines.push('');
  lines.push(
    'Implement the change directly in this repository. Make focused, correct edits ' +
      'and run any relevant tests. Do not commit, push, or open a pull request; the ' +
      'runner handles that. When done, briefly summarize what you changed.',
  );
  return lines.join('\n');
}

export class ClaudeCodeHarness implements Harness {
  private readonly spawnFn: SpawnFn;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly setTimer: NonNullable<ClaudeCodeHarnessOptions['setTimer']>;
  private readonly clearTimer: NonNullable<ClaudeCodeHarnessOptions['clearTimer']>;

  constructor(options: ClaudeCodeHarnessOptions = {}) {
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.binary = options.binary ?? 'claude';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** Flags this harness invokes claude with (exposed for tests/inspection). */
  buildArgs(issue: IssueContext): string[] {
    return [
      '-p',
      buildPrompt(issue),
      '--permission-mode',
      mapPermissionMode(issue.permissionMode),
      '--output-format',
      'text',
    ];
  }

  async run(workdir: string, issue: IssueContext, options: HarnessRunOptions = {}): Promise<HarnessResult> {
    const log = options.log ?? (() => {});
    const args = this.buildArgs(issue);

    log(`Launching ${this.binary} (permission-mode ${mapPermissionMode(issue.permissionMode)})`);

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
        log('Cancel requested; killing claude', 'warn');
        child.kill('SIGTERM');
      };

      const timer = this.setTimer(() => {
        timedOut = true;
        log(`Timed out after ${this.timeoutMs}ms; killing claude`, 'error');
        child.kill('SIGTERM');
        // Escalate to SIGKILL shortly after, in case SIGTERM is ignored.
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
          summary: `claude process error: ${err.message}`,
          changed: false,
        });
      });

      child.on('close', (code) => {
        if (timedOut) {
          finish({
            success: false,
            summary: `claude timed out after ${this.timeoutMs}ms (partial work may remain in the workspace)`,
            changed: true,
          });
          return;
        }
        if (cancelled) {
          finish({
            success: false,
            summary: 'claude was cancelled before completing (partial work may remain)',
            changed: true,
          });
          return;
        }
        if (code === 0) {
          const summary = tail.trim().split('\n').slice(-5).join('\n') || `claude completed issue ${issue.issueReference ?? `#${issue.issueId}`}`;
          finish({ success: true, summary, changed: true });
          return;
        }
        finish({
          success: false,
          summary: `claude exited with code ${code ?? 'signal'}: ${tail.trim().slice(-500) || '(no output)'}`,
          changed: false,
        });
      });
    });
  }
}
