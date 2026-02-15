#!/bin/bash
# =============================================================================
# Deploy to Raspberry Pi
# =============================================================================
#
# Syncs code to RPi and restarts services.
#
# Usage:
#   ./scripts/deploy-rpi.sh              # Deploy code + restart services
#   ./scripts/deploy-rpi.sh --no-restart # Deploy code only
#   ./scripts/deploy-rpi.sh --full       # Deploy + npm install + restart
#
# Environment variables (optional, defaults shown):
#   RPI_HOST=rpi                         # SSH host (from ~/.ssh/config)
#   RPI_USER=agetrox                     # SSH user
#   RPI_PASS=agetrox                     # SSH password (if not using keys)
#   RPI_PATH=/home/agetrox/visa-scraper  # Remote path
#
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration (from env vars or .env file)
# Load .env if it exists
if [[ -f "$(dirname "$0")/../.env" ]]; then
    set -a
    source "$(dirname "$0")/../.env"
    set +a
fi

RPI_HOST="${RPI_HOST:-rpi}"
RPI_USER="${RPI_USER:-pi}"
RPI_PASS="${RPI_PASS:-}"
RPI_PATH="${RPI_PATH:-/home/pi/visa-scraper}"

if [[ -z "$RPI_PASS" ]]; then
    echo -e "${YELLOW}Warning: RPI_PASS not set. Using SSH keys or will prompt for password.${NC}"
fi

# Parse arguments
NO_RESTART=false
FULL_INSTALL=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --no-restart)
            NO_RESTART=true
            shift
            ;;
        --full)
            FULL_INSTALL=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--no-restart] [--full]"
            echo ""
            echo "Options:"
            echo "  --no-restart  Deploy code without restarting services"
            echo "  --full        Deploy + run npm install + restart"
            echo ""
            echo "Environment variables:"
            echo "  RPI_HOST      SSH host (default: rpi)"
            echo "  RPI_USER      SSH user (default: pi)"
            echo "  RPI_PASS      SSH password (reads from .env if not set)"
            echo "  RPI_PATH      Remote path (default: /home/pi/visa-scraper)"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Get script directory (project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}Deploying to Raspberry Pi${NC}                                  ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${YELLOW}Host:${NC} $RPI_HOST"
echo -e "  ${YELLOW}Path:${NC} $RPI_PATH"
echo -e "  ${YELLOW}Options:${NC} restart=$([[ $NO_RESTART == true ]] && echo 'no' || echo 'yes'), npm_install=$([[ $FULL_INSTALL == true ]] && echo 'yes' || echo 'no')"
echo ""

# Helper function for SSH commands
ssh_cmd() {
    if command -v sshpass &> /dev/null && [[ -n "$RPI_PASS" ]]; then
        sshpass -p "$RPI_PASS" ssh -o StrictHostKeyChecking=no "$RPI_HOST" "$@"
    else
        ssh "$RPI_HOST" "$@"
    fi
}

# Helper function for rsync
rsync_cmd() {
    if command -v sshpass &> /dev/null && [[ -n "$RPI_PASS" ]]; then
        rsync -avz --progress \
            -e "sshpass -p '$RPI_PASS' ssh -o StrictHostKeyChecking=no" \
            "$@"
    else
        rsync -avz --progress -e ssh "$@"
    fi
}

# Step 1: Test connection
echo -e "${GREEN}[1/4] Testing connection...${NC}"
if ! ssh_cmd "echo 'Connected to RPi'" 2>/dev/null; then
    echo -e "${RED}Failed to connect to $RPI_HOST${NC}"
    echo "Make sure:"
    echo "  - RPi is online"
    echo "  - SSH config is correct (~/.ssh/config)"
    echo "  - cloudflared is running (if using tunnel)"
    exit 1
fi

# Step 2: Sync code
echo -e "${GREEN}[2/4] Syncing code...${NC}"

# Create exclude file
EXCLUDE_FILE=$(mktemp)
cat > "$EXCLUDE_FILE" << 'EOF'
node_modules
.env
.git
.trigger
.firecrawl
*.log
.DS_Store
EOF

# Sync using tar/ssh (more reliable with cloudflared than rsync)
echo "  Syncing src/..."
tar -cf - -C "$PROJECT_DIR" \
    --exclude='node_modules' \
    --exclude='.env' \
    --exclude='.git' \
    --exclude='.trigger' \
    --exclude='.firecrawl' \
    src scripts package.json package-lock.json tsconfig.json trigger.config.ts drizzle.config.ts CLAUDE.md 2>/dev/null | \
    ssh_cmd "cd $RPI_PATH && tar -xf - --overwrite 2>/dev/null"

rm -f "$EXCLUDE_FILE"
echo -e "  ${GREEN}✓ Code synced${NC}"

# Step 3: npm install (if --full)
if [[ $FULL_INSTALL == true ]]; then
    echo -e "${GREEN}[3/4] Running npm install...${NC}"
    ssh_cmd "cd $RPI_PATH && npm install"
    echo -e "  ${GREEN}✓ Dependencies installed${NC}"
else
    echo -e "${GREEN}[3/4] Skipping npm install (use --full to install)${NC}"
fi

# Step 4: Restart services
if [[ $NO_RESTART == true ]]; then
    echo -e "${GREEN}[4/4] Skipping restart (--no-restart)${NC}"
else
    echo -e "${GREEN}[4/4] Restarting services...${NC}"
    ssh_cmd "echo '$RPI_PASS' | sudo -S systemctl restart visa-api visa-trigger"
    sleep 3

    # Check status
    echo ""
    echo -e "${CYAN}Service status:${NC}"
    ssh_cmd "echo '$RPI_PASS' | sudo -S systemctl status visa-api visa-trigger --no-pager 2>/dev/null | grep -E '●|Active:' | head -4"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}  ${GREEN}✓ Deploy complete!${NC}                                         ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${YELLOW}API:${NC} https://visa.homiapp.xyz/api/health"
echo -e "  ${YELLOW}Monitor:${NC} ssh $RPI_HOST \"cd $RPI_PATH && npm run monitor\""
echo ""
