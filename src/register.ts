/**
 * SF-128: Registration logic.
 *
 * Two modes:
 *   (a) org-id + name: POST /api/v1/runners/register, then persist the returned
 *       auth_token + runner_id + server config (heartbeat_interval,
 *       max_log_batch_size) and api_url to config.json.
 *   (b) token: a runner token created in the web UI. No API call — just persist
 *       the token (and optional api_url) so the agent can authenticate.
 *
 * After either mode, config holds a working token and (for mode a) the runner
 * appears in the dashboard.
 */

import { hostname } from 'node:os';
import { ApiClient } from './api-client.js';
import { saveConfig, type AgentConfig, type PersistedConfig } from './config.js';
import type { Logger } from './logger.js';

export interface RegisterInput {
  /** Mode (a): organization id. */
  orgId?: string | undefined;
  /** Mode (a): human-readable runner name. */
  name?: string | undefined;
  /** Mode (b): a pre-issued runner token from the web UI. */
  token?: string | undefined;
  /** Optional base URL override (both modes). */
  apiUrl?: string | undefined;
}

export interface RegisterResult {
  mode: 'register' | 'token';
  token: string;
  runnerId: number | null;
  apiUrl: string;
}

/**
 * Run registration and persist the result to config.json.
 *
 * @param input    parsed CLI flags
 * @param config   the already-loaded effective config (supplies api_url, dir)
 * @param deps     injectable client factory + logger for testing
 */
export async function register(
  input: RegisterInput,
  config: AgentConfig,
  deps: {
    logger?: Logger;
    makeClient?: (baseUrl: string) => ApiClient;
  } = {},
): Promise<RegisterResult> {
  const apiUrl = input.apiUrl ?? config.api_url;
  const logger = deps.logger;

  // Mode (b): token provided directly — skip the API call.
  if (input.token) {
    const patch: PersistedConfig = { token: input.token, api_url: apiUrl };
    saveConfig(patch, config.config_dir);
    logger?.info('registered with provided runner token', { api_url: apiUrl });
    return { mode: 'token', token: input.token, runnerId: null, apiUrl };
  }

  // Mode (a): org-id + name — call register.
  if (!input.orgId || !input.name) {
    throw new Error(
      'register requires either --token <token>, or both --org-id <id> and --name <name>.',
    );
  }

  const client = deps.makeClient
    ? deps.makeClient(apiUrl)
    : new ApiClient({
        baseUrl: apiUrl,
        ...(logger
          ? { onLog: (level, message, meta) => logger.log(level, message, meta) }
          : {}),
      });

  const res = await client.register({
    organization_id: input.orgId,
    name: input.name,
    hostname: hostname(),
  });

  const patch: PersistedConfig = {
    token: res.auth_token,
    runner_id: res.runner_id,
    api_url: apiUrl,
  };
  if (res.config?.heartbeat_interval) patch.heartbeat_interval = res.config.heartbeat_interval;
  if (res.config?.max_log_batch_size) patch.max_log_batch_size = res.config.max_log_batch_size;
  saveConfig(patch, config.config_dir);

  logger?.info('registered runner', { runner_id: res.runner_id, api_url: apiUrl });
  return { mode: 'register', token: res.auth_token, runnerId: res.runner_id, apiUrl };
}
