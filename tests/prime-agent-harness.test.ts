import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  PrimeAgentHarness,
  type SpawnFn,
  type SpawnedProcess,
} from '../src/prime-agent-harness.js';
import { defaultHarnessRegistry, issueContextFromPayload } from '../src/harness.js';
import type { JobPayload } from '../src/types.js';

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
    ...overrides,
  };
}

describe('defaultHarnessRegistry', () => {
  it('resolves the prime-agent harness', () => {
    const registry = defaultHarnessRegistry();
    expect(registry.has('prime-agent')).toBe(true);
    expect(registry.resolve('prime-agent')).toBeInstanceOf(PrimeAgentHarness);
  });
});

describe('PrimeAgentHarness', () => {
  it('invokes prime-agent in autonomous print mode with the issue prompt', async () => {
    const child = new FakeChild();
    const spawn = vi.fn<Parameters<SpawnFn>, SpawnedProcess>(() => child);
    const harness = new PrimeAgentHarness({ spawn });
    const issue = issueContextFromPayload(payload());
    const pending = harness.run('/tmp/workdir', issue);
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = spawn.mock.calls[0]!;
    expect(cmd).toBe('prime-agent');
    expect(args[0]).toBe('-p');
    expect(args).toContain('--autonomous');
    expect(args).toContain('--offline');
    expect(args.at(-1)).toContain('SF-99');
    expect(opts.cwd).toBe('/tmp/workdir');
    queueMicrotask(() => child.emit('close', 0, null));
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
  });
});
