# Error Handling

## Intent

Unexpected failures should fail at the owning runtime boundary so top-level
exception handling, tracing, and retries can report one clear error. Local
catch-and-log blocks make important failures look recoverable and create noisy
duplicate diagnostics.

## Policy

- Let operations that should succeed throw to the caller; do not catch only to
  log a warning and continue.
- Catch errors only when the current layer can recover, translate an expected
  boundary failure into a typed domain result, or add required cleanup that
  cannot be expressed with `finally`.
- If a catch block handles an error, it must either complete the recovery or
  rethrow with useful domain context. Avoid log-and-rethrow duplicates.
- Use `finally` for cleanup that must run without changing error ownership.
- Keep best-effort observers explicit. If correctness depends on the operation,
  it is not best-effort.

## Exceptions

- External systems with expected transient failures may catch at the boundary
  that owns retry, backoff, auth pause, or typed fallback behavior.
- Product surfaces that intentionally degrade, such as optional UI streaming or
  non-critical observer callbacks, may catch locally when dropping the failure is
  part of their contract.
