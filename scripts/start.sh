#!/bin/bash
# Start the firefly-gateway server
# Auto-installs dependencies if not found (using China mirrors)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")/server"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Install Homebrew if not found
install_brew() {
    log_warn "Homebrew not found, installing..."
    /bin/bash -c "$(curl -fsSL https://mirrors.tuna.tsinghua.edu.cn/homebrew-install/git/install.sh)"
    echo 'export HOMEBREW_API_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-api"' >> ~/.zshrc
    echo 'export HOMEBREW_BREW_GIT_ENDPOINT="https://mirrors.tuna.tsinghua.edu.cn/homebrew"' >> ~/.zshrc
    echo 'export HOMEBREW_CORE_GIT_ENDPOINT="https://mirrors.tuna.tsinghua.edu.cn/homebrew-core"' >> ~/.zshrc
    echo 'export HOMEBREW_BOTTLE_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"' >> ~/.zshrc
    source ~/.zshrc 2>/dev/null || true
    source ~/.bash_profile 2>/dev/null || true
}

# Install Node.js if not found
install_nodejs() {
    log_warn "Node.js not found, installing..."
    if command_exists brew; then
        brew install node@20
    else
        curl -fsSL https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v20.11.0/node-v20.11.0-darwin-arm64.tar.gz | tar -xzC /usr/local --strip-components=1
    fi
}

# Install tmux if not found
install_tmux() {
    log_warn "tmux not found, installing..."
    if command_exists brew; then
        brew install tmux
    else
        log_error "Homebrew required to install tmux. Please install Homebrew first."
        exit 1
    fi
}

# Setup npm China mirror
setup_npm_mirror() {
    log_info "Setting up npm mirror (China)..."
    npm config set registry https://registry.npmmirror.com
    log_info "npm mirror: https://registry.npmmirror.com"
}

# Check and install dependencies
check_dependencies() {
    log_info "Checking dependencies..."

    # Check Node.js
    if ! command_exists node; then
        install_nodejs
    else
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -lt 18 ]; then
            log_warn "Node.js version is too old, upgrading..."
            install_nodejs
        else
            log_info "Node.js $(node -v) - OK"
        fi
    fi

    # Check npm
    if ! command_exists npm; then
        log_warn "npm not found"
        install_nodejs
    else
        log_info "npm $(npm -v) - OK"
    fi

    # Check tmux
    if ! command_exists tmux; then
        install_tmux
    else
        log_info "tmux $(tmux -V) - OK"
    fi

    # Check ffmpeg (required for screen streaming)
    if ! command_exists ffmpeg; then
        log_warn "ffmpeg not found. Screen live streaming will NOT work."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            log_info "Install with: brew install ffmpeg"
        elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
            log_info "Install with: sudo apt install ffmpeg  (or yum/pacman equivalent)"
        fi
    else
        log_info "ffmpeg $(ffmpeg -version | head -n1 | awk '{print $3}') - OK"
    fi

    # Check xdotool (Linux only, required for keyboard/mouse control)
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        if ! command_exists xdotool; then
            log_warn "xdotool not found. Linux screen keyboard/mouse control will NOT work."
            log_info "Install with: sudo apt install xdotool  (or yum/pacman equivalent)"
        else
            log_info "xdotool $(xdotool --version | awk '{print $3}') - OK"
        fi
    fi
}

# Initialize tmux session
init_tmux_session() {
    TMUX_SESSION="mobile-dev"
    log_info "Checking tmux session: $TMUX_SESSION"

    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        log_info "tmux session '$TMUX_SESSION' already exists"
    else
        log_info "Creating tmux session: $TMUX_SESSION"
        tmux new-session -d -s "$TMUX_SESSION"
        log_info "tmux session created"
    fi

    # Configure detach-on-destroy
    if ! grep -q "detach-on-destroy" ~/.tmux.conf 2>/dev/null; then
        echo 'set -g detach-on-destroy off' >> ~/.tmux.conf
    fi
}

# Install npm dependencies
install_npm_deps() {
    log_info "Installing npm dependencies..."
    cd "$SERVER_DIR" || exit 1

    if [ ! -d "node_modules" ] || [ ! -f "node_modules/.package-lock.json" ]; then
        log_info "Running npm install..."
        npm install
        log_info "Dependencies installed successfully"
    else
        log_info "Dependencies already installed"
    fi
}

# Main
main() {
    log_info "Starting firefly-gateway server..."
    log_info "Server directory: $SERVER_DIR"

    check_dependencies
    setup_npm_mirror
    init_tmux_session
    install_npm_deps

    log_info "Starting Node.js server on port 8080..."
    cd "$SERVER_DIR" && node server.js
}

main "$@"
