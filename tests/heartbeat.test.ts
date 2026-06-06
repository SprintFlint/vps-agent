import { describe, it, expect, vi } from 'vitest';
import { HeartbeatLoop } from '../src/heartbeat.js';
import type { ApiClient } from '../src/api-client.js';
import type { Logger } from '../src/logger.js';

function fakeLogger(): Logger {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() } as unknown as Logger;
}

/** A controllable timer queue so we can advance ticks deterministically. */
function timerHarness() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  const setTimer = (fn: () => void, ms: number) => {
    queue.push({ fn, ms });
    return queue.length as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = vi.fn();
  const fireNext = (): number | undefined => {
    const next = queue.shift();
    next?.fn();
    return next?.ms;
  };
  return { setTimer, clearTimer, fireNext, queue };
}

describe('HeartbeatLoop', () => {
  it('sends an immediate beat with status + system_stats, then schedules the next', async () => {
    const heartbeat = vi.fn().mockResolvedValue({ acknowledged: true, next_check_interval: 30, runner_id: 1 });
    const client = { heartbeat } as unknown as ApiClient;
    const timers = timerHarness();

    const loop = new HeartbeatLoop({
      client,
      logger: fakeLogger(),
      status: () => 'online',
      intervalSeconds: 30,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    loop.start();
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1));

    const call = heartbeat.mock.calls[0]![0] as { status: string; system_stats: Record<string, unknown> };
    expect(call.status).toBe('online');
    expect(call.system_stats.cpu_count).toBeGreaterThan(0);
    expect(call.system_stats.mem_total_bytes).toBeGreaterThan(0);
    // A follow-up tick should be scheduled.
    expect(timers.queue.length).toBe(1);
    loop.stop();
  });

  it('reports busy status from the probe', async () => {
    const heartbeat = vi.fn().mockResolvedValue({ acknowledged: true, next_check_interval: 30, runner_id: 1 });
    const client = { heartbeat } as unknown as ApiClient;
    const timers = timerHarness();
    let busy = true;
    const loop = new HeartbeatLoop({
      client,
      logger: fakeLogger(),
      status: () => (busy ? 'busy' : 'online'),
      intervalSeconds: 30,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    loop.start();
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1));
    expect((heartbeat.mock.calls[0]![0] as { status: string }).status).toBe('busy');
    busy = false;
    loop.stop();
  });

  it('honors the server next_check_interval for scheduling', async () => {
    const heartbeat = vi.fn().mockResolvedValue({ acknowledged: true, next_check_interval: 7, runner_id: 1 });
    const client = { heartbeat } as unknown as ApiClient;
    const timers = timerHarness();
    const loop = new HeartbeatLoop({
      client,
      logger: fakeLogger(),
      status: () => 'online',
      intervalSeconds: 30,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    loop.start();
    await vi.waitFor(() => expect(timers.queue.length).toBe(1));
    // Next scheduled delay should use the 7s server hint, not 30s default.
    expect(timers.queue[0]!.ms).toBe(7000);
    loop.stop();
  });

  it('backs off and keeps looping when a beat fails', async () => {
    const logger = fakeLogger();
    const heartbeat = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { heartbeat } as unknown as ApiClient;
    const timers = timerHarness();
    const loop = new HeartbeatLoop({
      client,
      logger,
      status: () => 'online',
      intervalSeconds: 10,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    loop.start();
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1));
    expect(logger.warn).toHaveBeenCalled();
    // After 1 failure: backoff multiplier 2 -> 10s * 2 = 20s.
    await vi.waitFor(() => expect(timers.queue.length).toBe(1));
    expect(timers.queue[0]!.ms).toBe(20000);
    loop.stop();
  });

  it('stop() clears the pending timer and prevents reschedule', async () => {
    const heartbeat = vi.fn().mockResolvedValue({ acknowledged: true, next_check_interval: 30, runner_id: 1 });
    const client = { heartbeat } as unknown as ApiClient;
    const timers = timerHarness();
    const loop = new HeartbeatLoop({
      client,
      logger: fakeLogger(),
      status: () => 'online',
      intervalSeconds: 30,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    loop.start();
    await vi.waitFor(() => expect(timers.queue.length).toBe(1));
    loop.stop();
    expect(timers.clearTimer).toHaveBeenCalled();
  });
});
