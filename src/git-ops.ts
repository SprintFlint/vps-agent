/**
 * SF-138 (git ops) + SF-140 (pluggable git-auth, push side).
 *
 * Detects working-tree changes, commits them with an issue-ref message, and
 * pushes the branch. The actual command execution is injectable so unit tests
 * never shell out to a real `git`.
 *
 * Auth modes (SF-140):
 *   - 'machine': push with the branch's existing/ambient remote + credentials.
 *   - 'token':   push to a one-shot tokenized HTTPS remote URL built from the
 *                server-injected token, so no credential is persisted to disk.
 *                The token is never logged (the remote URL is redacted).
 */

import type { GitAuthMode } from './types.js';

/** Result of running a command. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code; null if the process was killed by a signal. */
  exitCode: number | null;
}

/** Injectable command runner. Defaults to a child_process-backed runner. */
export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export interface GitOpsOptions {
  /** Repo working directory. */
  workdir: string;
  /** Branch to push. */
  branch: string;
  /** Issue id, woven into the commit message and as a closing ref. */
  issueId: number;
  /** Issue title, used as the commit summary. */
  issueTitle: string;
  /** Auth mode. Defaults to 'machine'. */
  gitAuth?: GitAuthMode;
  /** HTTPS clone/repo URL; required for token-mode push remote construction. */
  repoUrl?: string;
  /** Server-injected token (token mode only). Never logged. */
  gitToken?: string;
  /** Injectable command runner. */
  exec: ExecFn;
  /** Optional streaming log sink. */
  log?: (message: string, level?: 'info' | 'warn' | 'error' | 'debug') => void;
}

/** Build the commit message: a conventional summary + an issue ref trailer. */
export function buildCommitMessage(issueId: number, issueTitle: string): string {
  const subject = issueTitle.trim() || `Resolve issue #${issueId}`;
  // Keep the subject reasonable; full context lives in the PR body.
  const trimmed = subject.length > 72 ? `${subject.slice(0, 69)}...` : subject;
  return `${trimmed}\n\nRefs SF-${issueId}`;
}

/**
 * Rewrite an HTTPS git URL to embed a token for a one-shot push, e.g.
 *   https://github.com/acme/repo.git -> https://x-access-token:<tok>@github.com/acme/repo.git
 * SSH URLs are returned unchanged (token auth does not apply).
 */
export function tokenizeRemote(repoUrl: string, token: string): string {
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return repoUrl;
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return repoUrl;
  }
}

/** Redact any embedded credentials from a URL for safe logging. */
export function redactRemote(remote: string): string {
  try {
    const u = new URL(remote);
    if (u.username || u.password) {
      u.username = 'x-access-token';
      u.password = '***';
    }
    return u.toString();
  } catch {
    return remote;
  }
}

/** True if the working tree has staged or unstaged changes. */
export async function hasChanges(opts: Pick<GitOpsOptions, 'workdir' | 'exec'>): Promise<boolean> {
  const res = await opts.exec('git', ['status', '--porcelain'], { cwd: opts.workdir });
  return res.stdout.trim().length > 0;
}

function assertOk(res: ExecResult, what: string): void {
  if (res.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${res.exitCode ?? 'signal'}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
}

/** Stage all changes and commit them. Returns the committed message. */
export async function commitAll(opts: GitOpsOptions): Promise<string> {
  await assertOkAsync(opts.exec('git', ['add', '-A'], { cwd: opts.workdir }), 'git add');
  const message = buildCommitMessage(opts.issueId, opts.issueTitle);
  await assertOkAsync(
    opts.exec('git', ['commit', '-m', message], { cwd: opts.workdir }),
    'git commit',
  );
  opts.log?.(`Committed changes for SF-${opts.issueId}`);
  return message;
}

async function assertOkAsync(p: Promise<ExecResult>, what: string): Promise<ExecResult> {
  const res = await p;
  assertOk(res, what);
  return res;
}

/**
 * Push the branch using the configured auth mode.
 *   - machine: `git push -u origin <branch>`
 *   - token:   `git push -u <tokenized-remote> <branch>` (URL never logged)
 */
export async function pushBranch(opts: GitOpsOptions): Promise<void> {
  const mode: GitAuthMode = opts.gitAuth ?? 'machine';

  if (mode === 'token') {
    if (!opts.gitToken) throw new Error('git_auth=token but no git token was provided in the job payload');
    if (!opts.repoUrl) throw new Error('git_auth=token requires a repository URL to build the push remote');
    const remote = tokenizeRemote(opts.repoUrl, opts.gitToken);
    opts.log?.(`Pushing ${opts.branch} to ${redactRemote(remote)}`);
    await assertOkAsync(
      opts.exec('git', ['push', '-u', remote, `HEAD:${opts.branch}`], { cwd: opts.workdir }),
      'git push',
    );
    return;
  }

  opts.log?.(`Pushing ${opts.branch} to origin`);
  await assertOkAsync(
    opts.exec('git', ['push', '-u', 'origin', `HEAD:${opts.branch}`], { cwd: opts.workdir }),
    'git push',
  );
}

/** Convenience: detect changes, commit, push. Returns false if no changes. */
export async function commitAndPush(opts: GitOpsOptions): Promise<boolean> {
  if (!(await hasChanges(opts))) {
    opts.log?.('No working-tree changes to commit', 'warn');
    return false;
  }
  await commitAll(opts);
  await pushBranch(opts);
  return true;
}
