/**
 * Shared types for the VPS Agent.
 *
 * These mirror the REAL SprintFlint server contract
 * (app/controllers/api/v1/runners_controller.rb). The old Ruby prototype on the
 * `master` branch describes a different, fictional API and must not be trusted.
 */

/** Supported log levels, ordered from least to most verbose. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Identifier of a configured harness implementation. */
export type HarnessName = 'noop' | (string & {});

/**
 * Permission mode handed to a harness. Interpretation is harness-specific;
 * later waves (e.g. ClaudeCodeHarness) map this onto their own permission flags.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | (string & {});

// --- Server response payloads -------------------------------------------------

/** Runner config block returned by the register endpoint. */
export interface RunnerConfig {
  heartbeat_interval: number;
  max_log_batch_size: number;
  supported_job_types: string[];
  api_version: string;
}

/** Response body from POST /api/v1/runners/register. */
export interface RegisterResponse {
  runner_id: number;
  auth_token: string;
  config: RunnerConfig;
}

/** Status reported by a runner in a heartbeat. */
export type RunnerStatus = 'online' | 'busy' | 'offline';

/** Arbitrary system stats reported alongside a heartbeat. */
export interface SystemStats {
  [key: string]: unknown;
}

/** Response body from POST /api/v1/runners/heartbeat. */
export interface HeartbeatResponse {
  acknowledged: boolean;
  next_check_interval: number;
  runner_id: number;
}

/** Job type understood by this runner. Currently only autoplay. */
export type JobType = 'autoplay';

/**
 * Payload of a job returned by GET /api/v1/runners/next_job.
 *
 * Mirrors the server's payload exactly today. The server will later add
 * fields (body, comments, default_branch, clone_url, tags); they are declared
 * as optional here so downstream code can start consuming them without a
 * breaking change. See {@link IssueContext}.
 */
export interface JobPayload {
  issue_id: number;
  issue_title: string;
  repository_url: string;
  branch_name: string;
  description: string | null;

  // --- Forward-compatible fields the server will add later (all optional) ---
  /** Full issue body (markdown), if richer than `description`. */
  body?: string;
  /** Acceptance criteria, free-form or as discrete items. */
  acceptance_criteria?: string | string[];
  /** Threaded comments for additional context. */
  comments?: Array<{ author?: string; body: string; created_at?: string }>;
  /** Default branch to base a PR against (fallback when absent). */
  default_branch?: string;
  /** Explicit clone URL when it differs from `repository_url`. */
  clone_url?: string;
  /** Labels/tags on the issue. */
  tags?: string[];
}

/** A job assignment from the server. */
export interface Job {
  job_id: number;
  job_type: JobType;
  payload: JobPayload;
}

/**
 * Response from GET /api/v1/runners/next_job.
 * Either a full job, or `{ job: null }` when nothing is available.
 */
export type NextJobResponse = Job | { job: null; message?: string };

/** Lifecycle status of a job, as understood by the server. */
export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** A single structured log line for the append_log endpoint. */
export interface LogLine {
  timestamp: string;
  level: LogLevel | string;
  message: string;
  metadata?: Record<string, unknown>;
}

/** Response from POST /api/v1/runners/update_job. */
export interface UpdateJobResponse {
  acknowledged: boolean;
  job_id: number;
}

/** Response from POST /api/v1/runners/append_log. */
export interface AppendLogResponse {
  acknowledged: boolean;
  job_id: number;
  lines_appended: number;
}
