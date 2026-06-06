/**
 * SF-129: Heartbeat loop.
 *
 * Posts runner status + system_stats on an interval. Status is derived from a
 * caller-supplied probe (online when idle, busy while a job runs). The interval
 * seeds from config.heartbeat_interval; the server may shorten it via the
 * heartbeat response's `next_check_interval`. Network/API errors are logged and
 * retried on the next tick with exponential backoff (so a flapping API never
 * kills the loop).
 */

import type { ApiClient } from './api-client.js';
import type { Logger } from './logger.js';
import type { RunnerStatus } from './types.js';
import { collectSystemStats } from './system-stats.js';

export interface HeartbeatOptions {
  client: ApiClient;
  logger: Logger;
  /** Returns the current runner status at each tick. */
  status: () => RunnerStatus;
  /** Base interval in seconds. Defaults to 30. */
  intervalSeconds: number;
  /** Filesystem path to sample for disk stats. Defaults to '/'. */
  diskPath?: string;
  /** Injectable timer (tests). Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Max backoff multiplier applied after consecutive failures. Default 8. */
  maxBackoffMultiplier?: number;
}

/**
 * Drives heartbeats. Call {@link HeartbeatLoop.start} to begin and
 * {@link HeartbeatLoop.stop} for graceful shutdown.
 */
export class HeartbeatLoop {
  private readonly opts: Required<Omit<HeartbeatOptions, 'diskPath'>> & { diskPath: string };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Interval the server last asked us to use, in seconds. */
  private serverIntervalSeconds: number | null = null;
  private consecutiveFailures = 0;

  constructor(options: HeartbeatOptions) {
    this.opts = {
      client: options.client,
      logger: options.logger,
      status: options.status,
      intervalSeconds: options.intervalSeconds,
      diskPath: options.diskPath ?? '/',
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h)),
      maxBackoffMultiplier: options.maxBackoffMultiplier ?? 8,
    };
  }

  /** Begin the loop. Sends an immediate first beat, then schedules the rest. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  /** Stop scheduling further beats. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      this.opts.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Effective delay until the next beat, accounting for server hint + backoff. */
  private nextDelayMs(): number {
    const base = this.serverIntervalSeconds ?? this.opts.intervalSeconds;
    const multiplier =
      this.consecutiveFailures > 0
        ? Math.min(2 ** this.consecutiveFailures, this.opts.maxBackoffMultiplier)
        : 1;
    return Math.max(1, base) * multiplier * 1000;
  }

  /** Send one heartbeat and reschedule. Exposed for deterministic testing. */
  async sendOnce(): Promise<void> {
    const status = this.opts.status();
    const system_stats = await collectSystemStats(this.opts.diskPath);
    const res = await this.opts.client.heartbeat({ status, system_stats });
    if (typeof res.next_check_interval === 'number' && res.next_check_interval > 0) {
      this.serverIntervalSeconds = res.next_check_interval;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.sendOnce();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      this.opts.logger.warn('heartbeat failed', {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: this.consecutiveFailures,
      });
    } finally {
      this.schedule();
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = this.opts.setTimer(() => {
      void this.tick();
    }, this.nextDelayMs());
  }
}
