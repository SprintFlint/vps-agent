/**
 * SF-153 (F32): automated full-loop integration test.
 *
 * Drives the REAL agent end to end against an in-process Node http server that
 * speaks the SprintFlint runner contract. No real dev server, no network beyond
 * loopback. Exercises:
 *
 *   register -> heartbeat -> next_job (claim) -> Noop harness exec ->
 *   update_job(running) -> append_log (streaming) -> update_job(completed).
 *
 * The agent is wired exactly as production wires it: register.ts persists a
 * token to a temp config dir, then Runtime builds its own ApiClient (global
 * fetch) pointed at the test server's loopback URL.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { register } from '../src/register.js';
import { Runtime } from '../src/runtime.js';
import type { Job, LogLine } from '../src/types.js';

interface Recorded {
  registerCalls: number;
  heartbeats: Array<{ status: string }>;
  nextJobCalls: number;
  jobUpdates: Array<{
    status?: string;
    completion_percentage?: number;
    result?: unknown;
    error_message?: string;
  }>;
  logLines: LogLine[];
  authTokensSeen: Set<string>;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/**
 * Mock SprintFlint server. Serves exactly one job, then `{ job: null }`.
 */
function makeServer(rec: Recorded): Server {
  const job: Job = {
    job_id: 4242,
    job_type: 'autoplay',
    payload: {
      issue_id: 99,
      issue_title: 'Add a greeting helper',
      repository_url: 'https://github.com/acme/widgets.git',
      branch_name: 'sf-99-greeting',
      description: 'Implement greeting()',
    },
  };
  let jobServed = false;

  return createServer((req, res) => {
    const url = req.url ?? '';
    const token = req.headers['x-runner-token'];
    if (typeof token === 'string') rec.authTokensSeen.add(token);

    void (async () => {
      if (url.endsWith('/register')) {
        rec.registerCalls += 1;
        await readBody(req);
        json(res, 200, {
          runner_id: 7,
          auth_token: 'rt_integration_secret',
          config: {
            heartbeat_interval: 30,
            max_log_batch_size: 100,
            supported_job_types: ['autoplay'],
            api_version: 'v1',
          },
        });
        return;
      }
      if (url.endsWith('/heartbeat')) {
        const body = (await readBody(req)) as { status: string };
        rec.heartbeats.push({ status: body.status });
        json(res, 200, { acknowledged: true, next_check_interval: 30, runner_id: 7 });
        return;
      }
      if (url.endsWith('/next_job')) {
        rec.nextJobCalls += 1;
        if (!jobServed) {
          jobServed = true;
          json(res, 200, job);
        } else {
          json(res, 200, { job: null });
        }
        return;
      }
      if (url.endsWith('/update_job')) {
        const body = (await readBody(req)) as Recorded['jobUpdates'][number];
        rec.jobUpdates.push(body);
        json(res, 200, { acknowledged: true, job_id: job.job_id });
        return;
      }
      if (url.endsWith('/append_log')) {
        const body = (await readBody(req)) as { log_lines: LogLine[] };
        rec.logLines.push(...body.log_lines);
        json(res, 200, {
          acknowledged: true,
          job_id: job.job_id,
          lines_appended: body.log_lines.length,
        });
        return;
      }
      json(res, 404, { error: 'not found' });
    })();
  });
}

let server: Server;
let baseUrl: string;
let dir: string;
let rec: Recorded;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vps-agent-int-'));
  rec = {
    registerCalls: 0,
    heartbeats: [],
    nextJobCalls: 0,
    jobUpdates: [],
    logLines: [],
    authTokensSeen: new Set(),
  };
  server = makeServer(rec);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('full loop integration (SF-153)', () => {
  it('registers, heartbeats, claims a noop job, streams logs, and finalizes completed', async () => {
    // 1. Register (mode a): persists token + runner_id to the temp config dir.
    const cfg0 = loadConfig({
      cwd: dir,
      env: { VPS_AGENT_CONFIG_DIR: dir },
      overrides: { config_dir: dir, api_url: baseUrl },
    });
    const reg = await register({ orgId: 'org_1', name: 'ci-runner', apiUrl: baseUrl }, cfg0);
    expect(reg.mode).toBe('register');
    expect(reg.token).toBe('rt_integration_secret');
    expect(rec.registerCalls).toBe(1);

    // 2. Load the now-registered config and start the runtime against the mock.
    const cfg = loadConfig({
      cwd: dir,
      env: { VPS_AGENT_CONFIG_DIR: dir },
      overrides: {
        config_dir: dir,
        api_url: baseUrl,
        harness: 'noop',
        poll_interval: 1,
        heartbeat_interval: 1,
      },
    });
    expect(cfg.token).toBe('rt_integration_secret');

    const runtime = new Runtime({ config: cfg, installSignalHandlers: false });
    void runtime.start();

    // 3. Wait until the job has been finalized as completed.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (rec.jobUpdates.some((u) => u.status === 'completed')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await runtime.shutdown();

    // --- Assertions across the whole loop -----------------------------------
    // heartbeat happened, and ended with an offline beat on shutdown.
    expect(rec.heartbeats.length).toBeGreaterThan(0);
    expect(rec.heartbeats.some((h) => h.status === 'online' || h.status === 'busy')).toBe(true);
    expect(rec.heartbeats.some((h) => h.status === 'offline')).toBe(true);

    // job claimed + lifecycle: running then completed.
    expect(rec.nextJobCalls).toBeGreaterThan(0);
    expect(rec.jobUpdates.some((u) => u.status === 'running')).toBe(true);
    const completed = rec.jobUpdates.find((u) => u.status === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.completion_percentage).toBe(100);
    const result = completed?.result as Record<string, unknown> | undefined;
    expect(result?.harness).toBe('noop');

    // log streaming reached the server, including the noop harness summary.
    expect(rec.logLines.length).toBeGreaterThan(0);
    const allLogs = rec.logLines.map((l) => l.message).join('\n');
    expect(allLogs).toContain('Picked up issue #99');
    expect(allLogs).toContain('NoopHarness');

    // every authenticated request used the registered token.
    expect([...rec.authTokensSeen]).toContain('rt_integration_secret');
  });
});
