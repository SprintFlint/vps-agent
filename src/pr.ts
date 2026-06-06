/**
 * SF-139 (open PR) + SF-140 (pluggable git-auth, PR side).
 *
 * Opens a pull request with `gh pr create` and returns the PR URL. It NEVER
 * merges. Command execution is injectable so tests don't invoke real `gh`.
 *
 * Auth modes (SF-140):
 *   - 'machine': rely on the VPS's ambient `gh auth` session.
 *   - 'token':   pass the server-injected token to gh via the GH_TOKEN env var
 *                (gh's documented non-interactive auth). The token is never
 *                logged.
 */

import type { ExecFn } from './git-ops.js';
import type { GitAuthMode } from './types.js';
import type { IssueContext } from './harness.js';

export interface OpenPrOptions {
  workdir: string;
  /** Head branch (the pushed branch). */
  branch: string;
  /** Base branch; falls back to gh's default when null/undefined. */
  base?: string | null;
  title: string;
  body: string;
  gitAuth?: GitAuthMode;
  /** Server-injected token (token mode only). Never logged. */
  gitToken?: string;
  exec: ExecFn;
  log?: (message: string, level?: 'info' | 'warn' | 'error' | 'debug') => void;
}

/** Build a PR body from the issue context: description, criteria, footer. */
export function buildPrBody(issue: IssueContext): string {
  const parts: string[] = [];
  const desc = issue.body?.trim() || issue.description?.trim();
  if (desc) parts.push(desc);

  if (issue.acceptanceCriteria) {
    const ac = Array.isArray(issue.acceptanceCriteria)
      ? issue.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
      : issue.acceptanceCriteria.trim();
    if (ac) parts.push(`## Acceptance criteria\n\n${ac}`);
  }

  parts.push(`Refs SF-${issue.issueId}`);
  parts.push('\n_Automated by the SprintFlint VPS runner._');
  return parts.join('\n\n');
}

/** Extract the first URL-looking token from gh's stdout. */
function extractPrUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/\S+/);
  return match ? match[0].trim() : null;
}

/**
 * Run `gh pr create`, returning the PR URL. When `base` is omitted, gh defaults
 * to the repo's default branch. Throws on non-zero exit.
 */
export async function openPullRequest(opts: OpenPrOptions): Promise<string> {
  const args = ['pr', 'create', '--head', opts.branch, '--title', opts.title, '--body', opts.body];
  if (opts.base) {
    args.push('--base', opts.base);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if ((opts.gitAuth ?? 'machine') === 'token') {
    if (!opts.gitToken) throw new Error('git_auth=token but no git token was provided in the job payload');
    env.GH_TOKEN = opts.gitToken;
    // Avoid gh picking up a conflicting interactive session.
    delete env.GITHUB_TOKEN;
  }

  opts.log?.(`Opening PR for ${opts.branch}${opts.base ? ` -> ${opts.base}` : ''}`);
  const res = await opts.exec('gh', args, { cwd: opts.workdir, env });
  if (res.exitCode !== 0) {
    throw new Error(`gh pr create failed (exit ${res.exitCode ?? 'signal'}): ${res.stderr.trim() || res.stdout.trim()}`);
  }

  const url = extractPrUrl(res.stdout) ?? extractPrUrl(res.stderr);
  if (!url) {
    throw new Error(`gh pr create succeeded but no PR URL was found in output: ${res.stdout.trim()}`);
  }
  opts.log?.(`Opened PR: ${url}`);
  return url;
}
