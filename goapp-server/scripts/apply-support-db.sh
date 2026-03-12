#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

wait_for_postgres() {
  local attempts=30
  local delay_seconds=2

  for ((i = 1; i <= attempts; i++)); do
    if docker exec goapp-postgres pg_isready -U goapp -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay_seconds"
  done

  echo "PostgreSQL in goapp-postgres did not become ready in time." >&2
  return 1
}

create_db_if_missing() {
  local db="$1"
  local exists

  exists="$(docker exec -i goapp-postgres psql -U goapp -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='${db}'" || true)"
  if [[ "$exists" == "1" ]]; then
    echo "  - DB exists: $db"
    return 0
  fi

  docker exec -i goapp-postgres psql -U goapp -d postgres -c "CREATE DATABASE \"$db\";" >/dev/null
  echo "  - DB created: $db"
}

echo "[support-db] Waiting for postgres..."
wait_for_postgres

echo "[support-db] Ensuring support_db exists..."
create_db_if_missing "support_db"

echo "[support-db] Ensuring required extensions..."
docker exec -i goapp-postgres psql -U goapp -d support_db -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null

apply_sql() {
  local file_path="$1"
  local label="$2"

  docker exec -i goapp-postgres psql -U goapp -d support_db -v ON_ERROR_STOP=1 -f /dev/stdin \
    < "$file_path" >/dev/null
  echo "  - Applied: $label"
}

echo "[support-db] Applying support schema and catalog..."
apply_sql "$ROOT_DIR/enterprise-setup/sql/065_support_db_bootstrap.sql" "065_support_db_bootstrap.sql"
apply_sql "$ROOT_DIR/enterprise-setup/sql/066_support_past_ride_issue_catalog.sql" "066_support_past_ride_issue_catalog.sql"
apply_sql "$ROOT_DIR/enterprise-setup/sql/067_support_db_repair.sql" "067_support_db_repair.sql"

group_count="$(docker exec -i goapp-postgres psql -U goapp -d support_db -Atc "SELECT COUNT(*) FROM support_trip_issue_groups;")"
subissue_count="$(docker exec -i goapp-postgres psql -U goapp -d support_db -Atc "SELECT COUNT(*) FROM support_trip_issue_subissues;")"

if [[ "${group_count}" == "0" || "${subissue_count}" == "0" ]]; then
  echo "support_db catalog verification failed: groups=${group_count}, subissues=${subissue_count}" >&2
  exit 1
fi

echo "[support-db] Catalog ready: groups=${group_count}, subissues=${subissue_count}"
