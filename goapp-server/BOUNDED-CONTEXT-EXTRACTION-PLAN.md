# Bounded Context Extraction Plan (Identity → Ride First)

This plan intentionally sequences service extraction by **business bounded contexts** instead of by technical layer.

## Why this order

- Identity and Ride are the highest-traffic and highest-coupling contexts.
- Most other domains (pricing, wallet, notifications, incentives, safety) hang off Ride lifecycle events.
- Stabilizing auth/session and ride state contracts first reduces cross-domain migration risk.

## Phase A — Identity Context (first)

**Scope**
- OTP request/verify
- Session issue/validation
- User profile bootstrap and auth stats

**Deliverables**
1. Extract identity routes and middleware policy as standalone API boundary.
2. Replace in-memory identity repository adapter with PostgreSQL-backed repository implementation.
3. Publish identity domain events (`otp_requested`, `otp_verified`, `session_revoked`) through external event bus.
4. Add contract tests for OTP lifecycle and session validation.

**Exit Criteria**
- Identity service can run independently behind API gateway.
- Session token validation no longer depends on monolith memory.

## Phase B — Ride Context (second)

**Scope**
- Ride request lifecycle
- Matching invocation boundary
- Cancel/complete flow and billing hooks

**Deliverables**
1. Extract ride routes into dedicated service entrypoint.
2. Move ride aggregate persistence from in-memory map to PostgreSQL repository.
3. Keep matching engine as dependency boundary via repository/service port.
4. Emit canonical ride lifecycle events (`ride_requested`, `ride_matched`, `ride_cancelled`, `ride_completed`).

**Exit Criteria**
- Ride create/cancel/complete flows persist and replay correctly after restart.
- Wallet and notification integrations consume ride lifecycle events, not in-process calls.

## Phase C — Supporting contexts

After Identity + Ride are stable and independently deployable:
- Matching/Dispatch
- Wallet/Payments
- Notifications
- Safety/SOS
- Support/Tickets

Each context should be extracted with:
- repository interface + implementation,
- route contract tests,
- event contracts and versioning,
- backward-compatibility window via gateway routing.
