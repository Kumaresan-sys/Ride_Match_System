#!/usr/bin/env bash
set -euo pipefail

TOPICS_WITH_PARTITIONS=(
  "ride_requested:96"
  "ride_matched:96"
  "ride_started:96"
  "ride_completed:96"
  "ride_cancelled:96"
  "driver_location_updated:192"
  "payment_completed:48"
  "wallet_updated:48"
  "identity_profile_updated:48"
  "driver_profile_updated:48"
  "notification_dispatch_requested:24"
)

for entry in "${TOPICS_WITH_PARTITIONS[@]}"; do
  topic="${entry%%:*}"
  partitions="${entry##*:}"
  docker exec -i goapp-kafka kafka-topics \
    --bootstrap-server localhost:9092 \
    --create --if-not-exists \
    --topic "$topic" \
    --partitions "$partitions" \
    --replication-factor 1 >/dev/null
  echo "Created/verified topic: $topic (partitions=$partitions)"
done
