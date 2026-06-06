/**
 * SF-138 (git ops).
 *
 * Detects working-tree changes, commits them with an issue-ref message, and
 * pushes the branch to `origin` using the host's ambient git credentials. The
 * actual command execution is injectable so unit tests never shell out to a
 * real `git`.
 */

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
 * Push the branch to `origin` using the host's ambient git credentials.
 */
export async function pushBranch(opts: GitOpsOptions): Promise<void> {
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
