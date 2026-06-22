# vps-agent

The SprintFlint VPS agent. Install it on a VPS (or any Linux/macOS host) to turn
that machine into a SprintFlint **runner**: it registers with SprintFlint,
heartbeats its health, claims Autoplay jobs, runs them with a code harness
(Claude Code), opens a pull request with the result, and streams logs back to
your SprintFlint dashboard in real time.

It is a Node/TypeScript CLI that talks to the SprintFlint server API over HTTPS
(`X-Runner-Token` auth). It never opens inbound ports; the agent only makes
outbound requests.

## Requirements

- **Node.js >= 18** and npm.
- **git** (>= 2.20).
- **GitHub CLI (`gh`)**, authenticated with `gh auth login` **before** starting
  the agent. The agent clones, pushes, and opens PRs using this machine's
  ambient git + `gh` credentials; it never handles GitHub tokens itself.
- **Claude Code (`claude`)**, authenticated once, when running the `claude`
  harness.

Run `vps-agent doctor` at any time to verify these.

## Install

```bash
npm install -g vps-agent
```

Or run it without installing:

```bash
npx vps-agent --help
```

Or use the installer script (checks Node, installs globally, prints next steps):

```bash
curl -fsSL https://raw.githubusercontent.com/sprintflint/vps-agent/main/scripts/install.sh | bash
```

## Quick start

```bash
# 1. Register this host with your organization (calls the server, saves a token)
vps-agent register --org-id <your-org-id> --name "$(hostname)"

# 2. Verify prerequisites
vps-agent doctor

# 3. Start in the background
vps-agent start --daemon

# 4. Observe
vps-agent status
vps-agent logs -f
```

## Commands

| Command                    | What it does                                                                |
| -------------------------- | --------------------------------------------------------------------------- |
| `register`                 | Register this host as a runner (two modes; see below).                      |
| `start [--daemon]`         | Run the heartbeat + job-poll loop. `--daemon` detaches into the background. |
| `stop`                     | Signal the running (daemonized) agent to stop.                              |
| `status`                   | Print config + whether the agent is running (JSON).                         |
| `logs [-f] [-n <count>]`   | Show the last `-n` log lines (default 200); `-f` follows.                   |
| `unregister`               | Clear the local token + runner id (local-only; see note).                   |
| `config show`              | Print the effective config (token redacted).                                |
| `config set <key> <value>` | Persist a single config key.                                                |
| `project show`             | Print per-project working-tree source config.                               |
| `project set <repo> <key> <value>` | Set a per-project source key (see Working-tree source).            |
| `project remove <repo>`    | Remove a per-project source config entry.                                   |
| `doctor`                   | Check that git/gh/claude are installed, authenticated, and compatible.      |
| `version`                  | Print the version and runtime info.                                         |

### `register` — two modes

**Organization id + name** (calls the server, which returns the runner token):

```bash
vps-agent register --org-id org_123 --name "build-box-1"
```

**Pre-issued token** (created in the SprintFlint web UI; no server call, just
saves it locally):

```bash
vps-agent register --token <runner-token>
```

Both modes accept `--api-url <url>` to override the server base URL (defaults to
`https://sprintflint.com`; use `http://localhost:3000` for local development).

### `unregister`

This is **local-only**: it clears the token and runner id from `config.json` and
stops a running agent, but the SprintFlint server has no unregister endpoint.
To fully revoke a runner, remove it in your SprintFlint dashboard.

## Configuration

Configuration is resolved with this precedence (highest wins):

```
CLI flags  >  environment variables  >  .env file  >  ~/.vps-agent/config.json  >  defaults
```

The token and runner id are saved to `~/.vps-agent/config.json` by `register`.
That file holds a secret, so it is written **owner-only (`0600`)** inside an
owner-only (`0700`) directory.

| Key                  | Env var                        | Default                   | Meaning                                              |
| -------------------- | ------------------------------ | ------------------------- | ---------------------------------------------------- |
| `api_url`            | `VPS_AGENT_API_URL`            | `https://sprintflint.com` | SprintFlint server base URL.                         |
| `token`              | `VPS_AGENT_TOKEN`              | _(none)_                  | Runner token, sent as `X-Runner-Token`.              |
| `harness`            | `VPS_AGENT_HARNESS`            | `noop`                    | Job harness: `noop` or `claude`.                     |
| `permission_mode`    | `VPS_AGENT_PERMISSION_MODE`    | `default`                 | Permission mode for the harness (see below).         |
| `heartbeat_interval` | `VPS_AGENT_HEARTBEAT_INTERVAL` | `30`                      | Seconds between heartbeats (server may shorten).     |
| `poll_interval`      | `VPS_AGENT_POLL_INTERVAL`      | `5`                       | Seconds between idle `next_job` polls.               |
| `max_log_batch_size` | `VPS_AGENT_MAX_LOG_BATCH_SIZE` | `100`                     | Max log lines per `append_log` call.                 |
| `log_level`          | `VPS_AGENT_LOG_LEVEL`          | `info`                    | `error` \| `warn` \| `info` \| `debug`.              |
| `runner_id`          | `VPS_AGENT_RUNNER_ID`          | _(set by register)_       | This runner's numeric id.                            |
| `config_dir`         | `VPS_AGENT_CONFIG_DIR`         | `~/.vps-agent`            | Directory for config, logs, pidfile, job workspaces. |
| `source_mode`        | `VPS_AGENT_SOURCE_MODE`        | `clone`                   | How the working tree is sourced (see below).         |
| `local_path`         | `VPS_AGENT_LOCAL_PATH`         | _(none)_                  | Existing checkout to run in (`local_path` mode).     |
| `base_repo_path`     | `VPS_AGENT_BASE_REPO_PATH`     | _(none)_                  | Base repo to add worktrees from (`worktree` mode).   |
| `worktrees_dir`      | `VPS_AGENT_WORKTREES_DIR`      | `<config_dir>/worktrees`  | Where per-job worktrees are created (`worktree`).    |

Set a key:

```bash
vps-agent config set harness claude
vps-agent config set permission_mode acceptEdits
```

(`projects` — per-project overrides — is set with `vps-agent project set`; see
[Working-tree source](#working-tree-source-modes).)

### Permission modes (`claude` harness)

- `default` / `acceptEdits` — let Claude edit files; you review via the PR.
- `plan` — plan only.
- `bypassPermissions` — full autonomy (explicit opt-in).

### Git authentication

The agent always uses **this machine's ambient git + `gh` credentials**. Run
`gh auth login` before starting the agent; the `gh` CLI then handles clone,
push, and PR creation. The agent neither handles nor injects any GitHub token,
so there is no token-handling surface to secure.

## Working-tree source modes

By default the agent **clones the repo from scratch** into a fresh per-job
directory. That is slow, and — crucially — a fresh clone has none of the local
ENV / credentials / config your app needs to boot or test (e.g. a Rails app's
`config/master.key`, a `.env`, service account files). Those live in *your*
checkout and must stay there.

`source_mode` lets you choose, per project, how the runner sources the working
tree. **The runner never copies, syncs, logs, or transmits your secrets / ENV
files** — it only runs inside the path you point it at.

| Mode         | What it does                                                                                          | Use when                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `clone`      | Clones the repo into `~/.vps-agent/jobs/<job_id>/repo`; removes it after the job. (Original behaviour.) | Public/stateless repos that need nothing local to build or test.         |
| `local_path` | Runs **inside an existing checkout** you already maintain, so the harness inherits its local secrets. | Apps that need `master.key` / `.env` / local config to boot or run tests. |
| `worktree`   | `git worktree add`s a throwaway tree from a base repo, isolated but sharing the object store.          | You want isolation per job without re-cloning, and tracked files suffice. |

> Untracked, git-ignored secrets (e.g. `config/master.key`) are **not** present
> in a fresh `clone` or in a new `worktree`. If your app needs them, use
> `local_path`, which runs in the checkout that already holds them.

### `local_path` mode

The runner `cd`s into the configured checkout, **stashes any uncommitted work**
(tracked + untracked) so it starts clean, checks out the job's branch (creating
it if needed), runs the harness, commits + pushes, and then **restores your
original branch and pops the stash**. It never deletes your checkout, and
git-ignored files (your secrets) are left untouched throughout.

```bash
vps-agent config set source_mode local_path
vps-agent config set local_path /Users/you/code/your-app
```

### `worktree` mode

The runner runs `git worktree add <worktrees_dir>/<job_id> <branch>` from your
base repo, runs the harness there, and cleans up with `git worktree remove` when
the job completes or is cancelled.

```bash
vps-agent config set source_mode worktree
vps-agent config set base_repo_path /Users/you/code/your-app
# optional; defaults to <config_dir>/worktrees
vps-agent config set worktrees_dir /Users/you/.vps-agent/worktrees
```

### Per-project overrides

A single runner can serve several repos. Override the source config per project
with `vps-agent project set <repo> <key> <value>`, where `<repo>` is a repo URL
or `owner/repo` (normalized to a stable key, so https/ssh forms match):

```bash
vps-agent project set acme/web        source_mode local_path
vps-agent project set acme/web        local_path  /Users/you/code/web
vps-agent project set acme/worker     source_mode worktree
vps-agent project set acme/worker     base_repo_path /Users/you/code/worker
vps-agent project show
```

A per-project `source_mode` always wins. As a convenience, if you set a
`local_path` (or `base_repo_path`) but leave `source_mode` at the `clone`
default, the runner infers `local_path` (or `worktree`) instead of cloning — set
`source_mode clone` for that project to force a clone anyway.

Each job's log states the resolved mode and the working directory it used.

## Job flow

When the agent is running, for each claimed job it:

1. **Heartbeats** status (`online`, or `busy` while a job runs) with system
   stats, on an interval.
2. **Polls** `next_job`. On a job, it flips to `busy` (single-job concurrency:
   it will not claim another job until this one finishes).
3. Marks the job `running` and prepares the working tree per the configured
   [`source_mode`](#working-tree-source-modes) — clone (default), an existing
   `local_path`, or a `git worktree` — and checks out the job's branch. The log
   records which mode and working directory were used.
4. Runs the configured **harness** (e.g. Claude Code, headless) in that repo,
   **streaming** its stdout/stderr to the job log (`append_log`) as it goes.
5. If the harness changed files: **commits**, **pushes** the branch, and opens a
   **pull request** with `gh pr create` (it never merges).
6. **Finalizes** the job with `update_job` (`completed` or `failed`, with a
   result summary and PR URL), flushing remaining logs first.
7. **Cleans up** the workspace (on success or failure).

Network/API hiccups never tear the agent down: the heartbeat and poll loops log
the error and back off exponentially, then resume.

## Security model

- **No arbitrary remote command execution.** The agent only ever invokes the
  fixed binaries `git`, `gh`, and `claude`, each with a controlled array of
  arguments and **no shell**. It does not execute any command string supplied by
  the server. Job payload fields (branch names, repo URLs, prompts) are passed
  as discrete arguments, never interpolated into a shell.
- **Secret redaction.** Tokens (the runner token and provider keys such as
  `ghp_…` / `sk-ant-…`) are scrubbed from both the local agent log and the
  server-streamed job log.
- **Least-privilege files.** The config/token file is `0600` inside a `0700`
  directory; permissions are re-tightened on every write.
- **No GitHub tokens in the agent.** Git/`gh` operations use the host's ambient
  credentials only; the agent never receives, stores, or injects a GitHub token.
- **Your secrets stay yours.** In `local_path` / `worktree` modes the agent runs
  inside a path you configure but never reads, copies, syncs, logs, or transmits
  your ENV / credential files (e.g. `config/master.key`, `.env`). In `local_path`
  mode it stashes and restores your uncommitted work and never deletes the
  checkout; git-ignored files are left untouched.

## Logs and state

Everything lives under `config_dir` (default `~/.vps-agent`):

- `config.json` — persisted config (token redacted in `config show`).
- `agent.log` (rotated) — structured agent log; view with `vps-agent logs`.
- `daemon.out.log` — captured stdout/stderr of a `--daemon` start.
- `agent.pid` — pidfile for `start --daemon` / `stop`.
- `jobs/<job_id>/` — per-job clone workspaces (auto-removed after each job).
- `worktrees/<job_id>/` — per-job worktrees in `worktree` mode (auto-removed
  with `git worktree remove`). `local_path` mode uses your own checkout and
  writes nothing here.

## Troubleshooting

- **`No runner token configured`** — run `vps-agent register` first.
- **`doctor` fails on `gh`** — run `gh auth login` so the host has an
  authenticated `gh` session.
- **`doctor` fails on `claude`** — install Claude Code and run `claude` once to
  authenticate; only required when `harness=claude`.
- **`Agent already running`** — a live pidfile exists. Use `vps-agent stop`, or
  pass a different `--pidfile`.
- **Nothing happens after `start`** — check `vps-agent logs -f`; confirm
  `api_url` and the token are correct via `vps-agent config show`.
- **Private repo clone fails** — ensure the host's git/`gh` credentials can
  reach it (run `gh auth login` and confirm with `gh auth status`).

## Development

```bash
npm install
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup -> dist/
```

The library surface is exported from `src/index.ts` for embedding/testing. The
CLI entrypoint is `src/cli.ts`.

## License

MIT. See [LICENSE](./LICENSE).
