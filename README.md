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

Set a key:

```bash
vps-agent config set harness claude
vps-agent config set permission_mode acceptEdits
```

### Permission modes (`claude` harness)

- `default` / `acceptEdits` — let Claude edit files; you review via the PR.
- `plan` — plan only.
- `bypassPermissions` — full autonomy (explicit opt-in).

### Git authentication

The agent always uses **this machine's ambient git + `gh` credentials**. Run
`gh auth login` before starting the agent; the `gh` CLI then handles clone,
push, and PR creation. The agent neither handles nor injects any GitHub token,
so there is no token-handling surface to secure.

## Job flow

When the agent is running, for each claimed job it:

1. **Heartbeats** status (`online`, or `busy` while a job runs) with system
   stats, on an interval.
2. **Polls** `next_job`. On a job, it flips to `busy` (single-job concurrency:
   it will not claim another job until this one finishes).
3. Marks the job `running` and prepares an **isolated workspace**: clones the
   repo into `~/.vps-agent/jobs/<job_id>/repo` and checks out the job's branch.
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

## Logs and state

Everything lives under `config_dir` (default `~/.vps-agent`):

- `config.json` — persisted config (token redacted in `config show`).
- `agent.log` (rotated) — structured agent log; view with `vps-agent logs`.
- `daemon.out.log` — captured stdout/stderr of a `--daemon` start.
- `agent.pid` — pidfile for `start --daemon` / `stop`.
- `jobs/<job_id>/` — per-job workspaces (auto-removed after each job).

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
