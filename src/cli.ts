/**
 * SF-122 (A1): CLI entrypoint.
 *
 * Wires up commander with the runner subcommands. Most are STUBS at this stage;
 * downstream waves fill in register/start/stop/status with real behavior. The
 * config, logs, and version commands are functional now.
 */

import { Command } from 'commander';
import { loadConfig, saveConfig, configPath } from './config.js';
import { Logger, tailLog } from './logger.js';
import { VERSION } from './version.js';

const NOT_IMPLEMENTED = (name: string): void => {
  process.stderr.write(
    `vps-agent ${name}: not implemented yet (foundation scaffold). ` +
      `This lands in a later wave.\n`,
  );
  process.exitCode = 0;
};

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('vps-agent')
    .description('VPS Agent CLI for SprintFlint Autoplay')
    .version(VERSION, '-v, --version', 'output the version number');

  program
    .command('register')
    .description('Register this VPS with SprintFlint (stub)')
    .option('--name <name>', 'human-readable runner name')
    .option('--organization-id <id>', 'SprintFlint organization id')
    .option('--api-url <url>', 'override the SprintFlint base URL')
    .option('--token <token>', 'runner token (usually set after registration)')
    .action(() => NOT_IMPLEMENTED('register'));

  program
    .command('start')
    .description('Start the agent: heartbeat + poll for jobs (stub)')
    .option('--daemon', 'run detached in the background')
    .action(() => NOT_IMPLEMENTED('start'));

  program
    .command('stop')
    .description('Stop the running agent (stub)')
    .action(() => NOT_IMPLEMENTED('stop'));

  program
    .command('status')
    .description('Show agent status (stub)')
    .action(() => NOT_IMPLEMENTED('status'));

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
    .description('Unregister this VPS from SprintFlint (stub)')
    .action(() => NOT_IMPLEMENTED('unregister'));

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
    .description('Set a config key (api_url, token, log_level, harness, permission_mode)')
    .action((key: string, value: string) => {
      const allowed = ['api_url', 'token', 'log_level', 'harness', 'permission_mode'];
      if (!allowed.includes(key)) {
        process.stderr.write(`Unknown config key "${key}". Allowed: ${allowed.join(', ')}\n`);
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      saveConfig({ [key]: value }, cfg.config_dir);
      process.stdout.write(`Set ${key} in ${configPath(cfg.config_dir)}\n`);
    });

  program
    .command('version')
    .description('Show version information')
    .action(() => {
      process.stdout.write(`vps-agent ${VERSION}\n`);
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
