/**
 * SF-124 (A3): Configuration module.
 *
 * Loads and persists ~/.vps-agent/config.json and layers overrides on top:
 *
 *   defaults  <  config.json  <  .env file  <  process env vars
 *
 * Supported keys: api_url, token, log_level, harness, permission_mode, config_dir,
 * runner_id, heartbeat_interval, max_log_batch_size, poll_interval.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { HarnessName, LogLevel, PermissionMode } from './types.js';

/** Fully-resolved runtime configuration. */
export interface AgentConfig {
  api_url: string;
  token: string | null;
  log_level: LogLevel;
  harness: HarnessName;
  permission_mode: PermissionMode;
  config_dir: string;
  /** Numeric id of this runner, returned by register. Null until registered. */
  runner_id: number | null;
  /** Seconds between heartbeats. Seeded from the register response. */
  heartbeat_interval: number;
  /** Seconds between next_job polls when idle. */
  poll_interval: number;
  /** Max log lines per append_log batch. Seeded from the register response. */
  max_log_batch_size: number;
}

/** Default heartbeat interval (seconds) when the server gives none. */
export const DEFAULT_HEARTBEAT_INTERVAL = 30;
/** Default idle poll interval (seconds). */
export const DEFAULT_POLL_INTERVAL = 5;
/** Default max log lines per append_log batch. */
export const DEFAULT_MAX_LOG_BATCH_SIZE = 100;

/** Subset of config that is safe/sensible to persist to disk. */
export type PersistedConfig = Partial<Omit<AgentConfig, 'config_dir'>>;

const PROD_API_URL = 'https://sprintflint.com';

const DEFAULT_CONFIG_DIR = join(homedir(), '.vps-agent');

const VALID_LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

/** Map of config key -> environment variable name. */
const ENV_KEYS = {
  api_url: 'VPS_AGENT_API_URL',
  token: 'VPS_AGENT_TOKEN',
  log_level: 'VPS_AGENT_LOG_LEVEL',
  harness: 'VPS_AGENT_HARNESS',
  permission_mode: 'VPS_AGENT_PERMISSION_MODE',
  config_dir: 'VPS_AGENT_CONFIG_DIR',
  runner_id: 'VPS_AGENT_RUNNER_ID',
  heartbeat_interval: 'VPS_AGENT_HEARTBEAT_INTERVAL',
  poll_interval: 'VPS_AGENT_POLL_INTERVAL',
  max_log_batch_size: 'VPS_AGENT_MAX_LOG_BATCH_SIZE',
} as const;

function defaults(): AgentConfig {
  return {
    api_url: PROD_API_URL,
    token: null,
    log_level: 'info',
    harness: 'noop',
    permission_mode: 'default',
    config_dir: DEFAULT_CONFIG_DIR,
    runner_id: null,
    heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL,
    poll_interval: DEFAULT_POLL_INTERVAL,
    max_log_batch_size: DEFAULT_MAX_LOG_BATCH_SIZE,
  };
}

const NUMERIC_KEYS = [
  'heartbeat_interval',
  'poll_interval',
  'max_log_batch_size',
  'runner_id',
] as const;

function coerceNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function coerceLogLevel(value: string | undefined): LogLevel | undefined {
  if (value && (VALID_LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel;
  }
  return undefined;
}

/**
 * Minimal .env parser (no external dependency).
 * Supports `KEY=value`, `#` comments, blank lines, and optional surrounding quotes.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function readEnvFile(cwd: string): Record<string, string> {
  const envPath = join(cwd, '.env');
  if (!existsSync(envPath)) return {};
  try {
    return parseEnvFile(readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}

function configPathFor(dir: string): string {
  return join(dir, 'config.json');
}

/** Read the persisted config.json for a directory, or `{}` if absent/invalid. */
export function readPersisted(configDir: string): PersistedConfig {
  const path = configPathFor(configDir);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return (typeof parsed === 'object' && parsed !== null ? parsed : {}) as PersistedConfig;
  } catch {
    return {};
  }
}

/** Overrides accepted by loadConfig, including config_dir. */
export type ConfigOverrides = Partial<AgentConfig>;

export interface LoadOptions {
  /** Working directory used to locate a `.env` file. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment map. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Explicit overrides (e.g. CLI flags) applied last, highest precedence. */
  overrides?: ConfigOverrides;
}

/**
 * Resolve the effective configuration by merging all layers.
 * Order (lowest -> highest): defaults, config.json, .env file, env vars, overrides.
 */
export function loadConfig(options: LoadOptions = {}): AgentConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  // config_dir is resolved first because it determines where config.json lives.
  const envFileVars = readEnvFile(cwd);
  const configDir = resolve(
    options.overrides?.config_dir ??
      env[ENV_KEYS.config_dir] ??
      envFileVars[ENV_KEYS.config_dir] ??
      DEFAULT_CONFIG_DIR,
  );

  const base = defaults();
  base.config_dir = configDir;

  const persisted = readPersisted(configDir);

  // Layer 1: persisted config.json
  Object.assign(base, persisted);

  // Layer 2 + 3: .env file then real env vars (env wins).
  const fromEnvLayers = (key: keyof typeof ENV_KEYS): string | undefined =>
    env[ENV_KEYS[key]] ?? envFileVars[ENV_KEYS[key]];

  const apiUrl = fromEnvLayers('api_url');
  if (apiUrl) base.api_url = apiUrl;

  const token = fromEnvLayers('token');
  if (token) base.token = token;

  const logLevel = coerceLogLevel(fromEnvLayers('log_level'));
  if (logLevel) base.log_level = logLevel;

  const harness = fromEnvLayers('harness');
  if (harness) base.harness = harness;

  const permissionMode = fromEnvLayers('permission_mode');
  if (permissionMode) base.permission_mode = permissionMode;

  for (const key of NUMERIC_KEYS) {
    const n = coerceNumber(fromEnvLayers(key));
    if (n !== undefined) base[key] = n;
  }

  // Layer 4: explicit overrides (CLI flags). config_dir already applied above.
  if (options.overrides) {
    const baseRecord = base as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(options.overrides)) {
      if (v !== undefined && k !== 'config_dir') {
        baseRecord[k] = v;
      }
    }
  }

  return base;
}

/**
 * Persist a partial config to ~/.vps-agent/config.json, merging with what is
 * already there. `config_dir` is never written (it is itself the location).
 *
 * Security (SF-154): the file holds the runner token (a secret), so it is
 * written owner-only (0600) inside an owner-only directory (0700). chmod is
 * applied unconditionally so an already-existing, looser-permissioned file is
 * tightened on every write. On platforms that ignore POSIX modes (e.g. Windows)
 * chmod is a best-effort no-op and never fails the write.
 */
export function saveConfig(patch: PersistedConfig, configDir: string = DEFAULT_CONFIG_DIR): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(configDir, 0o700);
  } catch {
    /* best-effort; non-POSIX filesystems ignore modes */
  }
  const current = readPersisted(configDir);
  const merged: PersistedConfig = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && k !== 'config_dir') {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  const file = configPathFor(configDir);
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

/** Absolute path to the config file for a given (or default) directory. */
export function configPath(configDir: string = DEFAULT_CONFIG_DIR): string {
  return configPathFor(configDir);
}

export { DEFAULT_CONFIG_DIR, PROD_API_URL };
