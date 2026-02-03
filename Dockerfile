# VPS Agent Docker Image
# Multi-stage build for minimal image size

FROM ruby:3.3-alpine AS builder

# Install build dependencies
RUN apk add --no-cache build-base git

WORKDIR /build

# Copy gemspec and Gemfile first for better caching
COPY vps-agent.gemspec Gemfile Gemfile.lock ./
COPY lib/vps_agent.rb ./lib/

# Install gems
RUN bundle config set --local path 'vendor/bundle' && \
    bundle install --jobs 4 --retry 3

# Runtime stage
FROM ruby:3.3-alpine

LABEL maintainer="SprintFlint <support@sprintflint.com>"
LABEL description="VPS Agent for SprintFlint Autoplay"

# Install runtime dependencies
RUN apk add --no-cache \
    openssh-keygen \
    ca-certificates \
    tzdata

# Create non-root user
RUN addgroup -g 1000 vps-agent && \
    adduser -D -u 1000 -G vps-agent vps-agent

WORKDIR /app

# Copy installed gems from builder
COPY --from=builder /build/vendor/bundle ./vendor/bundle

# Copy application files
COPY lib ./lib
COPY bin ./bin
COPY vps-agent.gemspec Gemfile Gemfile.lock ./

# Set proper permissions
RUN chown -R vps-agent:vps-agent /app

# Switch to non-root user
USER vps-agent

# Configure bundle to use local gems
ENV BUNDLE_PATH=/app/vendor/bundle
ENV BUNDLE_DEPLOYMENT=true
ENV BUNDLE_WITHOUT=development:test

# Create config directory
RUN mkdir -p /home/vps-agent/.vps-agent

# Default volume for persistent data
VOLUME ["/home/vps-agent/.vps-agent"]

# Entrypoint
ENTRYPOINT ["bundle", "exec", "ruby", "bin/vps-agent"]
CMD ["--help"]
