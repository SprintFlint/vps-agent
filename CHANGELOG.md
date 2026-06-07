# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Never push to a `null` branch.** When the server's `branch_name` arrives
  empty or as the literal string `"null"`/`"undefined"` (a runner can claim a
  job within its poll interval before the server's async branch-name job has
  populated it), the agent now derives a deterministic `autoplay/<issue-ref>`
  branch instead of pushing to a bogus one.
- **Use the human issue reference, not the database id.** Commit messages, the
  PR title, the PR body, and the prompt handed to the harness now use the issue
  reference from the job payload (e.g. `SF121`) instead of the numeric database
  id, falling back to `#<id>` when the server omits the reference.

### Changed

- **Git authentication is now ambient-only.** The agent always uses this
  machine's git + `gh` CLI credentials (run `gh auth login` before starting).
  Removed the `git_auth` config key / `VPS_AGENT_GIT_AUTH` env var, the
  `token` auth mode, the per-job `git_token` payload field, and all
  `GH_TOKEN`/tokenized-remote handling. The agent no longer receives, stores,
  or injects any GitHub token, removing that token-handling surface entirely.

### Security

- `doctor` / pre-flight now **unconditionally** require an authenticated `gh`
  session; the old token-mode relaxation that skipped the `gh auth` check is
  gone.

## [0.1.0] - 2026-06-06

Initial release of the Node/TypeScript VPS agent.

### Added

- **CLI** (`vps-agent`) with commands: `register`, `start` (`--daemon`),
  `stop`, `status`, `logs` (`-f`/`-n`), `unregister`, `config` (`show`/`set`),
  `doctor`, and `version`.
- **Registration** in two modes: organization id + name
  (`--org-id` + `--name`, calls the server) and a pre-issued runner token
  (`--token`, local-only).
- **Layered configuration** (defaults < `config.json` < `.env` < env vars <
  CLI flags) with keys `api_url`, `token`, `harness`, `permission_mode`,
  `heartbeat_interval`, `poll_interval`, `log_level`,
  `max_log_batch_size`, `runner_id`, and `config_dir`.
- **Runtime loop**: concurrent heartbeat loop (with system stats) and job poll
  loop with single-job concurrency, exponential backoff, and graceful shutdown.
- **Typed API client** for the SprintFlint runner contract
  (`register`, `heartbeat`, `next_job`, `update_job`, `append_log`) with
  retries, timeouts, and `X-Runner-Token` auth.
- **Harnesses**: a config-driven registry with a `noop` harness (loop proof)
  and a `claude` harness (`ClaudeCodeHarness`) that runs Claude Code headless
  with a hard timeout and cancel support.
- **Job pipeline**: isolated per-job workspace clone/checkout, harness run with
  live log streaming, commit + push, and `gh pr create` (never merges). Git and
  `gh` use the host's ambient credentials.
- **Pre-flight / `doctor`** checks for `git`, `gh`, and (when used) `claude`.
- **Daemon** support via pidfile with stale-pid detection.
- **Structured leveled logger** with rotation, plus `logs`/`logs -f` tailing.

### Security

- The config/token file is written owner-only (`0600`) inside an owner-only
  directory (`0700`); permissions are re-tightened on every write.
- Secrets (runner token, provider keys) are redacted from both the local agent
  log and the server-streamed job log.
- The agent never executes a server-supplied command string: it only invokes
  `git`, `gh`, and `claude` with fixed, controlled argument arrays (no shell).

[Unreleased]: https://github.com/sprintflint/vps-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sprintflint/vps-agent/releases/tag/v0.1.0
