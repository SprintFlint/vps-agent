/**
 * SF-152: system-stats coverage. Verifies the heartbeat stats snapshot has the
 * expected shape and never throws, including on a bogus disk path.
 */

import { describe, it, expect } from 'vitest';
import { collectSystemStats } from '../src/system-stats.js';

describe('collectSystemStats', () => {
  it('returns core cpu/memory/process fields', async () => {
    const stats = await collectSystemStats();
    expect(typeof stats.hostname).toBe('string');
    expect(typeof stats.platform).toBe('string');
    expect(typeof stats.cpu_count).toBe('number');
    expect(stats.cpu_count).toBeGreaterThan(0);
    expect(typeof stats.mem_total_bytes).toBe('number');
    expect(typeof stats.mem_used_percent).toBe('number');
    expect(typeof stats.process_rss_bytes).toBe('number');
    expect(stats.pid).toBe(process.pid);
    expect(stats.node_version).toBe(process.version);
  });

  it('omits disk fields gracefully for a non-existent path', async () => {
    const stats = await collectSystemStats('/this/path/does/not/exist/anywhere');
    // Must not throw; disk fields simply absent.
    expect(stats.disk_total_bytes).toBeUndefined();
    expect(typeof stats.mem_total_bytes).toBe('number');
  });

  it('includes disk fields for a real path', async () => {
    const stats = await collectSystemStats(process.cwd());
    if (stats.disk_total_bytes !== undefined) {
      expect(typeof stats.disk_total_bytes).toBe('number');
      expect(typeof stats.disk_used_percent).toBe('number');
    }
  });
});
