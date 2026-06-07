import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  ClaudeCodeHarness,
  buildPrompt,
  mapPermissionMode,
  type SpawnFn,
  type SpawnedProcess,
} from '../src/claude-harness.js';
import { issueContextFromPayload, type IssueContext } from '../src/harness.js';
import type { JobPayload } from '../src/types.js';

/** A controllable fake child process. */
class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter() as unknown as SpawnedProcess['stdout'];
  stderr = new EventEmitter() as unknown as SpawnedProcess['stderr'];
  killed: NodeJS.Signals[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    return true;
  }
}

function payload(overrides: Partial<JobPayload> = {}): JobPayload {
  return {
    issue_id: 99,
    issue_reference: 'SF-99',
    issue_title: 'Add a widget',
    repository_url: 'https://github.com/acme/repo.git',
    branch_name: 'sf-99',
    description: 'We need a widget',
    acceptance_criteria: ['renders', 'is accessible'],
    comments: [{ author: 'lee', body: 'use the design system' }],
    ...overrides,
  };
}

describe('mapPermissionMode', () => {
  it('maps default and undefined to acceptEdits', () => {
    expect(mapPermissionMode(undefined)).toBe('acceptEdits');
    expect(mapPermissionMode('default')).toBe('acceptEdits');
  });
  it('passes bypassPermissions/plan/acceptEdits through', () => {
    expect(mapPermissionMode('bypassPermissions')).toBe('bypassPermissions');
    expect(mapPermissionMode('plan')).toBe('plan');
    expect(mapPermissionMode('acceptEdits')).toBe('acceptEdits');
  });
});

describe('buildPrompt', () => {
  it('includes title, description, criteria, and comments', () => {
    const ctx = issueContextFromPayload(payload());
    const prompt = buildPrompt(ctx);
    expect(prompt).toContain('SF-99');
    expect(prompt).toContain('Add a widget');
    expect(prompt).toContain('We need a widget');
    expect(prompt).toContain('- renders');
    expect(prompt).toContain('lee: use the design system');
    expect(prompt).toContain('Do not commit, push, or open a pull request');
  });
});

describe('ClaudeCodeHarness', () => {
  function makeHarness(child: FakeChild, opts: { perm?: string } = {}): {
    harness: ClaudeCodeHarness;
    spawn: ReturnType<typeof vi.fn>;
    issue: IssueContext;
  } {
    const spawn = vi.fn<Parameters<SpawnFn>, SpawnedProcess>(() => child);
    const harness = new ClaudeCodeHarness({ spawn: spawn as unknown as SpawnFn, timeoutMs: 10_000 });
    const issue = issueContextFromPayload(
      payload(),
      (opts.perm as IssueContext['permissionMode']) ?? 'default',
    );
    return { harness, spawn, issue };
  }

  it('invokes claude -p with the prompt and permission-mode flag', async () => {
    const child = new FakeChild();
    const { harness, spawn, issue } = makeHarness(child, { perm: 'bypassPermissions' });
    const logs: string[] = [];

    const p = harness.run('/work', issue, { log: (m) => logs.push(m) });
    // Emit some output then close cleanly.
    (child.stdout as unknown as EventEmitter).emit('data', 'edited files\nall good\n');
    child.emit('close', 0, null);
    const result = await p;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawn.mock.calls[0]!;
    expect(cmd).toBe('claude');
    expect(args[0]).toBe('-p');
    expect(args[1]).toContain('Add a widget'); // the prompt
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(args).toContain('--output-format');
    expect((options as { cwd: string }).cwd).toBe('/work');

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(logs.join('\n')).toContain('edited files');
  });

  it('reports failure on non-zero exit', async () => {
    const child = new FakeChild();
    const { harness, issue } = makeHarness(child);
    const p = harness.run('/work', issue, {});
    (child.stderr as unknown as EventEmitter).emit('data', 'boom\n');
    child.emit('close', 2, null);
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.summary).toContain('code 2');
  });

  it('kills the process on timeout and reports partial', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const spawn = vi.fn<Parameters<SpawnFn>, SpawnedProcess>(() => child);
    const harness = new ClaudeCodeHarness({ spawn: spawn as unknown as SpawnFn, timeoutMs: 1000 });
    const issue = issueContextFromPayload(payload());

    const p = harness.run('/work', issue, {});
    vi.advanceTimersByTime(1000); // trip the timeout -> SIGTERM
    expect(child.killed).toContain('SIGTERM');
    // The process eventually closes after being killed.
    child.emit('close', null, 'SIGTERM');
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.summary).toContain('timed out');
    vi.useRealTimers();
  });

  it('kills the process when the abort signal fires (cancel)', async () => {
    const child = new FakeChild();
    const { harness, issue } = makeHarness(child);
    const controller = new AbortController();
    const p = harness.run('/work', issue, { signal: controller.signal });
    controller.abort();
    expect(child.killed).toContain('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    const result = await p;
    expect(result.success).toBe(false);
    expect(result.summary).toContain('cancelled');
  });
});
