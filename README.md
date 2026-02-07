# VPS Agent

[![Gem Version](https://badge.fury.io/rb/vps-agent.svg)](https://badge.fury.io/rb/vps-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A CLI tool that connects your VPS (Virtual Private Server) to SprintFlint for automated job execution via WebSocket.

## Overview

VPS Agent runs on your server and:
- Registers your VPS with SprintFlint
- Maintains a persistent WebSocket connection
- Receives and executes AI-powered development jobs
- Streams logs back in real-time
- Reports status and health metrics

## Installation

### From RubyGems

```bash
gem install vps-agent
```

### From Source

```bash
git clone https://github.com/neoflintai/vps-agent.git
cd vps-agent
bundle install
bundle exec rake install
```

## Quick Start

### 1. Get a SprintFlint API Token

1. Log into your SprintFlint account
2. Go to Settings → API Tokens
3. Generate a new token with "Runner" permissions

### 2. Register Your VPS

```bash
export SPRINTFLINT_TOKEN="your_api_token_here"
vps-agent register --name "my-production-vps" --token $SPRINTFLINT_TOKEN
```

This will:
- Create a runner record in SprintFlint
- Generate SSH keys for secure communication
- Save configuration to `~/.vps-agent/config.json`

### 3. Start the Agent

```bash
vps-agent start
```

The agent will:
- Connect to SprintFlint via WebSocket
- Listen for job assignments
- Execute jobs when assigned
- Stream logs back in real-time

### 4. Run as a Service (Production)

Create a systemd service file at `/etc/systemd/system/vps-agent.service`:

```ini
[Unit]
Description=SprintFlint VPS Agent
After=network.target

[Service]
Type=simple
User=deploy
ExecStart=/usr/local/bin/vps-agent start
Restart=always
RestartSec=10
Environment="SPRINTFLINT_TOKEN=your_token"

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable vps-agent
sudo systemctl start vps-agent
```

## Commands

### `vps-agent register`

Register this VPS with SprintFlint.

```bash
vps-agent register \
  --name "production-web-01" \
  --api-url "https://api.sprintflint.com" \
  --token $SPRINTFLINT_TOKEN
```

Options:
- `--name` (required): Human-readable name for this runner
- `--api-url`: SprintFlint API URL (default: https://api.sprintflint.com)
- `--token`: API token (or set SPRINTFLINT_TOKEN env var)

### `vps-agent start`

Start the agent and connect to SprintFlint.

```bash
vps-agent start
```

Options:
- `--daemon`: Run as a background daemon
- `--pidfile`: Path to PID file (default: /tmp/vps-agent.pid)

### `vps-agent stop`

Stop the running daemon.

```bash
vps-agent stop
```

### `vps-agent status`

Check agent status and configuration.

```bash
vps-agent status
```

### `vps-agent logs`

View agent logs.

```bash
vps-agent logs          # Show last 50 lines
vps-agent logs -f       # Follow log output
vps-agent logs -n 100   # Show last 100 lines
```

### `vps-agent unregister`

Remove this agent from SprintFlint and delete local data.

```bash
vps-agent unregister
```

### `vps-agent config`

Show current configuration.

```bash
vps-agent config
```

## Configuration

Configuration is stored in `~/.vps-agent/config.json`:

```json
{
  "agent_id": 123,
  "api_url": "https://api.sprintflint.com",
  "token": "your_auth_token",
  "ws_url": "wss://api.sprintflint.com/ws"
}
```

## Environment Variables

- `SPRINTFLINT_TOKEN`: API token for authentication
- `VPS_AGENT_LOG_LEVEL`: Log level (debug, info, warn, error)
- `VPS_AGENT_CONFIG_DIR`: Configuration directory (default: ~/.vps-agent)

## How It Works

### Architecture

```
┌─────────────┐      WebSocket       ┌─────────────────┐
│  VPS Agent  │ ◄──────────────────► │   SprintFlint   │
│   (Your     │                      │    (Server)     │
│    Server)  │                      └─────────────────┘
└──────┬──────┘                               │
       │                                      │
       │ HTTP API                             │ Job Assignment
       │                                      ▼
       └───────────────────────────────► ┌──────────┐
                                         │  Runner  │
                                         │  Queue   │
                                         └──────────┘
```

### Job Execution Flow

1. **Registration**: Agent registers with SprintFlint and gets a unique ID
2. **WebSocket Connect**: Opens persistent connection for real-time communication
3. **Heartbeat**: Sends heartbeat every 30 seconds to maintain connection
4. **Job Assignment**: Server assigns jobs via WebSocket message
5. **Execution**: Agent executes the job (typically runs autoplay)
6. **Streaming**: Logs are streamed back in real-time
7. **Completion**: Job result is sent back to server

### Security

- All communication uses TLS encryption
- Runner authentication via unique token
- SSH key generation for secure git operations
- No sensitive data stored in logs

## Troubleshooting

### Connection Issues

```bash
# Check if agent can reach SprintFlint
curl https://api.sprintflint.com/health

# Check WebSocket connection
vps-agent status
```

### Registration Fails

- Verify your API token is valid
- Check that your account has runner permissions
- Ensure the organization_id is correct

### Jobs Not Being Assigned

- Check agent status: `vps-agent status`
- Verify agent is online in SprintFlint dashboard
- Check logs: `vps-agent logs -f`
- Ensure runner is not marked as "busy"

### Daemon Won't Start

```bash
# Check for existing process
ps aux | grep vps-agent

# Kill stale process
vps-agent stop

# Or manually
sudo pkill -f vps-agent

# Start fresh
vps-agent start --daemon
```

## Development

### Setup

```bash
git clone https://github.com/neoflintai/vps-agent.git
cd vps-agent
bundle install
```

### Running Tests

```bash
bundle exec rspec
```

### Building Gem

```bash
gem build vps-agent.gemspec
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -am 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- Documentation: https://docs.sprintflint.com/vps-agent
- Issues: https://github.com/neoflintai/vps-agent/issues
- Email: support@sprintflint.com

## Related Projects

- [SprintFlint](https://sprintflint.com) - AI-powered sprint management
- [SprintFlint Rails](https://github.com/ancez/sprintflint-rails) - Main application
