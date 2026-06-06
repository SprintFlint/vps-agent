# vps-agent

VPS Agent CLI for SprintFlint Autoplay; connects your VPS to SprintFlint for automated job execution.

This is the Node/TypeScript implementation. It talks to the real SprintFlint
server API (`X-Runner-Token` auth against `https://sprintflint.com`, or
`http://localhost:3000` in development).

## Install (dev)

```bash
npm install
npm run build
node dist/cli.js --help
```

## CLI

```
vps-agent register      Register this VPS with SprintFlint (stub)
vps-agent start         Start heartbeat + job poll loop (stub)
vps-agent stop          Stop the running agent (stub)
vps-agent status        Show agent status (stub)
vps-agent logs [-f]     Show / follow the agent log
vps-agent unregister    Unregister this VPS (stub)
vps-agent config        View or set local configuration
vps-agent version       Show version
```

The `register`, `start`, `stop`, `status`, `unregister` commands are wired as
stubs in this foundation and implemented in later waves.

## Configuration

Resolved with precedence (highest first): env var > `.env` > `~/.vps-agent/config.json` > defaults.
See [.env.example](./.env.example). Keys: `api_url`, `token`, `log_level`,
`harness`, `permission_mode`, `config_dir`.

## Scripts

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup -> dist/
```
