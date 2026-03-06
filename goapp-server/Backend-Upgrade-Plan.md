# Backend Upgrade Plan (Enterprise Architecture Alignment)

## Analysis Summary
- The enterprise architecture document defines service decomposition (Identity, Ride, Matching, Pricing, Event Bus) and AWS deployment targets.
- The codebase previously had strong ride/matching simulation but lacked OTP identity APIs and explicit AWS readiness endpoints.
- Real database integrations are intentionally deferred; test-data-first in-memory repositories are required for fast iteration.

## Implemented Changes
1. Added mock **Identity Service** with OTP login flow and session generation.
2. Expanded seed data to include deterministic identity users.
3. Bootstrapped all runtime services from mock repositories (no real DB required).
4. Added microservice inventory and AWS readiness APIs.
5. Added performance guardrails:
   - HTTP keep-alive and request timeout tuning.
   - Event bus memory cap to avoid unbounded growth.

## Future AWS Path
- Move identity/ride state from in-memory maps to Aurora PostgreSQL + ElastiCache Redis.
- Replace local event bus with MSK/Kinesis producers/consumers.
- Split service processes by `SERVICE_NAME` for ECS/Fargate deployment.

## Extraction Sequencing (Bounded Contexts)
1. Extract **Identity** bounded context first (OTP/session contracts + repository swap).
2. Extract **Ride** bounded context second (ride aggregate + lifecycle events).
3. Extract supporting contexts after Identity/Ride contract stability (Matching, Wallet, Notification, Safety).
