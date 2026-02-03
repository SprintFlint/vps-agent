#!/bin/bash
#
# VPS Agent Installer
# One-line install: curl -fsSL https://raw.githubusercontent.com/sprintflint/vps-agent/main/scripts/install.sh | bash
#

set -e

# Configuration
REPO="sprintflint/vps-agent"
BINARY_NAME="vps-agent"
INSTALL_DIR="/usr/local/bin"
FALLBACK_DIR="$HOME/.local/bin"
VERSION="${VERSION:-latest}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
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

# Detect OS and architecture
detect_platform() {
    local os
    local arch
    
    # Detect OS
    case "$(uname -s)" in
        Linux*)     os="linux";;
        Darwin*)    os="darwin";;
        CYGWIN*|MINGW*|MSYS*) os="windows";;
        *)          os="unknown";;
    esac
    
    # Detect architecture
    case "$(uname -m)" in
        x86_64|amd64) arch="amd64";;
        arm64|aarch64) arch="arm64";;
        armv7l) arch="arm";;
        i386|i686) arch="386";;
        *) arch="unknown";;
    esac
    
    echo "${os}_${arch}"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Download file
download() {
    local url="$1"
    local output="$2"
    
    if command_exists curl; then
        curl -fsSL "$url" -o "$output"
    elif command_exists wget; then
        wget -q "$url" -O "$output"
    else
        log_error "Neither curl nor wget is installed. Please install one of them."
        exit 1
    fi
}

# Get latest release version
get_latest_version() {
    local url="https://api.github.com/repos/${REPO}/releases/latest"
    
    if command_exists curl; then
        curl -fsSL "$url" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
    elif command_exists wget; then
        wget -qO- "$url" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
    fi
}

# Install binary
install_binary() {
    local platform="$1"
    local version="$2"
    local tmp_dir
    local download_url
    local checksum_url
    local archive_name
    
    tmp_dir=$(mktemp -d)
    trap "rm -rf $tmp_dir" EXIT
    
    # Map platform to release asset name
    case "$platform" in
        linux_amd64)
            archive_name="${BINARY_NAME}_linux_x86_64.tar.gz"
            ;;
        linux_arm64)
            archive_name="${BINARY_NAME}_linux_arm64.tar.gz"
            ;;
        linux_arm)
            archive_name="${BINARY_NAME}_linux_arm.tar.gz"
            ;;
        darwin_amd64)
            archive_name="${BINARY_NAME}_darwin_x86_64.tar.gz"
            ;;
        darwin_arm64)
            archive_name="${BINARY_NAME}_darwin_arm64.tar.gz"
            ;;
        *)
            log_error "Unsupported platform: $platform"
            log_info "Falling back to Ruby gem installation..."
            install_gem
            return
            ;;
    esac
    
    download_url="https://github.com/${REPO}/releases/download/${version}/${archive_name}"
    checksum_url="https://github.com/${REPO}/releases/download/${version}/checksums.txt"
    
    log_info "Downloading ${BINARY_NAME} ${version} for ${platform}..."
    
    # Download archive
    if ! download "$download_url" "$tmp_dir/$archive_name"; then
        log_error "Failed to download binary"
        log_info "Falling back to Ruby gem installation..."
        install_gem
        return
    fi
    
    # Extract archive
    log_info "Extracting..."
    tar -xzf "$tmp_dir/$archive_name" -C "$tmp_dir"
    
    # Determine install directory
    local target_dir="$INSTALL_DIR"
    if [[ ! -w "$INSTALL_DIR" ]]; then
        target_dir="$FALLBACK_DIR"
        mkdir -p "$target_dir"
    fi
    
    # Install binary
    log_info "Installing to ${target_dir}..."
    mv "$tmp_dir/$BINARY_NAME" "$target_dir/"
    chmod +x "$target_dir/$BINARY_NAME"
    
    log_success "Binary installed to ${target_dir}/${BINARY_NAME}"
    
    # Add to PATH if needed
    if [[ "$target_dir" == "$FALLBACK_DIR" ]]; then
        if [[ ":$PATH:" != *":$FALLBACK_DIR:"* ]]; then
            log_warning "$FALLBACK_DIR is not in your PATH"
            log_info "Add the following to your ~/.bashrc or ~/.zshrc:"
            echo "    export PATH=\"\$PATH:$FALLBACK_DIR\""
        fi
    fi
}

# Install as Ruby gem
install_gem() {
    log_info "Installing as Ruby gem..."
    
    if ! command_exists gem; then
        log_error "Ruby is not installed. Please install Ruby 3.0 or later."
        log_info "Visit: https://www.ruby-lang.org/en/documentation/installation/"
        exit 1
    fi
    
    local ruby_version
    ruby_version=$(ruby -v | cut -d' ' -f2 | cut -d'.' -f1,2)
    
    if [[ "${ruby_version%.*}${ruby_version#*.}" -lt "30" ]]; then
        log_warning "Ruby ${ruby_version} detected. Ruby 3.0+ is recommended."
    fi
    
    gem install vps-agent
    log_success "Gem installed successfully"
}

# Setup systemd service
setup_systemd() {
    local service_name="vps-agent"
    local service_file="/etc/systemd/system/${service_name}.service"
    
    # Check if running as root
    if [[ $EUID -ne 0 ]]; then
        log_warning "Skipping systemd setup (requires root)"
        return
    fi
    
    # Check if systemd is available
    if ! command_exists systemctl; then
        log_warning "systemd not detected, skipping service setup"
        return
    fi
    
    log_info "Setting up systemd service..."
    
    cat > "$service_file" << 'EOF'
[Unit]
Description=VPS Agent for SprintFlint
After=network.target

[Service]
Type=simple
User=vps-agent
Group=vps-agent
ExecStart=/usr/local/bin/vps-agent start
ExecStop=/usr/local/bin/vps-agent stop
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vps-agent

[Install]
WantedBy=multi-user.target
EOF
    
    # Create vps-agent user if it doesn't exist
    if ! id -u vps-agent >/dev/null 2>&1; then
        useradd --system --create-home --home-dir /var/lib/vps-agent vps-agent
    fi
    
    systemctl daemon-reload
    
    log_success "Systemd service created: ${service_name}"
    log_info "Start the service with: sudo systemctl start ${service_name}"
    log_info "Enable at boot with: sudo systemctl enable ${service_name}"
    
    # Ask to start service
    read -p "Start the service now? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        systemctl start "$service_name"
        log_info "Service started. Check status with: sudo systemctl status ${service_name}"
    fi
}

# Print usage
print_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo
    echo "Options:"
    echo "  -v, --version VERSION   Install specific version (default: latest)"
    echo "  -d, --dir DIRECTORY     Install directory (default: /usr/local/bin)"
    echo "  -s, --service           Setup systemd service (requires root)"
    echo "  -h, --help              Show this help message"
    echo
    echo "Environment variables:"
    echo "  VERSION                 Set version to install"
    echo "  SPRINTFLINT_TOKEN       API token for automatic registration"
    echo
    echo "Examples:"
    echo "  $0                      # Install latest version"
    echo "  $0 -v v1.2.3            # Install specific version"
    echo "  $0 -s                   # Install and setup systemd service"
}

# Main function
main() {
    local platform
    local version="$VERSION"
    local setup_service=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -v|--version)
                version="$2"
                shift 2
                ;;
            -d|--dir)
                INSTALL_DIR="$2"
                shift 2
                ;;
            -s|--service)
                setup_service=true
                shift
                ;;
            -h|--help)
                print_usage
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                print_usage
                exit 1
                ;;
        esac
    done
    
    # Header
    echo
    echo "============================================"
    echo "  VPS Agent Installer"
    echo "  https://sprintflint.com"
    echo "============================================"
    echo
    
    log_info "Detecting platform..."
    platform=$(detect_platform)
    log_info "Platform: $platform"
    
    # Get version
    if [[ "$version" == "latest" ]] || [[ -z "$version" ]]; then
        log_info "Checking for latest version..."
        version=$(get_latest_version)
        if [[ -z "$version" ]]; then
            log_warning "Could not determine latest version, using v0.1.0"
            version="v0.1.0"
        fi
    fi
    
    log_info "Version: $version"
    
    # Install
    install_binary "$platform" "$version"
    
    # Setup systemd if requested
    if [[ "$setup_service" == true ]]; then
        setup_systemd
    fi
    
    # Verify installation
    echo
    log_info "Verifying installation..."
    if command_exists vps-agent; then
        vps-agent version
        log_success "Installation complete!"
        echo
        echo "Next steps:"
        echo "  1. Register your VPS: vps-agent register --name \"my-vps\" --token YOUR_TOKEN"
        echo "  2. Start the agent: vps-agent start"
        echo
        echo "For help: vps-agent --help"
    else
        log_warning "vps-agent command not found in PATH"
        log_info "You may need to restart your shell or add the install directory to your PATH"
    fi
}

# Run main function
main "$@"
