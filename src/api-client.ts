/**
 * SF-127 (B6): Typed API client for the REAL SprintFlint server contract.
 *
 * Authoritative source: app/controllers/api/v1/runners_controller.rb.
 *
 *   Base URL:  prod https://sprintflint.com  |  dev http://localhost:3000
 *   Auth:      X-Runner-Token: <token>       (NOT Bearer)
 *
 * Endpoints:
 *   POST /api/v1/runners/register     (no auth)
 *   POST /api/v1/runners/heartbeat
 *   GET  /api/v1/runners/next_job
 *   POST /api/v1/runners/update_job
 *   POST /api/v1/runners/append_log
 */

import type {
  AppendLogResponse,
  HeartbeatResponse,
  JobStatus,
  LogLine,
  NextJobResponse,
  RegisterResponse,
  RunnerStatus,
  SystemStats,
  UpdateJobResponse,
} from './types.js';

/** Thrown for any non-2xx response or transport failure that exhausts retries. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RetryOptions {
  /** Maximum attempts (including the first). Default 4. */
  maxAttempts?: number;
  /** Initial backoff in ms. Default 500. */
  baseDelayMs?: number;
  /** Maximum backoff in ms. Default 10000. */
  maxDelayMs?: number;
}

export interface ApiClientOptions {
  /** Base URL, e.g. https://sprintflint.com or http://localhost:3000. */
  baseUrl: string;
  /** Runner token sent as X-Runner-Token. Optional for register-only use. */
  token?: string | null;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  retry?: RetryOptions;
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Optional structured logger hook. */
  onLog?: (level: 'debug' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** Include the X-Runner-Token header. Default true. */
  auth?: boolean;
  /** Whether to retry idempotently. Default true. */
  retryable?: boolean;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ApiClient {
  private readonly baseUrl: string;
  private token: string | null;
  private readonly timeoutMs: number;
  private readonly retry: Required<RetryOptions>;
  private readonly fetchFn: typeof fetch;
  private readonly onLog: ApiClientOptions['onLog'];

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token ?? null;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retry = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.onLog = options.onLog;
    if (typeof this.fetchFn !== 'function') {
      throw new Error('No fetch implementation available; pass fetchFn or run on Node >= 18.');
    }
  }

  /** Update the auth token after registration. */
  setToken(token: string): void {
    this.token = token;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private async request<T>(opts: RequestOptions): Promise<T> {
    const useAuth = opts.auth ?? true;
    const retryable = opts.retryable ?? true;
    const maxAttempts = retryable ? this.retry.maxAttempts : 1;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (useAuth) {
      if (!this.token) {
        throw new ApiError(`Missing runner token for ${opts.method} ${opts.path}`);
      }
      headers['X-Runner-Token'] = this.token;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const init: RequestInit = {
          method: opts.method,
          headers,
          signal: controller.signal,
        };
        if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
        const res = await this.fetchFn(this.url(opts.path), init);
        clearTimeout(timer);

        const text = await res.text();
        const parsed: unknown = text ? safeJson(text) : null;

        if (res.ok) {
          return parsed as T;
        }

        if (retryable && RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
          const delay = this.backoff(attempt, res.headers.get('retry-after'));
          this.onLog?.('warn', `Retryable ${res.status} on ${opts.method} ${opts.path}`, {
            attempt,
            delay,
          });
          await sleep(delay);
          continue;
        }

        throw new ApiError(
          `${opts.method} ${opts.path} failed with ${res.status}`,
          res.status,
          parsed,
        );
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (err instanceof ApiError) throw err;
        if (attempt < maxAttempts) {
          const delay = this.backoff(attempt, null);
          this.onLog?.('warn', `Network error on ${opts.method} ${opts.path}, retrying`, {
            attempt,
            delay,
            error: err instanceof Error ? err.message : String(err),
          });
          await sleep(delay);
          continue;
        }
      }
    }

    throw new ApiError(
      `${opts.method} ${opts.path} failed after ${maxAttempts} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, this.retry.maxDelayMs);
    }
    const exp = this.retry.baseDelayMs * 2 ** (attempt - 1);
    const jitter = Math.random() * this.retry.baseDelayMs;
    return Math.min(exp + jitter, this.retry.maxDelayMs);
  }

  // --- Typed endpoint methods -------------------------------------------------

  /**
   * POST /api/v1/runners/register (no auth).
   * Registers this runner and returns the auth token + server config.
   */
  register(input: {
    organization_id: string;
    name: string;
    hostname?: string;
    metadata?: Record<string, unknown>;
  }): Promise<RegisterResponse> {
    return this.request<RegisterResponse>({
      method: 'POST',
      path: '/api/v1/runners/register',
      body: input,
      auth: false,
    });
  }

  /** POST /api/v1/runners/heartbeat. */
  heartbeat(input: { status: RunnerStatus; system_stats?: SystemStats }): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>({
      method: 'POST',
      path: '/api/v1/runners/heartbeat',
      body: { status: input.status, system_stats: input.system_stats ?? {} },
    });
  }

  /** GET /api/v1/runners/next_job. Returns a job or `{ job: null }`. */
  nextJob(): Promise<NextJobResponse> {
    return this.request<NextJobResponse>({
      method: 'GET',
      path: '/api/v1/runners/next_job',
    });
  }

  /** POST /api/v1/runners/update_job. The server also accepts `token` in body. */
  updateJob(input: {
    job_id: number;
    status?: JobStatus;
    completion_percentage?: number;
    result?: Record<string, unknown>;
    error_message?: string;
  }): Promise<UpdateJobResponse> {
    return this.request<UpdateJobResponse>({
      method: 'POST',
      path: '/api/v1/runners/update_job',
      body: { token: this.token, ...input },
      // Status transitions are not safely idempotent under blind retry.
      retryable: false,
    });
  }

  /**
   * POST /api/v1/runners/append_log.
   * Caller must keep `log_lines` within the server's max_log_batch_size (default 100).
   */
  appendLog(input: { job_id: number; log_lines: LogLine[] }): Promise<AppendLogResponse> {
    return this.request<AppendLogResponse>({
      method: 'POST',
      path: '/api/v1/runners/append_log',
      body: { token: this.token, job_id: input.job_id, log_lines: input.log_lines },
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
