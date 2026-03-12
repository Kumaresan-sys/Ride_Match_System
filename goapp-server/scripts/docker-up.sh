#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

echo "[docker-up] Rebuilding and starting services..."
docker compose up -d --build

echo "[docker-up] Applying support database schema and catalog..."
bash "$ROOT_DIR/scripts/apply-support-db.sh"
