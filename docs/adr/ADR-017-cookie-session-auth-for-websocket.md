# ADR-017: Cookie-Session Authentication Propagated to WebSocket

**Date:** 2026-03-01

**Updated:** 2026-08-25

## Context

Chatto's frontend is a browser SPA that communicates through HTTP APIs plus a realtime websocket. The WebSocket upgrade is an HTTP request, which means the browser automatically includes same-origin cookies.

Authentication approaches for WebSocket:

- **Bearer token in `connection_init` payload**: Client sends a JWT or session token in the WebSocket init message. Common in mobile/multi-client architectures but requires the client to manage tokens explicitly.
- **Cookie-based session on HTTP upgrade**: The browser sends the session cookie with the upgrade request. The server authenticates during the upgrade handshake, before the WebSocket is established.

## Decision

Use cookie-based sessions (90-day expiry, `HttpOnly`, `SameSiteLax`) for the embedded browser SPA. For WebSocket connections, the session cookie is sent with the HTTP upgrade request, so the user is already authenticated before the WebSocket handshake completes.

ADR-046 moved cookie sessions onto typed runtime credentials. Each SCS-managed
`chatto_auth_<slot>` cookie stores only an opaque runtime credential handle; the
user ID is loaded from the `session.{hmac}` runtime credential record. Chatto
uses a fresh cookie slot for authentication and renewal responses. This design
prevents a late response from replacing a newer browser session. The separate
encrypted `chatto_session` cookie holds only short-lived browser-flow state.

The realtime WebSocket handler reads the authenticated user from request
context and creates connection-scoped state without inheriting request-local
caches. It revalidates the exact human credential before subscription and once
per minute. A cookie connection ends at the start of its final renewal quarter.
The bundled frontend calls the explicit HTTP renewal route and reconnects the
same event bus. The WebSocket upgrade does not update the session or set a
cookie. The connection acknowledgement includes the server version for
frontend upgrade detection. The renewal route also returns the next renewal
time. An independent HTTP timer uses it when realtime transport is unavailable.

## Consequences

- **No readable origin credential**: The browser stores and attaches the HttpOnly cookie. The frontend only reacts to a renewal signal and cannot read the credential value.
- **WebSocket auth is implicit for same-origin cookie clients**: The user is authenticated before the WS protocol even starts. Bearer-token clients use the realtime protocol's token path.
- **Non-browser clients use bearer tokens**: CLI tools, bots, multi-instance frontends, and future mobile apps can use opaque bearer tokens instead of cookies. Cookie sessions remain the same-origin browser path.
- **Explicit automatic renewal**: Ordinary HTTP and WebSocket requests are read-only. At the renewal threshold, the frontend calls the CSRF-protected renewal route and reconnects without user action.
- **Bounded revocation checks**: Established cookie and bearer sockets revalidate their exact credential once per minute, so a lost process-local termination signal cannot preserve access for the full session window.
- **Server version in the connection acknowledgement**: The frontend uses this to detect when the server has been upgraded and prompt users to refresh. This is a lightweight deployment coordination mechanism.

## Related

- [ADR-024](ADR-024-opaque-bearer-tokens-for-cross-origin-auth.md) partially extends this decision, adding a parallel cross-origin bearer-token path alongside same-origin cookie auth.
- [ADR-046](ADR-046-typed-runtime-credentials.md) moved the cookie session recorded here onto a typed runtime credential model.
- [ADR-079](ADR-079-renewable-bearer-sessions.md) extends the realtime authentication model to renewable bearer sessions for non-cookie clients.
- [ADR-081](ADR-081-explicit-expiry-for-mutable-runtime-credentials.md) replaces the sliding cookie-session renewal described here with explicit expiry and a defined renewal window.
