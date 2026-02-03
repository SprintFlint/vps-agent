# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-02-03

### Added
- Initial release of VPS Agent CLI
- Registration with SprintFlint API (`vps-agent register`)
- WebSocket connection for real-time communication
- Job execution with log streaming
- Heartbeat every 30 seconds
- Automatic reconnection with exponential backoff
- Daemon mode support (`vps-agent start --daemon`)
- Graceful shutdown handling
- Configuration management (`vps-agent config`, `vps-agent status`)
- Log viewing (`vps-agent logs -f`)
- SSH key generation for secure job execution
- Comprehensive test suite (24 tests)
- CI/CD workflow with GitHub Actions
