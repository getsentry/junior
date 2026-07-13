# Credentials And OAuth

This module resolves credential subjects, stores user grants, and brokers
provider authorization without exposing long-lived secrets to the model or
sandbox.

## Authority

- The current actor is the default credential subject.
- A different subject requires explicit delegation carried through the durable
  execution context.
- Run attribution and conversation membership do not grant provider authority.
- Missing actor or subject context fails closed.

## Issuance

- Provider plugins declare grants, domains, and header transformations.
- Credentials are issued lazily for a verified operation and sandbox context.
- Cache keys include provider, grant, subject, operation/resource scope,
  sandbox session, and expiry as applicable.
- Real credentials remain in host storage and host-applied request headers.

## OAuth Flow

1. A provider reports that a user-bound grant is required.
2. Runtime stores a short-lived, single-use authorization request bound to the
   actor, provider, conversation, and requested continuation.
3. The authorization URL is delivered privately; public conversation output
   contains no reusable URL or token.
4. The callback validates state, exchanges and stores the token, marks the
   request consumed, and appends work to resume the conversation.
5. Replayed, expired, mismatched, or already-consumed callbacks fail without
   altering conversation authority.

### MCP Authorization Attempts

- Every authorization start creates a fresh v2 attempt id. Its PKCE verifier
  and authorization URL are persisted independently and remain write-once.
- Thread-local MCP pending auth includes the exact attempt id before the private
  link is delivered. Failed delivery deletes the new attempt and restores the
  prior pending authorization without abandoning its blocked turn.
- Before each shared user/provider credential mutation, the callback acquires
  the thread lock and verifies that the attempt still owns pending auth.
- Pre-v2 attempts and legacy MCP pending-auth records without an attempt id are
  invalid after the cutover. Existing completed credentials remain valid.

Follow `../../../../../policies/security.md` and
`../../../../../policies/context-bound-systems.md`.
