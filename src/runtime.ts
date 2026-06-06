/**
 * SF-133 (the heart of `start`): in-process runtime that runs the heartbeat
 * loop and the poll loop concurrently until shutdown.
 *
 * Lifecycle:
 *   - requires a token in config (register first if absent),
 *   - starts HeartbeatLoop (status = busy while a job runs, else online),
 *   - starts Poller (single-job concurrency guard),
 *   - on SIGINT/SIGTERM: stops both loops, flushes logs (the in-flight job's
 *     LogStreamer flushes itself via Poller.finalize), and best-effort marks the
 *     runner offline before exiting.
 *
 * Reconnect/backoff lives inside the loops themselves (HeartbeatLoop / Poller),
 * so a flapping API never tears the runtime down.
 */

import { ApiClient } from './api-client.js';
import { Logger } from './logger.js';
import { HeartbeatLoop } from './heartbeat.js';
import { Poller } from './poller.js';
import { defaultHarnessRegistry, type HarnessRegistry } from './harness.js';
import type { AgentConfig } from './config.js';
import type { RunnerStatus } from './types.js';

export interface RuntimeOptions {
  config: AgentConfig;
  /** Injectable for tests; defaults built from config. */
  client?: ApiClient;
  logger?: Logger;
  registry?: HarnessRegistry;
  /** Install SIGINT/SIGTERM handlers. Defaults to true. */
  installSignalHandlers?: boolean;
}

export class Runtime {
  readonly config: AgentConfig;
  readonly client: ApiClient;
  readonly logger: Logger;
  private readonly registry: HarnessRegistry;
  private readonly heartbeat: HeartbeatLoop;
  private readonly poller: Poller;
  private readonly installSignals: boolean;

  private stopping = false;
  private stoppedPromise: Promise<void> | null = null;
  private resolveStopped: (() => void) | null = null;
  private readonly signalHandler = (): void => {
    void this.shutdown();
  };

  constructor(options: RuntimeOptions) {
    this.config = options.config;
    this.installSignals = options.installSignalHandlers ?? true;
    this.logger =
      options.logger ??
      new Logger({ dir: this.config.config_dir, level: this.config.log_level });
    this.client =
      options.client ??
      new ApiClient({
        baseUrl: this.config.api_url,
        token: this.config.token,
        onLog: (level, message, meta) => this.logger.log(level, message, meta),
      });
    this.registry = options.registry ?? defaultHarnessRegistry();

    this.poller = new Poller({
      client: this.client,
      logger: this.logger,
      registry: this.registry,
      config: this.config,
      onBusyChange: (busy) => {
        this.logger.debug('busy state changed', { busy });
      },
    });

    this.heartbeat = new HeartbeatLoop({
      client: this.client,
      logger: this.logger,
      status: (): RunnerStatus => (this.poller.isBusy ? 'busy' : 'online'),
      intervalSeconds: this.config.heartbeat_interval,
    });
  }

  /** Start both loops. Returns a promise that resolves once shutdown completes. */
  start(): Promise<void> {
    if (!this.config.token) {
      throw new Error('No runner token configured. Run `vps-agent register` first.');
    }
    this.stoppedPromise = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });

    this.logger.info('agent starting', {
      api_url: this.config.api_url,
      harness: this.config.harness,
      heartbeat_interval: this.config.heartbeat_interval,
      poll_interval: this.config.poll_interval,
      runner_id: this.config.runner_id,
    });

    this.heartbeat.start();
    this.poller.start();

    if (this.installSignals) {
      process.on('SIGINT', this.signalHandler);
      process.on('SIGTERM', this.signalHandler);
    }

    return this.stoppedPromise;
  }

  /** Graceful shutdown: stop loops, mark offline best-effort, resolve start(). */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info('agent shutting down');

    this.heartbeat.stop();
    this.poller.stop();

    if (this.installSignals) {
      process.removeListener('SIGINT', this.signalHandler);
      process.removeListener('SIGTERM', this.signalHandler);
    }

    // Best-effort offline beat so the dashboard updates promptly.
    try {
      await this.client.heartbeat({ status: 'offline' });
    } catch (err) {
      this.logger.warn('failed to mark runner offline', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.logger.info('agent stopped');
    this.resolveStopped?.();
  }
}
