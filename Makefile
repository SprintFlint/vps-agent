.DEFAULT_GOAL := help

# Version management
VERSION ?= $(shell ruby -r ./lib/vps_agent -e "puts VPSAgent::VERSION")
TAG = v$(VERSION)

.PHONY: help install test lint build clean release docker

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# Development targets
install: ## Install dependencies
	bundle install

test: ## Run all tests
	bundle exec rspec

lint: ## Run linter
	bundle exec rubocop

lint-fix: ## Fix linting issues automatically
	bundle exec rubocop -A

console: ## Start interactive console with VPSAgent loaded
	bundle exec ruby -I lib -r vps_agent -e "puts 'VPSAgent loaded. Try: VPSAgent::VERSION'" -r irb -e "IRB.start"

dev: ## Run CLI in development mode (pass args with ARGS="...")
	bundle exec ruby -I lib bin/vps-agent $(ARGS)

# Build targets
build: ## Build the gem
	gem build vps-agent.gemspec

install-local: build ## Install gem locally
	gem install vps-agent-*.gem

clean: ## Clean build artifacts
	rm -f vps-agent-*.gem
	rm -rf vendor/cache
	rm -rf dist/
	rm -f install.sh

# Release targets
release: test lint ## Create a new release (VERSION=x.y.z)
	@if [ -z "$(VERSION)" ]; then \
		echo "Error: VERSION is required. Usage: make release VERSION=0.2.0"; \
		exit 1; \
	fi
	@echo "Creating release $(TAG)..."
	# Update version in lib/vps_agent.rb
	sed -i.bak "s/VERSION = \"[^\"]*\"/VERSION = \"$(VERSION)\"/" lib/vps_agent.rb
	rm -f lib/vps_agent.rb.bak
	# Commit version bump
	git add lib/vps_agent.rb
	git commit -m "Bump version to $(VERSION)"
	# Create git tag
	git tag -a $(TAG) -m "Release $(TAG)"
	@echo "Release $(TAG) created. Run 'make push-release' to push to remote."

push-release: ## Push the current release to GitHub
	@if [ -z "$(VERSION)" ]; then \
		echo "Error: VERSION is required. Usage: make push-release VERSION=0.2.0"; \
		exit 1; \
	fi
	git push origin main
	git push origin $(TAG)
	@echo "Release $(TAG) pushed. GitHub Actions will build and publish."

release-local: test lint build ## Build all release artifacts locally
	@echo "Building release $(VERSION) locally..."
	scripts/build.sh $(VERSION)

# Docker targets
docker-build: ## Build Docker image
	docker build -t sprintflint/vps-agent:latest -t sprintflint/vps-agent:$(VERSION) .

docker-push: docker-build ## Push Docker image to registry
	docker push sprintflint/vps-agent:latest
	docker push sprintflint/vps-agent:$(VERSION)

docker-run: ## Run agent in Docker (requires env vars)
	docker run --rm -it \
		-e SPRINTFLINT_TOKEN="$(SPRINTFLINT_TOKEN)" \
		-v vps-agent-data:/home/vps-agent/.vps-agent \
		sprintflint/vps-agent:latest $(ARGS)

docker-compose-up: ## Start with docker-compose
	@if [ -z "$(SPRINTFLINT_TOKEN)" ]; then \
		echo "Error: SPRINTFLINT_TOKEN environment variable is required"; \
		exit 1; \
	fi
	SPRINTFLINT_TOKEN=$(SPRINTFLINT_TOKEN) docker-compose up -d

docker-compose-down: ## Stop docker-compose
	docker-compose down

docker-compose-logs: ## View docker-compose logs
	docker-compose logs -f

# CI targets
ci: test lint build ## Run all CI checks
	@echo "All CI checks passed!"

# Utility targets
version: ## Show current version
	@echo "VPS Agent v$(VERSION)"

install-script: ## Download and verify install script
	curl -fsSL https://raw.githubusercontent.com/sprintflint/vps-agent/main/scripts/install.sh -o install.sh
	chmod +x install.sh

.PHONY: all
all: clean install test lint build ## Run full build pipeline
