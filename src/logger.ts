/**
 * SF-125 (A4): Leveled structured logger.
 *
 * - Writes structured (JSON-line) records to ~/.vps-agent/agent.log.
 * - Rotates the file when it exceeds a size threshold, keeping N backups.
 * - Also echoes a human-readable line to the console at/above the level.
 * - Provides {@link tailLog} for the `logs` / `logs -f` CLI commands.
 */

import { join } from 'node:path';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
} from 'node:fs';
import type { LogLevel } from './types.js';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface LoggerOptions {
  /** Directory the log file lives in (typically config_dir). */
  dir: string;
  /** Minimum level that is emitted. */
  level?: LogLevel;
  /** Log file name. Defaults to `agent.log`. */
  fileName?: string;
  /** Rotate when the file exceeds this many bytes. Defaults to 5 MiB. */
  maxBytes?: number;
  /** Number of rotated backups to keep. Defaults to 5. */
  maxBackups?: number;
  /** Echo human-readable lines to stderr. Defaults to true. */
  console?: boolean;
}

/** A single structured log record as persisted to disk. */
export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 5;

export class Logger {
  private readonly filePath: string;
  private readonly level: LogLevel;
  private readonly maxBytes: number;
  private readonly maxBackups: number;
  private readonly toConsole: boolean;

  constructor(options: LoggerOptions) {
    this.level = options.level ?? 'info';
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxBackups = options.maxBackups ?? DEFAULT_MAX_BACKUPS;
    this.toConsole = options.console ?? true;
    mkdirSync(options.dir, { recursive: true });
    this.filePath = join(options.dir, options.fileName ?? 'agent.log');
  }

  /** Absolute path to the active log file. */
  get path(): string {
    return this.filePath;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[this.level];
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) return;
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;

    // Shift backups: agent.log.(n-1) -> agent.log.n, dropping the oldest.
    for (let i = this.maxBackups - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          /* best-effort rotation */
        }
      }
    }
    // Drop anything beyond the retention window.
    const overflow = `${this.filePath}.${this.maxBackups + 1}`;
    if (existsSync(overflow)) {
      try {
        unlinkSync(overflow);
      } catch {
        /* ignore */
      }
    }
    try {
      renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      /* ignore */
    }
  }

  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.enabled(level)) return;

    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(meta ?? {}),
    };

    this.rotateIfNeeded();
    try {
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      /* never let logging crash the agent */
    }

    if (this.toConsole) {
      const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      process.stderr.write(
        `${record.timestamp} [${level.toUpperCase()}] ${message}${metaStr}\n`,
      );
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  /** Return a child logger that merges `bindings` into every record. */
  child(bindings: Record<string, unknown>): Logger {
    const childLogger = Object.create(this) as Logger;
    const parentLog = this.log.bind(this);
    childLogger.log = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
      parentLog(level, message, { ...bindings, ...(meta ?? {}) });
    };
    return childLogger;
  }
}

export interface TailOptions {
  /** Keep watching the file and stream new lines as they arrive. */
  follow?: boolean;
  /** Emit at most this many existing lines before following. Default 200. */
  lines?: number;
  /** Sink for output. Defaults to process.stdout.write. */
  onLine?: (line: string) => void;
}

/**
 * Tail the log file, optionally following it (`logs -f`).
 *
 * Resolves immediately when not following (after printing the tail), or stays
 * pending while following and resolves when `stop()` is called or the returned
 * abort signal fires.
 */
export function tailLog(
  filePath: string,
  options: TailOptions = {},
): { stop: () => void; done: Promise<void> } {
  const lines = options.lines ?? 200;
  const onLine = options.onLine ?? ((l: string) => process.stdout.write(`${l}\n`));

  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  if (!existsSync(filePath)) {
    onLine(`(no log file yet at ${filePath})`);
  } else {
    printTail(filePath, lines, onLine);
  }

  if (!options.follow) {
    resolveDone();
    return { stop: resolveDone, done };
  }

  let position = existsSync(filePath) ? safeSize(filePath) : 0;
  const watcher = watch(filePath, { persistent: true }, (eventType) => {
    if (eventType !== 'change') return;
    const size = safeSize(filePath);
    if (size < position) {
      // File was rotated/truncated; restart from the beginning.
      position = 0;
    }
    if (size > position) {
      const stream = createReadStream(filePath, { start: position, end: size - 1, encoding: 'utf8' });
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
      });
      stream.on('end', () => {
        for (const line of buf.split('\n')) {
          if (line.length > 0) onLine(line);
        }
        position = size;
      });
    }
  });

  const stop = (): void => {
    watcher.close();
    resolveDone();
  };

  return { stop, done };
}

function safeSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function printTail(filePath: string, maxLines: number, onLine: (line: string) => void): void {
  // Simple, dependency-free tail: read whole file, keep the last `maxLines`.
  // Adequate for an agent log; the file is size-capped by rotation.
  try {
    const contents = readFileSync(filePath, 'utf8');
    const all = contents.split('\n').filter((l) => l.length > 0);
    for (const line of all.slice(-maxLines)) onLine(line);
  } catch {
    /* ignore unreadable file */
  }
}
