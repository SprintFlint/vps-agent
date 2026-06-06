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
export type { Harness, HarnessResult, HarnessFactory, IssueContext } from './harness.js';
export { VERSION } from './version.js';
