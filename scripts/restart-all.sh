#!/usr/bin/env bash
# Restart script for the complete SecretaryHQ SaaS stack
# Kills existing processes on ports 4001 and 4400, then starts the stack.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
cd "$ROOT_DIR"

echo "[secretaryhq] 🔄 Restarting full stack..."

# 1. Kill any processes on our ports
echo "[secretaryhq] 🧹 Cleaning up existing processes on ports 4001 and 4400..."
fuser -k 4001/tcp 4400/tcp 2>/dev/null || true

# 2. Call the standard start script
bash scripts/start-all.sh
