/**
 * SF-152: public surface (index.ts) coverage. Ensures the library barrel
 * re-exports the documented runtime values so `import { … } from 'vps-agent'`
 * stays stable for downstream consumers.
 */

import { describe, it, expect } from 'vitest';
import * as api from '../src/index.js';

describe('public index exports', () => {
  it('exports the core runtime classes/functions', () => {
    const expectedFns = [
      'loadConfig',
      'saveConfig',
      'configPath',
      'readPersisted',
      'parseEnvFile',
      'Logger',
      'tailLog',
      'ApiClient',
      'ApiError',
      'HarnessRegistry',
      'NoopHarness',
      'defaultHarnessRegistry',
      'issueContextFromPayload',
      'ClaudeCodeHarness',
      'buildPrompt',
      'mapPermissionMode',
      'runCommand',
      'defaultExec',
      'commitAndPush',
      'openPullRequest',
      'buildPrBody',
      'prepareWorkspace',
      'cleanupWorkspace',
      'jobsRoot',
      'resolveSource',
      'repoSlug',
      'isSourceMode',
      'JobExecutor',
      'preflight',
      'formatReport',
      'parseVersion',
      'collectSystemStats',
      'HeartbeatLoop',
      'LogStreamer',
      'Poller',
      'register',
      'Runtime',
      'defaultPidfile',
      'inspectRunning',
      'signalRunning',
      'redactSecrets',
      'redactValue',
    ];
    for (const name of expectedFns) {
      expect(typeof (api as Record<string, unknown>)[name], `missing export: ${name}`).toBe(
        'function',
      );
    }
  });

  it('exports constants', () => {
    expect(api.PROD_API_URL).toBe('https://sprintflint.com');
    expect(typeof api.DEFAULT_HEARTBEAT_INTERVAL).toBe('number');
    expect(typeof api.DEFAULT_POLL_INTERVAL).toBe('number');
    expect(typeof api.DEFAULT_MAX_LOG_BATCH_SIZE).toBe('number');
    expect(typeof api.VERSION).toBe('string');
    expect(api.REDACTED).toBe('***redacted***');
    expect(api.SOURCE_MODES).toEqual(['clone', 'local_path', 'worktree']);
  });
});
