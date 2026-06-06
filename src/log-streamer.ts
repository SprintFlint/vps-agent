/**
 * SF-131: Job log streamer.
 *
 * Buffers structured log lines emitted by a harness during a job and flushes
 * them to POST /api/v1/runners/append_log:
 *   - when the buffer reaches `maxBatchSize` (default 100, the server cap), or
 *   - on a periodic interval, whichever comes first.
 *
 * A flush in progress never overlaps another; lines that arrive mid-flush queue
 * for the next batch. {@link LogStreamer.flushAll} drains everything before a
 * job is finalized. Flush failures are logged and the lines re-queued so a
 * transient API blip does not lose output.
 */

import type { ApiClient } from './api-client.js';
import type { Logger } from './logger.js';
import type { LogLine, LogLevel } from './types.js';
import { redactSecrets, redactValue } from './redact.js';

export interface LogStreamerOptions {
  client: ApiClient;
  logger: Logger;
  jobId: number;
  /** Max lines per append_log call. Defaults to 100 (server cap). */
  maxBatchSize?: number;
  /** Auto-flush interval in ms. Defaults to 2000. */
  flushIntervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export class LogStreamer {
  private readonly client: ApiClient;
  private readonly logger: Logger;
  private readonly jobId: number;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly setTimer: NonNullable<LogStreamerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<LogStreamerOptions['clearTimer']>;

  private buffer: LogLine[] = [];
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: LogStreamerOptions) {
    this.client = options.client;
    this.logger = options.logger;
    this.jobId = options.jobId;
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 100);
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** Begin the periodic flush timer. */
  start(): void {
    this.stopped = false;
    this.scheduleFlush();
  }

  /** Queue a log line. Triggers an immediate flush once the batch fills. */
  append(
    message: string,
    level: LogLevel | string = 'info',
    metadata?: Record<string, unknown>,
  ): void {
    if (this.stopped) return;
    // SF-154: these lines are POSTed to the server's append_log and shown in the
    // dashboard; scrub any secret that slipped into harness/git/gh output.
    const line: LogLine = {
      timestamp: new Date().toISOString(),
      level,
      message: redactSecrets(message),
      ...(metadata ? { metadata: redactValue(metadata) as Record<string, unknown> } : {}),
    };
    this.buffer.push(line);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  /** Number of lines currently buffered (not yet acknowledged). */
  get pending(): number {
    return this.buffer.length;
  }

  /** Flush a single batch (up to maxBatchSize). Re-queues on failure. */
  async flush(): Promise<void> {
    // Coalesce concurrent callers onto the in-flight flush so none no-op away
    // a batch (e.g. an auto-flush from append() racing flushAll()).
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    if (this.buffer.length === 0) return;
    this.inFlight = this.doFlush();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async doFlush(): Promise<void> {
    const batch = this.buffer.splice(0, this.maxBatchSize);
    try {
      await this.client.appendLog({ job_id: this.jobId, log_lines: batch });
    } catch (err) {
      // Re-queue at the front so ordering is preserved for the retry.
      this.buffer.unshift(...batch);
      this.logger.warn('append_log flush failed; will retry', {
        jobId: this.jobId,
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Drain the entire buffer, one batch at a time, until empty or stuck. */
  async flushAll(): Promise<void> {
    // First, settle any flush already in progress (e.g. an auto-flush from
    // append()) so we observe the true buffer state.
    if (this.inFlight) await this.inFlight;

    // Then drain, one batch per iteration. Stop if a batch fails to make
    // progress (the failed batch was re-queued).
    let guard = 0;
    while (this.buffer.length > 0 && guard < 10_000) {
      const before = this.buffer.length;
      await this.flush();
      if (this.buffer.length >= before) break; // no progress (flush failed)
      guard += 1;
    }
  }

  /** Stop the timer and flush whatever remains. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    await this.flushAll();
  }

  private scheduleFlush(): void {
    if (this.stopped) return;
    this.timer = this.setTimer(() => {
      void this.flush().finally(() => this.scheduleFlush());
    }, this.flushIntervalMs);
  }
}
