# VPS Agent CLI

CLI tool that connects your VPS to SprintFlint for automated job execution.

## Features

- ✓ Registration with SprintFlint API
- ✓ WebSocket connection for real-time communication
- ✓ Job execution with log streaming
- ✓ Heartbeat every 30 seconds
- ✓ Automatic reconnection
- ✓ Daemon mode support
- ✓ Graceful shutdown
- ✓ Docker support
- ✓ One-line installer

## Installation

### One-Line Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/sprintflint/vps-agent/main/scripts/install.sh | bash
```

With options:
```bash
# Install specific version
curl -fsSL ... | bash -s -- -v v1.0.0

# Install with systemd service setup
sudo curl -fsSL ... | bash -s -- --service
```

### Ruby Gem

```bash
gem install vps-agent
```

### Docker

```bash
# Pull and run
docker run -d \
  --name vps-agent \
  -e SPRINTFLINT_TOKEN=your_token \
  -v vps-agent-data:/home/vps-agent/.vps-agent \
  sprintflint/vps-agent:latest start
```

### From Source

```bash
# Clone the repository
git clone https://github.com/sprintflint/vps-agent.git
cd vps-agent

# Install dependencies
bundle install

# Build and install
gem build vps-agent.gemspec
gem install vps-agent-*.gem
```

## Quick Start

```bash
# Register your VPS
vps-agent register --name "my-vps" --token YOUR_API_TOKEN

# Start the agent
vps-agent start

# Or run as daemon
vps-agent start --daemon

# Check status
vps-agent status

# View logs
vps-agent logs -f

# Stop the daemon
vps-agent stop
```

## Commands

| Command | Description |
|---------|-------------|
| `register` | Register this VPS with SprintFlint |
| `start` | Start the agent (connects to SprintFlint) |
| `stop` | Stop the running agent daemon |
| `status` | Check agent status |
| `logs` | Show agent logs |
| `config` | Show current configuration |
| `unregister` | Remove registration and local data |
| `version` | Show version information |

## Docker Usage

### Using Docker Compose

1. Create a `.env` file:
```bash
SPRINTFLINT_TOKEN=your_api_token_here
```

2. Start the agent:
```bash
docker-compose up -d
```

3. Register (first time only):
```bash
docker-compose exec vps-agent vps-agent register --name "docker-vps" --token $SPRINTFLINT_TOKEN
```

4. View logs:
```bash
docker-compose logs -f
```

5. Stop:
```bash
docker-compose down
```

### Docker Run Commands

```bash
# Register
docker run --rm -it \
  -v vps-agent-data:/home/vps-agent/.vps-agent \
  sprintflint/vps-agent:latest \
  register --name "my-vps" --token YOUR_TOKEN

# Start daemon
docker run -d \
  --name vps-agent \
  --restart unless-stopped \
  -v vps-agent-data:/home/vps-agent/.vps-agent \
  sprintflint/vps-agent:latest \
  start

# Check status
docker exec vps-agent vps-agent status

# View logs
docker logs -f vps-agent

# Stop
docker stop vps-agent
docker rm vps-agent
```

### Building Docker Image Locally

```bash
# Build
docker build -t vps-agent:local .

# Run
docker run --rm vps-agent:local version
```

## Configuration

Configuration is stored in `~/.vps-agent/config.json`:

```json
{
  "agent_id": "agent_abc123",
  "api_url": "https://api.sprintflint.com",
  "token": "your_api_token",
  "ws_url": "wss://api.sprintflint.com/ws"
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SPRINTFLINT_TOKEN` | API token for authentication | Required |
| `SPRINTFLINT_API_URL` | SprintFlint API URL | https://api.sprintflint.com |

## Systemd Service

If you used the `--service` flag during installation, or want to manually set up systemd:

```bash
# Start service
sudo systemctl start vps-agent

# Enable at boot
sudo systemctl enable vps-agent

# Check status
sudo systemctl status vps-agent

# View logs
sudo journalctl -u vps-agent -f
```

## Architecture

```
┌─────────────┐      HTTP      ┌─────────────────┐
│  vps-agent  │ ──────────────▶│  SprintFlint    │
│   register  │                │     API         │
└─────────────┘                └─────────────────┘
                                     │
                                     │ WebSocket
                                     ▼
                              ┌─────────────────┐
                              │   Agent Pool    │
                              │   (connected)   │
                              └─────────────────┘
                                     │
                              ┌──────┴──────┐
                              ▼             ▼
                         ┌────────┐    ┌────────┐
                         │ Job 1  │    │ Job 2  │
                         │ stdout │    │ stdout │
                         │ stderr │    │ stderr │
                         └────┬───┘    └────┬───┘
                              │             │
                              └──────┬──────┘
                                     ▼
                              Stream logs back
                              to SprintFlint
```

## Development

```bash
# Setup
bundle install

# Run tests
bundle exec rspec

# Run linter
bundle exec rubocop

# Fix linting
bundle exec rubocop -A

# Run in dev mode
bundle exec ruby -I lib bin/vps-agent version

# Interactive console
bundle exec ruby -I lib -r vps_agent -r irb -e "IRB.start"
```

### Makefile Targets

```bash
make help          # Show all targets
make install       # Install dependencies
make test          # Run tests
make lint          # Run linter
make build         # Build gem
make release       # Create a release (VERSION=x.y.z)
make docker-build  # Build Docker image
make docker-run    # Run in Docker
```

## Releases

This project uses GitHub Actions to automatically build and release:

- **Ruby Gem**: Published to RubyGems
- **Binary Packages**: Built for Linux (x86_64, ARM64, ARM) and macOS (x86_64, ARM64)
- **Docker Images**: Published to Docker Hub
- **Install Script**: One-line installer available

To create a release:

```bash
# Method 1: Using make
make release VERSION=0.2.0
make push-release VERSION=0.2.0

# Method 2: Manual
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

## Troubleshooting

### Agent won't start
- Check if registered: `vps-agent status`
- Verify token: `vps-agent config`
- Check logs: `vps-agent logs -n 100`

### Connection issues
- Verify network connectivity to api.sprintflint.com
- Check firewall rules for WebSocket (port 443)
- Try restarting: `vps-agent stop && vps-agent start`

### Permission denied
- Ensure `~/.vps-agent` directory is writable
- Run with appropriate user permissions
- For systemd, check service user

## License

MIT

## Support

- Documentation: https://docs.sprintflint.com
- Issues: https://github.com/sprintflint/vps-agent/issues
- Email: support@sprintflint.com
