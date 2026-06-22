/**
 * SF-135 / SF-195 (workspace): source the per-job working tree.
 *
 * The runner can source the working directory three ways (see source-mode.ts):
 *
 *   - clone       — clone the repo into ~/.vps-agent/jobs/<job_id>/repo and check
 *                   out the job's branch. The dir is removed when the job ends.
 *   - worktree    — `git worktree add` a throwaway tree from a configured base
 *                   repo under the worktrees dir; removed with `git worktree
 *                   remove` when the job ends. Jobs stay isolated but share the
 *                   object store.
 *   - local_path  — run inside an existing checkout on disk so the harness
 *                   inherits the user's own ENV / credentials / config that live
 *                   there. We stash any uncommitted work, switch to the branch,
 *                   and restore the original branch + stash when done — we never
 *                   delete the checkout.
 *
 * All git operations use the host's ambient credentials; no credentials or
 * secrets are handled, copied, or persisted by the agent.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecFn, ExecResult } from './git-ops.js';
import type { ResolvedSource, SourceMode } from './source-mode.js';

type LogFn = (message: string, level?: 'info' | 'warn' | 'error' | 'debug') => void;

export interface PrepareWorkspaceOptions {
  /** Resolved source decision for this job (mode + paths). */
  source: ResolvedSource;
  /** Root jobs dir, e.g. <config_dir>/jobs (used by clone mode). */
  jobsDir: string;
  jobId: number;
  /** URL to clone. Prefer IssueContext.cloneUrl, fall back to repositoryUrl. */
  cloneUrl: string;
  branch: string;
  exec: ExecFn;
  log?: LogFn;
}

export interface Workspace {
  /** The working directory the harness runs in. */
  repoDir: string;
  /** The branch checked out. */
  branch: string;
  /** Which source mode produced this workspace. */
  mode: SourceMode;
  /**
   * Tear down the workspace: remove the clone/worktree, or restore a local_path
   * checkout to its original branch + stash. Best-effort; never throws.
   */
  cleanup: () => Promise<void>;
}

const noopLog: LogFn = () => {};

function assertOk(res: ExecResult, what: string): void {
  if (res.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${res.exitCode ?? 'signal'}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

/** Check out an existing branch, creating it locally when it does not exist. */
async function checkoutBranch(exec: ExecFn, cwd: string, branch: string, log: LogFn): Promise<void> {
  const checkout = await exec('git', ['checkout', branch], { cwd });
  if (checkout.exitCode !== 0) {
    log(`Branch ${branch} not found; creating it`);
    assertOk(await exec('git', ['checkout', '-b', branch], { cwd }), `git checkout -b ${branch}`);
  } else {
    log(`Checked out existing branch ${branch}`);
  }
}

/** A short " (project owner/repo)" suffix for log lines, or "". */
function projectNote(source: ResolvedSource): string {
  return source.matchedProject ? ` (project ${source.matchedProject})` : '';
}

/**
 * Source the working tree per the resolved mode and switch to the branch. The
 * returned Workspace carries a `cleanup()` appropriate to the mode.
 */
export async function prepareWorkspace(opts: PrepareWorkspaceOptions): Promise<Workspace> {
  switch (opts.source.mode) {
    case 'local_path':
      return prepareLocalPath(opts);
    case 'worktree':
      return prepareWorktree(opts);
    case 'clone':
    default:
      return prepareClone(opts);
  }
}

/** clone mode: full clone into an isolated per-job dir (original behaviour). */
async function prepareClone(opts: PrepareWorkspaceOptions): Promise<Workspace> {
  const log = opts.log ?? noopLog;
  const jobDir = join(opts.jobsDir, String(opts.jobId));
  const repoDir = join(jobDir, 'repo');

  // Start from a clean slate in case a previous run left debris.
  rmSync(jobDir, { recursive: true, force: true });
  mkdirSync(jobDir, { recursive: true });

  log(`Source mode: clone${projectNote(opts.source)} — cloning ${opts.cloneUrl} into ${repoDir}`);
  assertOk(await opts.exec('git', ['clone', opts.cloneUrl, repoDir]), 'git clone');
  await checkoutBranch(opts.exec, repoDir, opts.branch, log);
  log(`Working directory: ${repoDir}`);

  return {
    repoDir,
    branch: opts.branch,
    mode: 'clone',
    cleanup: async () => {
      cleanupWorkspace(jobDir, (m, l) => log(m, (l as 'debug') ?? 'debug'));
    },
  };
}

/** True if `branch` exists locally in the repo at `cwd`. */
async function localBranchExists(exec: ExecFn, cwd: string, branch: string): Promise<boolean> {
  const res = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd });
  return res.exitCode === 0;
}

/** Remove a worktree from `base` (best-effort), pruning stale admin entries. */
async function removeWorktree(exec: ExecFn, base: string, worktreePath: string): Promise<void> {
  const res = await exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: base });
  if (res.exitCode !== 0) {
    await exec('git', ['worktree', 'prune'], { cwd: base });
  }
}

/** worktree mode: `git worktree add` a throwaway tree from the base repo. */
async function prepareWorktree(opts: PrepareWorkspaceOptions): Promise<Workspace> {
  const log = opts.log ?? noopLog;
  const base = opts.source.baseRepoPath;
  if (!base) {
    throw new Error('worktree source mode requires base_repo_path to be configured');
  }
  if (!existsSync(base)) {
    throw new Error(`worktree base repo path does not exist: ${base}`);
  }
  const worktreesDir = opts.source.worktreesDir ?? join(opts.jobsDir, 'worktrees');
  const repoDir = join(worktreesDir, String(opts.jobId));

  mkdirSync(worktreesDir, { recursive: true });

  // Clear any stale worktree left at that path by a previous run.
  await removeWorktree(opts.exec, base, repoDir);
  rmSync(repoDir, { recursive: true, force: true });

  log(`Source mode: worktree${projectNote(opts.source)} — adding ${repoDir} from base repo ${base}`);

  // Reuse an existing local branch when present; otherwise create it (-b).
  const exists = await localBranchExists(opts.exec, base, opts.branch);
  const addArgs = exists
    ? ['worktree', 'add', repoDir, opts.branch]
    : ['worktree', 'add', '-b', opts.branch, repoDir];
  assertOk(await opts.exec('git', addArgs, { cwd: base }), 'git worktree add');
  log(`Working directory: ${repoDir}`);

  return {
    repoDir,
    branch: opts.branch,
    mode: 'worktree',
    cleanup: async () => {
      try {
        await removeWorktree(opts.exec, base, repoDir);
        rmSync(repoDir, { recursive: true, force: true });
        log(`Removed worktree ${repoDir}`, 'debug');
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

/** Current branch name, or the commit SHA when HEAD is detached. */
async function currentRef(exec: ExecFn, cwd: string): Promise<string | null> {
  const sym = await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  if (sym.exitCode === 0 && sym.stdout.trim()) return sym.stdout.trim();
  const sha = await exec('git', ['rev-parse', 'HEAD'], { cwd });
  if (sha.exitCode === 0 && sha.stdout.trim()) return sha.stdout.trim();
  return null;
}

/**
 * local_path mode: run inside the user's existing checkout. We stash uncommitted
 * work (so the tree is clean and we can restore it), switch to the branch, and
 * on cleanup restore the original branch + stash. The checkout is NEVER deleted,
 * and we never read or transmit the stashed contents.
 */
async function prepareLocalPath(opts: PrepareWorkspaceOptions): Promise<Workspace> {
  const log = opts.log ?? noopLog;
  const path = opts.source.localPath;
  if (!path) {
    throw new Error('local_path source mode requires local_path to be configured');
  }
  if (!existsSync(path)) {
    throw new Error(`local_path does not exist: ${path}`);
  }
  const inside = await opts.exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: path });
  if (inside.exitCode !== 0) {
    throw new Error(`local_path is not a git repository: ${path}`);
  }

  log(`Source mode: local_path${projectNote(opts.source)} — using existing checkout ${path}`);

  const originalRef = await currentRef(opts.exec, path);

  // Stash any uncommitted work (tracked + untracked) so we start clean and can
  // restore the user's state afterwards.
  let stashed = false;
  const status = await opts.exec('git', ['status', '--porcelain'], { cwd: path });
  if (status.stdout.trim().length > 0) {
    const stash = await opts.exec(
      'git',
      ['stash', 'push', '--include-untracked', '-m', `vps-agent job ${opts.jobId}`],
      { cwd: path },
    );
    if (stash.exitCode !== 0) {
      throw new Error(
        `local_path has uncommitted changes and git stash failed; refusing to run: ${stash.stderr.trim() || stash.stdout.trim()}`,
      );
    }
    stashed = true;
    log('Stashed uncommitted local changes; will restore them when the job ends', 'warn');
  }

  try {
    await checkoutBranch(opts.exec, path, opts.branch, log);
  } catch (err) {
    // Roll back our stash before surfacing the failure.
    if (stashed) await opts.exec('git', ['stash', 'pop'], { cwd: path });
    throw err;
  }
  log(`Working directory: ${path}`);

  return {
    repoDir: path,
    branch: opts.branch,
    mode: 'local_path',
    cleanup: async () => {
      try {
        // Discard any uncommitted leftovers from the harness so we can switch
        // back cleanly. Work the harness committed is already on the branch (and
        // pushed); git clean keeps ignored files (e.g. master.key, .env).
        await opts.exec('git', ['reset', '--hard', 'HEAD'], { cwd: path });
        await opts.exec('git', ['clean', '-fd'], { cwd: path });
        if (originalRef) {
          await opts.exec('git', ['checkout', originalRef], { cwd: path });
          log(`Restored original ref ${originalRef}`, 'debug');
        }
        if (stashed) {
          const pop = await opts.exec('git', ['stash', 'pop'], { cwd: path });
          if (pop.exitCode !== 0) {
            log(
              'Could not auto-restore stashed changes; they remain safe in `git stash list`',
              'warn',
            );
          } else {
            log('Restored stashed local changes', 'debug');
          }
        }
      } catch {
        /* best-effort restore; we never delete the user's checkout */
      }
    },
  };
}

/** Remove a workspace directory. Best-effort; never throws. */
export function cleanupWorkspace(jobDir: string, log?: LogFn): void {
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
