/**
 * SF-130 (poll loop) + SF-132 (finalize).
 *
 * Polls GET /api/v1/runners/next_job on an interval. When a job arrives:
 *   1. flips status to busy (single-job concurrency guard: no further polling
 *      or claiming while a job runs),
 *   2. marks the job `running` server-side,
 *   3. builds an IssueContext and resolves the configured harness,
 *   4. streams harness output via LogStreamer,
 *   5. finalizes with update_job (completed/failed + result/error_message),
 *      flushing remaining logs first.
 *
 * Network/API errors while polling never kill the loop: they are logged and the
 * loop backs off exponentially, then resumes.
 */

import type { ApiClient } from './api-client.js';
import type { Logger } from './logger.js';
import type { HarnessRegistry, IssueContext } from './harness.js';
import { issueContextFromPayload } from './harness.js';
import { LogStreamer } from './log-streamer.js';
import type { AgentConfig } from './config.js';
import type { Job, JobStatus, NextJobResponse } from './types.js';

/** Default workspace root for harness runs. */
function defaultWorkdir(configDir: string, jobId: number): string {
  return `${configDir}/jobs/${jobId}`;
}

function isJob(res: NextJobResponse): res is Job {
  return (res as Job).job_id !== undefined && (res as { job: null }).job !== null;
}

export interface PollerOptions {
  client: ApiClient;
  logger: Logger;
  registry: HarnessRegistry;
  config: AgentConfig;
  /** Called whenever busy-state changes, so the heartbeat can report it. */
  onBusyChange?: (busy: boolean) => void;
  /** Idle poll interval in seconds. Defaults to config.poll_interval. */
  pollIntervalSeconds?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Resolve a workdir for a job. Defaults to <config_dir>/jobs/<id>. */
  resolveWorkdir?: (job: Job) => string;
  maxBackoffMultiplier?: number;
}

export class Poller {
  private readonly opts: Required<
    Omit<PollerOptions, 'onBusyChange' | 'pollIntervalSeconds' | 'resolveWorkdir'>
  > & {
    onBusyChange: (busy: boolean) => void;
    pollIntervalSeconds: number;
    resolveWorkdir: (job: Job) => string;
  };

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private busy = false;
  private consecutiveFailures = 0;

  constructor(options: PollerOptions) {
    this.opts = {
      client: options.client,
      logger: options.logger,
      registry: options.registry,
      config: options.config,
      onBusyChange: options.onBusyChange ?? (() => {}),
      pollIntervalSeconds: options.pollIntervalSeconds ?? options.config.poll_interval,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h)),
      resolveWorkdir:
        options.resolveWorkdir ?? ((job) => defaultWorkdir(options.config.config_dir, job.job_id)),
      maxBackoffMultiplier: options.maxBackoffMultiplier ?? 8,
    };
  }

  get isBusy(): boolean {
    return this.busy;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      this.opts.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.opts.onBusyChange(busy);
  }

  private nextDelayMs(): number {
    const base = Math.max(1, this.opts.pollIntervalSeconds);
    const multiplier =
      this.consecutiveFailures > 0
        ? Math.min(2 ** this.consecutiveFailures, this.opts.maxBackoffMultiplier)
        : 1;
    return base * multiplier * 1000;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    // Concurrency guard: never claim a new job while one is running.
    if (this.busy) {
      this.schedule();
      return;
    }
    try {
      const res = await this.opts.client.nextJob();
      this.consecutiveFailures = 0;
      if (isJob(res)) {
        await this.runJob(res);
      }
    } catch (err) {
      this.consecutiveFailures += 1;
      this.opts.logger.warn('next_job poll failed', {
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

  /**
   * Execute a single job end-to-end and finalize it. Public so a daemon can
   * await an in-flight job during graceful shutdown, and for testing.
   */
  async runJob(job: Job): Promise<void> {
    this.setBusy(true);
    const log = this.opts.logger.child({ jobId: job.job_id, issueId: job.payload.issue_id });
    const streamer = new LogStreamer({
      client: this.opts.client,
      logger: this.opts.logger,
      jobId: job.job_id,
      maxBatchSize: this.opts.config.max_log_batch_size,
    });
    streamer.start();

    let status: JobStatus = 'completed';
    let result: Record<string, unknown> | undefined;
    let errorMessage: string | undefined;

    try {
      log.info('job started', { title: job.payload.issue_title });
      streamer.append(`Picked up issue #${job.payload.issue_id}: ${job.payload.issue_title}`);

      await this.markRunning(job.job_id);

      const issue: IssueContext = issueContextFromPayload(
        job.payload,
        this.opts.config.permission_mode,
      );
      const workdir = this.opts.resolveWorkdir(job);

      const harness = this.opts.registry.resolve(this.opts.config.harness);
      streamer.append(`Running harness "${this.opts.config.harness}" in ${workdir}`);

      const outcome = await harness.run(workdir, issue);
      streamer.append(outcome.summary, outcome.success ? 'info' : 'error');

      if (this.opts.config.harness === 'noop') {
        // NoopHarness proves the loop; flag it clearly so nobody thinks work ran.
        streamer.append('No harness configured; job acknowledged without code changes.', 'warn');
      }

      status = outcome.success ? 'completed' : 'failed';
      result = { summary: outcome.summary, changed: outcome.changed, harness: this.opts.config.harness };
      if (!outcome.success) errorMessage = outcome.summary;
      log.info('job finished', { status, changed: outcome.changed });
    } catch (err) {
      status = 'failed';
      errorMessage = err instanceof Error ? err.message : String(err);
      streamer.append(`Job failed: ${errorMessage}`, 'error');
      log.error('job errored', { error: errorMessage });
    } finally {
      await this.finalize(job.job_id, streamer, status, result, errorMessage);
      this.setBusy(false);
    }
  }

  private async markRunning(jobId: number): Promise<void> {
    try {
      await this.opts.client.updateJob({ job_id: jobId, status: 'running', completion_percentage: 0 });
    } catch (err) {
      // Non-fatal: the heartbeat already shows us busy. Log and continue.
      this.opts.logger.warn('failed to mark job running', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** SF-132: flush logs, then post the terminal update_job. */
  private async finalize(
    jobId: number,
    streamer: LogStreamer,
    status: JobStatus,
    result: Record<string, unknown> | undefined,
    errorMessage: string | undefined,
  ): Promise<void> {
    await streamer.stop(); // flush remaining logs first
    try {
      await this.opts.client.updateJob({
        job_id: jobId,
        status,
        completion_percentage: 100,
        ...(result ? { result } : {}),
        ...(errorMessage ? { error_message: errorMessage } : {}),
      });
    } catch (err) {
      this.opts.logger.error('failed to finalize job', {
        jobId,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
