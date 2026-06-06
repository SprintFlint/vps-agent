/**
 * SF-122 (A1) + Epic B (SF-128..SF-134): CLI entrypoint.
 *
 * Wires up commander with the runner subcommands. cli.ts owns all commands and
 * stays cohesive: each action delegates to a focused src/ module
 * (register.ts, runtime.ts, daemon.ts) for the real logic.
 */

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { loadConfig, saveConfig, configPath } from './config.js';
import { Logger, tailLog } from './logger.js';
import { VERSION } from './version.js';
import { register as runRegister } from './register.js';
import { Runtime } from './runtime.js';
import {
  defaultPidfile,
  inspectRunning,
  removePidfile,
  signalRunning,
  writePidfile,
} from './daemon.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('vps-agent')
    .description('VPS Agent CLI for SprintFlint Autoplay')
    .version(VERSION, '-v, --version', 'output the version number');

  program
    .command('register')
    .description('Register this VPS with SprintFlint')
    .option('--name <name>', 'human-readable runner name (with --org-id)')
    .option('--org-id <id>', 'SprintFlint organization id (with --name)')
    .option('--organization-id <id>', 'alias for --org-id')
    .option('--api-url <url>', 'override the SprintFlint base URL')
    .option('--token <token>', 'use a runner token created in the web UI')
    .action(
      async (opts: {
        name?: string;
        orgId?: string;
        organizationId?: string;
        apiUrl?: string;
        token?: string;
      }) => {
        const config = loadConfig({
          overrides: opts.apiUrl ? { api_url: opts.apiUrl } : {},
        });
        const logger = new Logger({ dir: config.config_dir, level: config.log_level, console: false });
        try {
          const result = await runRegister(
            {
              orgId: opts.orgId ?? opts.organizationId,
              name: opts.name,
              token: opts.token,
              apiUrl: opts.apiUrl,
            },
            config,
            { logger },
          );
          if (result.mode === 'register') {
            process.stdout.write(
              `Registered runner #${result.runnerId} with ${result.apiUrl}.\n` +
                `Token saved to ${configPath(config.config_dir)}.\n` +
                `It should now appear in your SprintFlint dashboard. Run \`vps-agent start\`.\n`,
            );
          } else {
            process.stdout.write(
              `Saved runner token for ${result.apiUrl} to ${configPath(config.config_dir)}.\n` +
                `Run \`vps-agent start\` to connect.\n`,
            );
          }
        } catch (err) {
          process.stderr.write(`register failed: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exitCode = 1;
        }
      },
    );

  program
    .command('start')
    .description('Start the agent: heartbeat + poll for jobs')
    .option('--daemon', 'run detached in the background')
    .option('--pidfile <path>', 'pidfile location (defaults to <config_dir>/agent.pid)')
    .action(async (opts: { daemon?: boolean; pidfile?: string }) => {
      const config = loadConfig();
      const pidfile = opts.pidfile ?? defaultPidfile(config.config_dir);

      if (!config.token) {
        process.stderr.write('No runner token configured. Run `vps-agent register` first.\n');
        process.exitCode = 1;
        return;
      }

      const existing = inspectRunning(pidfile);
      if (existing.running) {
        process.stderr.write(`Agent already running (pid ${existing.pid}).\n`);
        process.exitCode = 1;
        return;
      }

      if (opts.daemon) {
        // Re-exec ourselves detached, without --daemon, redirecting output to the log.
        const logFile = join(config.config_dir, 'daemon.out.log');
        const out = openSync(logFile, 'a');
        const args = ['start', '--pidfile', pidfile];
        const child = spawn(process.execPath, [process.argv[1] as string, ...args], {
          detached: true,
          stdio: ['ignore', out, out],
        });
        child.unref();
        process.stdout.write(`Agent started in background (pid ${child.pid}). Logs: ${logFile}\n`);
        return;
      }

      // Foreground: own the pidfile for our lifetime.
      writePidfile(pidfile);
      const runtime = new Runtime({ config });
      const cleanup = (): void => removePidfile(pidfile);
      try {
        await runtime.start();
      } finally {
        cleanup();
      }
    });

  program
    .command('stop')
    .description('Stop the running agent (via pidfile)')
    .option('--pidfile <path>', 'pidfile location (defaults to <config_dir>/agent.pid)')
    .action((opts: { pidfile?: string }) => {
      const config = loadConfig();
      const pidfile = opts.pidfile ?? defaultPidfile(config.config_dir);
      const info = inspectRunning(pidfile);
      if (!info.running) {
        process.stdout.write('No running agent found.\n');
        return;
      }
      const pid = signalRunning(pidfile, 'SIGTERM');
      if (pid !== null) {
        process.stdout.write(`Sent SIGTERM to agent (pid ${pid}).\n`);
      } else {
        process.stderr.write('Failed to signal the running agent.\n');
        process.exitCode = 1;
      }
    });

  program
    .command('status')
    .description('Show agent status (config + whether running)')
    .option('--pidfile <path>', 'pidfile location (defaults to <config_dir>/agent.pid)')
    .action((opts: { pidfile?: string }) => {
      const config = loadConfig();
      const pidfile = opts.pidfile ?? defaultPidfile(config.config_dir);
      const info = inspectRunning(pidfile);
      const summary = {
        running: info.running,
        pid: info.pid,
        registered: Boolean(config.token),
        runner_id: config.runner_id,
        api_url: config.api_url,
        harness: config.harness,
        permission_mode: config.permission_mode,
        heartbeat_interval: config.heartbeat_interval,
        poll_interval: config.poll_interval,
        log_level: config.log_level,
        config_file: configPath(config.config_dir),
        pidfile,
      };
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    });

  program
    .command('logs')
    .description('Show the agent log; use -f to follow')
    .option('-f, --follow', 'follow the log as new lines are written')
    .option('-n, --lines <count>', 'number of trailing lines to show', '200')
    .action((opts: { follow?: boolean; lines?: string }) => {
      const config = loadConfig();
      const logger = new Logger({ dir: config.config_dir, console: false });
      const lines = Number.parseInt(opts.lines ?? '200', 10);
      const { done } = tailLog(logger.path, {
        follow: opts.follow ?? false,
        lines: Number.isFinite(lines) ? lines : 200,
      });
      if (opts.follow) {
        process.stderr.write('(following; press Ctrl+C to stop)\n');
      }
      return done;
    });

  program
    .command('unregister')
    .description('Clear local registration (local-only; no server endpoint)')
    .option('--pidfile <path>', 'pidfile location (defaults to <config_dir>/agent.pid)')
    .action((opts: { pidfile?: string }) => {
      const config = loadConfig();
      const pidfile = opts.pidfile ?? defaultPidfile(config.config_dir);
      // Best-effort: stop a running agent first so it stops heartbeating.
      const info = inspectRunning(pidfile);
      if (info.running) {
        signalRunning(pidfile, 'SIGTERM');
        process.stdout.write(`Signalled running agent (pid ${info.pid}) to stop.\n`);
      }
      // Local-only: the runner-token API has no unregister endpoint.
      saveConfig({ token: null, runner_id: null }, config.config_dir);
      removePidfile(pidfile);
      process.stdout.write(
        `Cleared local token + runner_id from ${configPath(config.config_dir)}.\n` +
          `Note: this is local-only; remove the runner in the dashboard to fully revoke it.\n`,
      );
    });

  const config = program.command('config').description('View or set local configuration');

  config
    .command('show', { isDefault: true })
    .description('Print the effective configuration (token redacted)')
    .action(() => {
      const cfg = loadConfig();
      const redacted = { ...cfg, token: cfg.token ? '***redacted***' : null };
      process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
      process.stdout.write(`\nconfig file: ${configPath(cfg.config_dir)}\n`);
    });

  config
    .command('set <key> <value>')
    .description(
      'Set a config key (api_url, token, log_level, harness, permission_mode, ' +
        'heartbeat_interval, poll_interval, max_log_batch_size)',
    )
    .action((key: string, value: string) => {
      const stringKeys = ['api_url', 'token', 'log_level', 'harness', 'permission_mode'];
      const numericKeys = ['heartbeat_interval', 'poll_interval', 'max_log_batch_size', 'runner_id'];
      if (![...stringKeys, ...numericKeys].includes(key)) {
        process.stderr.write(
          `Unknown config key "${key}". Allowed: ${[...stringKeys, ...numericKeys].join(', ')}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      let coerced: string | number = value;
      if (numericKeys.includes(key)) {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          process.stderr.write(`Value for "${key}" must be a number.\n`);
          process.exitCode = 1;
          return;
        }
        coerced = n;
      }
      saveConfig({ [key]: coerced }, cfg.config_dir);
      process.stdout.write(`Set ${key} in ${configPath(cfg.config_dir)}\n`);
    });

  program
    .command('version')
    .description('Show version information')
    .action(() => {
      process.stdout.write(`vps-agent ${VERSION} (node ${process.version}, ${process.platform})\n`);
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}

// Execute when run as the CLI binary.
main().catch((err: unknown) => {
  process.stderr.write(`vps-agent: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
