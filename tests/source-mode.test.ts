import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { repoSlug, resolveSource, isSourceMode, SOURCE_MODES } from '../src/source-mode.js';
import type { AgentConfig } from '../src/config.js';

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    api_url: 'http://localhost:3000',
    token: 'tok',
    log_level: 'info',
    harness: 'claude',
    permission_mode: 'default',
    config_dir: '/cfg',
    runner_id: 1,
    heartbeat_interval: 30,
    poll_interval: 5,
    max_log_batch_size: 100,
    source_mode: 'clone',
    local_path: null,
    base_repo_path: null,
    worktrees_dir: null,
    projects: {},
    ...overrides,
  };
}

const issue = (repositoryUrl: string, cloneUrl?: string): { repositoryUrl: string; cloneUrl?: string } =>
  cloneUrl ? { repositoryUrl, cloneUrl } : { repositoryUrl };

describe('repoSlug', () => {
  it('normalizes https, ssh, scp, and bare forms to lower-case owner/repo', () => {
    expect(repoSlug('https://github.com/Acme/Repo.git')).toBe('acme/repo');
    expect(repoSlug('https://github.com/Acme/Repo')).toBe('acme/repo');
    expect(repoSlug('git@github.com:Acme/Repo.git')).toBe('acme/repo');
    expect(repoSlug('ssh://git@github.com/Acme/Repo')).toBe('acme/repo');
    expect(repoSlug('Acme/Repo')).toBe('acme/repo');
  });

  it('keeps the trailing owner/repo for deeper paths', () => {
    expect(repoSlug('https://gitlab.example.com/group/sub/repo.git')).toBe('sub/repo');
  });

  it('returns null for empty input', () => {
    expect(repoSlug('')).toBeNull();
    expect(repoSlug(null)).toBeNull();
    expect(repoSlug(undefined)).toBeNull();
  });
});

describe('isSourceMode / SOURCE_MODES', () => {
  it('recognizes the three modes', () => {
    expect(SOURCE_MODES).toEqual(['clone', 'local_path', 'worktree']);
    expect(isSourceMode('clone')).toBe(true);
    expect(isSourceMode('worktree')).toBe(true);
    expect(isSourceMode('nope')).toBe(false);
  });
});

describe('resolveSource', () => {
  it('defaults to clone with no config', () => {
    const r = resolveSource(config(), issue('https://github.com/acme/repo.git'));
    expect(r.mode).toBe('clone');
    expect(r.matchedProject).toBeUndefined();
  });

  it('honors an explicit global source_mode', () => {
    const r = resolveSource(
      config({ source_mode: 'worktree', base_repo_path: '/repos/acme' }),
      issue('https://github.com/acme/repo.git'),
    );
    expect(r.mode).toBe('worktree');
    expect(r.baseRepoPath).toBe('/repos/acme');
    expect(r.worktreesDir).toBe(join('/cfg', 'worktrees'));
  });

  it('infers local_path when a global local_path is set but mode is left default', () => {
    const r = resolveSource(
      config({ local_path: '/Users/luke/code/app' }),
      issue('https://github.com/acme/repo.git'),
    );
    expect(r.mode).toBe('local_path');
    expect(r.localPath).toBe('/Users/luke/code/app');
  });

  it('infers worktree when only base_repo_path is set', () => {
    const r = resolveSource(
      config({ base_repo_path: '/repos/acme' }),
      issue('https://github.com/acme/repo.git'),
    );
    expect(r.mode).toBe('worktree');
    expect(r.baseRepoPath).toBe('/repos/acme');
  });

  it('uses a per-project override and matches regardless of URL form', () => {
    const cfg = config({
      local_path: '/global/path',
      projects: {
        'acme/repo': { source_mode: 'worktree', base_repo_path: '/repos/acme', worktrees_dir: '/wt' },
      },
    });
    const r = resolveSource(cfg, issue('git@github.com:Acme/Repo.git'));
    expect(r.mode).toBe('worktree');
    expect(r.matchedProject).toBe('acme/repo');
    expect(r.baseRepoPath).toBe('/repos/acme');
    expect(r.worktreesDir).toBe('/wt');
  });

  it('prefers the clone_url over repository_url for matching', () => {
    const cfg = config({
      projects: { 'acme/canonical': { source_mode: 'local_path', local_path: '/p' } },
    });
    const r = resolveSource(
      cfg,
      issue('https://github.com/acme/mirror.git', 'https://github.com/acme/canonical.git'),
    );
    expect(r.matchedProject).toBe('acme/canonical');
    expect(r.mode).toBe('local_path');
  });

  it('lets a per-project explicit clone override an inferred global mode', () => {
    const cfg = config({
      local_path: '/global/path', // would infer local_path globally
      projects: { 'acme/repo': { source_mode: 'clone' } },
    });
    const r = resolveSource(cfg, issue('https://github.com/acme/repo.git'));
    expect(r.mode).toBe('clone');
    expect(r.localPath).toBeUndefined();
  });
});
