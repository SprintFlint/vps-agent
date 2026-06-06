/**
 * SF-129: System stats collection for heartbeats.
 *
 * Gathers cpu / memory / disk / process metrics using only Node built-ins
 * (node:os, node:process). Disk stats use statfs when available (Node >= 18.15)
 * and degrade gracefully to omitting disk on older runtimes.
 */

import { cpus, freemem, loadavg, totalmem, hostname, platform, release } from 'node:os';
import { statfs } from 'node:fs/promises';
import type { SystemStats } from './types.js';

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Best-effort disk usage for a path (defaults to the filesystem root). */
async function diskStats(path = '/'): Promise<Record<string, number> | undefined> {
  if (typeof statfs !== 'function') return undefined;
  try {
    const fs = await statfs(path);
    const total = fs.blocks * fs.bsize;
    const free = fs.bfree * fs.bsize;
    const used = total - free;
    return {
      disk_total_bytes: total,
      disk_free_bytes: free,
      disk_used_bytes: used,
      disk_used_percent: total > 0 ? round((used / total) * 100) : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Collect a snapshot of system + process stats for a heartbeat.
 * Never throws; failures collapse to omitted fields.
 */
export async function collectSystemStats(diskPath = '/'): Promise<SystemStats> {
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  const cores = cpus();
  const load = loadavg();
  const mem = process.memoryUsage();

  const stats: SystemStats = {
    hostname: hostname(),
    platform: platform(),
    release: release(),
    cpu_count: cores.length,
    cpu_model: cores[0]?.model ?? 'unknown',
    load_avg_1m: round(load[0] ?? 0),
    load_avg_5m: round(load[1] ?? 0),
    load_avg_15m: round(load[2] ?? 0),
    mem_total_bytes: total,
    mem_free_bytes: free,
    mem_used_bytes: used,
    mem_used_percent: total > 0 ? round((used / total) * 100) : 0,
    process_rss_bytes: mem.rss,
    process_heap_used_bytes: mem.heapUsed,
    uptime_seconds: round(process.uptime()),
    pid: process.pid,
    node_version: process.version,
  };

  const disk = await diskStats(diskPath);
  if (disk) Object.assign(stats, disk);

  return stats;
}
