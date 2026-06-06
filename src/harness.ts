/**
 * SF-136 (C15): Harness interface, config-driven registry, and NoopHarness stub.
 *
 * A Harness executes a job inside a prepared working directory and reports
 * whether it succeeded and whether it changed anything. Downstream waves add
 * real implementations (e.g. ClaudeCodeHarness) and register them here.
 */

import type { HarnessName, JobPayload, PermissionMode } from './types.js';

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

  // --- Forward-compatible fields the server will add later ---
  body?: string;
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

/** Pluggable job executor. */
export interface Harness {
  run(workdir: string, issue: IssueContext): Promise<HarnessResult>;
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
    branchName: payload.branch_name,
    description: payload.description,
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
  return new HarnessRegistry().register('noop', () => new NoopHarness());
}
