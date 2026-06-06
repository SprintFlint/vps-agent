import { describe, it, expect } from 'vitest';
import {
  NoopHarness,
  HarnessRegistry,
  defaultHarnessRegistry,
  issueContextFromPayload,
  resolveBranchName,
} from '../src/harness.js';
import type { JobPayload } from '../src/types.js';

const payload: JobPayload = {
  issue_id: 42,
  issue_reference: 'SF42',
  issue_title: 'Fix the thing',
  repository_url: 'https://github.com/acme/repo',
  branch_name: 'sf-42-fix-the-thing',
  description: 'do it',
};

describe('issueContextFromPayload', () => {
  it('maps snake_case payload to camelCase context', () => {
    const ctx = issueContextFromPayload(payload, 'acceptEdits');
    expect(ctx.issueId).toBe(42);
    expect(ctx.issueTitle).toBe('Fix the thing');
    expect(ctx.repositoryUrl).toBe('https://github.com/acme/repo');
    expect(ctx.branchName).toBe('sf-42-fix-the-thing');
    expect(ctx.issueReference).toBe('SF42');
    expect(ctx.permissionMode).toBe('acceptEdits');
  });
});

describe('resolveBranchName', () => {
  it('uses the server-provided branch name when present', () => {
    expect(resolveBranchName(payload)).toBe('sf-42-fix-the-thing');
  });

  it('derives a branch from the issue reference when branch_name is the literal "null"', () => {
    // Reproduces the race where a runner claims a job before the async
    // branch-name job has populated suggested_branch_name.
    expect(resolveBranchName({ ...payload, branch_name: 'null' as unknown as string })).toBe(
      'autoplay/sf42',
    );
  });

  it('derives a branch from the issue reference when branch_name is empty', () => {
    expect(resolveBranchName({ ...payload, branch_name: '' })).toBe('autoplay/sf42');
  });

  it('falls back to the issue id when no reference is available', () => {
    const { issue_reference, ...without } = payload;
    void issue_reference;
    expect(resolveBranchName({ ...without, branch_name: '' })).toBe('autoplay/issue-42');
  });
});

describe('NoopHarness', () => {
  it('always succeeds without changes', async () => {
    const ctx = issueContextFromPayload(payload);
    const result = await new NoopHarness().run('/tmp/workdir', ctx);
    expect(result).toEqual({
      success: true,
      summary: expect.stringContaining('#42'),
      changed: false,
    });
  });
});

describe('HarnessRegistry', () => {
  it('resolves the built-in noop harness', () => {
    const registry = defaultHarnessRegistry();
    expect(registry.has('noop')).toBe(true);
    expect(registry.names()).toContain('noop');
    expect(registry.resolve('noop')).toBeInstanceOf(NoopHarness);
  });

  it('throws for unknown harness', () => {
    const registry = new HarnessRegistry();
    expect(() => registry.resolve('mystery')).toThrow(/Unknown harness "mystery"/);
  });
});
