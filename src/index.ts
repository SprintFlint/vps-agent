/**
 * Public library surface for the VPS Agent.
 *
 * Downstream waves (register command, heartbeat loop, poll loop, job execution,
 * ClaudeCodeHarness) import from here.
 */

export * from './types.js';
export {
  loadConfig,
  saveConfig,
  configPath,
  readPersisted,
  parseEnvFile,
  DEFAULT_CONFIG_DIR,
  PROD_API_URL,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_MAX_LOG_BATCH_SIZE,
} from './config.js';
export type { AgentConfig, PersistedConfig, LoadOptions, ConfigOverrides } from './config.js';
export { Logger, tailLog } from './logger.js';
export type { LoggerOptions, LogRecord, TailOptions } from './logger.js';
export { ApiClient, ApiError } from './api-client.js';
export type { ApiClientOptions, RetryOptions } from './api-client.js';
export {
  HarnessRegistry,
  NoopHarness,
  defaultHarnessRegistry,
  issueContextFromPayload,
} from './harness.js';
export type {
  Harness,
  HarnessResult,
  HarnessFactory,
  IssueContext,
  HarnessLogSink,
  HarnessRunOptions,
} from './harness.js';
export { ClaudeCodeHarness, buildPrompt, mapPermissionMode } from './claude-harness.js';
export type { ClaudeCodeHarnessOptions, SpawnFn, SpawnedProcess } from './claude-harness.js';
export { runCommand, defaultExec } from './exec.js';
export type { ExecFn, ExecResult, DefaultExecOptions } from './exec.js';
export {
  hasChanges,
  commitAll,
  pushBranch,
  commitAndPush,
  buildCommitMessage,
  tokenizeRemote,
  redactRemote,
} from './git-ops.js';
export type { GitOpsOptions } from './git-ops.js';
export { openPullRequest, buildPrBody } from './pr.js';
export type { OpenPrOptions } from './pr.js';
export { prepareWorkspace, cleanupWorkspace, jobsRoot } from './workspace.js';
export type { Workspace, PrepareWorkspaceOptions } from './workspace.js';
export { JobExecutor } from './job-executor.js';
export type { JobExecutorOptions, ExecutionResult } from './job-executor.js';
export { preflight, formatReport, parseVersion } from './preflight.js';
export type { PreflightInput, PreflightReport, CheckResult } from './preflight.js';
export { collectSystemStats } from './system-stats.js';
export { HeartbeatLoop } from './heartbeat.js';
export type { HeartbeatOptions } from './heartbeat.js';
export { LogStreamer } from './log-streamer.js';
export type { LogStreamerOptions } from './log-streamer.js';
export { Poller } from './poller.js';
export type { PollerOptions } from './poller.js';
export { register } from './register.js';
export type { RegisterInput, RegisterResult } from './register.js';
export { Runtime } from './runtime.js';
export type { RuntimeOptions } from './runtime.js';
export {
  defaultPidfile,
  writePidfile,
  readPidfile,
  removePidfile,
  isProcessAlive,
  inspectRunning,
  signalRunning,
} from './daemon.js';
export type { RunningInfo } from './daemon.js';
export { VERSION } from './version.js';
export { redactSecrets, redactValue, REDACTED } from './redact.js';
