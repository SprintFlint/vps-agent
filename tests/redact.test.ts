/**
 * SF-154: secret redaction unit tests.
 */

import { describe, it, expect } from 'vitest';
import { redactSecrets, redactValue, REDACTED } from '../src/redact.js';

describe('redactSecrets', () => {
  it('redacts credentials embedded in an https remote URL', () => {
    const out = redactSecrets(
      'Pushing to https://x-access-token:ghp_abcDEF1234567890XYZ@github.com/acme/repo.git',
    );
    expect(out).not.toContain('ghp_abcDEF1234567890XYZ');
    expect(out).toContain('https://***redacted***@github.com/acme/repo.git');
  });

  it('redacts credentials in a git:// remote URL', () => {
    const out = redactSecrets('git://user:supersecretpass@host/repo');
    expect(out).not.toContain('supersecretpass');
    expect(out).toContain(REDACTED);
  });

  it('redacts GitHub token shapes (ghp_, gho_, github_pat_)', () => {
    expect(redactSecrets('token ghp_0123456789abcdefABCD here')).not.toContain(
      'ghp_0123456789abcdefABCD',
    );
    expect(redactSecrets('gho_0123456789abcdefABCD')).toBe(REDACTED);
    expect(redactSecrets('github_pat_11ABCDEFG0123456789_abcdef')).toBe(REDACTED);
  });

  it('redacts Anthropic key shapes (sk-ant-)', () => {
    const out = redactSecrets('using sk-ant-api03-AbCdEf0123456789_xyz to call claude');
    expect(out).not.toContain('AbCdEf0123456789');
    expect(out).toContain(REDACTED);
  });

  it('redacts token=… and bearer fragments', () => {
    expect(redactSecrets('?token=abc123def456&x=1')).toContain('token=***redacted***');
    expect(redactSecrets('?token=abc123def456&x=1')).toContain('x=1');
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toContain('Bearer ***redacted***');
    expect(redactSecrets('X-Runner-Token: rt_secretvalue')).toContain(
      'x-runner-token: ***redacted***',
    );
  });

  it('leaves ordinary text untouched', () => {
    const text = 'Cloning repo and running tests; 12 passed, exit 0.';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactValue', () => {
  it('masks values whose key looks secret regardless of shape', () => {
    const out = redactValue({
      git_token: 'whatever',
      api_key: 123,
      nested: { password: 'x' },
    }) as Record<string, unknown>;
    expect(out.git_token).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).password).toBe(REDACTED);
  });

  it('scrubs secret shapes inside ordinary string values', () => {
    const out = redactValue({ msg: 'pushed via ghp_0123456789abcdefABCD' }) as Record<
      string,
      unknown
    >;
    expect(out.msg).not.toContain('ghp_0123456789abcdefABCD');
  });

  it('walks arrays and guards against cycles', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redactValue({ list: ['ghp_0123456789abcdefABCD', 2], cyclic }) as Record<
      string,
      unknown
    >;
    const list = out.list as unknown[];
    expect(list[0]).toBe(REDACTED);
    expect(list[1]).toBe(2);
    // No throw on cycle.
    expect(out.cyclic).toBeDefined();
  });

  it('passes through non-string primitives', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBe(null);
    expect(redactValue(true)).toBe(true);
  });
});
