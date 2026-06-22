/**
 * SF-195: working-tree source modes.
 *
 * Autoplay no longer always clones the repo from scratch. Per project, a runner
 * can source the working tree three ways:
 *
 *   - clone       — clone the repo into an isolated per-job dir (the original
 *                   behaviour; still the default when nothing else is configured).
 *   - local_path  — run inside an existing checkout on disk, so the harness
 *                   inherits the user's own ENV / credentials / config (e.g.
 *                   `config/master.key`, `.env`) that live there.
 *   - worktree    — `git worktree add` a throwaway tree from a base repo so jobs
 *                   stay isolated but share the object store.
 *
 * The runner NEVER copies, syncs, logs, or transmits secrets / ENV files. It
 * only executes inside the path the user configured; whatever secrets live there
 * are entirely under the user's control.
 */

import { join } from 'node:path';
import type { AgentConfig } from './config.js';
import type { IssueContext } from './harness.js';

/** How the runner sources the working tree for a job. */
export type SourceMode = 'clone' | 'local_path' | 'worktree';

/** All valid source modes, in documentation order. */
export const SOURCE_MODES: readonly SourceMode[] = ['clone', 'local_path', 'worktree'];

/** Type guard: is `value` a known source mode? */
export function isSourceMode(value: string): value is SourceMode {
  return (SOURCE_MODES as readonly string[]).includes(value);
}

/**
 * Per-project source configuration. Every field is optional and overrides the
 * matching global config key for jobs whose repository matches the project key.
 */
export interface ProjectSourceConfig {
  source_mode?: SourceMode;
  /** Existing checkout to run in (local_path mode). */
  local_path?: string;
  /** Base repo to `git worktree add` from (worktree mode). */
  base_repo_path?: string;
  /** Directory under which per-job worktrees are created (worktree mode). */
  worktrees_dir?: string;
}

/** Fully-resolved source decision for one job. */
export interface ResolvedSource {
  mode: SourceMode;
  /** The project config key that matched, if any (for logging). */
  matchedProject?: string;
  /** local_path mode: the existing checkout to run in. */
  localPath?: string;
  /** worktree mode: the base repo to `git worktree add` from. */
  baseRepoPath?: string;
  /** worktree mode: directory under which the per-job worktree is created. */
  worktreesDir?: string;
}

/**
 * Normalize a git remote (or a bare `owner/repo` string) to a stable, lower-cased
 * `owner/repo` key so per-project config matches regardless of https/ssh form or
 * a trailing `.git`. Returns null when no slug can be derived.
 *
 * Examples (all -> `acme/repo`):
 *   https://github.com/Acme/Repo.git
 *   git@github.com:Acme/Repo.git
 *   ssh://git@github.com/Acme/Repo
 *   Acme/Repo
 */
export function repoSlug(input: string | undefined | null): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/\.git$/i, '');

  const scp = /^[^/@]+@[^:]+:(.+)$/.exec(s); // git@host:owner/repo
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(s); // scheme://host/owner/repo
  if (scp) s = scp[1] as string;
  else if (url) s = url[1] as string;

  const parts = s
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length === 0) return null;
  // Keep the trailing owner/repo when the path is deeper (e.g. self-hosted groups).
  const slug = (parts.length >= 2 ? parts.slice(-2) : parts).join('/').toLowerCase();
  return slug || null;
}

/** Find the project config whose key normalizes to the same slug as `slug`. */
function matchProject(
  projects: Record<string, ProjectSourceConfig>,
  slug: string | null,
): { key: string; config: ProjectSourceConfig } | null {
  if (!slug) return null;
  for (const [key, config] of Object.entries(projects)) {
    if (repoSlug(key) === slug) return { key, config };
  }
  return null;
}

/**
 * Decide how to source the working tree for `issue`, layering an optional
 * per-project override on top of the global config.
 *
 * Mode selection:
 *   1. An explicit per-project `source_mode` wins.
 *   2. Otherwise the global `source_mode` is used.
 *   3. As a convenience, when the resolved mode would be the `clone` default but
 *      a path is configured (globally or for the project), the path implies the
 *      mode — `base_repo_path` -> worktree, `local_path` -> local_path — so a
 *      forgotten `source_mode` does not silently fall back to a full clone. Set
 *      `source_mode` explicitly per project to override this.
 */
export function resolveSource(
  config: AgentConfig,
  issue: Pick<IssueContext, 'repositoryUrl' | 'cloneUrl'>,
): ResolvedSource {
  const slug = repoSlug(issue.cloneUrl ?? issue.repositoryUrl);
  const matched = matchProject(config.projects ?? {}, slug);
  const project = matched?.config;

  const localPath = project?.local_path ?? config.local_path ?? undefined;
  const baseRepoPath = project?.base_repo_path ?? config.base_repo_path ?? undefined;

  let mode: SourceMode = project?.source_mode ?? config.source_mode ?? 'clone';
  if (mode === 'clone' && project?.source_mode === undefined) {
    if (baseRepoPath && !localPath) mode = 'worktree';
    else if (localPath) mode = 'local_path';
  }

  const resolved: ResolvedSource = { mode };
  if (matched) resolved.matchedProject = matched.key;

  if (mode === 'local_path' && localPath) {
    resolved.localPath = localPath;
  } else if (mode === 'worktree') {
    if (baseRepoPath) resolved.baseRepoPath = baseRepoPath;
    resolved.worktreesDir =
      project?.worktrees_dir ?? config.worktrees_dir ?? join(config.config_dir, 'worktrees');
  }
  return resolved;
}
