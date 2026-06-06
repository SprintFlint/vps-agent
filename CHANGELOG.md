# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  `git_auth`, `heartbeat_interval`, `poll_interval`, `log_level`,
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
  live log streaming, commit + push, and `gh pr create` (never merges).
- **Pluggable git auth** (`machine` / `token`): per-job token threaded into the
  push remote and `gh` via `GH_TOKEN`, never persisted.
- **Pre-flight / `doctor`** checks for `git`, `gh`, and (when used) `claude`.
- **Daemon** support via pidfile with stale-pid detection.
- **Structured leveled logger** with rotation, plus `logs`/`logs -f` tailing.

### Security

- The config/token file is written owner-only (`0600`) inside an owner-only
  directory (`0700`); permissions are re-tightened on every write.
- Secrets (runner token, per-job git token, provider keys) are redacted from
  both the local agent log and the server-streamed job log; tokenized git
  remotes are redacted before logging.
- The agent never executes a server-supplied command string: it only invokes
  `git`, `gh`, and `claude` with fixed, controlled argument arrays (no shell).

[Unreleased]: https://github.com/sprintflint/vps-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sprintflint/vps-agent/releases/tag/v0.1.0
