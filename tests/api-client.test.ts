import { describe, it, expect, vi } from 'vitest';
import { ApiClient, ApiError } from '../src/api-client.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('ApiClient', () => {
  it('strips trailing slash from baseUrl and hits register without auth', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ runner_id: 1, auth_token: 't', config: {} }, 201),
    );
    const client = new ApiClient({ baseUrl: 'http://localhost:3000/', fetchFn });
    const res = await client.register({ organization_id: 'org', name: 'box' });
    expect(res.auth_token).toBe('t');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/api/v1/runners/register');
    expect((init as RequestInit).method).toBe('POST');
    expect((init!.headers as Record<string, string>)['X-Runner-Token']).toBeUndefined();
  });

  it('sends X-Runner-Token on authenticated calls', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ acknowledged: true, next_check_interval: 30, runner_id: 1 }));
    const client = new ApiClient({ baseUrl: 'https://sprintflint.com', token: 'secret', fetchFn });
    await client.heartbeat({ status: 'online' });
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Runner-Token']).toBe('secret');
  });

  it('throws when an authenticated call has no token', async () => {
    const client = new ApiClient({ baseUrl: 'https://sprintflint.com', fetchFn: vi.fn() });
    await expect(client.nextJob()).rejects.toBeInstanceOf(ApiError);
  });

  it('retries retryable 503 then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, 503))
      .mockResolvedValueOnce(jsonResponse({ job: null }));
    const client = new ApiClient({
      baseUrl: 'https://sprintflint.com',
      token: 't',
      fetchFn,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    });
    const res = await client.nextJob();
    expect(res).toEqual({ job: null });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable 4xx', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 403));
    const client = new ApiClient({
      baseUrl: 'https://sprintflint.com',
      token: 't',
      fetchFn,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    });
    await expect(client.nextJob()).rejects.toMatchObject({ status: 403 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not retry update_job (non-idempotent)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const client = new ApiClient({
      baseUrl: 'https://sprintflint.com',
      token: 't',
      fetchFn,
      retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 5 },
    });
    await expect(
      client.updateJob({ job_id: 1, status: 'completed' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('includes token in update_job/append_log body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ acknowledged: true, job_id: 1 }));
    const client = new ApiClient({ baseUrl: 'https://sprintflint.com', token: 'tok', fetchFn });
    await client.updateJob({ job_id: 1, status: 'running', completion_percentage: 50 });
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.token).toBe('tok');
    expect(body.job_id).toBe(1);
    expect(body.completion_percentage).toBe(50);
  });
});
