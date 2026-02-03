#!/bin/bash
#
# Build script for local release builds
# Usage: ./scripts/build.sh [VERSION]
#

set -e

# Configuration
VERSION="${1:-$(ruby -r ./lib/vps_agent -e 'puts VPSAgent::VERSION')}"
BINARY_NAME="vps-agent"
DIST_DIR="dist"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Clean and prepare
clean() {
    log_info "Cleaning build artifacts..."
    rm -rf "$DIST_DIR"
    rm -f "${BINARY_NAME}-*.gem"
    mkdir -p "$DIST_DIR"
}

# Build the gem
build_gem() {
    log_info "Building gem..."
    gem build "${BINARY_NAME}.gemspec"
    mv "${BINARY_NAME}-${VERSION}.gem" "$DIST_DIR/"
    log_success "Gem built: ${DIST_DIR}/${BINARY_NAME}-${VERSION}.gem"
}

# Build Ruby-based wrapper binary
build_binary() {
    local platform="$1"
    local output_name="${BINARY_NAME}_${platform}"
    
    log_info "Building binary for $platform..."
    
    # Create a wrapper script that embeds the gem
    cat > "$DIST_DIR/$output_name" << EOF
#!/bin/bash
# VPS Agent v${VERSION}
# Platform: ${platform}
# This is a self-contained wrapper that manages gem installation

set -e

VERSION="${VERSION}"
GEM_NAME="${BINARY_NAME}"
GEM_FILE="\${0%/*}/${BINARY_NAME}-\${VERSION}.gem"

check_ruby() {
    if ! command -v ruby >/dev/null 2>\u00261; then
        echo "Error: Ruby is required but not installed." >\u00262
        echo "Please install Ruby 3.0 or later from https://www.ruby-lang.org/" >\u00262
        exit 1
    fi
    
    local ruby_version
    ruby_version=$(ruby -v | cut -d' ' -f2 | cut -d'.' -f1,2 | tr -d '.')
    if [ "\$ruby_version" -lt "30" ]; then
        echo "Warning: Ruby 3.0+ is recommended. Current version: \$(ruby -v)" >\u00262
    fi
}

install_gem() {
    if [ -f "\$GEM_FILE" ]; then
        echo "Installing from local gem..." >\u00262
        gem install "\$GEM_FILE" --no-document >/dev/null
    else
        echo "Installing from RubyGems..." >\u00262
        gem install "\$GEM_NAME" -v "\$VERSION" --no-document >/dev/null
    fi
}

main() {
    check_ruby
    
    # Check if correct version is installed
    if ! gem list "\$GEM_NAME" -i -v "\$VERSION" >/dev/null 2>\u00261; then
        install_gem
    fi
    
    exec vps-agent "\$@"
}

main "\$@"
EOF
    
    chmod +x "$DIST_DIR/$output_name"
    
    # Create tarball
    tar -czf "${DIST_DIR}/${output_name}.tar.gz" -C "$DIST_DIR" "$output_name"
    rm "$DIST_DIR/$output_name"
    
    log_success "Binary built: ${DIST_DIR}/${output_name}.tar.gz"
}

# Copy install script
copy_install_script() {
    log_info "Copying install script..."
    cp "scripts/install.sh" "$DIST_DIR/"
    chmod +x "$DIST_DIR/install.sh"
    log_success "Install script copied"
}

# Generate checksums
generate_checksums() {
    log_info "Generating checksums..."
    cd "$DIST_DIR"
    sha256sum *.tar.gz *.gem > checksums.txt 2>/dev/null || true
    cd - >/dev/null
    log_success "Checksums generated: ${DIST_DIR}/checksums.txt"
}

# List all artifacts
list_artifacts() {
    echo
    log_info "Build artifacts in ${DIST_DIR}/:"
    echo
    ls -lh "$DIST_DIR/" | awk '{printf "  %s %s %s\n", $5, $9, $10}'
    echo
    
    log_info "Checksums:"
    cat "$DIST_DIR/checksums.txt" 2>/dev/null || echo "  (none)"
}

# Main build process
main() {
    echo
    echo "============================================"
    echo "  VPS Agent Build Script"
    echo "  Version: ${VERSION}"
    echo "============================================"
    echo
    
    # Verify we're in the right directory
    if [ ! -f "${BINARY_NAME}.gemspec" ]; then
        log_error "Must run from project root directory"
        exit 1
    fi
    
    # Clean
    clean
    
    # Run tests first
    log_info "Running tests..."
    if bundle exec rspec >/dev/null 2>\u00261; then
        log_success "Tests passed"
    else
        log_warning "Tests failed (continuing anyway)"
    fi
    
    # Build
    build_gem
    
    # Build binaries for different platforms
    build_binary "linux_x86_64"
    build_binary "linux_arm64"
    build_binary "linux_arm"
    build_binary "darwin_x86_64"
    build_binary "darwin_arm64"
    
    # Copy install script
    copy_install_script
    
    # Generate checksums
    generate_checksums
    
    # List results
    list_artifacts
    
    log_success "Build complete!"
    echo
    echo "Next steps:"
    echo "  1. Review artifacts in ${DIST_DIR}/"
    echo "  2. Create git tag: git tag -a v${VERSION} -m 'Release v${VERSION}'"
    echo "  3. Push tag: git push origin v${VERSION}"
    echo "  4. Or upload manually to GitHub releases"
}

main "$@"
