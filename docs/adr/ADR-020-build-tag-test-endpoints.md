# ADR-020: Build-Tag Gated Test Endpoints

**Date:** 2026-03-01

## Context

Chatto's E2E tests need to perform operations that are intentionally impossible through the normal API: bypassing email verification, simulating OAuth callbacks, and inspecting outgoing emails. The options are:

- **Seed via normal API**: Register users, verify emails, etc. through the public API. Slow, can't bypass email delivery, and couples tests to the full registration flow.
- **Test doubles/mocks**: Replace NATS and other infrastructure with in-memory fakes. Wouldn't test actual JetStream behavior, stream ordering, or KV semantics.
- **Conditional test endpoints**: Compile test-only HTTP endpoints into the binary when built with a specific flag. Not present in production builds.

## Decision

Use Go build tags to conditionally compile test-only HTTP endpoints. When built with `-tags test_endpoints`, the binary includes about a dozen routes gated behind the same build tag, including:

- `GET /auth/test/last-email` — Retrieve the last captured verification email
- `POST /auth/test/verify-email` — Directly verify a user's email
- `POST /auth/test/create-user` and `POST /auth/test/create-user-session` — Create a test user, bypassing registration and email verification
- `POST /auth/test/create-registration-code` / `create-registration-token` — Issue a registration code or token without email delivery
- `POST /auth/test/oauth-callback` and `POST /auth/test/oauth-authorize` — Simulate an OAuth callback or mint an authorization code without the login UI
- `POST /auth/test/external-identity-flow` — Create a pending external-identity confirmation flow
- `POST /auth/test/seed-performance` — Seed a large encrypted performance fixture
- `DELETE /auth/test/emails` — Clear captured emails
- `POST /webhooks/test/call-join` and `POST /webhooks/test/call-leave` — Simulate LiveKit call-participant webhooks, bypassing HMAC validation

The full, current list lives in `cli/internal/http_server/test_endpoints.go`.

A stub file (`test_endpoints_stub.go`) provides no-op registrations for production builds. E2E tests compile a dedicated test binary via the `build-e2e-server` mise task.

Each E2E test spawns a real Chatto process with a unique ephemeral data directory. Ports are computed deterministically from the Playwright worker and parallel-test index, offset by a base that is randomized once per suite run so concurrent CI runs don't collide on the same port range.

## Consequences

- **Structurally impossible in production**: The test endpoints don't exist in the compiled binary unless `-tags test_endpoints` is specified. There's no runtime flag to enable them — the code is literally absent. This is stronger than a configuration guard.
- **True end-to-end coverage**: Tests run against a real binary with real embedded NATS, real JetStream streams, and real KV buckets. No mocks, no fakes, no in-memory substitutes.
- **Per-test isolation**: Each test gets its own Chatto process with a fresh data directory. No shared state, no cleanup between tests, no inter-test pollution.
- **Parallel test execution**: Deterministic per-worker ports plus a randomized per-suite-run base prevent collisions when multiple test suites run simultaneously in CI.
- **Other security controls are relaxed too, not only auth flow bypasses**: the `test_endpoints` tag also drops the bcrypt password-hash cost to `bcrypt.MinCost` (from `bcrypt.DefaultCost`) and disables the link-preview SSRF guard by defaulting `allowLocalhost` to true. Both changes make sense for throwaway E2E fixtures, but they mean a `test_endpoints` binary is weaker than production in more ways than the extra routes alone.
- **Test binary must be rebuilt**: Changes to the Go backend require rebuilding the E2E test binary before running tests. The mise task handles this, but it's an extra step compared to interpreted test frameworks.
