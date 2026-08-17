/**
 * SF-136 (C15): Harness interface, config-driven registry, and NoopHarness stub.
 *
 * A Harness executes a job inside a prepared working directory and reports
 * whether it succeeded and whether it changed anything. Downstream waves add
 * real implementations (e.g. ClaudeCodeHarness) and register them here.
 */

import type { HarnessName, JobPayload, PermissionMode } from './types.js';
import { ClaudeCodeHarness } from './claude-harness.js';
import { PrimeAgentHarness } from './prime-agent-harness.js';

/**
 * Normalized job context handed to a harness.
 *
 * Mirrors the next_job payload today. Marked extensible: the server will later
 * add body, comments, default_branch, clone_url, tags; those land here as
 * optional fields without breaking existing harnesses.
 */
export interface IssueContext {
  issueId: number;
  issueTitle: string;
  repositoryUrl: string;
  branchName: string;
  description: string | null;

  /** Human issue reference (e.g. "SF121") for commit/PR messages. */
  issueReference?: string;

  // --- Forward-compatible fields the server will add later ---
  body?: string;
  acceptanceCriteria?: string | string[];
  comments?: Array<{ author?: string; body: string; created_at?: string }>;
  defaultBranch?: string;
  cloneUrl?: string;
  tags?: string[];

  /** Permission mode for this run, resolved from config. */
  permissionMode?: PermissionMode;
}

/** Outcome of a harness run. */
export interface HarnessResult {
  success: boolean;
  summary: string;
  changed: boolean;
}

/**
 * Sink a harness uses to stream live output (stdout/stderr/progress) to the job
 * log. Optional: harnesses that produce no streaming output may ignore it.
 */
export type HarnessLogSink = (
  message: string,
  level?: 'info' | 'warn' | 'error' | 'debug',
) => void;

/** Options passed alongside a harness run (additive; all optional). */
export interface HarnessRunOptions {
  /** Stream live output here (forwarded to the job's LogStreamer). */
  log?: HarnessLogSink;
  /** Abort signal: fires on job timeout or cancel so the harness can kill work. */
  signal?: AbortSignal;
}

/** Pluggable job executor. */
export interface Harness {
  run(workdir: string, issue: IssueContext, options?: HarnessRunOptions): Promise<HarnessResult>;
}

/**
 * Resolve a safe branch name from the payload. The server normally sends a
 * generated name, but a runner can claim a job within its poll interval before
 * the async branch-name job has populated it — in which case `branch_name`
 * arrives empty or as the literal string "null". Never push to such a branch;
 * fall back to a deterministic name derived from the issue reference or id.
 */
export function resolveBranchName(payload: JobPayload): string {
  const raw = String(payload.branch_name ?? '').trim();
  const lowered = raw.toLowerCase();
  if (raw && lowered !== 'null' && lowered !== 'undefined') return raw;

  const ref = String(payload.issue_reference ?? '').trim();
  const slug = ref
    ? ref.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : '';
  return `autoplay/${slug || `issue-${payload.issue_id}`}`;
}

/** Build an IssueContext from a raw next_job payload. */
export function issueContextFromPayload(
  payload: JobPayload,
  permissionMode?: PermissionMode,
): IssueContext {
  return {
    issueId: payload.issue_id,
    issueTitle: payload.issue_title,
    repositoryUrl: payload.repository_url,
    branchName: resolveBranchName(payload),
    description: payload.description,
    ...(payload.issue_reference !== undefined
      ? { issueReference: payload.issue_reference }
      : {}),
    ...(payload.body !== undefined ? { body: payload.body } : {}),
    ...(payload.acceptance_criteria !== undefined
      ? { acceptanceCriteria: payload.acceptance_criteria }
      : {}),
    ...(payload.comments !== undefined ? { comments: payload.comments } : {}),
    ...(payload.default_branch !== undefined ? { defaultBranch: payload.default_branch } : {}),
    ...(payload.clone_url !== undefined ? { cloneUrl: payload.clone_url } : {}),
    ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };
}

/** A factory that constructs a harness instance. */
export type HarnessFactory = () => Harness;

/**
 * Registry mapping harness names to factories. Config-driven selection happens
 * via {@link HarnessRegistry.resolve}, keyed off `config.harness`.
 */
export class HarnessRegistry {
  private readonly factories = new Map<string, HarnessFactory>();

  register(name: HarnessName, factory: HarnessFactory): this {
    this.factories.set(name, factory);
    return this;
  }

  has(name: HarnessName): boolean {
    return this.factories.has(name);
  }

  names(): string[] {
    return [...this.factories.keys()];
  }

  /** Resolve and instantiate a harness by name, throwing if unknown. */
  resolve(name: HarnessName): Harness {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(
        `Unknown harness "${name}". Registered: ${this.names().join(', ') || '(none)'}`,
      );
    }
    return factory();
  }
}

/**
 * No-op harness: validates the wiring end-to-end without touching the repo.
 * Always succeeds, never reports changes.
 */
export class NoopHarness implements Harness {
  async run(_workdir: string, issue: IssueContext): Promise<HarnessResult> {
    return {
      success: true,
      summary: `NoopHarness: received issue #${issue.issueId} "${issue.issueTitle}" (no action taken)`,
      changed: false,
    };
  }
}

/** A registry pre-populated with the built-in harnesses. */
export function defaultHarnessRegistry(): HarnessRegistry {
  return new HarnessRegistry()
    .register('noop', () => new NoopHarness())
    .register('claude', () => new ClaudeCodeHarness())
    .register('prime-agent', () => new PrimeAgentHarness());
}
