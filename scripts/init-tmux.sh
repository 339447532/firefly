#!/bin/bash
# Initialize tmux session for firefly development
# Checks if session exists, creates if not

set -e

TMUX_SESSION="mobile-dev"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }

# Check if tmux exists
if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux not found. Please install tmux first:"
    echo "  brew install tmux"
    exit 1
fi

# Check if session exists
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log_info "tmux session '$TMUX_SESSION' already exists"
else
    log_info "Creating tmux session '$TMUX_SESSION'..."
    tmux new-session -d -s "$TMUX_SESSION"
    log_info "tmux session created"
fi

# Add configuration for detach-on-destroy
if ! grep -q "detach-on-destroy" ~/.tmux.conf 2>/dev/null; then
    echo 'set -g detach-on-destroy off' >> ~/.tmux.conf
    log_info "Added detach-on-destroy to ~/.tmux.conf"
fi

echo ""
log_info "tmux session '$TMUX_SESSION' is ready"
echo "  Attach: tmux attach -t $TMUX_SESSION"
echo "  Detach: Ctrl+B, D"
