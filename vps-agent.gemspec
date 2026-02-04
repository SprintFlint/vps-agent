# frozen_string_literal: true

require_relative 'lib/vps_agent'

Gem::Specification.new do |spec|
  spec.name          = 'vps-agent'
  spec.version       = VPSAgent::VERSION
  spec.authors       = ['SprintFlint']
  spec.email         = ['support@sprintflint.com']

  spec.summary       = 'VPS Agent for SprintFlint Autoplay'
  spec.description   = 'CLI tool that connects your VPS to SprintFlint for automated job execution via WebSocket'
  spec.homepage      = 'https://github.com/sprintflint/vps-agent'
  spec.license       = 'MIT'

  spec.files         = Dir['lib/**/*', 'bin/*', 'README.md', 'LICENSE', 'CHANGELOG.md']
  spec.bindir        = 'bin'
  spec.executables   = ['vps-agent']
  spec.require_paths = ['lib']

  spec.required_ruby_version = '>= 3.0'

  # Metadata
  spec.metadata['homepage_uri'] = spec.homepage
  spec.metadata['source_code_uri'] = 'https://github.com/sprintflint/vps-agent'
  spec.metadata['changelog_uri'] = 'https://github.com/sprintflint/vps-agent/blob/main/CHANGELOG.md'
  spec.metadata['bug_tracker_uri'] = 'https://github.com/sprintflint/vps-agent/issues'
  spec.metadata['documentation_uri'] = 'https://docs.sprintflint.com/vps-agent'
  spec.metadata['rubygems_mfa_required'] = 'true'

  # Dependencies
  spec.add_dependency 'httparty', '~> 0.21'
  spec.add_dependency 'thor', '~> 1.3'
  spec.add_dependency 'websocket-client-simple', '~> 0.6'

  # Development dependencies
  spec.add_development_dependency 'rspec', '~> 3.12'
  spec.add_development_dependency 'rubocop', '~> 1.50'
end
