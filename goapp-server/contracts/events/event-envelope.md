# Event Envelope Contract

All Kafka/outbox events should use this envelope shape:

```json
{
  "eventId": "uuid",
  "eventType": "ride_requested",
  "aggregateType": "ride",
  "aggregateId": "RIDE-XXXX",
  "version": 1,
  "occurredAt": "2026-03-10T00:00:00.000Z",
  "region": "ap-south-1",
  "idempotencyKey": "optional-key",
  "payload": {}
}
```

Current topics:
- `ride_requested`
- `ride_matched`
- `ride_started`
- `ride_completed`
- `driver_location_updated`
- `payment_completed`
