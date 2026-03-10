#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

echo "[1/5] Starting Docker services (api, postgres, redis, kafka)..."
docker compose up -d --build

create_db_if_missing() {
  local db="$1"
  local exists
  exists="$(docker exec -i goapp-postgres psql -U goapp -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='${db}'" || true)"
  if [[ "$exists" == "1" ]]; then
    echo "  - DB exists: $db"
  else
    docker exec -i goapp-postgres psql -U goapp -d postgres -c "CREATE DATABASE \"$db\";" >/dev/null
    echo "  - DB created: $db"
  fi
}

echo "[2/5] Ensuring domain databases exist..."
for db in identity_db drivers_db rides_db payments_db analytics_db; do
  create_db_if_missing "$db"
done

echo "[3/5] Ensuring required PostgreSQL extensions..."
for db in identity_db drivers_db rides_db payments_db analytics_db; do
  docker exec -i goapp-postgres psql -U goapp -d "$db" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null
  echo "  - pgcrypto: $db"
done
for db in drivers_db rides_db; do
  docker exec -i goapp-postgres psql -U goapp -d "$db" -c "CREATE EXTENSION IF NOT EXISTS postgis;" >/dev/null
  echo "  - postgis: $db"
done

echo "[4/5] Creating Kafka topics..."
"$ROOT_DIR/enterprise-setup/scripts/init-topics.sh"

echo "[5/5] Verifying stack status and API health..."
docker compose ps
curl -sSf http://localhost:3000/api/v1/health >/dev/null
echo "Docker setup complete. API health endpoint is reachable."
