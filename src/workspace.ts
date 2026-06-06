/**
 * SF-135 (workspace): isolated per-job working directory.
 *
 * For each job we create ~/.vps-agent/jobs/<job_id>/repo, clone the repository
 * into it, and check out (creating if needed) the job's branch. After the job
 * finishes (success OR failure) the directory is removed so jobs never leak
 * disk or cross-contaminate each other.
 *
 * Cloning respects SF-140 git_auth: in 'token' mode a tokenized HTTPS remote is
 * used so private repos clone without persisting credentials. The token is
 * never logged.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecFn } from './git-ops.js';
import { tokenizeRemote, redactRemote } from './git-ops.js';
import type { GitAuthMode } from './types.js';

export interface PrepareWorkspaceOptions {
  /** Root jobs dir, e.g. <config_dir>/jobs. */
  jobsDir: string;
  jobId: number;
  /** URL to clone. Prefer IssueContext.cloneUrl, fall back to repositoryUrl. */
  cloneUrl: string;
  branch: string;
  gitAuth?: GitAuthMode;
  gitToken?: string;
  exec: ExecFn;
  log?: (message: string, level?: 'info' | 'warn' | 'error' | 'debug') => void;
}

export interface Workspace {
  /** The per-job root (…/jobs/<id>). */
  jobDir: string;
  /** The cloned repo working directory (…/jobs/<id>/repo). */
  repoDir: string;
  /** The branch checked out. */
  branch: string;
}

function assertOk(res: { exitCode: number | null; stderr: string; stdout: string }, what: string): void {
  if (res.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${res.exitCode ?? 'signal'}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

/**
 * Clone the repo into an isolated per-job directory and switch to the branch,
 * creating it locally when it does not exist on the remote.
 */
export async function prepareWorkspace(opts: PrepareWorkspaceOptions): Promise<Workspace> {
  const jobDir = join(opts.jobsDir, String(opts.jobId));
  const repoDir = join(jobDir, 'repo');

  // Start from a clean slate in case a previous run left debris.
  rmSync(jobDir, { recursive: true, force: true });
  mkdirSync(jobDir, { recursive: true });

  const remote =
    (opts.gitAuth ?? 'machine') === 'token' && opts.gitToken
      ? tokenizeRemote(opts.cloneUrl, opts.gitToken)
      : opts.cloneUrl;

  opts.log?.(`Cloning ${redactRemote(remote)} into ${repoDir}`);
  assertOk(await opts.exec('git', ['clone', remote, repoDir]), 'git clone');

  // Try to check out an existing branch; if it doesn't exist, create it.
  const checkout = await opts.exec('git', ['checkout', opts.branch], { cwd: repoDir });
  if (checkout.exitCode !== 0) {
    opts.log?.(`Branch ${opts.branch} not found; creating it`);
    assertOk(
      await opts.exec('git', ['checkout', '-b', opts.branch], { cwd: repoDir }),
      `git checkout -b ${opts.branch}`,
    );
  } else {
    opts.log?.(`Checked out existing branch ${opts.branch}`);
  }

  return { jobDir, repoDir, branch: opts.branch };
}

/** Remove a workspace directory. Best-effort; never throws. */
export function cleanupWorkspace(jobDir: string, log?: (m: string, l?: string) => void): void {
  try {
    rmSync(jobDir, { recursive: true, force: true });
    log?.(`Cleaned up workspace ${jobDir}`);
  } catch {
    /* best-effort cleanup; the next prepare() also clears stale dirs */
  }
}

/** The conventional jobs root under a config dir. */
export function jobsRoot(configDir: string): string {
  return join(configDir, 'jobs');
}
