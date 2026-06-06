import { describe, it, expect, vi } from 'vitest';
import { LogStreamer } from '../src/log-streamer.js';
import type { ApiClient } from '../src/api-client.js';
import type { Logger } from '../src/logger.js';

function fakeLogger(): Logger {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() } as unknown as Logger;
}

// Timer that never auto-fires, so we drive flushing explicitly.
const noTimer = {
  setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
  clearTimer: () => {},
};

describe('LogStreamer', () => {
  it('flushes automatically once the batch size is reached', async () => {
    const appendLog = vi.fn().mockResolvedValue({ acknowledged: true, job_id: 1, lines_appended: 3 });
    const client = { appendLog } as unknown as ApiClient;
    const s = new LogStreamer({ client, logger: fakeLogger(), jobId: 1, maxBatchSize: 3, ...noTimer });
    s.append('a');
    s.append('b');
    expect(appendLog).not.toHaveBeenCalled();
    s.append('c'); // reaches batch size -> triggers flush
    await vi.waitFor(() => expect(appendLog).toHaveBeenCalledTimes(1));
    const body = appendLog.mock.calls[0]![0] as { job_id: number; log_lines: unknown[] };
    expect(body.job_id).toBe(1);
    expect(body.log_lines).toHaveLength(3);
  });

  it('does not exceed maxBatchSize per call', async () => {
    const appendLog = vi.fn().mockResolvedValue({ acknowledged: true, job_id: 1, lines_appended: 2 });
    const client = { appendLog } as unknown as ApiClient;
    const s = new LogStreamer({ client, logger: fakeLogger(), jobId: 1, maxBatchSize: 2, ...noTimer });
    for (let i = 0; i < 5; i++) s.append(`line ${i}`);
    // flush drains in batches of 2
    await s.flushAll();
    for (const call of appendLog.mock.calls) {
      expect((call[0] as { log_lines: unknown[] }).log_lines.length).toBeLessThanOrEqual(2);
    }
    expect(s.pending).toBe(0);
  });

  it('re-queues lines when a flush fails and preserves order', async () => {
    const logger = fakeLogger();
    const appendLog = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ acknowledged: true, job_id: 1, lines_appended: 2 });
    const client = { appendLog } as unknown as ApiClient;
    const s = new LogStreamer({ client, logger, jobId: 1, maxBatchSize: 10, ...noTimer });
    s.append('first');
    s.append('second');
    await s.flush(); // fails, re-queues
    expect(logger.warn).toHaveBeenCalled();
    expect(s.pending).toBe(2);
    await s.flush(); // succeeds
    expect(s.pending).toBe(0);
    const sent = (appendLog.mock.calls[1]![0] as { log_lines: Array<{ message: string }> }).log_lines;
    expect(sent.map((l) => l.message)).toEqual(['first', 'second']);
  });

  it('stop() drains all remaining lines', async () => {
    const appendLog = vi.fn().mockResolvedValue({ acknowledged: true, job_id: 1, lines_appended: 1 });
    const client = { appendLog } as unknown as ApiClient;
    const s = new LogStreamer({ client, logger: fakeLogger(), jobId: 1, maxBatchSize: 100, ...noTimer });
    s.append('only');
    await s.stop();
    expect(appendLog).toHaveBeenCalledTimes(1);
    expect(s.pending).toBe(0);
    // After stop, further appends are ignored.
    s.append('ignored');
    expect(s.pending).toBe(0);
  });
});
