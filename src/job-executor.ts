/**
 * JobExecutor: the wiring that turns a claimed job into a pull request.
 *
 * Flow (per the Epic C WIRING spec):
 *   1. workspace.prepare  — clone repo into an isolated per-job dir, checkout
 *      the branch (SF-135),
 *   2. harness.run(workdir, issue) — run the configured harness (e.g. claude),
 *      streaming output to the job log (SF-137),
 *   3. if it changed anything: git commit + push (SF-138/140), then open a PR
 *      (SF-139/140), capturing pr_url,
 *   4. ALWAYS clean up the workspace, on success or failure (SF-141),
 *   5. return the result (incl. pr_url) to the caller.
 *
 * The Poller keeps ownership of finalize/updateJob; the executor only returns
 * the outcome so the poller reports it. A job timeout aborts the harness via an
 * AbortSignal and reports partial results (SF-141).
 */

import type { Harness, IssueContext, HarnessLogSink } from './harness.js';
import type { AgentConfig } from './config.js';
import type { ExecFn } from './git-ops.js';
import { defaultExec } from './exec.js';
import { commitAndPush } from './git-ops.js';
import { openPullRequest, buildPrBody } from './pr.js';
import { prepareWorkspace, cleanupWorkspace, jobsRoot } from './workspace.js';

/** Outcome the executor hands back to the poller. */
export interface ExecutionResult {
  success: boolean;
  summary: string;
  changed: boolean;
  pr_url?: string;
}

export interface JobExecutorOptions {
  harness: Harness;
  config: AgentConfig;
  jobId: number;
  /** Stream live progress to the job log. */
  log: HarnessLogSink;
  /** Injectable command runner for git/gh (tests). Defaults to child_process. */
  exec?: ExecFn;
  /** Hard wall-clock timeout for the whole job (ms). Defaults to 30 min. */
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;

export class JobExecutor {
  private readonly opts: Required<
    Omit<JobExecutorOptions, 'exec' | 'timeoutMs' | 'setTimer' | 'clearTimer'>
  > & {
    exec: ExecFn;
    timeoutMs: number;
    setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  };

  constructor(options: JobExecutorOptions) {
    this.opts = {
      harness: options.harness,
      config: options.config,
      jobId: options.jobId,
      log: options.log,
      exec: options.exec ?? defaultExec,
      timeoutMs: options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h)),
    };
  }

  /** Run the full pipeline for one issue. Never throws; reports via result. */
  async execute(issue: IssueContext): Promise<ExecutionResult> {
    const { config, log, exec } = this.opts;
    const cloneUrl = issue.cloneUrl ?? issue.repositoryUrl;
    const jobsDir = jobsRoot(config.config_dir);
    let jobDir: string | null = null;

    // Whole-job timeout: aborts the harness and short-circuits the rest.
    const controller = new AbortController();
    const timer = this.opts.setTimer(() => {
      log(`Job timeout (${this.opts.timeoutMs}ms) reached; aborting`, 'error');
      controller.abort();
    }, this.opts.timeoutMs);

    try {
      const ws = await prepareWorkspace({
        jobsDir,
        jobId: this.opts.jobId,
        cloneUrl,
        branch: issue.branchName,
        exec,
        log,
      });
      jobDir = ws.jobDir;

      const outcome = await this.opts.harness.run(ws.repoDir, issue, {
        log,
        signal: controller.signal,
      });

      if (!outcome.success) {
        return { success: false, summary: outcome.summary, changed: outcome.changed };
      }

      if (!outcome.changed) {
        return { success: true, summary: outcome.summary, changed: false };
      }

      const pushed = await commitAndPush({
        workdir: ws.repoDir,
        branch: issue.branchName,
        issueId: issue.issueId,
        issueTitle: issue.issueTitle,
        exec,
        log,
      });

      if (!pushed) {
        // Harness claimed changes but the tree was clean; nothing to PR.
        return { success: true, summary: `${outcome.summary} (no file changes detected)`, changed: false };
      }

      const prUrl = await openPullRequest({
        workdir: ws.repoDir,
        branch: issue.branchName,
        base: issue.defaultBranch ?? null,
        title: issue.issueTitle || `Resolve SF-${issue.issueId}`,
        body: buildPrBody(issue),
        exec,
        log,
      });

      return { success: true, summary: outcome.summary, changed: true, pr_url: prUrl };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Job execution failed: ${message}`, 'error');
      return { success: false, summary: message, changed: false };
    } finally {
      this.opts.clearTimer(timer);
      if (jobDir) cleanupWorkspace(jobDir, (m) => log(m, 'debug'));
    }
  }
}
